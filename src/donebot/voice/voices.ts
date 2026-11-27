/**
 * Client-side voice presentation metadata & capability normalization.
 * Single source of truth for registered model specs & validation lives in `shared/donebot-voice.ts`;
 * this module adds user-facing Chinese presentation labels for all verified Qwen-Audio-3.1 voices
 * and legacy gpt-4o-mini-tts voices, plus graceful fallback when loading capabilities.
 */

import {
  DONEBOT_ASR_WS_PATH,
  DONEBOT_TTS_MODEL_PRIORITY,
  DONEBOT_VOICE_MODELS,
  doneBotSpeechModelSpec,
  doneBotSpeechVoices,
  isValidDoneBotVoiceId,
  type DoneBotCatalog,
  type DoneBotGatewayModel,
  type DoneBotVoiceCapabilities,
  type DoneBotVoiceDescriptor,
  type DoneBotVoiceGender,
} from "../../../shared/donebot";

export interface VoiceDisplayMeta {
  name: string;
  gender: DoneBotVoiceGender;
  shortStyle: string;
  description: string;
  tags?: string[];
  recommended?: boolean;
  legacyLabel?: string;
}

/**
 * Verified voice metadata aligned with Alibaba Cloud Model Studio Qwen-Audio-3.1 official docs (#20)
 * plus legacy gpt-4o-mini-tts voices for backwards compatibility.
 */
export const VERIFIED_VOICE_DISPLAY_META: Readonly<Record<string, VoiceDisplayMeta>> = {
  // Qwen-Audio-3.1 flagship `_v3.1` voices (supported by both plus and flash)
  "longanhuan_v3.1": {
    name: "龙安欢",
    gender: "female",
    shortStyle: "欢脱元气女声",
    description: "欢脱元气、开朗活泼，支持多方言与自然表达",
    tags: ["默认推荐", "活泼", "多方言"],
    recommended: true,
  },
  "longanlingxin_v3.1": {
    name: "龙安灵心",
    gender: "female",
    shortStyle: "温柔治愈女声",
    description: "温柔细腻、温暖治愈陪伴，适合长对话与汇报",
    tags: ["温柔", "治愈", "多方言"],
  },
  "longanfengyue_v3.1": {
    name: "龙安风悦",
    gender: "female",
    shortStyle: "优雅动听女声",
    description: "优雅动听、表现力丰富，适合讲解与日常陪伴",
    tags: ["优雅", "自然", "多方言"],
  },
  "xunanchuan_v3.1": {
    name: "许南川",
    gender: "male",
    shortStyle: "磁性沉稳男声",
    description: "磁性真诚、沉稳叙事感，适合播报与深度交流",
    tags: ["男声", "沉稳", "磁性"],
  },

  // Qwen-Audio-3.1 Flash verified boutique `_v3.1` voices
  "yuxiaoyun_v3.1": {
    name: "于小云",
    gender: "female",
    shortStyle: "元气亲切女声",
    description: "元气亲切自然，清晰明快，适合日常对话",
    tags: ["亲切", "自然"],
  },
  "qiaoxiaojiao_v3.1": {
    name: "乔小娇",
    gender: "female",
    shortStyle: "俏丽可爱女声",
    description: "俏丽可爱、灵动活泼，富有亲和力",
    tags: ["俏丽", "可爱"],
  },
  "xiaxiaochen_v3.1": {
    name: "夏小晨",
    gender: "female",
    shortStyle: "元气明亮女声",
    description: "元气明亮、节奏轻快，声音清爽有活力",
    tags: ["元气", "明亮"],
  },
  "anmingyuan_v3.1": {
    name: "安明远",
    gender: "male",
    shortStyle: "清亮自然男声",
    description: "清亮自然、吐字清晰，适合效率助手与播报",
    tags: ["男声", "清亮", "自然"],
  },
  "wenhuaiqing_v3.1": {
    name: "温怀清",
    gender: "female",
    shortStyle: "清亮柔和女声",
    description: "清亮柔和、娓娓道来，耐听舒适",
    tags: ["清亮", "柔和"],
  },
  "anxiaolan_v3.1": {
    name: "安小岚",
    gender: "female",
    shortStyle: "清甜纯净女声",
    description: "清甜纯净、柔和细腻，适合桌宠陪伴",
    tags: ["清甜", "纯净"],
  },
  "xieshurou_v3.1": {
    name: "谢舒柔",
    gender: "female",
    shortStyle: "柔和知性女声",
    description: "柔和自然知性、从容大方，适合办公与总结",
    tags: ["知性", "柔和"],
  },
  "baiqinglan_v3.1": {
    name: "白清岚",
    gender: "female",
    shortStyle: "明亮清纯女声",
    description: "明亮清纯、声音清澈，表达自然流畅",
    tags: ["明亮", "清纯"],
  },
  "Emily_v3.1": {
    name: "Emily",
    gender: "female",
    shortStyle: "自然英式女声",
    description: "自然英式英语，吐字优雅清晰",
    tags: ["英文", "英式"],
  },

  // Legacy gpt-4o-mini-tts voices (kept for backwards compatibility)
  alloy: { name: "alloy", gender: "neutral", shortStyle: "自然中性", description: "自然中性", legacyLabel: "alloy（自然中性）" },
  echo: { name: "echo", gender: "male", shortStyle: "沉稳男声", description: "沉稳男声", legacyLabel: "echo（沉稳男声）" },
  fable: { name: "fable", gender: "neutral", shortStyle: "温和叙事", description: "温和叙事", legacyLabel: "fable（温和叙事）" },
  onyx: { name: "onyx", gender: "male", shortStyle: "低沉男声", description: "低沉男声", legacyLabel: "onyx（低沉男声）" },
  nova: { name: "nova", gender: "female", shortStyle: "清亮女声", description: "清亮女声", legacyLabel: "nova（清亮女声）" },
  shimmer: { name: "shimmer", gender: "female", shortStyle: "温柔女声", description: "温柔女声", legacyLabel: "shimmer（温柔女声）" },
  ash: { name: "ash", gender: "neutral", shortStyle: "干练清朗", description: "干练清朗", legacyLabel: "ash（干练清朗）" },
  ballad: { name: "ballad", gender: "neutral", shortStyle: "抒情柔和", description: "抒情柔和", legacyLabel: "ballad（抒情柔和）" },
  coral: { name: "coral", gender: "female", shortStyle: "明快亲和", description: "明快亲和", legacyLabel: "coral（明快亲和）" },
  sage: { name: "sage", gender: "neutral", shortStyle: "知性冷静", description: "知性冷静", legacyLabel: "sage（知性冷静）" },
  verse: { name: "verse", gender: "male", shortStyle: "生动自然", description: "生动自然", legacyLabel: "verse（生动自然）" },
};

const MODEL_DISPLAY_LABELS: Readonly<Record<string, string>> = {
  [DONEBOT_VOICE_MODELS.ttsFlash]: "Qwen-Audio 3.1 极速语音（多音色低延迟）",
  [DONEBOT_VOICE_MODELS.ttsPlus]: "Qwen-Audio 3.1 旗舰语音（高清质感）",
  [DONEBOT_VOICE_MODELS.ttsLegacy]: "GPT-4o mini TTS（旧版兼容）",
};

export function formatDoneBotSpeechModelName(modelId: string, displayName?: string): string {
  if (Object.hasOwn(MODEL_DISPLAY_LABELS, modelId)) {
    return MODEL_DISPLAY_LABELS[modelId]!;
  }
  return displayName?.trim() || modelId;
}

export function genderLabel(gender?: DoneBotVoiceGender): string {
  if (gender === "female") return "女声";
  if (gender === "male") return "男声";
  if (gender === "neutral") return "中性";
  return "";
}

export function enrichVoiceDescriptor(
  voice: string | DoneBotVoiceDescriptor,
): DoneBotVoiceDescriptor | null {
  if (typeof voice === "string") {
    if (!isValidDoneBotVoiceId(voice)) return null;
    const meta = Object.hasOwn(VERIFIED_VOICE_DISPLAY_META, voice)
      ? VERIFIED_VOICE_DISPLAY_META[voice]
      : undefined;
    return {
      id: voice,
      label: meta?.legacyLabel ?? meta?.name ?? voice,
      name: meta?.name ?? voice,
      gender: meta?.gender,
      description: meta?.description,
      tags: meta?.tags ? [...meta.tags] : undefined,
      recommended: meta?.recommended,
    };
  }
  if (!voice || typeof voice !== "object" || !isValidDoneBotVoiceId(voice.id)) return null;
  const meta = Object.hasOwn(VERIFIED_VOICE_DISPLAY_META, voice.id)
    ? VERIFIED_VOICE_DISPLAY_META[voice.id]
    : undefined;
  return {
    id: voice.id,
    name: voice.name || meta?.name || voice.label || voice.id,
    label: voice.label || meta?.legacyLabel || meta?.name || voice.id,
    gender: voice.gender ?? meta?.gender,
    description: voice.description || meta?.description,
    tags: Array.isArray(voice.tags) && voice.tags.length > 0 ? [...voice.tags] : meta?.tags ? [...meta.tags] : undefined,
    recommended: voice.recommended ?? meta?.recommended,
  };
}

/**
 * Formats a concise human-readable label for dropdowns & summary rows.
 * Example: `longanhuan_v3.1` -> `龙安欢 · 欢脱元气女声`, `alloy` -> `alloy（自然中性）`.
 */
export function formatDoneBotVoiceLabel(
  voiceId: string,
  descriptor?: Partial<DoneBotVoiceDescriptor> | null,
): string {
  const id = String(voiceId ?? "").trim();
  if (!id) return "默认声音";
  const meta = Object.hasOwn(VERIFIED_VOICE_DISPLAY_META, id)
    ? VERIFIED_VOICE_DISPLAY_META[id]
    : undefined;
  if (meta?.legacyLabel) return meta.legacyLabel;
  if (meta) return `${meta.name} · ${meta.shortStyle}`;
  const name = descriptor?.name?.trim() || descriptor?.label?.trim();
  const desc = descriptor?.description?.trim();
  if (name && desc && !name.includes(desc)) {
    const brief = desc.split(/[，,。；;]/)[0]?.trim() || desc;
    return brief.length <= 16 ? `${name} · ${brief}` : name;
  }
  return name || id;
}

function modelPriorityIndex(modelId: string): number {
  const idx = (DONEBOT_TTS_MODEL_PRIORITY as readonly string[]).indexOf(modelId);
  return idx === -1 ? DONEBOT_TTS_MODEL_PRIORITY.length + 1 : idx;
}

function extractVoicesFromCatalogModel(model: DoneBotGatewayModel): DoneBotVoiceDescriptor[] {
  const params = model.media_parameters;
  const descriptorsRaw = params?.voice_descriptors;
  if (Array.isArray(descriptorsRaw) && descriptorsRaw.length > 0) {
    const out = descriptorsRaw
      .map((item) => enrichVoiceDescriptor(item as DoneBotVoiceDescriptor))
      .filter((item): item is DoneBotVoiceDescriptor => item !== null);
    if (out.length > 0) return out;
  }

  const voicesRaw = params?.voices;
  if (Array.isArray(voicesRaw) && voicesRaw.length > 0) {
    const out = voicesRaw
      .map((item) => enrichVoiceDescriptor(item as string | DoneBotVoiceDescriptor))
      .filter((item): item is DoneBotVoiceDescriptor => item !== null);
    if (out.length > 0) return out;
  }

  return doneBotSpeechVoices(model.id)
    .map((item) => enrichVoiceDescriptor(item))
    .filter((item): item is DoneBotVoiceDescriptor => item !== null);
}

/** Builds a `DoneBotVoiceCapabilities` view from `/api/donebot/catalog` as fallback. */
export function capabilitiesFromCatalog(
  catalog: DoneBotCatalog | null | undefined,
  preferredModelId?: string,
): DoneBotVoiceCapabilities {
  const speechModels = (catalog?.models ?? [])
    .filter((model) => Array.isArray(model.interfaces) && model.interfaces.includes("openai.audio.speech"))
    .sort((a, b) => modelPriorityIndex(a.id) - modelPriorityIndex(b.id));

  const models = speechModels.map((model) => {
    const voices = extractVoicesFromCatalogModel(model);
    const spec = doneBotSpeechModelSpec(model.id);
    const paramDefault = typeof model.media_parameters?.default_voice === "string"
      ? model.media_parameters.default_voice
      : "";
    const defaultVoice = (paramDefault && voices.some((v) => v.id === paramDefault) ? paramDefault : "")
      || (spec?.defaultVoice && voices.some((v) => v.id === spec.defaultVoice) ? spec.defaultVoice : "")
      || voices[0]?.id
      || "";
    return {
      id: model.id,
      displayName: formatDoneBotSpeechModelName(model.id, model.display_name),
      defaultVoice,
      voices,
    };
  });

  const activeModel = models.find((m) => m.id === preferredModelId) ?? models[0];
  const asrModel = (catalog?.models ?? []).find(
    (model) => Array.isArray(model.interfaces) && model.interfaces.includes("openai.audio.transcriptions.realtime"),
  );

  return {
    tts: {
      available: models.length > 0,
      model: activeModel?.id ?? "",
      defaultVoice: activeModel?.defaultVoice ?? "",
      models,
    },
    asr: {
      available: Boolean(asrModel),
      model: asrModel?.id ?? "",
      wsPath: DONEBOT_ASR_WS_PATH,
      sampleRate: 16000,
      format: "pcm",
    },
  };
}

export function normalizeVoiceCapabilities(
  raw: DoneBotVoiceCapabilities,
): DoneBotVoiceCapabilities {
  const models = [...(raw.tts?.models ?? [])]
    .sort((a, b) => modelPriorityIndex(a.id) - modelPriorityIndex(b.id))
    .map((model) => {
      const voices = (model.voices ?? [])
        .map((v) => enrichVoiceDescriptor(v))
        .filter((v): v is DoneBotVoiceDescriptor => v !== null);
      const defaultVoice = (model.defaultVoice && voices.some((v) => v.id === model.defaultVoice) ? model.defaultVoice : "")
        || voices[0]?.id
        || "";
      return {
        id: model.id,
        displayName: formatDoneBotSpeechModelName(model.id, model.displayName),
        defaultVoice,
        voices,
      };
    });

  const active = models.find((m) => m.id === raw.tts?.model) ?? models[0];
  return {
    tts: {
      available: raw.tts?.available === true && models.length > 0,
      model: active?.id ?? raw.tts?.model ?? "",
      defaultVoice: active?.defaultVoice ?? raw.tts?.defaultVoice ?? "",
      models,
    },
    asr: {
      available: raw.asr?.available === true,
      model: raw.asr?.model ?? "",
      wsPath: raw.asr?.wsPath || DONEBOT_ASR_WS_PATH,
      sampleRate: 16000,
      format: "pcm",
    },
  };
}

/**
 * Loads voice capabilities from `/api/voice/capabilities`, gracefully falling back to
 * `/api/donebot/catalog` on older servers or mocked tests.
 */
export async function loadDoneBotVoiceCapabilities(
  fetchJson: <T>(path: string) => Promise<T>,
  preferredModelId?: string,
): Promise<DoneBotVoiceCapabilities> {
  try {
    const res = await fetchJson<DoneBotVoiceCapabilities | DoneBotCatalog>("/api/voice/capabilities");
    if (res && typeof res === "object" && "tts" in res && res.tts && Array.isArray(res.tts.models)) {
      return normalizeVoiceCapabilities(res);
    }
    if (res && typeof res === "object" && "models" in res && Array.isArray(res.models)) {
      return capabilitiesFromCatalog(res, preferredModelId);
    }
  } catch {
    // Fall through to legacy catalog endpoint.
  }
  const catalog = await fetchJson<DoneBotCatalog>("/api/donebot/catalog");
  return capabilitiesFromCatalog(catalog, preferredModelId);
}

export interface ResolvedVoiceSelection {
  selectedVoiceId: string;
  effectiveVoiceId: string;
  defaultVoiceId: string;
  isFallback: boolean;
  unavailableSavedVoice?: string;
  effectiveDescriptor?: DoneBotVoiceDescriptor;
}

export function resolveVoiceSelection(
  savedVoiceId: string | undefined,
  voices: readonly DoneBotVoiceDescriptor[],
  defaultVoiceId?: string,
): ResolvedVoiceSelection {
  const saved = (savedVoiceId ?? "").trim();
  const fallbackDefault = (defaultVoiceId && voices.some((v) => v.id === defaultVoiceId) ? defaultVoiceId : "")
    || voices.find((v) => v.recommended)?.id
    || voices[0]?.id
    || "";

  if (!saved) {
    return {
      selectedVoiceId: "",
      effectiveVoiceId: fallbackDefault,
      defaultVoiceId: fallbackDefault,
      isFallback: false,
      effectiveDescriptor: voices.find((v) => v.id === fallbackDefault),
    };
  }

  const exact = voices.find((v) => v.id === saved);
  if (exact) {
    return {
      selectedVoiceId: exact.id,
      effectiveVoiceId: exact.id,
      defaultVoiceId: fallbackDefault,
      isFallback: false,
      effectiveDescriptor: exact,
    };
  }

  return {
    selectedVoiceId: "",
    effectiveVoiceId: fallbackDefault,
    defaultVoiceId: fallbackDefault,
    isFallback: true,
    unavailableSavedVoice: saved,
    effectiveDescriptor: voices.find((v) => v.id === fallbackDefault),
  };
}
