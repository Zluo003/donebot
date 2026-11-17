import { DONEBOT_CODING, subscriptionCodingId, existingCodingId, EXISTING_CODING_MODEL, isDoneBotCodingInstance } from "../../shared/donebot-coding.ts";
import { createCodingDrivers } from "./coding-drivers.ts";
import { codingModels } from "./coding-models.ts";
import { join } from "node:path";
import type { AppConfig } from "../config.ts";
import type { InstanceConfigMap, ModelSelection, ProviderInstance } from "../contracts.ts";
import type { Store } from "../store.ts";
import { doneBotProtocol, doneBotTextModels } from "./catalog.ts";
import { DoneBotGateway } from "./gateway.ts";
import { createDoneBotCredentialStore, type DoneBotPrivatePort } from "./credential-store.ts";
import { cloudCredentialStore } from "./cloud-credential.ts";
import { DoneBotInstallationIdentity } from "./installation-identity.ts";
import { createDoneBotLlmDriver } from "./llm-driver.ts";
import { createDoneBotHelpers } from "./helpers.ts";
import { createDoneBotAccountRoutes } from "./routes.ts";
import { bindDoneBotVoice } from "../tts/index.ts";
import { createDoneBotVoice } from "./tts.ts";
import { publicArtifactResponse } from "./media-download.ts";
import { DoneBotMediaPreferencesStore, createDoneBotMediaSettingsRoute } from "./media-preferences.ts";

export function createDoneBotRuntimeHost(dataDir: string, config: () => AppConfig, sourceUrl: string) {
  const fixture = sourceUrl.endsWith(".ts") && process.env.NODE_ENV === "test";
  const enabled = !(fixture && process.env.DONEBOT_UPSTREAM_FIXTURE === "1");
  const fixtureOrigin = fixture ? process.env.DONEBOT_FIXTURE_ORIGIN : undefined;
  const identity = new DoneBotInstallationIdentity(join(dataDir, "donebot", "installation-identities.json"));
  const cloudCredential = process.env.DONEBOT_CLOUD_CREDENTIAL_FILE;
  if (cloudCredential && cloudCredential !== "/run/donebot/gateway.json" && !fixture) throw new Error("Invalid Cloud installation credential path.");
  const gateway = new DoneBotGateway(cloudCredential ? cloudCredentialStore(cloudCredential) : createDoneBotCredentialStore((process as NodeJS.Process & { parentPort?: DoneBotPrivatePort }).parentPort, join(dataDir, "donebot", "session-id")), {
    resolveInstallation: (accountId, previous) => identity.resolve(accountId, previous),
    ...(fixtureOrigin ? { testOrigin: fixtureOrigin } : {}),
  });
  const model = (id: string) => gateway.models()?.models.find(model => model.id === id);
  const mediaPreferences = new DoneBotMediaPreferencesStore(join(dataDir, "donebot", "media-preferences.json"));
  gateway.bindMediaPreferences(() => mediaPreferences.get(gateway.scope()?.accountId));
  const driver = createDoneBotLlmDriver({
    imageCacheDir: join(dataDir, "donebot", "model-images"),
    request: (path, init) => gateway.request(path, init),
    models: () => doneBotTextModels(gateway.models()), catalog: () => gateway.models(),
    mediaPreferences: () => gateway.mediaPreferences(),
    protocol: id => doneBotProtocol(id, gateway.models()), authenticated: () => gateway.authenticated(),
    toolUse: id => model(id)?.capabilities?.tool_calling === true,
  });
  const coding = createCodingDrivers(gateway, dataDir);
  const allows = (selection: ModelSelection) => {
    if (selection.instanceId === "donebot") return doneBotTextModels(gateway.models()).options.some(model => model.id === selection.model);
    for (const [engine, entry] of Object.entries(DONEBOT_CODING)) {
      const kind = engine as keyof typeof DONEBOT_CODING;
      if (selection.instanceId === entry.instanceId) return codingModels(kind, gateway.codingCatalog(kind)).options.some(model => model.id === selection.model);
      if (selection.instanceId === existingCodingId(kind)) return selection.model === EXISTING_CODING_MODEL;
      if (selection.instanceId === subscriptionCodingId(kind)) {
        const catalog = coding.subscriptions.get(kind)?.models;
        return catalog?.options.length ? catalog.options.some(model => model.id === selection.model)
          : (kind === "codex" ? /^(?:gpt-|o[134](?:-|$))/ : /^claude-/).test(selection.model);
      }
    }
    return false;
  };
  const select = (previous?: ModelSelection): ModelSelection => previous && allows(previous) ? { ...previous } : { instanceId: "donebot", model: doneBotTextModels(gateway.models()).default };
  const policy = {
    allows, select, error: () => gateway.authenticated() ? "Choose an available DoneBot model." : "Sign in to DoneBot to use models.",
    configs: (): InstanceConfigMap => ({ donebot: { driver: "donebot", displayName: "DoneBot", config: {} },
      ...Object.fromEntries(Object.entries(DONEBOT_CODING).flatMap(([engine, entry]) => [
        [entry.instanceId, { driver: entry.driver, displayName: entry.name, access: "api", config: {} }],
        [existingCodingId(engine as keyof typeof DONEBOT_CODING), { driver: entry.driver, displayName: `${engine === "codex" ? "Codex" : "Claude Code"} · 维持现有 CLI 配置`, access: "api", config: {} }],
        [subscriptionCodingId(engine as keyof typeof DONEBOT_CODING), { driver: entry.driver, displayName: `${engine === "codex" ? "Codex" : "Claude Code"} · Subscription`, access: "subscription", config: {} }],
      ])),
    }),
    decorate: (instance: ProviderInstance) => instance,
    resetTask: (previous: ModelSelection, next: ModelSelection) => previous.instanceId !== next.instanceId || previous.model !== next.model
      ? { resumeCursors: {}, lastInstanceId: undefined, rewound: true, lastContextModel: undefined, appliedCompactionId: undefined } : {},
    reconcile(_store: Store) {},
  };
  if (enabled) bindDoneBotVoice(createDoneBotVoice({ gateway, resolveModel: () => gateway.models()?.models.find(model => model.id === config().tts?.model && model.interfaces.includes("openai.audio.speech")) ?? gateway.models()?.models.find(model => model.interfaces.includes("openai.audio.speech")) }));
  return {
    enabled, gateway, driver, drivers: [driver, ...coding.drivers], isCodingInstance: isDoneBotCodingInstance, policy,
    fetchArtifact: fixtureOrigin ? (url: string, signal: AbortSignal) => {
      const parsed = new URL(url);
      return parsed.origin === fixtureOrigin && ["/fixture-audio.mp3", "/fixture-image.png"].includes(parsed.pathname) && !parsed.search && !parsed.hash
        ? fetch(url, { signal, redirect: "error", credentials: "omit" }) : publicArtifactResponse(url, signal);
    } : undefined,
    routes: enabled ? [createDoneBotMediaSettingsRoute(gateway, mediaPreferences), createDoneBotAccountRoutes(gateway)] : [],
    helpers: () => createDoneBotHelpers(gateway, config, dataDir),
    async restore() { if (enabled) await gateway.restore().catch(() => console.warn("DoneBot secure session could not be restored.")); },
  };
}
