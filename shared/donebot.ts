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

/** Global per-turn safety caps for DoneBot gateway chat models (model rounds & cumulative tool calls). */
export interface DoneBotTurnLimits {
  maxSteps: number;
  maxToolCalls: number;
}

export const MIN_DONEBOT_TURN_STEPS = 16;
export const MAX_DONEBOT_TURN_STEPS = 1000;
export const MIN_DONEBOT_TURN_TOOL_CALLS = 32;
export const MAX_DONEBOT_TURN_TOOL_CALLS = 4000;
export const DEFAULT_DONEBOT_TURN_LIMITS: DoneBotTurnLimits = {
  maxSteps: 256,
  maxToolCalls: 800,
};

/** Upstream proxy mode for the desktop built-in Bot browser egress gate. */
export type DoneBotBrowserProxyMode = "system" | "manual" | "direct";

export interface DoneBotBrowserProxyConfig {
  mode: DoneBotBrowserProxyMode;
  /** Explicit upstream proxy URL when mode is "manual" (e.g. socks5://127.0.0.1:10808 or http://127.0.0.1:10809). */
  url: string;
  /** Optional comma/newline-separated bypass hosts or CIDRs when mode is "manual". */
  bypass: string;
}

export const DEFAULT_DONEBOT_BROWSER_PROXY: DoneBotBrowserProxyConfig = {
  mode: "system",
  url: "",
  bypass: "",
};

export interface DoneBotBrowserProxyState extends DoneBotBrowserProxyConfig {
  /** Live detected desktop system proxy summary (for display in Settings), or null when direct. */
  detectedSystemProxy: string | null;
}

/** Choices are the enabled gateway models with a verified client adapter. */
export interface DoneBotMediaSettings {
  accountId: string;
  preferences: DoneBotMediaPreferences;
  models: { id: string; name: string; kind: "image" | "video" }[];
}

export {
  DONEBOT_ASR_DEFAULT_SAMPLE_RATE,
  DONEBOT_ASR_WS_PATH,
  DONEBOT_SPEECH_MODEL_SPECS,
  DONEBOT_TTS_DEFAULT_SAMPLE_RATE,
  DONEBOT_TTS_MODEL_PRIORITY,
  DONEBOT_VOICE_ID_PATTERN,
  DONEBOT_VOICE_MODELS,
  doneBotSpeechMaxInputChars,
  doneBotSpeechModelSpec,
  doneBotSpeechVoices,
  doneBotVoiceLabel,
  isKnownDoneBotSpeechVoice,
  isQwen31SpeechModel,
  isValidDoneBotVoiceId,
  resolveDoneBotSpeechVoice,
  type DoneBotAsrClientMessage,
  type DoneBotAsrConfigSummary,
  type DoneBotAsrErrorCode,
  type DoneBotAsrServerMessage,
  type DoneBotAsrVadModel,
  type DoneBotSpeechModelSpec,
  type DoneBotVoiceCapabilities,
  type DoneBotVoiceDescriptor,
  type DoneBotVoiceGender,
} from "./donebot-voice.ts";

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
