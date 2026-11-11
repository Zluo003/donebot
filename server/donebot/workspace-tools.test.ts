import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SendTurnInput } from "../contracts.ts";
import type { LocalChatTools } from "../drivers/openai-chat.ts";
import { createWorkspaceTools } from "./workspace-tools.ts";

const directories: string[] = [], sessions: LocalChatTools[] = [];
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const signal = () => new AbortController().signal;
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const directory of directories.splice(0)) await rm(directory, { force: true, recursive: true });
  vi.unstubAllEnvs();
});
const fixture = async (turn: Partial<SendTurnInput> = {}) => {
  const cwd = await mkdtemp(join(tmpdir(), "donebot-workspace-fixture-")); directories.push(cwd);
  const session = await createWorkspaceTools({ threadId: "fixture", text: "fixture", cwd, ...turn }, signal()); sessions.push(session);
  return { cwd, session, execute: (name: string, args: Record<string, unknown>, callSignal = signal()) => session.execute(name, args, callSignal) };
};

describe("DoneBot selected workspace tools", () => {
  it("rejects traversal, absolute paths and symlink parents without changing outside files", async () => {
    const { cwd, execute } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "donebot-outside-fixture-")); directories.push(outside);
    await writeFile(join(outside, "receipt.txt"), "outside");
    await symlink(outside, join(cwd, "shortcut"), "dir");
    for (const path of ["../receipt.txt", join(outside, "receipt.txt"), "shortcut/receipt.txt"]) {
      await expect(execute("workspace_read", { path })).rejects.toThrow();
      await expect(execute("workspace_write", { path, text: "forbidden" })).rejects.toThrow();
    }
    expect(await readFile(join(outside, "receipt.txt"), "utf8")).toBe("outside");
  });

  it("respects tool scope and guest confinement even for an unadvertised direct call", async () => {
    const guest = await fixture({ guestConfined: true });
    expect(guest.session.definitions.map((one) => one.function.name)).toEqual(["workspace_list", "workspace_read", "workspace_search"]);
    await expect(guest.execute("workspace_run", { executable: process.execPath, args: [] })).rejects.toThrow("selection");
    await expect(guest.execute("workspace_write", { path: "no", text: "no" })).rejects.toThrow("selection");
    const scoped = await fixture({ toolScope: { allow: ["native:workspace_read"] } });
    expect(scoped.session.definitions.map((one) => one.function.name)).toEqual(["workspace_read"]);
    expect(() => scoped.session.validate("workspace_list", {})).toThrow("selection");
    const absent = await createWorkspaceTools({ threadId: "none", text: "none" }, signal()); sessions.push(absent);
    expect(absent.definitions).toEqual([]);
  });

  it("uses exact file hashes for overwrites and refuses stale or ambiguous patches", async () => {
    const { cwd, execute, session } = await fixture();
    expect(session.view("workspace_write", { path: "a.txt", text: "first" }).ask).toBe(true);
    await execute("workspace_write", { path: "a.txt", text: "first" });
    await expect(execute("workspace_write", { path: "a.txt", text: "unauthorized" })).rejects.toThrow("overwrite");
    await expect(execute("workspace_write", { path: "a.txt", text: "stale", expected_sha256: sha("wrong") })).rejects.toThrow("changed");
    await execute("workspace_patch", { path: "a.txt", old_text: "first", new_text: "$&literal", expected_sha256: sha("first") });
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("$&literal");
    await writeFile(join(cwd, "a.txt"), "repeat repeat");
    await expect(execute("workspace_patch", { path: "a.txt", old_text: "repeat", new_text: "x", expected_sha256: sha("repeat repeat") })).rejects.toThrow("exactly one");
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("repeat repeat");
  });

  it("creates files without clobbering a competing create", async () => {
    const { cwd, execute } = await fixture();
    const results = await Promise.allSettled([execute("workspace_write", { path: "receipt.txt", text: "one" }), execute("workspace_write", { path: "receipt.txt", text: "two" })]);
    expect(results.filter((one) => one.status === "fulfilled")).toHaveLength(1);
    expect(["one", "two"]).toContain(await readFile(join(cwd, "receipt.txt"), "utf8"));
    const listed = JSON.parse((await execute("workspace_list", {})).text);
    expect(listed.entries.map((one: { name: string }) => one.name)).toEqual(["receipt.txt"]);
  });

  it("bounds read results and returns the whole file hash for every page", async () => {
    const { cwd, execute } = await fixture(), text = "a".repeat(60_000) + "tail";
    await writeFile(join(cwd, "large.txt"), text);
    const first = JSON.parse((await execute("workspace_read", { path: "large.txt" })).text);
    const last = JSON.parse((await execute("workspace_read", { path: "large.txt", offset: 60_000, limit: 4 })).text);
    expect(first.text).toHaveLength(24_000);
    expect(first).toMatchObject({ sha256: sha(text), truncated: true, totalCharacters: 60_004 });
    expect(last).toMatchObject({ text: "tail", sha256: sha(text), truncated: false });
  });

  it("searches literal text while excluding symlinks and dependency trees", async () => {
    const { cwd, execute } = await fixture();
    await mkdir(join(cwd, "node_modules"));
    await writeFile(join(cwd, "node_modules", "ignored"), "needle");
    await writeFile(join(cwd, "a.txt"), "one\nneedle [x]\nthree");
    await symlink(join(cwd, "a.txt"), join(cwd, "shortcut"));
    const result = JSON.parse((await execute("workspace_search", { query: "needle [x]" })).text);
    expect(result.matches).toEqual([{ path: "a.txt", line: 2, text: "needle [x]" }]);
  });

  it("runs separate arguments with a clean environment and exposes the exact command to the safety floor", async () => {
    vi.stubEnv("DONEBOT_FIXTURE_TOKEN", "never-pass-this-fixture-token");
    const { execute, session } = await fixture();
    const args = { executable: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify({arg: process.argv[1], token: process.env.DONEBOT_FIXTURE_TOKEN ?? null, home: process.env.HOME}))", "$(never-execute);literal"] };
    expect(session.view("workspace_run", args)).toMatchObject({ ask: true, input: { command: expect.stringContaining("'$(never-execute);literal'") } });
    const result = JSON.parse((await execute("workspace_run", args)).text);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(JSON.parse(result.output)).toMatchObject({ arg: "$(never-execute);literal", token: null });
  });

  it("Stop interrupts a process and refuses a cancelled write", async () => {
    const { cwd, execute } = await fixture(), controller = new AbortController();
    const receipt = join(cwd, "started");
    const running = execute("workspace_run", { executable: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)", receipt] }, controller.signal);
    await vi.waitFor(async () => expect(await readFile(receipt, "utf8")).toBe("ready"));
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    await expect(execute("workspace_write", { path: "forbidden", text: "x" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(readFile(join(cwd, "forbidden"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
