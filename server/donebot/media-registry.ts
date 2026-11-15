import type { DoneBotCatalog, DoneBotGatewayModel } from "../../shared/donebot.ts";
import { nativeModel, registeredMediaAdapters } from "./capabilities.ts";

export const DONEBOT_MEDIA_MODELS = { image: "seedream-5-5", video: "seedance-2-5", music: "suno" } as const;

const speech: DoneBotGatewayModel = {
  id: "gpt-4o-mini-tts", display_name: "GPT-4o mini TTS", media_types: ["audio"], platforms: [], interfaces: ["openai.audio.speech"],
  media_parameters: { formats: ["opus", "aac", "flac", "wav", "pcm"], voices: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] },
};

export function doneBotClientSpeechModel(enabled: DoneBotGatewayModel | undefined): DoneBotGatewayModel | undefined {
  return enabled?.id === speech.id && enabled.interfaces.includes("openai.audio.speech") ? structuredClone(speech) : undefined;
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
