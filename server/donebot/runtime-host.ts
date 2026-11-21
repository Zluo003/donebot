import { join } from "node:path";
import type { AppConfig } from "../config.ts";
import type { InstanceConfigMap, ModelSelection, ProviderInstance } from "../contracts.ts";
import type { Store } from "../store.ts";
import { doneBotProtocol, doneBotTextModels } from "./catalog.ts";
import { DoneBotGateway } from "./gateway.ts";
import { createDoneBotCredentialStore, type DoneBotPrivatePort } from "./credential-store.ts";
import { cloudCredentialStore } from "./cloud-credential.ts";
import { DoneBotInstallationIdentity } from "./installation-identity.ts";
import { doneBotDeviceName } from "./device-name.ts";
import { createDoneBotLlmDriver } from "./llm-driver.ts";
import { createDoneBotHelpers } from "./helpers.ts";
import { createDoneBotAccountRoutes } from "./routes.ts";
import { bindDoneBotVoice } from "../tts/index.ts";
import { createDoneBotVoice } from "./tts.ts";
import { publicArtifactResponse } from "./media-download.ts";
import { DoneBotMediaPreferencesStore, createDoneBotMediaSettingsRoute } from "./media-preferences.ts";
import { DoneBotTeamModelGateway } from "./team-model-gateway.ts";
import { teamRuntimeActor, type DoneBotTeamRuntime } from "./team-runtime.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";

export function createDoneBotRuntimeHost(dataDir: string, config: () => AppConfig, sourceUrl: string, teamRuntime?: DoneBotTeamRuntime | null) {
  const fixture = sourceUrl.endsWith(".ts") && process.env.NODE_ENV === "test";
  const enabled = !(fixture && process.env.DONEBOT_UPSTREAM_FIXTURE === "1");
  const fixtureOrigin = fixture ? process.env.DONEBOT_FIXTURE_ORIGIN : undefined;
  const identity = new DoneBotInstallationIdentity(join(dataDir, "donebot", "installation-identities.json"));
  const cloudCredential = process.env.DONEBOT_CLOUD_CREDENTIAL_FILE;
  if (cloudCredential && cloudCredential !== "/run/donebot/gateway.json" && !fixture) throw new Error("Invalid Cloud installation credential path.");
  const credentials = cloudCredential ? cloudCredentialStore(cloudCredential) : createDoneBotCredentialStore((process as NodeJS.Process & { parentPort?: DoneBotPrivatePort }).parentPort, join(dataDir, "donebot", "session-id"));
  const gateway = new DoneBotGateway(credentials, {
    resolveInstallation: async (accountId, previous) => {
      const local = identity.lookup(accountId) ?? previous;
      const restored = await credentials.resolveInstallation?.(accountId, local).catch(error => {
        if (!local) throw error;
        return undefined;
      });
      return identity.resolve(accountId, local ?? restored);
    },
    installationName: () => doneBotDeviceName(config().computerName),
    ...(fixtureOrigin ? { testOrigin: fixtureOrigin } : {}),
  });
  const team = teamRuntime ? new DoneBotTeamModelGateway(dataDir, teamRuntime, {
    coordinatorFile: process.env.DONEBOT_TEAM_COORDINATOR_FILE ?? "/run/donebot/team-coordinator.json",
    executionEnabled: process.env.DONEBOT_TEAM_EXECUTION_ENABLED === "1", ...(fixtureOrigin ? { fixtureOrigin } : {}),
  }) : null;
  const catalog = () => team ? team.models() : gateway.models();
  const authenticated = () => team ? team.authenticated() : gateway.authenticated();
  const model = (id: string) => catalog()?.models.find(model => model.id === id);
  const mediaPreferences = new DoneBotMediaPreferencesStore(join(dataDir, "donebot", "media-preferences.json"));
  gateway.bindMediaPreferences(() => mediaPreferences.get(gateway.scope()?.accountId));
  const driver = createDoneBotLlmDriver({
    imageCacheDir: join(dataDir, "donebot", "model-images"),
    request: (path, init, context) => team ? team.request(path, init, context) : gateway.request(path, init),
    models: () => doneBotTextModels(catalog()), catalog,
    mediaPreferences: () => gateway.mediaPreferences(),
    protocol: id => doneBotProtocol(id, catalog()), authenticated, requiresExecutionContext: Boolean(team),
    toolUse: id => model(id)?.capabilities?.tool_calling === true,
  });
  const allows = (selection: ModelSelection) => selection.instanceId === "donebot" && doneBotTextModels(catalog()).options.some(model => model.id === selection.model);
  const select = (previous?: ModelSelection): ModelSelection => previous && allows(previous) ? { ...previous } : { instanceId: "donebot", model: doneBotTextModels(catalog()).default };
  const policy = {
    allows, select, error: () => authenticated() ? "Choose an available DoneBot model." : team ? "团队模型执行尚未启用或目录不可用。" : "Sign in to DoneBot to use models.",
    configs: (): InstanceConfigMap => ({ donebot: { driver: "donebot", displayName: "DoneBot", config: {} } }),
    decorate: (instance: ProviderInstance) => instance,
    resetTask: (previous: ModelSelection, next: ModelSelection) => previous.instanceId !== next.instanceId || previous.model !== next.model
      ? { resumeCursors: {}, lastInstanceId: undefined, rewound: true, lastContextModel: undefined, appliedCompactionId: undefined } : {},
    reconcile(_store: Store) {},
  };
  if (enabled && !team) bindDoneBotVoice(createDoneBotVoice({ gateway, resolveModel: () => gateway.models()?.models.find(model => model.id === config().tts?.model && model.interfaces.includes("openai.audio.speech")) ?? gateway.models()?.models.find(model => model.interfaces.includes("openai.audio.speech")) }));
  const teamRoute: RouteHandler = async ({ path, method, auth, res, json }) => {
    if (!path.startsWith("/api/donebot/")) return PASS;
    res.setHeader("Cache-Control", "no-store");
    if (!team || !teamRuntime || auth.kind !== "session" || !teamRuntimeActor(teamRuntime, auth.session)) return json(res, 403, { error: "A verified team member is required." });
    if (path === "/api/donebot/catalog" && method === "GET") {
      try { return json(res, 200, await team.refreshCatalog()); }
      catch { return json(res, 503, { error: "团队模型目录暂不可用。" }); }
    }
    return json(res, 403, { error: "个人账号与账单只能在个人工作空间管理。" });
  };
  return {
    enabled, gateway, driver, policy, team,
    fetchArtifact: fixtureOrigin ? (url: string, signal: AbortSignal) => {
      const parsed = new URL(url);
      return parsed.origin === fixtureOrigin && ["/fixture-audio.mp3", "/fixture-image.png"].includes(parsed.pathname) && !parsed.search && !parsed.hash
        ? fetch(url, { signal, redirect: "error", credentials: "omit" }) : publicArtifactResponse(url, signal);
    } : undefined,
    routes: enabled ? team ? [teamRoute] : [createDoneBotMediaSettingsRoute(gateway, mediaPreferences), createDoneBotAccountRoutes(gateway)] : [],
    helpers: () => createDoneBotHelpers(gateway, config, dataDir),
    async restore() {
      if (!enabled) return;
      if (team) await team.refreshCatalog().catch(() => console.warn("DoneBot team model catalog could not be restored."));
      else await gateway.restore().catch(() => console.warn("DoneBot secure session could not be restored."));
    },
  };
}
