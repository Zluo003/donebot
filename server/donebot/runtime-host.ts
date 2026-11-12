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
  const driver = createDoneBotLlmDriver({
    request: (path, init) => gateway.request(path, init),
    models: () => doneBotTextModels(gateway.models()), catalog: () => gateway.models(),
    protocol: id => doneBotProtocol(id, gateway.models()), authenticated: () => gateway.authenticated(),
    imageInput: id => Array.isArray(model(id)?.capabilities?.input_modalities) && (model(id)!.capabilities!.input_modalities as unknown[]).includes("image"),
    toolUse: id => model(id)?.capabilities?.tool_calling === true,
  });
  const allows = (selection: ModelSelection) => selection.instanceId === "donebot" && doneBotTextModels(gateway.models()).options.some(model => model.id === selection.model);
  const select = (previous?: ModelSelection): ModelSelection => previous && allows(previous) ? { ...previous } : { instanceId: "donebot", model: doneBotTextModels(gateway.models()).default };
  const policy = {
    allows, select, error: () => gateway.authenticated() ? "Choose an available DoneBot model." : "Sign in to DoneBot to use models.",
    configs: (): InstanceConfigMap => ({ donebot: { driver: "donebot", displayName: "DoneBot", config: {} } }),
    decorate: (instance: ProviderInstance) => instance,
    resetTask: (previous: ModelSelection, next: ModelSelection) => previous.instanceId !== next.instanceId || previous.model !== next.model
      ? { resumeCursors: {}, lastInstanceId: undefined, rewound: true, lastContextModel: undefined, appliedCompactionId: undefined } : {},
    reconcile(_store: Store) {},
  };
  if (enabled) bindDoneBotVoice(createDoneBotVoice({ gateway, resolveModel: () => gateway.models()?.models.find(model => model.id === config().tts?.model && model.interfaces.includes("openai.audio.speech")) ?? gateway.models()?.models.find(model => model.interfaces.includes("openai.audio.speech")) }));
  return {
    enabled, gateway, driver, policy,
    fetchArtifact: fixtureOrigin ? (url: string, signal: AbortSignal) => {
      const parsed = new URL(url);
      return parsed.origin === fixtureOrigin && ["/fixture-audio.mp3", "/fixture-image.png"].includes(parsed.pathname) && !parsed.search && !parsed.hash
        ? fetch(url, { signal, redirect: "error", credentials: "omit" }) : publicArtifactResponse(url, signal);
    } : undefined,
    routes: enabled ? [createDoneBotAccountRoutes(gateway)] : [],
    helpers: () => createDoneBotHelpers(gateway, config, dataDir),
    async restore() { if (enabled) await gateway.restore().catch(() => console.warn("DoneBot secure session could not be restored.")); },
  };
}
