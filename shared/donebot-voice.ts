export const DONEBOT_VOICE_MODELS = {
  ttsFlash: "qwen-audio-3.1-tts-flash",
  ttsPlus: "qwen-audio-3.1-tts-plus",
  ttsLegacy: "gpt-4o-mini-tts",
  asrRealtime: "qwen-audio-3.1-asr-flash-streaming",
} as const;

export const DONEBOT_TTS_MODEL_PRIORITY = [
  DONEBOT_VOICE_MODELS.ttsFlash,
  DONEBOT_VOICE_MODELS.ttsPlus,
  DONEBOT_VOICE_MODELS.ttsLegacy,
] as const;

export const DONEBOT_ASR_WS_PATH = "/api/voice/asr";
export const DONEBOT_ASR_DEFAULT_SAMPLE_RATE = 16_000 as const;
export const DONEBOT_TTS_DEFAULT_SAMPLE_RATE = 24_000 as const;

/** Qwen-Audio-3.1 voice IDs contain dots (e.g. `longanhuan_v3.1`). */
export const DONEBOT_VOICE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function isValidDoneBotVoiceId(value: unknown): value is string {
  return (
    typeof value === "string"
    && DONEBOT_VOICE_ID_PATTERN.test(value)
    && value !== "."
    && value !== ".."
    && !value.includes("..")
  );
}

export type DoneBotVoiceGender = "female" | "male" | "neutral";

export interface DoneBotVoiceDescriptor {
  id: string;
  label: string;
  name?: string;
  gender?: DoneBotVoiceGender;
  description?: string;
  tags?: string[];
  recommended?: boolean;
}

export interface DoneBotSpeechModelSpec {
  id: string;
  displayName: string;
  defaultVoice: string;
  maxInputChars: number;
  formats: readonly string[];
  defaultSampleRate: number;
  supportsControls: boolean;
  voices: readonly DoneBotVoiceDescriptor[];
}

export interface DoneBotVoiceCapabilities {
  tts: {
    available: boolean;
    model: string;
    defaultVoice: string;
    models: Array<{
      id: string;
      displayName: string;
      defaultVoice: string;
      voices: DoneBotVoiceDescriptor[];
    }>;
  };
  asr: {
    available: boolean;
    model: string;
    wsPath: string;
    sampleRate: 16000;
    format: "pcm";
  };
}

export interface DoneBotAsrConfigSummary {
  ready: boolean;
  model: string;
  wsPath: string;
}

export type DoneBotAsrVadModel = "near_meeting_16k" | "far_field_meeting_16k";

/** Client-to-local-server JSON control frames over `/api/voice/asr` (audio goes as raw binary 16-bit LE PCM). */
export type DoneBotAsrClientMessage =
  | {
    type: "start";
    sampleRate?: 16000 | 8000;
    endpointMs?: number;
    vadModel?: DoneBotAsrVadModel;
    languageHints?: string[];
    keepDialect?: boolean;
    hotwords?: Record<string, number>;
    context?: string;
    idleTimeoutMs?: number;
  }
  | { type: "finish" }
  | { type: "stop" }
  | { type: "ping" };

export type DoneBotAsrErrorCode =
  | "asr_unavailable"
  | "auth_expired"
  | "account_changed"
  | "idle_timeout"
  | "max_duration"
  | "backpressure"
  | "upstream_failed"
  | "upstream_closed"
  | "invalid_frame";

/** Local-server-to-client JSON event frames over `/api/voice/asr`. */
export type DoneBotAsrServerMessage =
  | { type: "ready"; model: string; taskId: string }
  | { type: "speech_started"; sentenceId: number; beginTime?: number }
  | { type: "transcript"; sentenceId: number; text: string; final: boolean; beginTime?: number; endTime?: number }
  | { type: "speech_stopped"; sentenceId: number; endTime?: number }
  | { type: "finished"; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }
  | { type: "pong" }
  | { type: "error"; code: DoneBotAsrErrorCode; message: string };

// Verified flagship `_v3.1` voices from Alibaba Cloud Model Studio `qwen-audio-tts-voice-list`.
const QWEN31_FLAGSHIP_VOICES: readonly DoneBotVoiceDescriptor[] = [
  {
    id: "longanhuan_v3.1",
    name: "龙安欢",
    label: "龙安欢",
    gender: "female",
    description: "欢脱元气、开朗活泼，支持多方言与指令控制",
    tags: ["默认推荐", "活泼", "多方言"],
    recommended: true,
  },
  {
    id: "longanlingxin_v3.1",
    name: "龙安灵心",
    label: "龙安灵心",
    gender: "female",
    description: "温柔细腻、温暖治愈陪伴，适合长对话与故事",
    tags: ["温柔", "治愈", "多方言"],
  },
  {
    id: "longanfengyue_v3.1",
    name: "龙安风悦",
    label: "龙安风悦",
    gender: "female",
    description: "优雅动听、表现力丰富，适合讲解与日常陪伴",
    tags: ["优雅", "自然", "多方言"],
  },
  {
    id: "xunanchuan_v3.1",
    name: "许南川",
    label: "许南川",
    gender: "male",
    description: "磁性真诚、沉稳叙事感，适合播报与深度交流",
    tags: ["男声", "沉稳", "磁性"],
  },
];

// Verified 13 real `_v3.1` voices for `qwen-audio-3.1-tts-flash` from `help.aliyun.com` `qwen-audio-tts-voice-list`.
const QWEN31_FLASH_VOICES: readonly DoneBotVoiceDescriptor[] = [
  ...QWEN31_FLAGSHIP_VOICES,
  {
    id: "yuxiaoyun_v3.1",
    name: "于小云",
    label: "于小云",
    gender: "female",
    description: "元气亲切自然，适合日常交流与助手播报",
    tags: ["元气", "亲切", "中文"],
  },
  {
    id: "qiaoxiaojiao_v3.1",
    name: "乔小娇",
    label: "乔小娇",
    gender: "female",
    description: "俏丽可爱、灵动活泼，适合轻快陪伴",
    tags: ["可爱", "俏丽", "中文"],
  },
  {
    id: "xiaxiaochen_v3.1",
    name: "夏小晨",
    label: "夏小晨",
    gender: "female",
    description: "元气明亮、清脆明快，适合高频语音互动",
    tags: ["元气", "明亮", "中文"],
  },
  {
    id: "anmingyuan_v3.1",
    name: "安明远",
    label: "安明远",
    gender: "male",
    description: "清亮自然、温和耐听，适合男声助手",
    tags: ["男声", "清亮", "自然"],
  },
  {
    id: "wenhuaiqing_v3.1",
    name: "温怀清",
    label: "温怀清",
    gender: "female",
    description: "清亮柔和、温婉得体，适合信息播报与陪聊",
    tags: ["柔和", "清亮", "中文"],
  },
  {
    id: "anxiaolan_v3.1",
    name: "安小岚",
    label: "安小岚",
    gender: "female",
    description: "清甜纯净、柔和轻盈，适合轻声陪伴",
    tags: ["清甜", "纯净", "中文"],
  },
  {
    id: "xieshurou_v3.1",
    name: "谢舒柔",
    label: "谢舒柔",
    gender: "female",
    description: "柔和自然知性，适合专业讲解与舒缓对话",
    tags: ["知性", "柔和", "中文"],
  },
  {
    id: "baiqinglan_v3.1",
    name: "白清岚",
    label: "白清岚",
    gender: "female",
    description: "明亮清纯、自然清新",
    tags: ["明亮", "清纯", "中文"],
  },
  {
    id: "Emily_v3.1",
    name: "Emily",
    label: "Emily",
    gender: "female",
    description: "自然英式英语，适合英文与双语播报",
    tags: ["英式英语", "英文"],
  },
];

const GPT4O_MINI_TTS_VOICES: readonly DoneBotVoiceDescriptor[] = [
  { id: "alloy", name: "alloy", label: "alloy（自然中性）", gender: "neutral", description: "自然中性", recommended: true },
  { id: "echo", name: "echo", label: "echo（沉稳男声）", gender: "male", description: "沉稳男声" },
  { id: "fable", name: "fable", label: "fable（温和叙事）", gender: "neutral", description: "温和叙事" },
  { id: "onyx", name: "onyx", label: "onyx（低沉男声）", gender: "male", description: "低沉男声" },
  { id: "nova", name: "nova", label: "nova（清亮女声）", gender: "female", description: "清亮女声" },
  { id: "shimmer", name: "shimmer", label: "shimmer（温柔女声）", gender: "female", description: "温柔女声" },
];

/** Extra legacy OpenAI TTS voice IDs recognized for smooth fallback when upgrading models. */
const LEGACY_OPENAI_TTS_VOICE_IDS: readonly string[] = [
  "ash",
  "ballad",
  "coral",
  "sage",
  "verse",
  "marin",
  "cedar",
];

export const DONEBOT_SPEECH_MODEL_SPECS: Readonly<Record<string, DoneBotSpeechModelSpec>> = {
  [DONEBOT_VOICE_MODELS.ttsFlash]: {
    id: DONEBOT_VOICE_MODELS.ttsFlash,
    displayName: "Qwen Audio 3.1 TTS Flash",
    defaultVoice: "longanhuan_v3.1",
    maxInputChars: 20_000,
    formats: ["pcm", "wav", "mp3", "opus"],
    defaultSampleRate: DONEBOT_TTS_DEFAULT_SAMPLE_RATE,
    supportsControls: true,
    voices: QWEN31_FLASH_VOICES,
  },
  [DONEBOT_VOICE_MODELS.ttsPlus]: {
    id: DONEBOT_VOICE_MODELS.ttsPlus,
    displayName: "Qwen Audio 3.1 TTS Plus",
    defaultVoice: "longanhuan_v3.1",
    maxInputChars: 20_000,
    formats: ["pcm", "wav", "mp3", "opus"],
    defaultSampleRate: DONEBOT_TTS_DEFAULT_SAMPLE_RATE,
    supportsControls: true,
    voices: QWEN31_FLAGSHIP_VOICES,
  },
  [DONEBOT_VOICE_MODELS.ttsLegacy]: {
    id: DONEBOT_VOICE_MODELS.ttsLegacy,
    displayName: "GPT-4o mini TTS",
    defaultVoice: "alloy",
    maxInputChars: 4_096,
    formats: ["opus", "aac", "flac", "wav", "pcm"],
    defaultSampleRate: DONEBOT_TTS_DEFAULT_SAMPLE_RATE,
    supportsControls: false,
    voices: GPT4O_MINI_TTS_VOICES,
  },
};

export function isQwen31SpeechModel(modelId: string): boolean {
  return modelId === DONEBOT_VOICE_MODELS.ttsFlash || modelId === DONEBOT_VOICE_MODELS.ttsPlus;
}

export function doneBotSpeechModelSpec(modelId: string): DoneBotSpeechModelSpec | undefined {
  return Object.hasOwn(DONEBOT_SPEECH_MODEL_SPECS, modelId) ? DONEBOT_SPEECH_MODEL_SPECS[modelId] : undefined;
}

export function doneBotSpeechVoices(modelId: string): DoneBotVoiceDescriptor[] {
  const spec = doneBotSpeechModelSpec(modelId);
  return spec ? spec.voices.map((voice) => ({ ...voice, ...(voice.tags ? { tags: [...voice.tags] } : {}) })) : [];
}

export function isKnownDoneBotSpeechVoice(voiceId: string): boolean {
  if (!isValidDoneBotVoiceId(voiceId)) return false;
  if (LEGACY_OPENAI_TTS_VOICE_IDS.includes(voiceId)) return true;
  for (const spec of Object.values(DONEBOT_SPEECH_MODEL_SPECS)) {
    if (spec.voices.some((voice) => voice.id === voiceId)) return true;
  }
  return false;
}

export function doneBotVoiceLabel(voiceId: string, modelId?: string): string {
  if (modelId) {
    const inModel = doneBotSpeechModelSpec(modelId)?.voices.find((voice) => voice.id === voiceId);
    if (inModel) return inModel.label;
  }
  for (const spec of Object.values(DONEBOT_SPEECH_MODEL_SPECS)) {
    const found = spec.voices.find((voice) => voice.id === voiceId);
    if (found) return found.label;
  }
  return voiceId;
}

/**
 * Resolves the effective voice ID for `modelId`.
 * Smoothly falls back to `modelId`'s default voice when `requestedVoiceId` is empty or belongs to another
 * registered DoneBot speech model (for example `alloy` after upgrading to Qwen-Audio-3.1, or a Flash-only
 * voice after switching to Plus). When `fallbackUnknown` is true, any unsupported voice ID falls back too.
 */
export function resolveDoneBotSpeechVoice(
  modelId: string,
  requestedVoiceId?: string,
  options?: { fallbackUnknown?: boolean },
): string | undefined {
  const spec = doneBotSpeechModelSpec(modelId);
  if (!spec || spec.voices.length === 0) return undefined;
  const trimmed = typeof requestedVoiceId === "string" ? requestedVoiceId.trim() : "";
  if (!trimmed) return spec.defaultVoice || spec.voices[0]?.id;
  const exact = spec.voices.find((voice) => voice.id === trimmed);
  if (exact) return exact.id;
  if (options?.fallbackUnknown || isKnownDoneBotSpeechVoice(trimmed)) {
    return spec.defaultVoice || spec.voices[0]?.id;
  }
  return undefined;
}

export function doneBotSpeechMaxInputChars(modelId: string): number {
  return doneBotSpeechModelSpec(modelId)?.maxInputChars ?? 4_096;
}
