import type { DoneBotCatalog, DoneBotGatewayModel } from "../../shared/donebot.ts";

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
  const models = registry.flatMap(local => {
    const enabled = catalog.models.find(model => model.id === local.id);
    return enabled ? [{ ...structuredClone(local), ...(enabled.pricing ? { pricing: enabled.pricing } : {}) }] : [];
  });
  return { ...catalog, defaults: { ...catalog.defaults, image: DONEBOT_MEDIA_MODELS.image, video: DONEBOT_MEDIA_MODELS.video, music: DONEBOT_MEDIA_MODELS.music }, models };
}

export function doneBotFixedMediaModel(kind: "image" | "video" | "audio"): string {
  return DONEBOT_MEDIA_MODELS[kind === "audio" ? "music" : kind];
}
