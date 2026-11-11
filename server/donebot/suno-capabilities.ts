import type { NativeModel } from "./capabilities.ts";

export const SUNO_SOURCE = "https://docs.apimart.ai/en/api-reference/audios/suno/generation";
export const SUNO_LIMITS = { lyrics: 5000, title: 80, style: 1000, duration: { min: 10, max: 360 } };
export const SUNO_FIXED_PARAMETERS = { version: "v6", custom: true, auto_lyrics: false };
export const SUNO_FORMATS = ["mp3", "m4a", "wav"];
export const SUNO_VARIETIES = ["off", "normal", "high", "extra", "max"];
export const SUNO_FIELDS = ["model", "prompt", "version", "custom", "instrumental", "title", "style", "negative_tags", "vocal_gender", "max_mode", "duration", "audio_format", "variety", "style_weight", "weirdness_constraint", "audio_weight", "auto_lyrics"];

export const sunoV6: NativeModel = {
  officialId: "Suno v6", kind: "music", tools: false, input: ["text"], output: ["audio"], streaming: false,
  verifiedAt: "2026-11-11", sources: [SUNO_SOURCE, "https://docs.apimart.ai/en/api-reference/audios/suno/overview"],
  media: { operations: ["generate", "custom_lyrics", "instrumental"], versions: ["v6"], formats: SUNO_FORMATS,
    maxReferences: { image: 0, video: 0, audio: 0 }, duration: { ...SUNO_LIMITS.duration, automatic: false },
    musicGeneration: { modes: ["instrumental", "song_with_lyrics"], fixedParameters: SUNO_FIXED_PARAMETERS,
      maxUnicodeCharacters: { prompt: SUNO_LIMITS.lyrics, title: SUNO_LIMITS.title, style: SUNO_LIMITS.style },
      vocalGenders: ["Male", "Female"], weights: { min: 0, max: 1 }, varieties: SUNO_VARIETIES,
      maxModePriceMultiplier: 2, targetDurationOnly: true },
    notes: ["DoneBot exposes only v6 custom generation: instrumental music or songs with lyrics. No inspiration, lyrics-only, reference, persona, custom-model, cover or extension workflow.",
      "For songs, prompt contains exact lyrics, not a topic; the LLM can compose lyrics before submission when requested. Instrumentals omit prompt and describe the arrangement in style. auto_lyrics=false preserves input lyrics.",
      "duration is a 10..360-second target, not a guaranteed output length. max_mode defaults to false and doubles the request tariff. The client defaults audio_format to mp3; the provider has no documented fixed format or variety default.",
      "No separate published length limit for negative_tags. Every returned music variant belongs to the same submitted task; inspect actual audio before claiming lyric or voice fidelity."] },
};

export const sunoParameterRules = {
  fields: SUNO_FIELDS.filter(field => field !== "model"), required: ["instrumental"],
  references: "Text only. No reference, cover, persona or extension inputs.",
  rules: ["Only instrumental music and songs with lyrics. The client fixes version=v6, custom=true and auto_lyrics=false; these fields may be omitted but cannot be changed.",
    "Set instrumental=true for pure music: omit prompt, describe instrumentation, mood and arrangement in style; use negative_tags to exclude vocals, choir or humming if requested.",
    "Set instrumental=false for songs and put complete lyrics in prompt, including section labels. Preserve supplied lyrics verbatim. When asked to write a song without supplied lyrics, compose the lyrics in the same LLM response before calling generation; do not submit a topic as lyrics or call a lyrics service.",
    "Lyrics <=5000 Unicode characters, title<=80, style<=1000. Keep arrangement and vocal descriptions in style. vocal_gender=Male/Female is optional for songs; omit vocal controls for instrumental music.",
    "duration=10..360 integer target seconds; actual length comes from the result. audio_format=mp3(client default)/m4a/wav. variety=off/normal/high/extra/max, no fixed default. style_weight/weirdness_constraint/audio_weight=0..1. max_mode defaults to false; true doubles the ordinary request tariff.",
    "Submit once asynchronously and collect every returned music[] variant. Do not poll or submit again to retrieve another variant. Inspect actual format/duration; returned lyrics alone do not prove the sung words match or that an instrumental has no voice."],
};

export const sunoParameterSchema = {
  type: "object", additionalProperties: false,
  properties: {
    instrumental: { type: "boolean", description: "Required: true for pure music; false for a song with complete lyrics in prompt." },
    prompt: { type: "string", maxLength: SUNO_LIMITS.lyrics, description: "Complete lyrics, required for songs; omit for instrumental music. Preserve supplied lyrics verbatim." },
    title: { type: "string", maxLength: SUNO_LIMITS.title }, style: { type: "string", maxLength: SUNO_LIMITS.style },
    negative_tags: { type: "string" }, vocal_gender: { type: "string", enum: ["Male", "Female"], description: "Optional for songs; omit for instrumental music." },
    version: { type: "string", enum: ["v6"] }, custom: { type: "boolean", enum: [true] }, auto_lyrics: { type: "boolean", enum: [false] },
    max_mode: { type: "boolean", description: "Default false. Enabling doubles the request tariff." },
    duration: { type: "integer", minimum: SUNO_LIMITS.duration.min, maximum: SUNO_LIMITS.duration.max, description: "Target seconds; actual output length can differ." },
    audio_format: { type: "string", enum: SUNO_FORMATS }, variety: { type: "string", enum: SUNO_VARIETIES },
    style_weight: { type: "number", minimum: 0, maximum: 1 }, weirdness_constraint: { type: "number", minimum: 0, maximum: 1 }, audio_weight: { type: "number", minimum: 0, maximum: 1 },
  }, required: ["instrumental"],
};
