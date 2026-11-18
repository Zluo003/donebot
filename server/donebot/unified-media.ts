import type { DoneBotGatewayModel } from "../../shared/donebot.ts";
import { nativeModel, modelCapabilities } from "./capabilities.ts";
import { SEEDANCE_MODE_GUIDANCE, seedanceReferenceGuidance } from "./seedance-capabilities.ts";
import { nativeMediaModelSchema } from "./media-model-schema.ts";
import type { ValidateFunction } from "ajv";
import { compileToolSchema } from "../mcp-schema-validator.ts";

export const UNIFIED_MEDIA_PROTOCOL = "donebot.media.v1";
export const unifiedMedia = (p: Record<string, unknown>) => p.protocol === UNIFIED_MEDIA_PROTOCOL;
export const unifiedAdapter = (kind: string, adapter: string, p: Record<string, unknown>) => unifiedMedia(p) && (kind === "image" || kind === "video") ? `donebot.media.${kind}s.v1` : adapter;
export const unifiedOperation = (p: Record<string, unknown>): "generate" | "edit" | "extend" => p.mode === "edit" ? "edit" : p.mode === "extend" ? "extend" : "generate";

type Reference = { type: string; role: string; url: unknown };
const referenceSchema = { type: "object", additionalProperties: false, properties: {
  type: { type: "string", enum: ["image", "video", "audio"] }, role: { type: "string", enum: ["reference", "first_frame", "last_frame"] },
  url: { type: "object", additionalProperties: false, properties: { local_path: { type: "string", minLength: 1 } }, required: ["local_path"] },
}, required: ["type", "role", "url"] };

export function unifiedMediaSchema(model: DoneBotGatewayModel) {
  const native = nativeModel(model.id)!;
  const legacy = nativeMediaModelSchema(model);
  const capabilities = modelCapabilities(model);
  const fields = structuredClone(legacy.parameters.properties) as Record<string, Record<string, unknown>>;
  const properties: Record<string, unknown> = {};
  for (const key of ["prompt", "duration", "resolution", "size", "output_format"]) {
    if (fields[key]) { properties[key] = fields[key]; delete fields[key]; }
  }
  if (fields.n) { properties.count = fields.n; delete fields.n; }
  if (native.kind === "video") {
    properties.prompt = { type: "string", minLength: 1 };
    properties.output_format = { type: "string", enum: native.media!.formats };
    properties.aspect_ratio = fields.aspect_ratio ?? fields.ratio;
    delete fields.aspect_ratio; delete fields.ratio;
  }
  for (const key of ["content", "images", "image_urls", "reference_images", "omni_reference_task_type", "generate_audio", "layer_decomposition", "stream"]) delete fields[key];
  const modes = native.kind === "video" ? ["text", "reference",
    ...(capabilities.client.operations.includes("first_frame") ? ["first_frame", "first_last_frame"] : []),
    ...legacy.operations.filter(x => x !== "generate")]
    : ["text", "reference", "edit", ...(native.media?.layerDecomposition ? ["layers"] : [])];
  const modeGuidance = native.media?.referenceMedia ? SEEDANCE_MODE_GUIDANCE : "Without references use text; with any references default to reference. Use first_frame, first_last_frame, edit, extend or layers only when explicitly requested.";
  properties.mode = { type: "string", enum: modes, description: modeGuidance };
  properties.references = { type: "array", maxItems: capabilities.client.referenceLimits.maxFiles, items: referenceSchema,
    description: "Preserve the user's reference order. Default every supplied material's role to reference, including one or two images. first_frame/last_frame roles require an explicit request for that frame mode." };
  properties.options = { type: "object", additionalProperties: false, properties: fields };
  const required = native.kind === "video" ? ["mode", "prompt", "duration", "resolution"] : ["mode"];
  const guidance = native.kind === "video"
    ? `Use the unified prompt, mode, duration, resolution, aspect_ratio, output_format, references and options fields. Duration ${native.media!.duration!.min}..${native.media!.duration!.max} seconds, default 6. References use {type:'image'|'video'|'audio',role:'reference'|'first_frame'|'last_frame',url:{local_path:'/allowed/file'}}. ${modeGuidance} ${native.media?.referenceMedia ? seedanceReferenceGuidance(native) : "Only image references are supported."}`
    : `Use unified mode, prompt, size, resolution, count, output_format, references and options. References use {type:'image',role:'reference',url:{local_path:'/allowed/image'}}. Use layers only for explicit layer decomposition; prompt may be omitted for layers. ${native.media?.referenceImage ? JSON.stringify(native.media.referenceImage) : ""}`;
  return { parameters: { type: "object", additionalProperties: false, properties, required }, guidance, operations: ["generate", ...legacy.operations.filter(x => x !== "generate")] };
}

export function normalizeUnifiedMedia(model: DoneBotGatewayModel, p: Record<string, unknown>, operation: string): Record<string, unknown> {
  if (p.protocol !== UNIFIED_MEDIA_PROTOCOL) throw new Error("Unsupported media protocol.");
  if (operation !== unifiedOperation(p)) throw new Error("Media operation does not match its mode.");
  const native = nativeModel(model.id)!;
  const { generate_audio: _audio, complexity, ...rest } = p;
  if (native.media?.complexity && (p.options as Record<string, unknown> | undefined)?.complexity !== undefined && (p.options as Record<string, unknown>).complexity !== "high") throw new Error("complexity is fixed by DoneBot.");
  const options = { ...(p.options as Record<string, unknown> | undefined), ...(native.media?.complexity ? { complexity: "high" } : {}) };
  if (complexity !== undefined && complexity !== "high") throw new Error("complexity is fixed by DoneBot.");
  return { ...rest, ...(native.kind === "video" ? { duration: p.duration ?? 6, resolution: p.resolution ?? "720p", aspect_ratio: p.aspect_ratio ?? (model.id === "muse-video" ? "16:9" : "adaptive") } : {}),
    ...(Object.keys(options).length ? { options } : {}) };
}

const validators = new Map<string, { schema: string; check: ValidateFunction }>();

export function validateUnifiedMedia(model: DoneBotGatewayModel, p: Record<string, unknown>): void {
  const { protocol: _protocol, ...data } = p;
  const refs = (p.references ?? []) as Reference[];
  const schema = unifiedMediaSchema(model).parameters;
  const key = JSON.stringify(schema);
  let compiled = validators.get(model.id);
  if (compiled?.schema !== key) { compiled = { schema: key, check: compileToolSchema(schema) }; validators.set(model.id, compiled); }
  const check = compiled.check;
  const localShape = { ...data, ...(p.references === undefined ? {} : { references: refs.map(ref => ({ ...ref, url: { local_path: "uploaded-reference" } })) }) };
  if (!check(localShape)) throw new Error(`Unsupported unified media parameters for ${model.id}: ${JSON.stringify(check.errors)}`);
  for (const ref of refs) if (typeof ref.url !== "string" || !ref.url.startsWith("https://")) throw new Error("References must be uploaded through DoneBot.");
  const counts = (role: string) => refs.filter(ref => ref.role === role).length;
  const first = counts("first_frame"), last = counts("last_frame"), references = counts("reference");
  if (refs.some(ref => ref.role !== "reference" && ref.type !== "image")) throw new Error("Frame references must be images.");
  const valid = p.mode === "text" ? refs.length === 0
    : p.mode === "first_frame" ? first === 1 && last === 0 && references === 0
      : p.mode === "first_last_frame" ? first === 1 && last === 1 && references === 0
        : p.mode === "reference" || p.mode === "layers" || p.mode === "edit" || p.mode === "extend" ? refs.length > 0 && references === refs.length : false;
  if (!valid) throw new Error("Reference roles do not match the requested media mode.");
  const native = nativeModel(model.id)!;
  if (native.kind === "image" && refs.some(ref => ref.type !== "image")) throw new Error("Image generation accepts image references only.");
  for (const type of ["image", "video", "audio"] as const) if (refs.filter(ref => ref.type === type).length > (native.media?.maxReferences?.[type] ?? 0)) throw new Error(`Too many ${type} references for ${model.id}.`);
  if (native.kind === "video") {
    if ((p.mode === "edit" || p.mode === "extend") && !refs.some(ref => ref.type === "video")) throw new Error("Video edit/extend requires a video reference.");
    if (model.id !== "muse-video" && ["first_frame", "first_last_frame", "extend"].includes(String(p.mode)) && p.aspect_ratio !== "adaptive") throw new Error("Frame and extension modes require adaptive aspect_ratio.");
    if (native.media?.audioOnlyReference === false && refs.length && refs.every(ref => ref.type === "audio")) throw new Error("This model needs an image or video with audio references.");
  }
}

export function unifiedImageCapabilityParameters(p: Record<string, unknown>, gpt: boolean): Record<string, unknown> {
  const refs = (p.references ?? []) as Reference[];
  return { ...(p.options as Record<string, unknown> | undefined), ...(p.prompt === undefined ? {} : { prompt: p.prompt }),
    ...(p.size === undefined ? {} : { size: p.size }), ...(p.resolution === undefined ? {} : { resolution: p.resolution }),
    ...(p.output_format === undefined ? {} : { output_format: p.output_format }), ...(p.count === undefined ? {} : { n: p.count }),
    ...(p.mode === "layers" ? { layer_decomposition: true } : {}),
    ...(refs.length ? gpt ? { images: refs.map(ref => ({ image_url: ref.url })) } : { image_urls: refs.map(ref => ref.url) } : {}) };
}
