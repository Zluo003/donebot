import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DONEBOT_CODING, subscriptionCodingId, type DoneBotCodingEngine } from "../../shared/donebot-coding.ts";
import { TurnNotStartedError, newId } from "../contracts.ts";
import type { AnyProviderDriver, ProviderAdapter, ProviderInstance, RuntimeEventListener, SendTurnInput, TextGenerationOptions } from "../contracts.ts";
import { CodexDriver } from "../drivers/codex.ts";
import { ClaudeDriver } from "../drivers/claude.ts";
import { findCliCandidates } from "../env-path.ts";
import { installNpmEngine, npmPackageOf } from "../engine-install.ts";
import { pinnedNpmVersion } from "../engine-versions.ts";
import type { DoneBotGateway, DoneBotScope } from "./gateway.ts";
import { codingModels } from "./coding-models.ts";
import { startCodingProxy } from "./coding-proxy.ts";

const scopeKey = (scope: DoneBotScope | null) => scope ? `${scope.accountId}:${scope.installationId}` : "signed-out";

function codingStartup(adapter: () => ProviderAdapter, prepare: (turn: SendTurnInput) => Promise<ProviderAdapter>): ProviderAdapter {
  const pending = new Map<string, AbortController>();
  return new Proxy(adapter(), {
    get(_target, property) {
      if (property === "sendTurn") return async (turn: SendTurnInput) => {
        const admission = new AbortController();
        pending.get(turn.threadId)?.abort(); pending.set(turn.threadId, admission);
        const stopped = new Promise<never>((_resolve, reject) => {
          admission.signal.addEventListener("abort", () => reject(new TurnNotStartedError(newId(), "Coding startup was stopped.")), { once: true });
        });
        try {
          const ready = await Promise.race([prepare(turn), stopped]);
          admission.signal.throwIfAborted();
          return await ready.sendTurn({ ...turn, mcpFromUserConfig: false, userSkillsDir: undefined });
        } finally { if (pending.get(turn.threadId) === admission) pending.delete(turn.threadId); }
      };
      if (property === "interruptTurn") return async (threadId: string, turnId?: string) => {
        pending.get(threadId)?.abort(); pending.delete(threadId);
        await adapter().interruptTurn(threadId, turnId);
      };
      if (property === "stopAll") return async () => { for (const admission of pending.values()) admission.abort(); pending.clear(); await adapter().stopAll(); };
      const value = Reflect.get(adapter(), property);
      return typeof value === "function" ? value.bind(adapter()) : value;
    },
  });
}

export function createCodingDrivers(gateway: DoneBotGateway, dataDir: string, native: Record<DoneBotCodingEngine, AnyProviderDriver> = { codex: CodexDriver, claude: ClaudeDriver }) {
  const instances = new Map<DoneBotCodingEngine, ProviderInstance>();
  const subscriptions = new Map<DoneBotCodingEngine, ProviderInstance>();
  const installing = new Map<DoneBotCodingEngine, Promise<void>>();
  const install = (engine: DoneBotCodingEngine) => {
    if (!gateway.authenticated()) return Promise.reject(new Error("Sign in to DoneBot first."));
    const pending = installing.get(engine);
    if (pending) return pending;
    const driver = native[engine], pkg = npmPackageOf(driver.install);
    if (!pkg) return Promise.reject(new Error("This coding executor cannot be installed here."));
    const result = installNpmEngine(pkg, { baseDir: dataDir, cli: engine, version: pinnedNpmVersion(driver.driverKind) })
      .finally(() => installing.delete(engine));
    installing.set(engine, result);
    return result;
  };
  const drivers = (Object.keys(DONEBOT_CODING) as DoneBotCodingEngine[]).map(engine => {
    const driver = native[engine];
    return {
      ...driver, metadata: { ...driver.metadata, displayName: DONEBOT_CODING[engine].name, access: "api" as const },
      install: driver.install ? { ...driver.install, signInCommand: undefined } : undefined,
      defaultConfig: () => ({ cli: engine }),
      decodeConfig(raw: unknown) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length) throw new Error("DoneBot manages coding executor configuration.");
        return {};
      },
      async create(input): Promise<ProviderInstance> {
        if (input.instanceId === subscriptionCodingId(engine)) {
          const home = join(dataDir, "providers", "donebot-subscription", engine);
          mkdirSync(home, { recursive: true, mode: 0o700 });
          const config = engine === "codex" ? { authMode: "chatgpt-plan" } : { configDir: home };
          const environment: Record<string, string> = engine === "codex" ? { CODEX_HOME: home }
            : { CLAUDE_CONFIG_DIR: home, ANTHROPIC_BASE_URL: "https://api.anthropic.com", DONEBOT_CLAUDE_INHERIT_USER_CONFIG: "0" };
          const instance = await driver.create({ ...input, config: driver.decodeConfig(config), environment });
          const subscribed: ProviderInstance = { ...instance, displayName: `${engine === "codex" ? "Codex" : "Claude Code"} · Subscription`,
            get models() { return instance.models; }, get modelsUnconfirmed() { return instance.modelsUnconfirmed; }, installRuntime: () => install(engine),
            adapter: codingStartup(() => instance.adapter, async turn => {
              if (turn.guestConfined) throw new Error("Coding executors require an owner-authorized project folder.");
              if (!findCliCandidates(engine).length) await install(engine);
              return instance.adapter;
            }),
            async dispose() {
              await subscribed.adapter.stopAll();
              try { await instance.dispose(); } finally { if (subscriptions.get(engine) === subscribed) subscriptions.delete(engine); }
            } };
          subscriptions.set(engine, subscribed);
          return subscribed;
        }
        const listeners = new Set<RuntimeEventListener>();
        let disposed = false;
        const build = async () => {
          const scope = gateway.scope(), key = scopeKey(scope);
          const bridge = await startCodingProxy(gateway, engine, scope);
          const home = join(dataDir, "providers", "donebot-coding", createHash("sha256").update(key).digest("hex"), engine);
          mkdirSync(home, { recursive: true, mode: 0o700 });
          const modelIds = codingModels(engine, gateway.models()).options.map(model => model.id);
          if (!modelIds.length) modelIds.push("donebot-unavailable");
          try {
            const config = engine === "codex" ? { endpoint: { url: `${bridge.url}/v1`, models: modelIds } }
              : { managed: true, managedModels: modelIds, requireApiKey: true, configDir: home };
            const environment: Record<string, string> = engine === "codex" ? { CODEX_HOME: home, OPENMAUSBOT_CODEX_API_KEY: bridge.token }
              : { CLAUDE_CONFIG_DIR: home, ANTHROPIC_BASE_URL: bridge.url, ANTHROPIC_API_KEY: bridge.token, ANTHROPIC_AUTH_TOKEN: bridge.token,
                DONEBOT_CLAUDE_INHERIT_USER_CONFIG: "0", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
            const instance = await driver.create({ ...input, config: driver.decodeConfig(config), environment });
            const unsubscribe = instance.adapter.onEvent(event => { for (const listener of listeners) listener(event); });
            return { key, bridge, instance, unsubscribe, modelIds, invalidated: false };
          } catch (error) { await bridge.close(); throw error; }
        };
        let current = await build();
        let changing: Promise<void> | undefined;
        let stopping = Promise.resolve();
        const unsubscribeAccount = gateway.onChange(() => {
          if (current.key !== scopeKey(gateway.scope()) || !gateway.authenticated()) {
            current.invalidated = true; current.bridge.revoke();
            stopping = Promise.all([stopping, adapter.stopAll()]).then(() => {});
            void stopping.catch(() => {});
          }
        });
        const ensure = async () => {
          if (disposed) throw new Error("Coding executor is closed.");
          if (!gateway.authenticated()) throw new Error("Sign in to DoneBot to use coding executors.");
          if (current.invalidated || current.key !== scopeKey(gateway.scope())) {
            changing ??= (async () => {
              await stopping;
              const previous = current;
              previous.unsubscribe();
              await previous.instance.dispose();
              await previous.bridge.close();
              current = await build();
            })().finally(() => { changing = undefined; });
            await changing;
          }
          if (disposed || current.key !== scopeKey(gateway.scope())) throw new Error("DoneBot account changed. Send again with the current account.");
          current.modelIds.splice(0, current.modelIds.length, ...codingModels(engine, gateway.models()).options.map(model => model.id));
          return current.instance;
        };
        const validate = (model?: string) => {
          if (!model || !codingModels(engine, gateway.models()).options.some(option => option.id === model)) throw new Error("Choose an available DoneBot coding model.");
        };
        const prepare = async (turn: SendTurnInput) => {
          validate(turn.model);
          const instance = await ensure();
          if (turn.guestConfined) throw new Error("Coding executors require an owner-authorized project folder.");
          if (!findCliCandidates(engine).length) await install(engine);
          if (disposed || current.instance !== instance || current.key !== scopeKey(gateway.scope())) throw new Error("DoneBot account changed before coding started.");
          return instance.adapter;
        };
        const routedAdapter = new Proxy(current.instance.adapter, {
          get(_target, property) {
            if (property === "onEvent") return (listener: RuntimeEventListener) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
            const value = Reflect.get(current.instance.adapter, property);
            return typeof value === "function" ? value.bind(current.instance.adapter) : value;
          },
        }) as ProviderAdapter;
        const adapter = codingStartup(() => routedAdapter, prepare);
        const background = async (kind: "generateText" | "generateMemoryText" | "reviewPermission", text: string, options?: TextGenerationOptions | AbortSignal) => {
          const instance = await ensure();
          const call = instance[kind];
          if (!call) throw new Error("This executor does not support background text.");
          if (kind === "reviewPermission") return instance.reviewPermission!(text, options as AbortSignal | undefined);
          const settings = options as TextGenerationOptions | undefined;
          const model = settings?.model ?? codingModels(engine, gateway.models()).default;
          validate(model);
          return (kind === "generateText" ? instance.generateText! : instance.generateMemoryText!)(text, { ...settings, model });
        };
        const managed: ProviderInstance = {
          instanceId: input.instanceId, driverKind: driver.driverKind, displayName: DONEBOT_CODING[engine].name, enabled: true,
          get models() { return codingModels(engine, gateway.models()); },
          refreshModels: async () => {}, installRuntime: () => install(engine), adapter,
          async snapshot() {
            if (!gateway.authenticated()) return { state: "unavailable", authenticated: false, reason: "Sign in to DoneBot to use coding executors." };
            const instance = await ensure();
            return { ...await instance.snapshot(), authenticated: true, billing: "metered" };
          },
          ...(current.instance.generateText ? { generateText: (text: string, options?: TextGenerationOptions) => background("generateText", text, options) } : {}),
          ...(current.instance.generateMemoryText ? { generateMemoryText: (text: string, options?: TextGenerationOptions) => background("generateMemoryText", text, options) } : {}),
          ...(current.instance.reviewPermission ? { reviewPermission: (text: string, signal?: AbortSignal) => background("reviewPermission", text, signal) } : {}),
          async dispose() {
            disposed = true; unsubscribeAccount(); current.bridge.revoke();
            await adapter.stopAll();
            await changing?.catch(() => {});
            current.unsubscribe();
            try { await current.instance.dispose(); } finally { await current.bridge.close(); }
            if (instances.get(engine) === managed) instances.delete(engine);
          },
        };
        instances.set(engine, managed);
        return managed;
      },
    } satisfies AnyProviderDriver;
  });
  return { drivers, install, instances, subscriptions, installing };
}
