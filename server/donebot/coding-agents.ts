import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  codingAgentById,
  codingAgentByInstanceId,
  EXTERNAL_CODING_AGENTS,
  EXTERNAL_CODING_AGENT_SWITCH_REFUSAL,
  isExternalCodingAgentInstance,
  type ExternalCodingAgentId,
  type ExternalCodingAgentSource,
  type ExternalCodingAgentSpec,
  type ExternalCodingAgentStatus,
} from "../../shared/coding-agents.ts";
import { validateBotCwd } from "../bot-cwd.ts";
import type {
  AnyProviderDriver,
  InstanceConfigMap,
  ModelSelection,
  ProviderInstance,
  ProviderSnapshot,
} from "../contracts.ts";
import { AntigravityDriver } from "../drivers/antigravity.ts";
import { resolveAntigravityRuntime } from "../drivers/antigravity-runtime.ts";
import { ClaudeDriver } from "../drivers/claude.ts";
import { CodexDriver } from "../drivers/codex.ts";
import { DeepSeekAgentDriver } from "../drivers/acp/deepseek.ts";
import { findZCodeDesktopBundle, resolveZCodeLaunch, ZCodeDriver } from "../drivers/zcode.ts";
import { augmentedPath, resetPathCache, sealedFixture } from "../env-path.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import { resolveCli } from "../procs.ts";
import type { ProviderAuthSessions } from "../provider-auth-sessions.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import type { BotRecord, Store } from "../store.ts";

export interface DiscoveredCodingAgent {
  installed: boolean;
  desktopAppDetected: boolean;
  source: ExternalCodingAgentSource;
  cliPath: string | null;
}

const createBotSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  cwd: z.string().trim().max(4096).nullable().optional(),
  model: z.string().trim().min(1).max(200).optional(),
}).strict();

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || homedir();
}

function compareSemverDesc(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true });
}

function findFirstExisting(paths: readonly string[]): string | null {
  for (const candidate of paths) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function findOnPath(binary: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const resolved = resolveCli(binary, [], { ...env, PATH: env.PATH || augmentedPath() });
    if (resolved.command && resolved.command !== binary && existsSync(resolved.command)) {
      return resolved.command;
    }
  } catch { /* ignore */ }
  return null;
}

export function findClaudeDesktopBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { cliPath: string | null; desktopAppDetected: boolean } {
  if (sealedFixture()) return { cliPath: null, desktopAppDetected: false };
  const home = homeDir(env);
  if (platform === "darwin") {
    const desktopAppDetected =
      existsSync("/Applications/Claude.app") || existsSync(join(home, "Applications", "Claude.app"));
    const versionsRoot = join(home, "Library", "Application Support", "Claude", "claude-code");
    try {
      const dirs = readdirSync(versionsRoot).sort(compareSemverDesc);
      for (const ver of dirs) {
        const found = findFirstExisting([
          join(versionsRoot, ver, "claude.app", "Contents", "MacOS", "claude"),
          join(versionsRoot, ver, "claude"),
        ]);
        if (found) return { cliPath: found, desktopAppDetected: true };
      }
    } catch { /* no embedded claude-code folder */ }
    return { cliPath: null, desktopAppDetected };
  }
  if (platform === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const desktopAppDetected =
      existsSync(join(localAppData, "AnthropicClaude", "claude.exe")) ||
      existsSync(join(appData, "Claude"));
    const versionsRoot = join(appData, "Claude", "claude-code");
    try {
      const dirs = readdirSync(versionsRoot).sort(compareSemverDesc);
      for (const ver of dirs) {
        const found = findFirstExisting([join(versionsRoot, ver, "claude.exe")]);
        if (found) return { cliPath: found, desktopAppDetected: true };
      }
    } catch { /* ignore */ }
    return { cliPath: null, desktopAppDetected };
  }
  return { cliPath: null, desktopAppDetected: false };
}

export function findCodexDesktopBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { cliPath: string | null; desktopAppDetected: boolean } {
  if (sealedFixture()) return { cliPath: null, desktopAppDetected: false };
  const home = homeDir(env);
  if (platform === "darwin") {
    const desktopAppDetected =
      existsSync("/Applications/Codex.app") ||
      existsSync(join(home, "Applications", "Codex.app")) ||
      existsSync("/Applications/ChatGPT.app") ||
      existsSync(join(home, "Applications", "ChatGPT.app"));
    const found = findFirstExisting([
      "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      join(home, "Applications", "Codex.app", "Contents", "Resources", "codex-cli", "bin", "codex"),
      join(home, "Applications", "Codex.app", "Contents", "Resources", "codex"),
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex"),
      join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
    ]);
    return { cliPath: found, desktopAppDetected: desktopAppDetected || Boolean(found) };
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const found = findFirstExisting([
      join(localAppData, "Programs", "Codex", "resources", "codex-cli", "bin", "codex.exe"),
      join(localAppData, "Programs", "Codex", "resources", "codex.exe"),
    ]);
    const desktopAppDetected =
      Boolean(found) || existsSync(join(localAppData, "Programs", "Codex", "Codex.exe"));
    return { cliPath: found, desktopAppDetected };
  }
  return { cliPath: null, desktopAppDetected: false };
}

export function findDeepSeekDesktopBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { cliPath: string | null; desktopAppDetected: boolean } {
  if (sealedFixture()) return { cliPath: null, desktopAppDetected: false };
  const home = homeDir(env);
  if (platform === "darwin") {
    const desktopAppDetected =
      existsSync("/Applications/DeepSeek Harness.app") ||
      existsSync(join(home, "Applications", "DeepSeek Harness.app"));
    const found = findFirstExisting([
      "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
      join(home, "Applications", "DeepSeek Harness.app", "Contents", "Resources", "runtime", "cli", "bin", "dsh"),
    ]);
    return { cliPath: found, desktopAppDetected: desktopAppDetected || Boolean(found) };
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = env["ProgramFiles(x86)"];
    const installRoots = [
      join(localAppData, "Programs", "DeepSeek Harness"),
      join(programFiles, "DeepSeek Harness"),
      ...(programFilesX86 ? [join(programFilesX86, "DeepSeek Harness")] : []),
    ];
    for (const root of installRoots) {
      const cliCandidate = findFirstExisting([
        join(root, "resources", "runtime", "cli", "bin", "dsh.cmd"),
        join(root, "resources", "runtime", "cli", "bin", "dsh.exe"),
      ]);
      if (cliCandidate) {
        return { cliPath: cliCandidate, desktopAppDetected: true };
      }
      const exe = join(root, "DeepSeek Harness.exe");
      if (existsSync(exe)) {
        const hasAsar = existsSync(join(root, "resources", "app.asar"));
        return { cliPath: hasAsar ? exe : null, desktopAppDetected: true };
      }
    }
    return { cliPath: null, desktopAppDetected: false };
  }
  return { cliPath: null, desktopAppDetected: false };
}

function findAntigravityDesktopApp(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (sealedFixture()) return false;
  const home = homeDir(env);
  if (platform === "darwin") {
    return (
      existsSync("/Applications/Antigravity.app") ||
      existsSync(join(home, "Applications", "Antigravity.app"))
    );
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return existsSync(join(localAppData, "Programs", "Antigravity", "Antigravity.exe"));
  }
  return false;
}

function findZCodeDesktopApp(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (sealedFixture()) return false;
  const home = homeDir(env);
  if (platform === "darwin") {
    return (
      existsSync("/Applications/ZCode.app") ||
      existsSync(join(home, "Applications", "ZCode.app"))
    );
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    return (
      existsSync(join(localAppData, "Programs", "ZCode", "ZCode.exe")) ||
      existsSync(join(programFiles, "ZCode", "ZCode.exe"))
    );
  }
  return false;
}

export function discoverCodingAgentSync(
  id: ExternalCodingAgentId,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DiscoveredCodingAgent {
  const probeEnv = env === process.env ? { ...env, PATH: augmentedPath() } : env;
  switch (id) {
    case "claude": {
      const desktop = findClaudeDesktopBinary(probeEnv, platform);
      const cli = findOnPath("claude", probeEnv);
      if (cli) {
        return { installed: true, desktopAppDetected: desktop.desktopAppDetected, source: "cli", cliPath: cli };
      }
      if (desktop.cliPath) {
        return { installed: true, desktopAppDetected: true, source: "desktop", cliPath: desktop.cliPath };
      }
      return { installed: false, desktopAppDetected: desktop.desktopAppDetected, source: "none", cliPath: null };
    }
    case "codex": {
      const desktop = findCodexDesktopBinary(probeEnv, platform);
      const cli = findOnPath("codex", probeEnv);
      if (cli) {
        return { installed: true, desktopAppDetected: desktop.desktopAppDetected, source: "cli", cliPath: cli };
      }
      if (desktop.cliPath) {
        return { installed: true, desktopAppDetected: true, source: "desktop", cliPath: desktop.cliPath };
      }
      return { installed: false, desktopAppDetected: desktop.desktopAppDetected, source: "none", cliPath: null };
    }
    case "antigravity": {
      const desktopAppDetected = findAntigravityDesktopApp(probeEnv, platform);
      const agyCli = findOnPath("agy", probeEnv);
      return {
        installed: false,
        desktopAppDetected,
        source: "none",
        cliPath: agyCli,
      };
    }
    case "deepseek": {
      const desktop = findDeepSeekDesktopBinary(probeEnv, platform);
      if (desktop.cliPath) {
        return { installed: true, desktopAppDetected: true, source: "desktop", cliPath: desktop.cliPath };
      }
      const cli = findOnPath("dsh", probeEnv);
      if (cli) {
        return { installed: true, desktopAppDetected: desktop.desktopAppDetected, source: "cli", cliPath: cli };
      }
      return { installed: false, desktopAppDetected: desktop.desktopAppDetected, source: "none", cliPath: null };
    }
    case "zcode": {
      const desktopAppDetected = findZCodeDesktopApp(probeEnv, platform);
      const bundle = findZCodeDesktopBundle(probeEnv, platform);
      if (bundle) {
        return { installed: true, desktopAppDetected: true, source: "desktop", cliPath: bundle };
      }
      const launch = resolveZCodeLaunch("zcode", [], probeEnv, platform);
      if (launch) {
        return {
          installed: true,
          desktopAppDetected: desktopAppDetected || launch.source === "desktop",
          source: launch.source,
          cliPath: launch.cliPath,
        };
      }
      return { installed: false, desktopAppDetected, source: "none", cliPath: null };
    }
  }
}

export async function discoverCodingAgent(
  id: ExternalCodingAgentId,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<DiscoveredCodingAgent> {
  if (id !== "antigravity") return discoverCodingAgentSync(id, env, platform);
  const probeEnv = env === process.env ? { ...env, PATH: augmentedPath() } : env;
  const desktopAppDetected = findAntigravityDesktopApp(probeEnv, platform);
  try {
    const runtime = await resolveAntigravityRuntime("agy", probeEnv);
    return {
      installed: true,
      desktopAppDetected,
      source: runtime.source === "managed" ? "managed" : "cli",
      cliPath: runtime.executablePath,
    };
  } catch {
    return { installed: false, desktopAppDetected, source: "none", cliPath: null };
  }
}

export function externalCodingAgentDrivers(): readonly AnyProviderDriver[] {
  return [
    ClaudeDriver,
    CodexDriver,
    AntigravityDriver,
    DeepSeekAgentDriver,
    ZCodeDriver,
  ];
}

export function buildExternalCodingAgentConfigs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): InstanceConfigMap {
  const claude = discoverCodingAgentSync("claude", env, platform);
  const codex = discoverCodingAgentSync("codex", env, platform);
  const deepseek = discoverCodingAgentSync("deepseek", env, platform);
  const zcode = discoverCodingAgentSync("zcode", env, platform);

  return {
    "coding-claude": {
      driver: "claudeAgent",
      displayName: "Claude Code",
      config: { cli: claude.cliPath ?? "claude", fullAuto: false },
    },
    "coding-codex": {
      driver: "codex",
      displayName: "Codex",
      config: { cli: codex.cliPath ?? "codex", fullAuto: false },
    },
    "coding-antigravity": {
      driver: "antigravityAgent",
      displayName: "Antigravity",
      config: { cli: "agy", fullAuto: false },
    },
    "coding-deepseek": {
      driver: "deepseekAgent",
      displayName: "DeepSeek Harness",
      config: { cli: deepseek.cliPath ?? "dsh", fullAuto: false },
    },
    "coding-zcode": {
      driver: "zcodeAgent",
      displayName: "ZCode",
      config: { cli: zcode.cliPath ?? "zcode", fullAuto: false },
    },
  };
}

export function externalCodingAgentSwitchRefusal(
  current: ModelSelection | undefined,
  next: ModelSelection,
): string | undefined {
  if (!current) return undefined;
  const fromExternal = isExternalCodingAgentInstance(current.instanceId);
  const toExternal = isExternalCodingAgentInstance(next.instanceId);
  if (!fromExternal && !toExternal) return undefined;
  if (current.instanceId !== next.instanceId) {
    return EXTERNAL_CODING_AGENT_SWITCH_REFUSAL;
  }
  return undefined;
}

export interface DoneBotCodingAgentRouteDeps {
  enabled: boolean;
  store: Pick<Store, "bots" | "bot" | "createBot" | "patchBot">;
  registry: Pick<ProviderRegistry, "get" | "cliTarget" | "refreshModels" | "installRuntime" | "forgetSnapshots">;
  providerAuthSessions: Pick<ProviderAuthSessions, "start" | "status" | "complete" | "cancel">;
  providerConfigs: () => InstanceConfigMap;
  engineLaunches: (configs: InstanceConfigMap) => Record<string, unknown>;
  reloadProviders: (before: Record<string, unknown>) => Promise<void>;
  publicBot: (bot: BotRecord) => unknown;
  broadcast: (payload: Record<string, unknown>) => void;
  configStatus: () => Record<string, unknown>;
}

async function reloadChangedCodingAgents(
  deps: DoneBotCodingAgentRouteDeps,
  targetIds?: readonly string[],
): Promise<void> {
  const configs = deps.providerConfigs();
  const launches = deps.engineLaunches(configs);
  const checkIds = targetIds ?? EXTERNAL_CODING_AGENTS.map((a) => a.instanceId);
  const before: Record<string, unknown> = { ...launches };
  let needsReload = false;
  for (const instanceId of checkIds) {
    const entry = configs[instanceId];
    if (!entry) continue;
    const wantedCli = typeof (entry.config as { cli?: unknown } | undefined)?.cli === "string"
      ? (entry.config as { cli: string }).cli
      : null;
    const current = deps.registry.cliTarget(instanceId);
    if (!deps.registry.get(instanceId) || !current || current.cli !== wantedCli) {
      before[instanceId] = { driver: entry.driver, cli: current?.cli ?? "__stale__" };
      needsReload = true;
    }
  }
  if (needsReload) {
    await deps.reloadProviders(before);
  }
}

async function buildAgentStatus(
  spec: ExternalCodingAgentSpec,
  deps: DoneBotCodingAgentRouteDeps,
): Promise<ExternalCodingAgentStatus> {
  const discovered = await discoverCodingAgent(spec.id);
  const instance: ProviderInstance | null | undefined = deps.registry.get(spec.instanceId);
  let snapshot: ProviderSnapshot | null = null;
  if (instance) {
    try {
      snapshot = await instance.snapshot();
    } catch (error) {
      snapshot = {
        state: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const available = snapshot?.state === "available";
  const installed = available || discovered.installed;
  const authenticated = available && snapshot?.authenticated !== false;
  const account = snapshot?.account?.email ?? snapshot?.account?.organization ?? null;
  const bots = deps.store.bots
    .filter((bot) => !bot.hidden && bot.modelSelection.instanceId === spec.instanceId)
    .map((bot) => ({ id: bot.id, name: bot.name, ...(bot.cwd ? { cwd: bot.cwd } : {}) }));

  const models = instance?.models ?? { default: "", options: [] };
  return {
    id: spec.id,
    instanceId: spec.instanceId,
    driverKind: spec.driverKind,
    name: spec.name,
    displayName: spec.displayName,
    vendor: spec.vendor,
    tagline: spec.tagline,
    loginGuide: spec.loginGuide,
    docsUrl: spec.docsUrl,
    installed,
    desktopAppDetected: discovered.desktopAppDetected,
    source: discovered.source !== "none" ? discovered.source : available ? "cli" : "none",
    cliPath: discovered.cliPath,
    version: snapshot?.version ?? null,
    authenticated,
    account,
    reason: available && authenticated ? null : snapshot?.reason ?? null,
    supportsInAppAuth: Boolean(spec.supportsInAppAuth && instance?.startAuthentication),
    supportsManagedInstall: Boolean(spec.supportsManagedInstall && instance?.installRuntime),
    models: {
      default: models.default,
      options: models.options.map((option) => ({ id: option.id, label: option.label })),
    },
    bots,
  };
}

function uniqueBotName(baseName: string, existing: readonly BotRecord[]): string {
  const activeNames = new Set(existing.filter((b) => !b.hidden).map((b) => b.name.trim().toLowerCase()));
  if (!activeNames.has(baseName.trim().toLowerCase())) return baseName;
  for (let i = 2; i <= 99; i += 1) {
    const candidate = `${baseName} ${i}`;
    if (!activeNames.has(candidate.toLowerCase())) return candidate;
  }
  return baseName;
}

export function createDoneBotCodingAgentRoutes(deps: DoneBotCodingAgentRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (!path.startsWith("/api/donebot/coding-agents")) return PASS;
    if (!ownerOrAdmin(auth)) {
      return json(res, 403, { error: "仅工作空间所有者可管理本机外部编程 Agent。" });
    }
    res.setHeader("Cache-Control", "no-store");
    if (!deps.enabled) {
      return json(res, 403, { error: "外部本地编程 Agent 仅支持在个人本机空间使用。" });
    }

    const authOwner = auth.kind === "session" ? auth.session.id : "local-owner";

    if (method === "GET" && path === "/api/donebot/coding-agents") {
      resetPathCache();
      if (url.searchParams.get("fresh") === "1") {
        deps.registry.forgetSnapshots();
      }
      await reloadChangedCodingAgents(deps);
      const agents = await Promise.all(EXTERNAL_CODING_AGENTS.map((spec) => buildAgentStatus(spec, deps)));
      return json(res, 200, { agents });
    }

    const createBotMatch = path.match(/^\/api\/donebot\/coding-agents\/([a-z]+)\/bot$/);
    if (method === "POST" && createBotMatch) {
      const spec = codingAgentById(createBotMatch[1]);
      if (!spec) return json(res, 404, { error: "不支持该外部编程 Agent。" });
      const raw = await readBody(req).catch(() => ({}));
      const parsed = createBotSchema.safeParse(raw ?? {});
      if (!parsed.success) {
        return json(res, 400, { error: "参数无效，请检查机器人名称或工作目录。" });
      }
      const checkedCwd = validateBotCwd(parsed.data.cwd ?? null);
      if (!checkedCwd.ok) {
        return json(res, 400, { error: checkedCwd.error });
      }

      let instance = deps.registry.get(spec.instanceId);
      if (!instance) {
        resetPathCache();
        await reloadChangedCodingAgents(deps, [spec.instanceId]);
        instance = deps.registry.get(spec.instanceId);
      }
      if (!instance) {
        return json(res, 503, { error: `${spec.displayName} 实例未就绪，请先点击重新检测。` });
      }

      const requestedModel = parsed.data.model?.trim();
      const model = requestedModel && instance.models.options.some((opt) => opt.id === requestedModel)
        ? requestedModel
        : instance.models.default || instance.models.options[0]?.id || "default";

      const name = parsed.data.name || uniqueBotName(spec.name, deps.store.bots);
      const created = deps.store.createBot({
        name,
        title: spec.defaultTitle,
        description: spec.defaultDescription,
        color: spec.defaultColor,
        modelSelection: { instanceId: spec.instanceId, model },
        ...(checkedCwd.cwd ? { cwd: checkedCwd.cwd } : {}),
      });
      const updated = deps.store.patchBot(created.id, { computer: "local" }) ?? created;
      const wired = deps.publicBot(updated);
      deps.broadcast({ kind: "bot.created", bot: wired });
      return json(res, 201, { bot: wired });
    }

    const refreshMatch = path.match(/^\/api\/donebot\/coding-agents\/([a-z]+)\/refresh$/);
    if (method === "POST" && refreshMatch) {
      const spec = codingAgentById(refreshMatch[1]);
      if (!spec) return json(res, 404, { error: "不支持该外部编程 Agent。" });
      resetPathCache();
      deps.registry.forgetSnapshots();
      await reloadChangedCodingAgents(deps, [spec.instanceId]);
      void deps.registry.refreshModels(spec.instanceId).then(() => {
        deps.broadcast({ kind: "config", ...deps.configStatus() });
      }).catch(() => {});
      deps.broadcast({ kind: "config", ...deps.configStatus() });
      const agent = await buildAgentStatus(spec, deps);
      return json(res, 200, { agent });
    }

    const installMatch = path.match(/^\/api\/donebot\/coding-agents\/([a-z]+)\/install$/);
    if (method === "POST" && installMatch) {
      const spec = codingAgentById(installMatch[1]);
      if (!spec) return json(res, 404, { error: "不支持该外部编程 Agent。" });
      if (!spec.supportsManagedInstall) {
        return json(res, 400, { error: `${spec.displayName} 需通过官方桌面端或 CLI 安装。` });
      }
      try {
        await deps.registry.installRuntime(spec.instanceId);
        deps.registry.forgetSnapshots();
        deps.broadcast({ kind: "config", ...deps.configStatus() });
        const agent = await buildAgentStatus(spec, deps);
        return json(res, 200, { agent });
      } catch (error) {
        return json(res, 502, {
          error: error instanceof Error ? error.message : `${spec.displayName} 运行时安装失败。`,
        });
      }
    }

    const authStartMatch = path.match(/^\/api\/donebot\/coding-agents\/([a-z]+)\/auth\/start$/);
    if (method === "POST" && authStartMatch) {
      const spec = codingAgentById(authStartMatch[1]);
      if (!spec) return json(res, 404, { error: "不支持该外部编程 Agent。" });
      const instance = deps.registry.get(spec.instanceId);
      if (!instance?.startAuthentication) {
        return json(res, 400, { error: `${spec.displayName} 请直接在对应官方桌面端完成登录。` });
      }
      try {
        const flow = await deps.providerAuthSessions.start(instance, authOwner);
        return json(res, 200, { auth: flow });
      } catch (error) {
        const status = typeof (error as { status?: unknown })?.status === "number"
          ? (error as { status: number }).status
          : 502;
        return json(res, status, { error: error instanceof Error ? error.message : "启动登录流程失败。" });
      }
    }

    const authStatusMatch = path.match(/^\/api\/donebot\/coding-agents\/([a-z]+)\/auth\/status$/);
    if (method === "GET" && authStatusMatch) {
      const spec = codingAgentById(authStatusMatch[1]);
      if (!spec) return json(res, 404, { error: "不支持该外部编程 Agent。" });
      const flowId = url.searchParams.get("flowId") ?? "";
      if (!flowId) return json(res, 400, { error: "缺少 flowId。" });
      const instance = deps.registry.get(spec.instanceId);
      if (instance && !instance.getAuthentication) {
        const snap = await instance.snapshot().catch(() => null);
        if (snap?.state === "available" && snap.authenticated === true) {
          deps.registry.forgetSnapshots();
          deps.broadcast({ kind: "config", ...deps.configStatus() });
          return json(res, 200, { auth: { phase: "succeeded", flowId, authorizationUrl: null, expiresAt: null } });
        }
        return json(res, 200, { auth: { phase: "waiting", flowId, authorizationUrl: null, expiresAt: null } });
      }
      try {
        const status = await deps.providerAuthSessions.status(spec.instanceId, authOwner, flowId);
        if (status.phase === "succeeded") {
          deps.registry.forgetSnapshots();
          deps.broadcast({ kind: "config", ...deps.configStatus() });
        }
        return json(res, 200, { auth: status });
      } catch (error) {
        const status = typeof (error as { status?: unknown })?.status === "number"
          ? (error as { status: number }).status
          : 400;
        return json(res, status, { error: error instanceof Error ? error.message : "查询登录状态失败。" });
      }
    }

    const authCompleteMatch = path.match(/^\/api\/donebot\/coding-agents\/([a-z]+)\/auth\/complete$/);
    if (method === "POST" && authCompleteMatch) {
      const spec = codingAgentById(authCompleteMatch[1]);
      if (!spec) return json(res, 404, { error: "不支持该外部编程 Agent。" });
      const raw = await readBody(req).catch(() => ({}));
      const parsed = z.object({
        flowId: z.string().trim().min(1).max(200),
        callbackUrl: z.string().trim().min(1).max(4096),
      }).strict().safeParse(raw);
      if (!parsed.success) {
        return json(res, 400, { error: "请粘贴完整的浏览器回调地址或授权码。" });
      }
      try {
        await deps.providerAuthSessions.complete(spec.instanceId, authOwner, parsed.data.flowId, parsed.data.callbackUrl);
        deps.registry.forgetSnapshots();
        deps.broadcast({ kind: "config", ...deps.configStatus() });
        const agent = await buildAgentStatus(spec, deps);
        return json(res, 200, { agent });
      } catch (error) {
        const status = typeof (error as { status?: unknown })?.status === "number"
          ? (error as { status: number }).status
          : 400;
        return json(res, status, { error: error instanceof Error ? error.message : "完成登录授权失败。" });
      }
    }

    return PASS;
  };
}

export function externalCodingAgentInstanceForBot(
  bot: Pick<BotRecord, "modelSelection"> | null | undefined,
): ExternalCodingAgentSpec | undefined {
  return codingAgentByInstanceId(bot?.modelSelection?.instanceId);
}
