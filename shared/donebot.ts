export type DoneBotProtocol = "messages" | "gemini" | "responses" | "chat";
export type DoneBotModelKind = "text" | "image" | "video" | "music" | "audio";

export function doneBotMediaConcurrency(total: number): number | null {
  return Number.isSafeInteger(total) && total > 0 ? Math.max(1, Math.floor(total * 0.5)) : null;
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

/** Account state sent to clients never contains a login token or installation credential. */
export interface DoneBotAccountState {
  enabled: boolean;
  authenticated: boolean;
  user?: { id: string; email: string };
  requires2fa?: boolean;
  modelCount: number;
  persistent: boolean;
}
