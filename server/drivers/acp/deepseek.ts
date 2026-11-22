// DeepSeek Harness support — DeepSeek's `dsh` (github.com/deepseek-ai/deepseek-harness)
// over ACP stdio (`dsh --profile acp`). The generic protocol runtime lives in
// acp/core.ts; this file is only the per-harness quirks. Verified against
// @deepseek-ai/dsh 0.2.1-rc.2 on 2026-10-22:
//
//   - initialize answers protocolVersion 1, authMethods [] (no sign-in step:
//     the DeepSeek key is read from DEEPSEEK_API_KEY or dsh's own
//     $DSH_HOME/.credentials.yaml), promptCapabilities.image false,
//     sessionCapabilities {close, list, resume} — resume is session/resume,
//     there is no session/load.
//   - session/new advertises two config options: `model` (category "model",
//     values are JSON pairs such as ["deepseek-official","deepseek-v4-flash"],
//     grouped per provider) and `reasoning_effort` (category "thought_level":
//     off | low | high | max). Both are set with session/set_config_option,
//     which answers with the full configOptions so the core can confirm the
//     change. That is exactly the OpenCode-shaped path (selectModel +
//     modelVariants), so model and effort need no driver code of their own.
//   - Warm boot to initialize is 1.6 s; the first boot after an install
//     creates $DSH_HOME/profiles/acp (a cold `npx` boot took ~120 s because
//     it downloaded the dependency tree, so the catalog is only probed on an
//     explicit Refresh, never at app startup).
//
// Picker ids are `<provider>/<model>` so bot settings, badges and config.json
// stay readable; resolveTurnModel turns them into dsh's wire pair just before
// the core selects the model.
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { ModelCatalog } from "../../contracts.ts";
import { harnessHome, sealedFixture, whichWin } from "../../env-path.ts";
import { execCli, resolveCli, spawnCli } from "../../procs.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { versionFromProbe } from "./version-probe.ts";

export const DEEPSEEK_MODELS: ModelCatalog = {
  default: "deepseek-official/deepseek-v4-flash",
  options: [
    { id: "deepseek-official/deepseek-v4-flash", label: "DeepSeek-V4-Flash" },
    { id: "deepseek-official/deepseek-flash", label: "DeepSeek-V4.1-Flash" },
    { id: "deepseek-official/deepseek-v4-pro", label: "DeepSeek-V4-Pro" },
  ],
};

/** `provider/model` → dsh's `["provider","model"]`. An id with no provider
 * is handed to dsh as-is so its own error names the problem. */
export function deepseekWireValue(pickerId: string): string {
  const slash = pickerId.indexOf("/");
  if (slash <= 0 || slash === pickerId.length - 1) return pickerId;
  return JSON.stringify([pickerId.slice(0, slash), pickerId.slice(slash + 1)]);
}

/** Inverse of deepseekWireValue; null for anything but a two-string pair. */
export function deepseekPickerId(wireValue: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(wireValue);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [provider, model] = parsed;
  if (typeof provider !== "string" || typeof model !== "string" || !provider || !model) return null;
  return `${provider}/${model}`;
}

export function dshHome(env: Record<string, string | undefined>): string {
  return env.DSH_HOME?.trim() || harnessHome("dsh", env);
}

const nonEmpty = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";

const DESKTOP_HOST_CLI_SEGMENTS = ["dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js"] as const;

export interface DeepSeekResolvedLaunch {
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
}

function desktopAppRootFromPath(targetPath: string): string | null {
  const trimmed = targetPath.trim();
  if (!trimmed) return null;
  if (basename(trimmed).toLowerCase() === "deepseek harness.exe") {
    const root = dirname(trimmed);
    if (existsSync(trimmed) && existsSync(join(root, "resources", "app.asar"))) return root;
    return null;
  }
  let cur = dirname(trimmed);
  for (let depth = 0; depth < 6; depth += 1) {
    if (basename(cur).toLowerCase() === "resources") {
      const root = dirname(cur);
      if (existsSync(join(root, "DeepSeek Harness.exe")) && existsSync(join(cur, "app.asar"))) {
        return root;
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function windowsDesktopInstallRoots(env: Record<string, string | undefined>): string[] {
  if (sealedFixture()) return [];
  const roots: string[] = [];
  const home = env.USERPROFILE || env.HOME || "";
  const localAppData = env.LOCALAPPDATA || (home ? join(home, "AppData", "Local") : "");
  if (localAppData) roots.push(join(localAppData, "Programs", "DeepSeek Harness"));
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  if (programFiles) roots.push(join(programFiles, "DeepSeek Harness"));
  const programFilesX86 = env["ProgramFiles(x86)"];
  if (programFilesX86) roots.push(join(programFilesX86, "DeepSeek Harness"));
  return roots;
}

function buildWindowsDesktopLaunch(
  appRoot: string,
  env: Record<string, string | undefined>,
  cmdShimPath?: string,
): DeepSeekResolvedLaunch {
  const exe = join(appRoot, "DeepSeek Harness.exe");
  const asar = join(appRoot, "resources", "app.asar");
  let entry = join(asar, ...DESKTOP_HOST_CLI_SEGMENTS);
  if (cmdShimPath && existsSync(cmdShimPath)) {
    try {
      const text = readFileSync(cmdShimPath, "utf8");
      const match = /app\.asar[\\/]([^"'\r\n]+?\.m?c?js)\b/i.exec(text);
      if (match?.[1]) {
        entry = join(asar, ...match[1].split(/[\\/]+/).filter(Boolean));
      }
    } catch { /* fall back to standard desktop-host cli entry */ }
  }
  return {
    command: exe,
    args: ["--expose-internals", entry],
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
  };
}

/**
 * DeepSeek Harness Desktop on Windows ships `resources\runtime\cli\bin\dsh.cmd`, which sets
 * `ELECTRON_RUN_AS_NODE=1` and runs `DeepSeek Harness.exe --expose-internals ...\app.asar\...\cli.js`.
 * Node 24 refuses to spawn `.cmd` directly without a shell (`EINVAL`), and plain `node.exe` cannot
 * read inside Electron's `app.asar`, so resolve Desktop installs directly to `DeepSeek Harness.exe`.
 */
export function resolveDeepSeekLaunch(
  cli: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): DeepSeekResolvedLaunch {
  const trimmed = cli.trim() || "dsh";
  if (platform !== "win32") {
    return { command: trimmed, args: [] };
  }

  const directRoot = desktopAppRootFromPath(trimmed);
  if (directRoot) {
    const ext = extname(trimmed).toLowerCase();
    return buildWindowsDesktopLaunch(directRoot, env, ext === ".cmd" || ext === ".bat" ? trimmed : undefined);
  }

  if (trimmed.toLowerCase() === "dsh" || trimmed.toLowerCase() === "dsh.cmd") {
    const onPath = whichWin("dsh", env as NodeJS.ProcessEnv);
    if (onPath) {
      const pathRoot = desktopAppRootFromPath(onPath);
      if (pathRoot) return buildWindowsDesktopLaunch(pathRoot, env, onPath);
      return { command: trimmed, args: [] };
    }
    for (const root of windowsDesktopInstallRoots(env)) {
      if (existsSync(join(root, "DeepSeek Harness.exe")) && existsSync(join(root, "resources", "app.asar"))) {
        const shim = join(root, "resources", "runtime", "cli", "bin", "dsh.cmd");
        return buildWindowsDesktopLaunch(root, env, existsSync(shim) ? shim : undefined);
      }
    }
  }

  return { command: trimmed, args: [] };
}

/** dsh 0.2.1 writes `version: 1` with the key under `refs:`; it also migrates
 * the pre-release flat layout (the key at the top level), so both count. An
 * empty or quoted-empty value is "no key": dsh treats it as a boot error. */
function storedCredentialPresent(path: string): boolean {
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (!doc || typeof doc !== "object") return false;
  const root = doc as Record<string, unknown>;
  const refs = root.refs && typeof root.refs === "object" ? root.refs as Record<string, unknown> : {};
  if (nonEmpty(refs.DEEPSEEK_API_KEY) || nonEmpty(root.DEEPSEEK_API_KEY)) return true;
  const records = root.records && typeof root.records === "object" ? root.records as Record<string, unknown> : {};
  for (const [key, entry] of Object.entries(records)) {
    if (!key.startsWith("deepseek-account-platform/")) continue;
    if (!entry || typeof entry !== "object") continue;
    const payload = (entry as Record<string, unknown>).payload;
    if (!payload || typeof payload !== "object") continue;
    const p = payload as Record<string, unknown>;
    if (nonEmpty(p.token) || nonEmpty(p.accessToken) || nonEmpty(p.access_token)) {
      return true;
    }
  }
  return false;
}

const DOTENV_LINE = /^[ \t]*(?:export[ \t]+)?DEEPSEEK_API_KEY[ \t]*=(.*)$/;

/** One dotenv assignment with a non-empty value, quotes and a trailing comment stripped. */
function dotenvValuePresent(path: string): boolean {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = DOTENV_LINE.exec(line);
    if (!match) continue;
    let value = match[1]!.trim();
    const quoted = /^(["'])(.*)\1(?:[ \t]+#.*)?$/.exec(value);
    if (quoted) value = quoted[2]!;
    else value = value.replace(/[ \t]+#.*$/, "").trim();
    if (value !== "") return true;
  }
  return false;
}

/** A DeepSeek key dsh will find: the launch env, its stored credential file,
 * or its home .env (the layers dsh documents, read-only here). The stored
 * file outranks the env inside dsh; for "is there a key at all" any layer counts. */
export function hasDeepSeekKey(env: Record<string, string | undefined>): boolean {
  if (nonEmpty(env.DEEPSEEK_API_KEY)) return true;
  const homes = [dshHome(env)];
  if (!env.DSH_HOME?.trim() && env.HOME?.trim() && env.USERPROFILE?.trim() && env.HOME.trim() !== env.USERPROFILE.trim()) {
    const other = join(process.platform === "win32" ? env.HOME.trim() : env.USERPROFILE.trim(), ".dsh");
    if (!homes.includes(other)) homes.push(other);
  }
  return homes.some((home) => storedCredentialPresent(join(home, ".credentials.yaml")) || dotenvValuePresent(join(home, ".env")));
}

/** Every `value` string under a select option, descending into groups. */
function offeredWireValues(sessionConfig: unknown, configId: string): { values: string[]; current: string | null } {
  const options = (sessionConfig as { configOptions?: unknown[] } | undefined)?.configOptions;
  const option = (Array.isArray(options) ? options : []).find(
    (entry: any) => entry?.id === configId,
  ) as { currentValue?: unknown; options?: unknown } | undefined;
  const values: string[] = [];
  const collect = (entries: unknown) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (typeof entry?.value === "string") values.push(entry.value);
      else if (Array.isArray(entry?.options)) collect(entry.options);
    }
  };
  collect(option?.options);
  return { values, current: typeof option?.currentValue === "string" ? option.currentValue : null };
}

/** The `model` config option of a session/new answer, as a picker catalog.
 * Groups carry dsh's provider display name, kept as the option's provider
 * badge so a gateway's copy of a model stays distinguishable. */
export function parseDeepSeekCatalog(sessionResult: unknown): ModelCatalog {
  const options = (sessionResult as { configOptions?: unknown[] } | undefined)?.configOptions;
  const option = (Array.isArray(options) ? options : []).find((entry: any) => entry?.id === "model") as
    { currentValue?: unknown; options?: unknown } | undefined;
  const out: ModelCatalog["options"] = [];
  const collect = (entries: unknown, provider: string | undefined) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (Array.isArray(entry?.options)) {
        const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim()
          : typeof entry.group === "string" ? entry.group : provider;
        collect(entry.options, name);
        continue;
      }
      if (typeof entry?.value !== "string") continue;
      const id = deepseekPickerId(entry.value);
      if (!id || out.some((row) => row.id === id)) continue;
      const label = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id;
      out.push({ id, label, ...(provider ? { provider } : {}) });
    }
  };
  collect(option?.options, undefined);
  if (!out.length) throw new Error("dsh advertised no models");
  const current = typeof option?.currentValue === "string" ? deepseekPickerId(option.currentValue) : null;
  return {
    default: current && out.some((row) => row.id === current) ? current : out[0]!.id,
    options: out,
  };
}

export const DEEPSEEK_MODELS_TIMEOUT_ENV = "OPENMAUS_DEEPSEEK_MODELS_TIMEOUT_MS";
/** A warm `dsh --profile acp` answers session/new in ~2 s; the first boot
 * after an install also creates the profile, so leave real headroom. */
export const DEEPSEEK_MODELS_DEFAULT_TIMEOUT_MS = 60_000;

function catalogTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env[DEEPSEEK_MODELS_TIMEOUT_ENV];
  if (raw === undefined) return DEEPSEEK_MODELS_DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647 ? parsed : DEEPSEEK_MODELS_DEFAULT_TIMEOUT_MS;
}

/** Ask the installed dsh what it offers: initialize, session/new in `cwd`,
 * read the catalog, session/close. Rejects on any failure so the core keeps
 * the last usable catalog; never resolves to an empty or guessed list. */
export function fetchDeepSeekCatalog(
  cli: string,
  env: Record<string, string | undefined>,
  cwd: string,
  allowEnv: readonly string[] = [],
): Promise<ModelCatalog> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      // Security: while the bot box is on, dsh runs in it, as a bot's turn does: it reads ~/.dsh, which a bot can write.
      const launch = resolveDeepSeekLaunch(cli, env);
      const launchEnv = (launch.env ?? env) as NodeJS.ProcessEnv;
      const resolved = resolveCli(launch.command, [...launch.args, "--profile", "acp"], launchEnv);
      child = spawnCli(resolved.command, resolved.args, { stdio: ["pipe", "pipe", "ignore"], env: launchEnv, box: { allowEnv } });
    } catch (error) {
      return reject(error instanceof Error ? error : new Error(String(error)));
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: { catalog: ModelCatalog } | { error: Error }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        child.stdin?.end();
      } catch {}
      try {
        if (child.kill()) {
          const hardKill = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {}
          }, 1_000);
          hardKill.unref?.();
        }
      } catch {}
      if ("catalog" in outcome) resolve(outcome.catalog);
      else reject(outcome.error);
    };
    timer = setTimeout(() => finish({ error: new Error(`dsh timed out after ${catalogTimeoutMs(env)} ms without answering session/new`) }), catalogTimeoutMs(env));
    child.once("error", (error) => finish({ error }));
    // A child that already exited makes stdin emit EPIPE, and an unhandled stream 'error' crashes the server.
    child.stdin?.on("error", (error) => finish({ error }));
    child.once("close", (code, signal) => finish({ error: new Error(`dsh exited (${signal ?? code}) before answering session/new`) }));

    let buf = "";
    let nextId = 0;
    const send = (method: string, params: unknown): number => {
      nextId += 1;
      try {
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: nextId, method, params })}\n`, (error) => {
          if (error) finish({ error });
        });
      } catch (error) {
        finish({ error: error instanceof Error ? error : new Error(String(error)) });
      }
      return nextId;
    };
    let initId = 0;
    let sessionReqId = 0;
    let closeId = 0;
    let catalog: ModelCatalog | null = null;
    child.stdout?.on("data", (chunk) => {
      buf += String(chunk);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg?.id === initId) {
          if (!msg.result) return finish({ error: new Error(`dsh rejected initialize: ${JSON.stringify(msg.error ?? msg)}`) });
          sessionReqId = send("session/new", { cwd, mcpServers: [] });
        } else if (sessionReqId && msg?.id === sessionReqId) {
          const sessionId = typeof msg.result?.sessionId === "string" ? msg.result.sessionId : null;
          try {
            catalog = parseDeepSeekCatalog(msg.result);
          } catch (error) {
            // Best effort: the close is sent, but an unusable answer does not wait on it.
            if (sessionId) send("session/close", { sessionId });
            return finish({ error: error instanceof Error ? error : new Error(String(error)) });
          }
          if (!sessionId) return finish({ catalog });
          // Leave no half-open session behind in dsh's persisted list.
          closeId = send("session/close", { sessionId });
        } else if (closeId && msg?.id === closeId) {
          finish({ catalog: catalog! });
        }
      }
    });
    initId = send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: "donebot", version: "catalog" },
    });
  });
}

export const deepseekSupport: AcpSupport = {
  driverKind: "deepseekAgent",
  displayName: "DeepSeek Harness",
  models: DEEPSEEK_MODELS,
  defaultCli: "dsh",
  nativeSource: "deepseek.acp",
  loginNote: "DeepSeek Harness has no DeepSeek API key — paste one under Settings → Connections → Model providers, or set DEEPSEEK_API_KEY",

  install: {
    command: {
      darwin: "npm install -g @deepseek-ai/dsh",
      linux: "npm install -g @deepseek-ai/dsh",
      win32: "npm install -g @deepseek-ai/dsh",
    },
    docsUrl: "https://github.com/deepseek-ai/deepseek-harness",
    needsNode: true,
    // Keyless is "paste a key in Settings", not a terminal sign-in.
    settings: "connections",
  },

  spawnArgs: () => ["--profile", "acp"],
  resolveCommand: async (env, config) => resolveDeepSeekLaunch(config.cli || "dsh", env),
  snapshot: async (env, config) => {
    const cli = config.cli || "dsh";
    const launch = resolveDeepSeekLaunch(cli, env);
    const probeEnv = (launch.env ?? env) as NodeJS.ProcessEnv;
    const probe = await new Promise<{ version?: string; reason?: string }>((resolve) => {
      execCli(launch.command, [...launch.args, "--version"], { timeout: 15_000, env: probeEnv }, (err, stdout, stderr) => {
        if (err) {
          const failure = err as NodeJS.ErrnoException & { killed?: boolean };
          const reason = failure.code === "ENOENT"
            ? `\`${cli}\` isn't installed, or isn't on this app's PATH. Install it for the user running DoneBot or use Set CLI, then check again.`
            : failure.code === "EACCES" || failure.code === "EPERM"
              ? `\`${cli}\` isn't executable. Check its file permissions, then check again.`
              : failure.killed && failure.code == null
                ? `\`${cli}\` version check timed out after 15 seconds. Check it in a terminal on the server, then try again.`
                : `\`${cli}\` version check failed. Run it with --version on the server to diagnose the installation, then check again.`;
          resolve({ reason });
          return;
        }
        const version = versionFromProbe(stdout, stderr);
        resolve(version ? { version } : { reason: `\`${cli}\` returned no version. Check the configured executable with --version, then try again.` });
      });
    });
    if (!probe.version) return { state: "unavailable", reason: probe.reason };
    return { state: "available", version: probe.version, authenticated: hasDeepSeekKey(env) };
  },
  credentialEnv: ["DEEPSEEK_API_KEY"],
  // Model and reasoning effort are session config options (see header).
  selectModel: { configId: "model" },
  modelVariants: true,
  resumeMethod: "resume",
  // dsh 0.2 rejects session/resume of a session still open in the same process
  // ("session is already active"), so a turn with new tools needs a new process.
  restartOnMcpChange: true,
  // Refresh only: a fresh profile boot can take long, and startup must not wait on it.
  resolveModels: (env, config, _instanceId, _fresh, allowEnv) => fetchDeepSeekCatalog(config.cli || "dsh", env, tmpdir(), allowEnv),
  resolveModelsOnCreate: false,

  // initialize advertises no auth methods; the key rides in the child env or
  // dsh's own credential file, so there is nothing to call authenticate for.
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env) => hasDeepSeekKey(env),

  resolveTurnModel: (model) => (model ? deepseekWireValue(model) : model),
  fallbackModel: (sessionConfig, catalogDefault) => {
    const { values, current } = offeredWireValues(sessionConfig, "model");
    const wanted = catalogDefault ? deepseekWireValue(catalogDefault) : "";
    if (wanted && values.includes(wanted)) return wanted;
    if (current && values.includes(current)) return current;
    return null;
  },

  // House convention for ACP harnesses: the persona rides in the prompt text.
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const DeepSeekAgentDriver = createAcpDriver(deepseekSupport);
