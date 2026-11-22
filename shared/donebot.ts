export type DoneBotProtocol = "messages" | "gemini" | "responses" | "chat";
export type DoneBotModelKind = "text" | "image" | "video" | "music" | "audio";

export function doneBotMediaConcurrency(total: number): number | null {
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

export interface DoneBotGatewayModel {
  id: string;
  display_name: string;
  media_types: DoneBotModelKind[];
  interfaces: string[];
  platforms: string[];
  capabilities?: Record<string, unknown>;
  media_parameters?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
}

export interface DoneBotCatalog {
  gateway_contract_version: 3 | 4;
  catalog_scope_id: string;
  catalog_version: string;
  defaults: Record<string, string>;
  models: DoneBotGatewayModel[];
}

/** Media defaults belong to the signed-in account in the current workspace. */
export interface DoneBotMediaPreferences {
  image: { primary: string; fallback: string };
  video: { primary: string; fallback: string };
}

export const DEFAULT_DONEBOT_MEDIA_PREFERENCES: DoneBotMediaPreferences = {
  image: { primary: "seedream-5-5", fallback: "" }, video: { primary: "seedance-2-5", fallback: "" },
};

/** Choices are the enabled gateway models with a verified client adapter. */
export interface DoneBotMediaSettings {
  accountId: string;
  preferences: DoneBotMediaPreferences;
  models: { id: string; name: string; kind: "image" | "video" }[];
}

/** Account state sent to clients never contains a login token or installation credential. */
export interface DoneBotAccountState {
  enabled: boolean;
  authenticated: boolean;
  user?: { id: string; email: string };
  requires2fa?: boolean;
  cloudManaged?: true;
  modelCount: number;
  persistent: boolean;
}
