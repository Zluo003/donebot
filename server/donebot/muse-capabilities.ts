import type { NativeModel } from "./capabilities.ts";
import type { MediaReferencePolicy } from "./media-assets.ts";

export const museVideo: NativeModel = {
  officialId: "muse-video", kind: "video", tools: false, input: ["text", "image"], output: ["video"], streaming: false,
  verifiedAt: "2026-11-15", sources: ["https://token.secure-skill.com/docs#muse-video"],
  media: { operations: ["generate"], maxReferences: { image: 10, video: 0, audio: 0 }, resolutions: ["720p"],
    aspectRatios: ["16:9", "9:16"], formats: ["mp4"], duration: { min: 4, max: 10, automatic: false },
    notes: ["DoneBot gateway Muse contract: duration defaults to 6 seconds; resolution must be explicit 720p. No video/audio references, editing, extension or streaming."] },
};

export const museParameterSchema = {
  type: "object", additionalProperties: false,
  properties: {
    prompt: { type: "string", minLength: 1 }, duration: { type: "integer", minimum: 4, maximum: 10, default: 6 },
    resolution: { type: "string", enum: ["720p"] }, aspect_ratio: { type: "string", enum: ["16:9", "9:16"], default: "16:9" },
    reference_images: { type: "array", maxItems: 10, items: { type: "object", additionalProperties: false,
      properties: { local_path: { type: "string" } }, required: ["local_path"] } },
    extra: { type: "string" }, timeout: { type: "integer", minimum: 1 }, stream: { type: "boolean", enum: [false] },
  }, required: ["prompt", "resolution"],
};

export const museParameterRules = {
  fields: Object.keys(museParameterSchema.properties), required: ["prompt", "resolution"],
  references: "reference_images:[{local_path:'/allowed/image.png'}]; up to 10 images, no video/audio references.",
  rules: ["Muse: 720p only; integer duration 4..10 seconds, default 6; aspect_ratio 16:9 or 9:16; at most 10 reference images. No reference video/audio, edit, extend or stream. Continue querying the original task while generation or settlement is pending; uncertain outcomes must not be resubmitted."],
};

export const museReferencePolicy: MediaReferencePolicy = {
  maxFiles: 10,
  validateFile: file => { if (!file.mime.startsWith("image/")) throw new Error("Muse accepts reference images only."); },
};

export function normalizeMuseParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  return { duration: 6, resolution: "720p", aspect_ratio: "16:9", ...parameters };
}

export function validateMuseParameters(parameters: Record<string, unknown>, operation: string): void {
  const fail = (message: string): never => { throw new Error(`Muse parameters: ${message}`); };
  if (operation !== "generate") fail("only generation is supported.");
  for (const key of Object.keys(parameters)) if (key !== "model" && !museParameterRules.fields.includes(key)) fail(`unsupported field ${key}.`);
  if (typeof parameters.prompt !== "string" || !parameters.prompt.trim()) fail("prompt is required.");
  if (parameters.resolution !== "720p") fail("resolution must be 720p.");
  if (typeof parameters.duration !== "number" || !Number.isInteger(parameters.duration) || parameters.duration < 4 || parameters.duration > 10) fail("duration must be an integer from 4 to 10.");
  if (!["16:9", "9:16"].includes(String(parameters.aspect_ratio))) fail("aspect_ratio must be 16:9 or 9:16.");
  if (parameters.stream !== undefined && parameters.stream !== false) fail("streaming is unsupported.");
  if (parameters.extra !== undefined && typeof parameters.extra !== "string") fail("extra must be text.");
  if (parameters.timeout !== undefined && (typeof parameters.timeout !== "number" || !Number.isSafeInteger(parameters.timeout) || parameters.timeout <= 0)) fail("timeout must be a positive integer.");
  const refs = parameters.reference_images;
  if (refs !== undefined && (!Array.isArray(refs) || refs.length > 10 || refs.some(ref => typeof ref !== "string" || !ref.startsWith("https://")))) fail("reference_images must contain up to 10 uploaded image URLs.");
}
