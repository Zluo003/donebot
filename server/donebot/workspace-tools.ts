import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { allowsTool } from "../../shared/tool-scope.ts";
import { augmentedPath } from "../env-path.ts";
import { killCliTree, spawnCli } from "../procs.ts";
import type { SendTurnInput } from "../contracts.ts";
import type { ChatToolDefinition, ChatToolResult } from "../drivers/chat-mcp-tools.ts";
import type { LocalChatTools } from "../drivers/openai-chat.ts";

const MAX_FILE = 1024 * 1024;
const MAX_OUTPUT = 64 * 1024;
const hasControls = (value: string) => [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const pathValue = z.string().min(1).max(4096).refine((value) => !hasControls(value), "Path contains control characters");
const hashValue = z.string().regex(/^[a-f0-9]{64}$/);
const schemas = {
  workspace_list: z.object({ path: pathValue.optional() }).strict(),
  workspace_read: z.object({ path: pathValue, offset: z.number().int().min(0).max(MAX_FILE).optional(), limit: z.number().int().min(1).max(24_000).optional() }).strict(),
  workspace_search: z.object({ query: z.string().min(1).max(500), path: pathValue.optional() }).strict(),
  workspace_write: z.object({ path: pathValue, text: z.string().max(MAX_FILE), expected_sha256: hashValue.optional() }).strict(),
  workspace_patch: z.object({ path: pathValue, old_text: z.string().min(1).max(MAX_FILE), new_text: z.string().max(MAX_FILE), expected_sha256: hashValue }).strict(),
  workspace_run: z.object({ executable: z.string().min(1).max(4096).refine((value) => !hasControls(value) && !value.startsWith("-")), args: z.array(z.string().max(32_768).refine((value) => !value.includes("\0"))).max(256), timeout_seconds: z.number().int().min(1).max(300).optional() }).strict(),
};
type ToolName = keyof typeof schemas;
const definitions: ChatToolDefinition[] = [
  { type: "function", function: { name: "workspace_list", description: "List files in your selected working folder. Paths are relative to that folder; symlinks are not followed.", parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "workspace_read", description: "Read a UTF-8 text file in your selected working folder. Returns its whole-file SHA-256 for a later safe edit. Reads at most 24000 characters; use offset and limit to page through larger files.", parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 24000 } }, required: ["path"], additionalProperties: false } } },
  { type: "function", function: { name: "workspace_search", description: "Search literal text in files under your selected working folder. Skips symlinks, binary files, dependencies and git internals. Results are bounded; narrow the query for more detail.", parameters: { type: "object", properties: { query: { type: "string" }, path: { type: "string" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "workspace_write", description: "Create a UTF-8 file in your selected working folder. Overwriting an existing file requires the expected_sha256 from workspace_read. Does not create parent folders.", parameters: { type: "object", properties: { path: { type: "string" }, text: { type: "string" }, expected_sha256: { type: "string" } }, required: ["path", "text"], additionalProperties: false } } },
  { type: "function", function: { name: "workspace_patch", description: "Replace exactly one old_text passage in a UTF-8 file in your selected working folder. Requires expected_sha256 from workspace_read; stale or ambiguous edits fail.", parameters: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, expected_sha256: { type: "string" } }, required: ["path", "old_text", "new_text", "expected_sha256"], additionalProperties: false } } },
  { type: "function", function: { name: "workspace_run", description: "Run an approved executable with a separate args array in your selected working folder. Shell expansion is not applied. Uses the platform's existing bot box when configured. In an unboxed desktop this has the user's process privileges, so only request the precise action needed. No model credentials are inherited. Timeout or Stop kills the process tree; inspect side effects before retrying.", parameters: { type: "object", properties: { executable: { type: "string" }, args: { type: "array", items: { type: "string" } }, timeout_seconds: { type: "integer", minimum: 1, maximum: 300 } }, required: ["executable", "args"], additionalProperties: false } } },
];
const isTool = (name: string): name is ToolName => Object.hasOwn(schemas, name);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const within = (root: string, path: string) => { const part = relative(root, path); return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`)); };

export async function createWorkspaceTools(turn: SendTurnInput, signal: AbortSignal): Promise<LocalChatTools> {
  const folder = turn.cwd ?? turn.toolResultFolder;
  const offered = !folder ? [] : definitions.filter(({ function: fn }) => allowsTool(turn.toolScope, { kind: "native", name: fn.name }) && (!turn.guestConfined || ["workspace_list", "workspace_read", "workspace_search"].includes(fn.name)));
  const available = new Set(offered.map(({ function: fn }) => fn.name));
  const root = folder ? await realpath(folder) : "";
  const running = new Set<ReturnType<typeof spawnCli>>();
  let closed = false;
  const live = (callSignal: AbortSignal) => { signal.throwIfAborted(); callSignal.throwIfAborted(); if (closed) throw new Error("Workspace tools are closed"); };
  const checked = async (path: string, creating = false) => {
    if (!root || isAbsolute(path)) throw new Error("Use a relative path inside the selected working folder");
    if (await realpath(folder!) !== root) throw new Error("The selected working folder changed");
    const target = resolve(root, path);
    if (!within(root, target)) throw new Error("Path leaves the selected working folder");
    let current = root;
    const components = relative(root, target).split(sep).filter(Boolean);
    for (const [index, component] of components.entries()) {
      current = join(current, component);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new Error("Symlinks are not allowed in workspace tools");
        if (index < components.length - 1 && !info.isDirectory()) throw new Error("Parent path is not a directory");
      } catch (error) {
        if (creating && index === components.length - 1 && (error as NodeJS.ErrnoException).code === "ENOENT") return target;
        throw error;
      }
    }
    return target;
  };
  const textAt = async (target: string) => {
    const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_FILE) throw new Error("Expected a text file no larger than 1 MiB");
      const bytes = await file.readFile();
      if (bytes.length > MAX_FILE || bytes.includes(0)) throw new Error("Expected a text file no larger than 1 MiB");
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } finally { await file.close(); }
  };
  const write = async (path: string, text: string, callSignal: AbortSignal, expected?: string) => {
    if (Buffer.byteLength(text) > MAX_FILE) throw new Error("Text exceeds the 1 MiB file limit");
    const target = await checked(path, true);
    let before: string | undefined;
    try { before = await textAt(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (before !== undefined ? expected !== sha(before) : expected !== undefined) throw new Error("File changed or overwrite was not authorized: read it again first");
    const temporary = join(dirname(target), `.donebot-write-${randomUUID()}`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(text, "utf8"); await file.sync(); } finally { await file.close(); }
      live(callSignal);
      await checked(path, true);
      if (before === undefined) {
        live(callSignal);
        await link(temporary, target);
      } else {
        if (sha(await textAt(target)) !== expected) throw new Error("File changed while preparing the edit");
        live(callSignal);
        await rename(temporary, target);
      }
    } finally { await unlink(temporary).catch(() => {}); }
    return { ok: true, text: JSON.stringify({ path, sha256: sha(text), bytes: Buffer.byteLength(text) }) };
  };
  const run = async (args: z.infer<typeof schemas.workspace_run>, callSignal: AbortSignal): Promise<ChatToolResult> => {
    const cwd = await checked(".");
    const temporary = join(cwd, ".donebot-tmp");
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    await checked(".donebot-tmp");
    const env: NodeJS.ProcessEnv = { PATH: augmentedPath(), HOME: cwd, TMPDIR: temporary, TEMP: temporary, TMP: temporary,
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT } : {}),
    };
    const child = spawnCli(args.executable, args.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], box: { botId: turn.botId }, botWork: true }, "bot");
    running.add(child);
    child.stdin.end();
    let output = "", total = 0, timedOut = false;
    const capture = (chunk: Buffer) => { total += chunk.byteLength; if (output.length < MAX_OUTPUT) output += chunk.toString("utf8").slice(0, MAX_OUTPUT - output.length); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    const combined = AbortSignal.any([signal, callSignal]);
    const abort = () => { void killCliTree(child).catch(() => {}); };
    combined.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; abort(); }, (args.timeout_seconds ?? 60) * 1000);
    timer.unref?.();
    try {
      const code = await new Promise<number | null>((resolveCode, reject) => { child.once("error", reject); child.once("close", resolveCode); if (combined.aborted) abort(); });
      live(callSignal);
      return { ok: code === 0 && !timedOut, text: JSON.stringify({ exitCode: code, timedOut, output, truncated: total > MAX_OUTPUT }) };
    } finally { clearTimeout(timer); combined.removeEventListener("abort", abort); running.delete(child); }
  };
  const validate = (name: string, args: unknown) => {
    if (!isTool(name) || !available.has(name)) throw new Error("Tool selection excludes this workspace tool");
    if (!schemas[name].safeParse(args).success) throw new Error("Workspace tool arguments do not match its schema");
  };
  return {
    definitions: offered,
    validate,
    view(name, args) {
      validate(name, args);
      const runArgs = name === "workspace_run" ? schemas.workspace_run.parse(args) : undefined;
      const input = runArgs ? { ...args, command: [runArgs.executable, ...runArgs.args].map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ") } : args;
      return { title: name, input, ask: !["workspace_list", "workspace_read", "workspace_search"].includes(name) };
    },
    async execute(name, raw, callSignal) {
      live(callSignal); validate(name, raw);
      if (name === "workspace_run") return run(schemas.workspace_run.parse(raw), callSignal);
      if (name === "workspace_write") { const args = schemas.workspace_write.parse(raw); return write(args.path, args.text, callSignal, args.expected_sha256); }
      if (name === "workspace_patch") {
        const args = schemas.workspace_patch.parse(raw), text = await textAt(await checked(args.path));
        if (sha(text) !== args.expected_sha256 || !text.includes(args.old_text) || text.indexOf(args.old_text) !== text.lastIndexOf(args.old_text)) throw new Error("File changed or patch does not match exactly one passage");
        return write(args.path, text.replace(args.old_text, () => args.new_text), callSignal, args.expected_sha256);
      }
      if (name === "workspace_read") {
        const args = schemas.workspace_read.parse(raw), text = await textAt(await checked(args.path));
        const offset = args.offset ?? 0, end = offset + (args.limit ?? 24_000);
        return { ok: true, text: JSON.stringify({ path: args.path, sha256: sha(text), text: text.slice(offset, end), offset, totalCharacters: text.length, truncated: end < text.length }) };
      }
      if (name === "workspace_list") {
        const args = schemas.workspace_list.parse(raw), entries = await readdir(await checked(args.path ?? "."), { withFileTypes: true });
        return { ok: true, text: JSON.stringify({ entries: entries.slice(0, 1000).map((entry) => ({ name: entry.name, kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file" })), truncated: entries.length > 1000 }) };
      }
      const args = schemas.workspace_search.parse(raw), matches: Array<{ path: string; line: number; text: string }> = [];
      let scanned = 0, truncated = false;
      const visit = async (path: string) => {
        live(callSignal);
        if (++scanned > 2000 || matches.length >= 100) { truncated = true; return; }
        const target = await checked(path), info = await lstat(target);
        if (info.isDirectory()) {
          for (const entry of await readdir(target, { withFileTypes: true })) {
            if (entry.isSymbolicLink() || [".git", "node_modules", ".donebot-tmp"].includes(entry.name)) continue;
            if (scanned >= 2000 || matches.length >= 100) { truncated = true; break; }
            await visit(join(path, entry.name));
          }
        } else if (info.isFile() && info.size <= MAX_FILE) {
          let text: string;
          try { text = await textAt(target); } catch { return; }
          for (const [index, line] of text.split("\n").entries()) if (line.includes(args.query)) { matches.push({ path, line: index + 1, text: line.slice(0, 500) }); if (matches.length >= 100) { truncated = true; break; } }
        }
      };
      await visit(args.path ?? ".");
      return { ok: true, text: JSON.stringify({ matches, truncated, scanned }) };
    },
    async close() { closed = true; const results = await Promise.all([...running].map((child) => killCliTree(child))); if (results.some((stopped) => !stopped)) throw new Error("Workspace process shutdown could not be confirmed"); },
  };
}
