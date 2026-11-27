import type { DoneBotCatalog, DoneBotGatewayModel, DoneBotVoiceCapabilities } from "../../shared/donebot.ts";
import {
  DONEBOT_ASR_DEFAULT_SAMPLE_RATE,
  DONEBOT_ASR_WS_PATH,
  DONEBOT_SPEECH_MODEL_SPECS,
  DONEBOT_TTS_MODEL_PRIORITY,
  DONEBOT_VOICE_MODELS,
  doneBotSpeechModelSpec,
  doneBotSpeechVoices,
} from "../../shared/donebot-voice.ts";
import { nativeModel, registeredMediaAdapters } from "./capabilities.ts";

export const DONEBOT_MEDIA_MODELS = { image: "seedream-5-5", video: "seedance-2-5", music: "suno" } as const;

function speechGatewayModel(id: string): DoneBotGatewayModel | undefined {
  const spec = doneBotSpeechModelSpec(id);
  if (!spec) return undefined;
  return {
    id: spec.id,
    display_name: spec.displayName,
    media_types: ["audio"],
    platforms: [],
    interfaces: ["openai.audio.speech"],
    media_parameters: {
      formats: [...spec.formats],
      voices: spec.voices.map((voice) => voice.id),
      ...(spec.id !== DONEBOT_VOICE_MODELS.ttsLegacy
        ? {
          default_voice: spec.defaultVoice,
          voice_descriptors: doneBotSpeechVoices(spec.id),
          sample_rate: spec.defaultSampleRate,
          max_input_chars: spec.maxInputChars,
        }
        : {}),
    },
  };
}

export function doneBotClientSpeechModel(enabled: DoneBotGatewayModel | undefined): DoneBotGatewayModel | undefined {
  if (!enabled || !enabled.interfaces.includes("openai.audio.speech")) return undefined;
  return speechGatewayModel(enabled.id);
}

function friendlyDisplayName(advertised: string | undefined, id: string, fallback: string): string {
  const trimmed = advertised?.trim();
  return trimmed && trimmed !== id ? trimmed : fallback;
}

export function doneBotClientAsrModel(enabled: DoneBotGatewayModel | undefined): DoneBotGatewayModel | undefined {
  if (!enabled || enabled.id !== DONEBOT_VOICE_MODELS.asrRealtime || !enabled.interfaces.includes("openai.audio.transcriptions.realtime")) {
    return undefined;
  }
  return {
    id: DONEBOT_VOICE_MODELS.asrRealtime,
    display_name: friendlyDisplayName(enabled.display_name, enabled.id, "Qwen Audio 3.1 ASR Flash Streaming"),
    media_types: ["audio"],
    platforms: [...enabled.platforms],
    interfaces: ["openai.audio.transcriptions.realtime"],
    media_parameters: {
      formats: ["pcm", "wav", "opus"],
      sample_rates: [16_000, 8_000],
      default_sample_rate: DONEBOT_ASR_DEFAULT_SAMPLE_RATE,
      vad_models: ["near_meeting_16k", "far_field_meeting_16k"],
      hotwords: true,
    },
    ...(enabled.pricing ? { pricing: structuredClone(enabled.pricing) } : {}),
  };
}

export function doneBotClientSpeechModels(catalog: DoneBotCatalog | null): DoneBotGatewayModel[] {
  if (!catalog) return [];
  const enabledById = new Map<string, DoneBotGatewayModel>();
  for (const model of catalog.models) {
    const local = doneBotClientSpeechModel(model);
    if (local) {
      enabledById.set(model.id, {
        ...local,
        ...(model.pricing ? { pricing: structuredClone(model.pricing) } : {}),
      });
    }
  }
  const ordered: DoneBotGatewayModel[] = [];
  for (const id of DONEBOT_TTS_MODEL_PRIORITY) {
    const found = enabledById.get(id);
    if (found) ordered.push(found);
  }
  for (const [id, model] of enabledById) {
    if (!ordered.some((item) => item.id === id)) ordered.push(model);
  }
  return ordered;
}

export function resolvePreferredDoneBotSpeechModel(
  catalog: DoneBotCatalog | null,
  preferredModelId?: string,
): DoneBotGatewayModel | undefined {
  const models = doneBotClientSpeechModels(catalog);
  if (!models.length) return undefined;
  const trimmed = preferredModelId?.trim();
  if (trimmed) {
    const matched = models.find((model) => model.id === trimmed);
    if (matched) return matched;
  }
  return models[0];
}

export function resolveDoneBotAsrModel(catalog: DoneBotCatalog | null): DoneBotGatewayModel | undefined {
  if (!catalog) return undefined;
  for (const model of catalog.models) {
    const local = doneBotClientAsrModel(model);
    if (local) return local;
  }
  return undefined;
}

export function doneBotVoiceCapabilities(
  catalog: DoneBotCatalog | null,
  authenticated: boolean,
  preferredTtsModelId?: string,
): DoneBotVoiceCapabilities {
  const speechModels = authenticated ? doneBotClientSpeechModels(catalog) : [];
  const selectedSpeech = authenticated ? resolvePreferredDoneBotSpeechModel(catalog, preferredTtsModelId) : undefined;
  const selectedSpec = selectedSpeech ? doneBotSpeechModelSpec(selectedSpeech.id) : undefined;
  const asrModel = authenticated ? resolveDoneBotAsrModel(catalog) : undefined;
  return {
    tts: {
      available: Boolean(selectedSpeech && selectedSpec && selectedSpec.voices.length > 0),
      model: selectedSpeech?.id ?? "",
      defaultVoice: selectedSpec?.defaultVoice ?? "",
      models: speechModels.flatMap((model) => {
        const spec = doneBotSpeechModelSpec(model.id);
        if (!spec) return [];
        return [{
          id: spec.id,
          displayName: spec.displayName,
          defaultVoice: spec.defaultVoice,
          voices: doneBotSpeechVoices(spec.id),
        }];
      }),
    },
    asr: {
      available: Boolean(asrModel),
      model: asrModel?.id ?? "",
      wsPath: DONEBOT_ASR_WS_PATH,
      sampleRate: DONEBOT_ASR_DEFAULT_SAMPLE_RATE,
      format: "pcm",
    },
  };
}

/**
 * Enriches gateway catalog voice models with client-registered voice descriptors so the renderer
 * never relies on the gateway advertising private capability tables.
 */
export function enrichDoneBotCatalogForClient(catalog: DoneBotCatalog): DoneBotCatalog {
  const preferredSpeech = resolvePreferredDoneBotSpeechModel(catalog);
  const models = catalog.models.map((model) => {
    const speech = doneBotClientSpeechModel(model);
    if (speech) {
      const spec = DONEBOT_SPEECH_MODEL_SPECS[speech.id]!;
      return {
        ...model,
        display_name: friendlyDisplayName(model.display_name, model.id, spec.displayName),
        media_parameters: {
          ...model.media_parameters,
          formats: [...spec.formats],
          voices: spec.voices.map((voice) => voice.id),
          default_voice: spec.defaultVoice,
          voice_descriptors: doneBotSpeechVoices(spec.id),
          sample_rate: spec.defaultSampleRate,
          max_input_chars: spec.maxInputChars,
        },
      };
    }
    const asr = doneBotClientAsrModel(model);
    if (asr) {
      return {
        ...model,
        display_name: friendlyDisplayName(model.display_name, model.id, asr.display_name),
        media_parameters: {
          ...model.media_parameters,
          ...asr.media_parameters,
        },
      };
    }
    return model;
  });
  return {
    ...catalog,
    defaults: {
      ...catalog.defaults,
      ...(preferredSpeech ? { audio: preferredSpeech.id } : {}),
    },
    models,
  };
}

const registry: DoneBotGatewayModel[] = [
  { id: DONEBOT_MEDIA_MODELS.image, display_name: "Seedream 5.5", media_types: ["image"], platforms: [], interfaces: ["openai.images"],
    media_parameters: { protocol: { adapter: "apimart.images.v1" } } },
  { id: DONEBOT_MEDIA_MODELS.video, display_name: "Seedance 2.5", media_types: ["video"], platforms: [], interfaces: ["openai.videos"],
    media_parameters: { protocol: { adapter: "seedance.videos.v1" } } },
  { id: DONEBOT_MEDIA_MODELS.music, display_name: "Suno v6", media_types: ["music"], platforms: [], interfaces: ["openai.music"],
    media_parameters: { protocol: { adapter: "apimart.music.v1" }, music_versions: ["v6"] } },
];

export function doneBotClientMediaCatalog(catalog: DoneBotCatalog | null): DoneBotCatalog | null {
  if (!catalog) return null;
  const models = catalog.models.flatMap(enabled => {
    const native = nativeModel(enabled.id), adapter = registeredMediaAdapters[enabled.id];
    if (!native || !adapter || !["image", "video", "music"].includes(native.kind) || !enabled.media_types.includes(native.kind)) return [];
    const iface = native.kind === "image" ? "openai.images" : native.kind === "video" ? "openai.videos" : "openai.music";
    if (!enabled.interfaces.includes(iface)) return [];
    const local = registry.find(model => model.id === enabled.id);
    return [{ ...structuredClone(local ?? { id: enabled.id, display_name: enabled.display_name || enabled.id,
      media_types: [native.kind], platforms: [], interfaces: [iface], media_parameters: { protocol: { adapter } } }),
      ...(enabled.pricing ? { pricing: enabled.pricing } : {}) }];
  });
  return { ...catalog, defaults: { ...catalog.defaults, image: DONEBOT_MEDIA_MODELS.image, video: DONEBOT_MEDIA_MODELS.video, music: DONEBOT_MEDIA_MODELS.music }, models };
}

export function doneBotFixedMediaModel(kind: "image" | "video" | "audio"): string {
  return DONEBOT_MEDIA_MODELS[kind === "audio" ? "music" : kind];
}
