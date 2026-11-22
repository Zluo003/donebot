import type { RailAddChoices } from "../../electron/cloud-rail.mjs";

export const DONEBOT_CLOUD_URL = "https://donebot.cn/cloud";
export const DONEBOT_PRIVATE_DESKTOP_ENABLED = false;
export const DONEBOT_TEMPLATES_ENABLED = false;

export const UPSTREAM_SETTINGS = {
  computerRail: false,
  analytics: false,
  grokImport: false,
  more: false,
  advanced: false,
  computers: false,
  apiKeys: false,
  welcomeTour: false,
  diagnostics: false,
  profilePhone: false,
  profileSupport: false,
};

export function doneBotSettingsSectionVisible(id: string): boolean {
  if (!UPSTREAM_SETTINGS.computers && ["computer", "companion", "remote", "desktopWorkspaces", "logins"].includes(id)) return false;
  return id !== "connections" || UPSTREAM_SETTINGS.apiKeys;
}

export function rememberDoneBotCloud(response: Response): void {
  if (response.headers.get("x-donebot-cloud") === "1") {
    try { sessionStorage.setItem("donebot.cloud-browser", "1"); } catch {}
  }
}

export function isDoneBotCloudBrowser(): boolean {
  try { return sessionStorage.getItem("donebot.cloud-browser") === "1"; } catch { return false; }
}

export function doneBotPurchaseVisible({ enabled, cloudHome, team, remote, ownerOrAdmin }: {
  enabled?: boolean; cloudHome?: boolean; team?: boolean; remote?: boolean; ownerOrAdmin: boolean | null;
}): boolean {
  return enabled === true && cloudHome !== true && team !== true && remote !== true && !isDoneBotCloudBrowser() && ownerOrAdmin !== false;
}

export const doneBotCloudServerVisible = doneBotPurchaseVisible;
export const doneBotTeamsVisible = doneBotPurchaseVisible;

export const UPSTREAM_SERVICES = {
  promotions: false,
  cloud: false,
  boat: false,
  mobileApps: false,
  updatesEmail: false,
  liveCalls: false,
};

export function doneBotKeyVisible(id: string): boolean {
  return (id !== "box" || UPSTREAM_SERVICES.boat) && (id !== "modelgo" || UPSTREAM_SERVICES.promotions);
}

export function doneBotPlaceChoices(choices: RailAddChoices): RailAddChoices {
  return {
    ...choices,
    cloud: choices.cloud && UPSTREAM_SERVICES.cloud,
    organization: choices.organization === true && UPSTREAM_SERVICES.cloud,
    account: choices.account === true && UPSTREAM_SERVICES.cloud,
  };
}
