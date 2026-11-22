// 智谱 ZCode 本地编程 Agent 驱动：支持 ZCode 桌面端内置 zcode.cjs 与独立 zcode CLI，
// 通过 `--prompt` + `--output-format stream-json` 实现实时流式输出与 `--resume` 多轮续聊。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import type { ChildProcess } from "node:child_process";

import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { assertToolScopeSupported } from "../../shared/tool-scope-support.ts";
import { stripWorkspaceCredentialEnv } from "../config.ts";
import {
  newEventId,
  newId,
  type DriverCreateInput,
  type ModelCatalog,
  type ProviderDriver,
  type ProviderInstance,
  type ProviderSnapshot,
  type RuntimeEvent,
  type RuntimeEventListener,
  type SendTurnInput,
  type TurnId,
} from "../contracts.ts";
import { augmentedPath, sealedFixture } from "../env-path.ts";
import { describeSpawnFailure, execCli, killCliTree, resolveCli, spawnCli } from "../procs.ts";
import { toolDetailPreview } from "../tool-summary.ts";

const DRIVER_KIND = "zcodeAgent";

export interface ZCodeConfig {
  cli: string;
  fullAuto: boolean;
}

export const STATIC_ZCODE_MODELS: ModelCatalog = {
  default: "default",
  options: [
    { id: "default", label: "ZCode 当前默认模型" },
    { id: "GLM-5.3", label: "GLM-5.3" },
    { id: "GLM-5.3-Flash", label: "GLM-5.3-Flash" },
    { id: "GLM-5.2", label: "GLM-5.2" },
    { id: "GLM-5.1", label: "GLM-5.1" },
    { id: "GLM-5", label: "GLM-5" },
    { id: "GLM-5-Turbo", label: "GLM-5-Turbo" },
    { id: "GLM-4.7", label: "GLM-4.7" },
    { id: "GLM-4.6", label: "GLM-4.6" },
  ],
};

function decodeConfig(raw: unknown): ZCodeConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof o.cli === "string" && o.cli.trim() ? o.cli.trim() : "zcode",
    fullAuto: o.fullAuto === true,
  };
}

export function zcodeDesktopBundlePaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (sealedFixture()) return [];
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === "darwin") {
    return [
      "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
      join(home, "Applications", "ZCode.app", "Contents", "Resources", "glm", "zcode.cjs"),
    ];
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    return [
      join(localAppData, "Programs", "ZCode", "resources", "glm", "zcode.cjs"),
      join(programFiles, "ZCode", "resources", "glm", "zcode.cjs"),
    ];
  }
  return [];
}

export function findZCodeDesktopBundle(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  for (const candidate of zcodeDesktopBundlePaths(env, platform)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface ZCodeResolvedLaunch {
  command: string;
  args: string[];
  extraEnv?: Record<string, string>;
  source: "desktop" | "cli";
  cliPath: string;
}

function isScriptPath(target: string): boolean {
  const ext = extname(target).toLowerCase();
  return ext === ".cjs" || ext === ".js" || ext === ".mjs";
}

export function resolveZCodeLaunch(
  cli: string,
  extraArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ZCodeResolvedLaunch | null {
  const trimmed = cli.trim() || "zcode";
  if (isScriptPath(trimmed)) {
    if (!existsSync(trimmed)) return null;
    return {
      command: process.execPath,
      args: [trimmed, ...extraArgs],
      extraEnv: { ELECTRON_RUN_AS_NODE: "1" },
      source: trimmed.includes("ZCode.app") || trimmed.includes("\\ZCode\\") ? "desktop" : "cli",
      cliPath: trimmed,
    };
  }
  if (trimmed !== "zcode") {
    const resolved = resolveCli(trimmed, extraArgs, env);
    if (resolved.command === trimmed && !existsSync(trimmed)) return null;
    return { command: resolved.command, args: resolved.args, source: "cli", cliPath: resolved.command };
  }
  const onPath = resolveCli("zcode", extraArgs, env);
  if (onPath.command !== "zcode" && existsSync(onPath.command)) {
    return { command: onPath.command, args: onPath.args, source: "cli", cliPath: onPath.command };
  }
  const bundle = findZCodeDesktopBundle(env, platform);
  if (bundle) {
    return {
      command: process.execPath,
      args: [bundle, ...extraArgs],
      extraEnv: { ELECTRON_RUN_AS_NODE: "1" },
      source: "desktop",
      cliPath: bundle,
    };
  }
  return null;
}

export function zcodeHome(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.ZCODE_HOME?.trim() || env.HOME || env.USERPROFILE || homedir();
  return join(base, ".zcode", "v2");
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function zcodeAuthState(env: NodeJS.ProcessEnv = process.env): {
  authenticated: boolean;
  account?: { email?: string; method?: "login" | "api-key" };
} {
  if (nonEmptyString(env.ZAI_API_KEY) || nonEmptyString(env.BIGMODEL_API_KEY) || nonEmptyString(env.ZHIPU_API_KEY)) {
    return { authenticated: true, account: { method: "api-key" } };
  }
  const credFile = join(zcodeHome(env), "credentials.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(credFile, "utf8"));
  } catch {
    return { authenticated: false };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { authenticated: false };
  const record = raw as Record<string, unknown>;
  const hasLogin =
    nonEmptyString(record["oauth:bigmodel:access_token"]) ||
    nonEmptyString(record["oauth:zai:access_token"]) ||
    nonEmptyString(record.zcodejwttoken) ||
    Object.entries(record).some(([k, v]) => k.startsWith("account-provider:") && nonEmptyString(v));
  if (!hasLogin) return { authenticated: false };

  let email: string | undefined;
  for (const infoKey of ["oauth:bigmodel:user_info", "oauth:zai:user_info"]) {
    const infoRaw = record[infoKey];
    if (typeof infoRaw !== "string" || !infoRaw.trim()) continue;
    try {
      const info = JSON.parse(infoRaw) as Record<string, unknown>;
      const candidate =
        (typeof info.email === "string" && info.email.trim()) ||
        (typeof info.nickname === "string" && info.nickname.trim()) ||
        (typeof info.name === "string" && info.name.trim()) ||
        (typeof info.phone === "string" && info.phone.trim());
      if (candidate) {
        email = candidate;
        break;
      }
    } catch { /* ignore unparseable user_info */ }
  }
  return { authenticated: true, account: { ...(email ? { email } : {}), method: "login" } };
}

export function zcodePermissionMode(fullAuto: boolean, approvalMode?: ApprovalMode): "yolo" | "edit" | "guarded" {
  if (fullAuto || approvalMode === "full") return "yolo";
  if (approvalMode === "edits") return "edit";
  return "guarded";
}

function zcodeEnvironment(instanceEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...instanceEnv,
    PATH: augmentedPath(),
  };
  stripWorkspaceCredentialEnv(env);
  return env;
}

function buildPromptText(input: SendTurnInput): string {
  const resuming = !input.sessionReset && typeof input.resumeCursor === "string" && input.resumeCursor.trim().length > 0;
  const parts: string[] = [];
  if (!resuming && input.system?.trim()) {
    parts.push(input.system.trim());
  }
  if (input.recalled?.trim()) {
    parts.push(input.recalled.trim());
  }
  parts.push(input.text);
  return parts.join("\n\n");
}

function extractToolName(payload: Record<string, unknown>): string {
  for (const key of ["toolName", "name", "tool"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "tool";
}

function extractToolId(payload: Record<string, unknown>): string {
  for (const key of ["toolCallId", "callId", "id"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return newId();
}

function extractToolDetail(payload: Record<string, unknown>): string | undefined {
  for (const key of ["displayCommand", "command", "summary", "path", "filePath"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
  }
  if (payload.input !== undefined) return toolDetailPreview(payload.input);
  if (payload.args !== undefined) return toolDetailPreview(payload.args);
  return undefined;
}

function parseUsage(raw: unknown): { input: number; output: number; cachedInput?: number } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const input = Number(u.inputTokens ?? u.promptTokens ?? u.input ?? 0);
  const output = Number(u.outputTokens ?? u.completionTokens ?? u.output ?? 0);
  const cached = Number(u.cacheReadInputTokens ?? u.cachedInputTokens ?? u.cachedInput ?? 0);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return undefined;
  return {
    input: Number.isFinite(input) ? Math.max(0, Math.round(input)) : 0,
    output: Number.isFinite(output) ? Math.max(0, Math.round(output)) : 0,
    ...(Number.isFinite(cached) && cached > 0 ? { cachedInput: Math.round(cached) } : {}),
  };
}

export const ZCodeDriver: ProviderDriver<ZCodeConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "ZCode",
    access: "subscription",
    cliVersion: /\bzcode\b|\b\d+\.\d+\.\d+\b/i,
  },
  install: {
    docsUrl: "https://zcode.bigmodel.cn",
  },
  decodeConfig,
  defaultConfig: () => ({ cli: "zcode", fullAuto: false }),
  models: STATIC_ZCODE_MODELS,

  async create(input: DriverCreateInput<ZCodeConfig>): Promise<ProviderInstance> {
    const listeners = new Set<RuntimeEventListener>();
    const activeChildren = new Map<string, { child: ChildProcess; turnId: TurnId; aborted: boolean }>();
    const knownSessions = new Map<string, string>();
    let disposed = false;

    const emit = (event: RuntimeEvent) => {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          console.error("[zcode] listener error:", error);
        }
      }
    };

    const baseEvent = (threadId: string, turnId?: TurnId) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      providerInstanceId: input.instanceId,
      threadId,
      createdAt: new Date().toISOString(),
      ...(turnId ? { turnId } : {}),
    });

    const probeVersion = async (env: NodeJS.ProcessEnv): Promise<{ launch: ZCodeResolvedLaunch | null; version: string | null; reason?: string }> => {
      const launch = resolveZCodeLaunch(input.config.cli, ["--version"], env);
      if (!launch) {
        return { launch: null, version: null, reason: "未检测到 ZCode 桌面端或 zcode CLI。" };
      }
      return await new Promise((resolve) => {
        execCli(
          launch.command,
          launch.args,
          { env: { ...env, ...launch.extraEnv }, timeout: 8_000 },
          (error, stdout, stderr) => {
            if (error) {
              resolve({
                launch,
                version: null,
                reason: describeSpawnFailure(error as NodeJS.ErrnoException, launch.cliPath).message,
              });
              return;
            }
            const text = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
            const ver = text.match(/(\d+\.\d+\.\d+(?:[-+.\w]+)?)/)?.[1] ?? null;
            resolve({ launch, version: ver });
          },
        );
      });
    };

    const adapter: ProviderInstance["adapter"] = {
      provider: DRIVER_KIND,
      capabilities: {
        sessionModelSwitch: "unsupported",
        images: true,
        nativeImageInput: true,
      },
      hasSession(threadId: string): boolean {
        return activeChildren.has(threadId) || knownSessions.has(threadId);
      },
      enginePid(threadId: string): number | undefined {
        return activeChildren.get(threadId)?.child.pid;
      },
      onEvent(listener: RuntimeEventListener): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async respondToRequest() {
        return "unavailable";
      },
      async interruptTurn(threadId: string): Promise<void> {
        const active = activeChildren.get(threadId);
        if (!active) return;
        active.aborted = true;
        await killCliTree(active.child);
      },
      async stopAll(): Promise<void> {
        const running = [...activeChildren.values()];
        activeChildren.clear();
        for (const item of running) {
          item.aborted = true;
          await killCliTree(item.child).catch(() => {});
        }
      },
      async sendTurn(turn: SendTurnInput) {
        if (disposed) throw new Error("ZCode 实例已关闭。");
        assertToolScopeSupported(DRIVER_KIND, turn.toolScope);

        const env = zcodeEnvironment(input.environment);
        const prompt = buildPromptText(turn);
        const mode = zcodePermissionMode(input.config.fullAuto, turn.approvalMode);
        const resumeId = !turn.sessionReset && typeof turn.resumeCursor === "string" && turn.resumeCursor.trim()
          ? turn.resumeCursor.trim()
          : undefined;
        const cwd = turn.cwd?.trim() || process.cwd();

        const cliArgs: string[] = [
          "-p", prompt,
          "--cwd", cwd,
          "--mode", mode,
          "--output-format", "stream-json",
          "--no-color",
        ];
        if (resumeId) {
          cliArgs.push("--resume", resumeId);
        }
        if (Array.isArray(turn.images)) {
          for (const image of turn.images) {
            if (image?.path) cliArgs.push("--attach", image.path);
          }
        }

        const launch = resolveZCodeLaunch(input.config.cli, cliArgs, env);
        if (!launch) {
          throw new Error("未检测到 ZCode 桌面端或 zcode CLI，请先安装 ZCode。");
        }

        const turnId = newId();
        const prev = activeChildren.get(turn.threadId);
        if (prev) {
          prev.aborted = true;
          await killCliTree(prev.child).catch(() => {});
          activeChildren.delete(turn.threadId);
        }

        const child = spawnCli(launch.command, launch.args, {
          cwd,
          env: { ...env, ...launch.extraEnv },
          stdio: ["ignore", "pipe", "pipe"],
        });

        const state = { child, turnId, aborted: false };
        activeChildren.set(turn.threadId, state);

        void (async () => {
          let sessionEmitted = false;
          let sessionId: string | null = resumeId ?? null;
          let streamedText = "";
          let finalResponseText = "";
          let lastError = "";
          let usage: { input: number; output: number; cachedInput?: number } | undefined;
          let stderrBuf = "";
          let stdoutBuf = "";
          const openTools = new Set<string>();

          const ensureSessionStarted = (sid: string | null) => {
            if (sid) {
              sessionId = sid;
              knownSessions.set(turn.threadId, sid);
            }
            if (sessionEmitted) return;
            sessionEmitted = true;
            emit({
              ...baseEvent(turn.threadId, turnId),
              type: "session.started",
              sessionId: sessionId,
              model: turn.model ?? STATIC_ZCODE_MODELS.default,
            });
          };

          emit({ ...baseEvent(turn.threadId, turnId), type: "turn.started" });

          const handleFrame = (rawLine: string) => {
            const trimmed = rawLine.trim();
            if (!trimmed) return;
            let frame: Record<string, unknown>;
            try {
              const parsed = JSON.parse(trimmed);
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
              frame = parsed as Record<string, unknown>;
            } catch {
              return;
            }

            if (typeof frame.sessionId === "string" && frame.sessionId.trim()) {
              ensureSessionStarted(frame.sessionId.trim());
            }

            const type = typeof frame.type === "string" ? frame.type : "";
            const payload = frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload)
              ? frame.payload as Record<string, unknown>
              : {};

            if (type === "result") {
              ensureSessionStarted(typeof frame.sessionId === "string" ? frame.sessionId : sessionId);
              if (typeof frame.response === "string" && frame.response.trim()) {
                finalResponseText = frame.response;
              }
              const parsedUsage = parseUsage(frame.usage);
              if (parsedUsage) usage = parsedUsage;
              return;
            }

            if (type === "model.streaming") {
              const kind = typeof payload.kind === "string" ? payload.kind : "";
              const delta = typeof payload.delta === "string" ? payload.delta : "";
              if (!delta) return;
              if (kind === "text_delta") {
                streamedText += delta;
                emit({
                  ...baseEvent(turn.threadId, turnId),
                  type: "content.delta",
                  streamKind: "assistant_text",
                  delta,
                });
              } else if (kind === "reasoning_delta") {
                emit({
                  ...baseEvent(turn.threadId, turnId),
                  type: "content.delta",
                  streamKind: "reasoning_text",
                  delta,
                });
              }
              return;
            }

            if (type === "tool.updated") {
              const kind = typeof payload.kind === "string" ? payload.kind : "";
              const callId = extractToolId(payload);
              const name = extractToolName(payload);
              if (kind === "started" || kind === "scheduled") {
                if (!openTools.has(callId)) {
                  openTools.add(callId);
                  emit({
                    ...baseEvent(turn.threadId, turnId),
                    itemId: callId,
                    type: "item.started",
                    itemType: "tool",
                    title: name,
                    summary: extractToolDetail(payload),
                  });
                }
              } else if (kind === "result" || kind === "error") {
                if (!openTools.has(callId)) {
                  emit({
                    ...baseEvent(turn.threadId, turnId),
                    itemId: callId,
                    type: "item.started",
                    itemType: "tool",
                    title: name,
                    summary: extractToolDetail(payload),
                  });
                }
                openTools.delete(callId);
                const outputText = typeof payload.output === "string"
                  ? payload.output.slice(0, 2_000)
                  : typeof payload.error === "string"
                    ? payload.error.slice(0, 2_000)
                    : undefined;
                emit({
                  ...baseEvent(turn.threadId, turnId),
                  itemId: callId,
                  type: "item.completed",
                  itemType: "tool",
                  ok: kind === "result",
                  ...(outputText ? { output: outputText } : {}),
                });
              }
              return;
            }

            if (type === "turn.completed") {
              if (typeof payload.response === "string" && payload.response.trim()) {
                finalResponseText = payload.response;
              }
              const parsedUsage = parseUsage(payload.usage);
              if (parsedUsage) usage = parsedUsage;
              return;
            }

            if (type === "turn.failed") {
              const err =
                (typeof payload.message === "string" && payload.message.trim()) ||
                (typeof payload.error === "string" && payload.error.trim()) ||
                "ZCode 执行失败。";
              lastError = err;
            }
          };

          child.stdout?.on("data", (chunk: Buffer | string) => {
            stdoutBuf += String(chunk);
            let nl: number;
            while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
              const line = stdoutBuf.slice(0, nl);
              stdoutBuf = stdoutBuf.slice(nl + 1);
              handleFrame(line);
            }
          });

          child.stderr?.on("data", (chunk: Buffer | string) => {
            if (stderrBuf.length < 16_384) stderrBuf += String(chunk);
          });

          const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
            child.once("error", (error) => resolve({ code: null, signal: null, error }));
            child.once("close", (code, signal) => resolve({ code, signal }));
          });

          if (stdoutBuf.trim()) handleFrame(stdoutBuf);
          if (activeChildren.get(turn.threadId) === state) {
            activeChildren.delete(turn.threadId);
          }

          ensureSessionStarted(sessionId);

          if (state.aborted) {
            emit({
              ...baseEvent(turn.threadId, turnId),
              type: "turn.completed",
              ok: false,
              stopReason: "cancelled",
            });
            return;
          }

          if (outcome.error) {
            emit({
              ...baseEvent(turn.threadId, turnId),
              type: "item.completed",
              itemType: "assistant_text",
              text: describeSpawnFailure(outcome.error as NodeJS.ErrnoException, launch.cliPath, cwd).message,
              synthetic: true,
            });
            emit({
              ...baseEvent(turn.threadId, turnId),
              type: "turn.completed",
              ok: false,
              stopReason: "error",
            });
            return;
          }

          const finalText = (streamedText || finalResponseText).trim();
          const failed = outcome.code !== 0 || Boolean(lastError);
          if (failed && !finalText) {
            const errMsg = lastError || stderrBuf.trim() || `ZCode 进程异常退出（${outcome.signal ?? outcome.code ?? "unknown"}）。`;
            emit({
              ...baseEvent(turn.threadId, turnId),
              type: "item.completed",
              itemType: "assistant_text",
              text: errMsg.slice(0, 4_000),
              synthetic: true,
            });
            emit({
              ...baseEvent(turn.threadId, turnId),
              type: "turn.completed",
              ok: false,
              stopReason: "error",
            });
            return;
          }

          if (finalText) {
            if (!streamedText) {
              emit({
                ...baseEvent(turn.threadId, turnId),
                type: "content.delta",
                streamKind: "assistant_text",
                delta: finalText,
              });
            }
            emit({
              ...baseEvent(turn.threadId, turnId),
              type: "item.completed",
              itemType: "assistant_text",
              text: finalText,
            });
          }

          emit({
            ...baseEvent(turn.threadId, turnId),
            type: "turn.completed",
            ok: !failed,
            stopReason: failed ? "error" : "end_turn",
            ...(usage ? { usage } : {}),
          });
        })();

        return { turnId };
      },
    };

    return {
      instanceId: input.instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName ?? "ZCode",
      enabled: input.enabled,
      models: STATIC_ZCODE_MODELS,
      adapter,
      async snapshot(): Promise<ProviderSnapshot> {
        const env = zcodeEnvironment(input.environment);
        const probed = await probeVersion(env);
        if (!probed.launch) {
          return {
            state: "unavailable",
            reason: probed.reason ?? "未检测到 ZCode 桌面端或 zcode CLI。",
          };
        }
        const auth = zcodeAuthState(env);
        return {
          state: "available",
          version: probed.version,
          authenticated: auth.authenticated,
          ...(auth.account ? { account: auth.account } : {}),
          ...(!auth.authenticated ? { reason: "请先在 ZCode 桌面端登录智谱 / Z.AI 账号。" } : {}),
        };
      },
      async dispose() {
        disposed = true;
        await adapter.stopAll();
        listeners.clear();
      },
    };
  },
};
