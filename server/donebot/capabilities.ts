import type { DoneBotGatewayModel, DoneBotModelKind, DoneBotProtocol } from "../../shared/donebot.ts";
import { MAX_MEDIA_REFERENCE_BYTES, MAX_MEDIA_REFERENCE_FILES } from "./media-assets.ts";
import { SEEDREAM55_SOURCE, seedream55, seedream55ParameterRules, SEEDREAM55_FIELDS, SEEDREAM55_RATIOS } from "./seedream-capabilities.ts";
import { SUNO_FIELDS, SUNO_FIXED_PARAMETERS, SUNO_FORMATS, SUNO_LIMITS, SUNO_VARIETIES, sunoParameterRules, sunoV6 } from "./suno-capabilities.ts";
import { seedance, seedanceParameterRules, SEEDANCE_FIELDS, SEEDANCE_RATIOS, type SeedanceReferenceConstraints } from "./seedance-capabilities.ts";

type Modality = "text" | "image" | "audio" | "video";
export interface NativeModel {
  officialId: string;
  kind: DoneBotModelKind;
  protocol?: DoneBotProtocol;
  tools: boolean;
  input: Modality[];
  output: Modality[];
  contextWindow?: number;
  maxOutput?: number;
  outputLimits?: { sharedWithInput: boolean; streamingRequest: number; nonStreamingRequest: number; continuation?: { apiVersion: string; field: string } };
  structuredOutput?: boolean;
  streaming: boolean;
  reasoning?: { field: string; levels: string[]; default?: string; modes?: string[]; restrictions?: string[] };
  media?: {
    operations: string[];
    maxReferences?: { image: number; video: number; audio: number };
    mask?: boolean | "unverified";
    resolutions?: string[];
    aspectRatios?: string[];
    formats?: string[];
    referenceImage?: { formats: string[]; maxMegabytes: number; maxBytes?: number; minPixels?: number; maxPixels: number; maxRatio?: number; minEdgeExclusive?: number };
    referenceMedia?: SeedanceReferenceConstraints;
    videoOutput?: { fps: number; audioChannels: number; defaultResolution: string; defaultRatio: string; defaultFormat: string; defaultDuration?: number; movEncoding?: string; highResolutionHevc10Bit: string[] };
    prompt?: { languages: string[]; recommendedMax: { chineseCharacters: number; englishWords: number }; referenceAddressing: string };
    layerDecomposition?: {
      referenceCount: number;
      referenceImage: NonNullable<NonNullable<NativeModel["media"]>["referenceImage"]>;
      baseImages: number;
      maxLayers?: number;
      maxImages?: { min: number; max: number; default: number; includesBase: boolean };
      layerFormat: string;
      sizes: string[];
      defaultSize: string;
      metadata: string[];
      partialSuccess?: boolean;
      textRecognition?: { optional: boolean; default: boolean; promptMaySuppress: boolean };
    };
    musicGeneration?: { modes: string[]; fixedParameters: Record<string, unknown>; maxUnicodeCharacters: Record<string, number>; vocalGenders: string[]; weights: { min: number; max: number }; varieties: string[]; maxModePriceMultiplier: number; targetDurationOnly: boolean };
    draft?: { previewResolution: string; finalResolution: string; taskTtlDays: number; ttlEffectiveAt: string; separatelyBilled: boolean; inheritedFields: string[]; overridableFields: string[] };
    promptOptimization?: { field: string; modes: string[]; default: string };
    duration?: { min?: number; max: number; automatic: boolean };
    voices?: string[];
    customSize?: { minPixels?: number; maxPixels?: number; maxRatio: number; alignment?: number; maxEdge?: number; experimentalAbovePixels?: number };
    audioOnlyReference?: boolean;
    nativeAssetReferences?: boolean;
    explicitTaskTypes?: string[];
    qualities?: string[];
    backgrounds?: string[];
    transparentFormats?: string[];
    defaults?: { size: string; quality: string; background: string; output_format: string; complexity?: string };
    complexity?: { levels: string[]; default: string };
    animatedGif?: {
      operations: ("generate" | "edit")[];
      frameCount: { min: number; max: number; default: number };
      frameDurationMs: { min: number; max: number; default: number; rounding: number; encodedMax: number };
      size: { automatic: boolean; alignment: number; positiveDimensions: boolean; providerValidatedPixelBudget: boolean };
      requiresPreviewAccess: boolean;
      streaming: boolean;
      outputCompression: boolean;
    };
    versions?: string[];
    builtInTools?: string[];
    notes?: string[];
  };
  sources: string[];
  verifiedAt: string;
}

const VERIFIED = "2026-11-05";
const OPENAI = "https://developers.openai.com/api/docs/";
const CLAUDE = "https://platform.claude.com/docs/en/";
const GOOGLE = "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/";
const VOLC = "https://docs.volcengine.com/docs/ark/";
const APIMART_SEEDREAM = "https://docs.apimart.ai/cn/api-reference/images/seedream-5-0-flash/generation";
const APIMART_SUNO = "https://docs.apimart.ai/cn/api-reference/audios/suno/generation";
const imageRatios = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "2:1", "1:2", "21:9"];
const effort = ["low", "medium", "high", "xhigh", "max"];
const gptImage25Qualities = ["auto", "low", "medium", "high", "xhigh", "max"];
const gptImage25Size = { minPixels: 655_360, maxPixels: 8_294_400, maxRatio: 3, alignment: 16, maxEdge: 3840, experimentalAbovePixels: 3_686_400 };

function text(officialId: string, protocol: DoneBotProtocol, contextWindow: number, maxOutput: number, sources: string[], extra: Partial<NativeModel> = {}): NativeModel {
  return { officialId, kind: "text", protocol, tools: true, input: ["text", "image"], output: ["text"], contextWindow, maxOutput,
    structuredOutput: true, streaming: true, verifiedAt: VERIFIED, sources, ...extra };
}
function claude(id: string, defaultEffort: string, modes: string[], restrictions: string[]): NativeModel {
  return text(id, "messages", 1_000_000, 128_000, [`${CLAUDE}models/overview`, `${CLAUDE}build-with-claude/thinking`, `${CLAUDE}build-with-claude/effort`], {
    reasoning: { field: "output_config.effort", levels: effort, default: defaultEffort, modes, restrictions },
  });
}
function gpt(id: string, none = false): NativeModel {
  return text(id, "responses", 1_050_000, 128_000, [`${OPENAI}models/${id}`, `${OPENAI}guides/function-calling`], {
    reasoning: { field: "reasoning.effort", levels: none ? ["none", ...effort] : effort, ...(id === "gpt-6-astra" ? {} : { default: "medium" }) },
  });
}
function gemini(id: string): NativeModel {
  return text(id, "gemini", 1_048_576, id === "gemini-4-argon" ? 1_048_576 : 65_536, [`${GOOGLE}gemini/${id === "gemini-4-argon" ? "4-argon" : "3-8-flash"}`, `${GOOGLE}thinking`], {
    input: ["text", "image", "audio", "video"],
    ...(id === "gemini-4-argon" ? { outputLimits: { sharedWithInput: true, streamingRequest: 65_536, nonStreamingRequest: 32_768, continuation: { apiVersion: "v1beta1", field: "continuation_token" } } } : {}),
    reasoning: { field: "generationConfig.thinkingConfig.thinkingLevel", levels: ["LOW", "MEDIUM", "HIGH"], default: "MEDIUM",
      restrictions: ["MINIMAL and thinkingBudget are unsupported.", ...(id === "gemini-4-argon" ? ["The context limit includes both input and output. A single stream emits at most 65536 output tokens; non-streaming direct HTTP emits at most 32768. Long decoding needs v1beta1 continuation tokens."] : [])] },
  });
}
function gptImage(id: string): NativeModel {
  return { officialId: id, kind: "image", tools: false, input: ["text", "image"], output: ["image"], streaming: true,
    verifiedAt: "2026-11-06", sources: [`${OPENAI}models/${id}`, `${OPENAI}guides/image-generation`, `${OPENAI}guides/image-prompting?model=gpt-image-2.5`, "https://developers.openai.com/api/reference/resources/images/methods/edit"],
    media: { operations: ["generate", "edit", "mask_edit", "markup_edit"], maxReferences: { image: 16, video: 0, audio: 0 }, mask: true,
      formats: ["png", "jpeg", "webp"], qualities: [...gptImage25Qualities], backgrounds: ["auto", "opaque", "transparent"], transparentFormats: ["png", "webp"],
      defaults: { size: "auto", quality: "auto", background: "auto", output_format: "png" }, customSize: { ...gptImage25Size },
      notes: [id === "gpt-image-2.5-flare" ? "Small model optimized for speed and everyday image generation." : "Base model optimized for quality and precise image editing.",
        "Custom WIDTHxHEIGHT: multiples of 16; edge <=3840; ratio 1:3–3:1; 655360–8294400 total pixels. Above 3686400 pixels is experimental.",
        "quality controls rendering quality; it is not a reasoning or complexity parameter. Higher quality does not guarantee a better result for every prompt.",
        "Transparent output requires PNG or WebP; preserve and inspect the decoded alpha channel."] } };
}
function gptImage26(id: string): NativeModel {
  const model = gptImage(id);
  return { ...model, verifiedAt: "2026-11-07",
    sources: [`${OPENAI}models/${id}`, `${OPENAI}guides/image-generation`, `${OPENAI}guides/image-prompting?model=gpt-image-2.6`,
      "https://developers.openai.com/api/reference/resources/images/methods/generate", "https://developers.openai.com/api/reference/resources/images/methods/edit"],
    media: { ...model.media!, formats: ["png", "jpeg", "webp", "svg", "gif"], transparentFormats: ["png", "webp", "svg"],
      customSize: { alignment: 16, maxRatio: 3 },
      defaults: { ...model.media!.defaults!, complexity: "high" }, complexity: { levels: ["low", "medium", "high"], default: "high" },
      animatedGif: { operations: ["generate", "edit"], frameCount: { min: 2, max: 16, default: 9 },
        frameDurationMs: { min: 20, max: 2000, default: 200, rounding: 10, encodedMax: 655_350 },
        size: { automatic: true, alignment: 16, positiveDimensions: true, providerValidatedPixelBudget: true },
        requiresPreviewAccess: true, streaming: false, outputCompression: false },
      notes: [id.endsWith("-flare") ? "Small model optimized for fast iteration." : "Base model optimized for detail and precise image editing.",
        "complexity controls planning independently of quality; omit input_fidelity on edits. reasoning.summary is unsupported.",
        "Raster transparency is documented for PNG/WebP; verify the decoded alpha channel. Native SVG also supports transparency, but DoneBot disables SVG output.",
        "Animated GIF supports generation and still-reference edits. Frame size, frame count and n share a provider-enforced pixel budget; its numeric limits are not published.",
        "Native SVG generation is registered but disabled in DoneBot; SVG editing is unsupported."] } };
}
const MODELS: Readonly<Record<string, NativeModel>> = {
  "claude-fable-5-1": claude("claude-fable-5-1", "high", ["adaptive"], ["Thinking cannot be disabled; legacy enabled/budget_tokens is unsupported."]),
  "claude-haiku-5-5": claude("claude-haiku-5-5", "medium", ["adaptive", "disabled"], ["disabled is accepted only at high effort or below."]),
  "claude-opus-5-5": claude("claude-opus-5-5", "medium", ["adaptive"], ["Thinking cannot be disabled; legacy enabled/budget_tokens is unsupported."]),
  "claude-sonnet-5-5": claude("claude-sonnet-5-5", "high", ["adaptive", "between_tools"], ["disabled is unsupported; between_tools is accepted only at high effort or below."]),
  "deepseek-flash": text("DeepSeek-V4.1-Flash-1017", "chat", 1_000_000, 384_000,
    ["https://api-docs.deepseek.com/quick_start/pricing/", "https://api-docs.deepseek.com/news/news260910/"], {
      reasoning: { field: "thinking.type", levels: ["enabled", "disabled"], default: "enabled" },
    }),
  "gemini-3.8-flash": gemini("gemini-3.8-flash"),
  "gemini-4-argon": gemini("gemini-4-argon"),
  "glm-5.3-flash": text("glm-5.3-flash", "chat", 1_000_000, 131_072,
    ["https://docs.z.ai/guides/llm/glm-5.3-flash"], {
      verifiedAt: "2026-11-11",
      reasoning: { field: "reasoning_effort", levels: ["low", "high", "max"], default: "max" },
    }),
  "gpt-6-astra": gpt("gpt-6-astra"),
  "gpt-6.1-sol": gpt("gpt-6.1-sol"),
  "gpt-6.1-terra": gpt("gpt-6.1-terra", true),
  "gpt-image-2.5-flare": gptImage("gpt-image-2.5-flare"),
  "gpt-image-2.5-sunburst": gptImage("gpt-image-2.5-sunburst"),
  "gpt-image-2.6-flare": gptImage26("gpt-image-2.6-flare"),
  "gpt-image-2.6-sunburst": gptImage26("gpt-image-2.6-sunburst"),
  "seedance-2-0": seedance("doubao-seedance-2-0-260128", ["480p", "720p", "1080p", "4k"]),
  "seedance-2-0-fast": seedance("doubao-seedance-2-0-fast-260128", ["480p", "720p"]),
  "seedance-2-0-mini": seedance("doubao-seedance-2-0-mini-260615", ["480p", "720p"]),
  "seedance-2-5": seedance("doubao-seedance-2-5-260628", ["480p", "720p", "1080p"], true),
  "seedream-5-5": seedream55,
  "seedream-5-0-flash": { officialId: "doubao-seedream-5-0-flash-260915", kind: "image", tools: false, input: ["text", "image"], output: ["image"], streaming: false,
    verifiedAt: "2026-11-07", sources: [`${VOLC}image-generation-api?lang=zh`, `${VOLC}seedream-5-0-pro?lang=zh`, `${VOLC}seedream-5-0-pro-editing-guide?lang=zh`],
    media: { operations: ["generate", "reference_edit", "coordinate_edit", "layer_decomposition"], maxReferences: { image: 10, video: 0, audio: 0 }, mask: "unverified",
      resolutions: ["1K", "1.5K", "2K"], formats: ["png", "jpeg"],
      customSize: { minPixels: 921_600, maxPixels: 4_624_220, maxRatio: 16 },
      referenceImage: { formats: ["jpeg", "png", "webp", "bmp", "tiff", "gif", "heic", "heif"], maxMegabytes: 30, minPixels: 196, maxPixels: 36_000_000, maxRatio: 16, minEdgeExclusive: 14 },
      layerDecomposition: { referenceCount: 1, referenceImage: { formats: ["png", "jpeg"], maxMegabytes: 30, minPixels: 262_144, maxPixels: 36_000_000, maxRatio: 16 },
        baseImages: 1, maxLayers: 16, layerFormat: "png", sizes: ["auto", "1K", "1.5K", "2K"], defaultSize: "auto", metadata: ["z_index", "name", "description", "bounding_box.absolute", "bounding_box.normalized"], partialSuccess: false },
      promptOptimization: { field: "optimize_prompt_options.mode", modes: ["standard"], default: "standard" },
      notes: ["Single-image generation; no sequential generation, web search or streaming. Generation size defaults to 2K; output_format defaults to jpeg.",
        "Layer decomposition accepts an optional prompt and returns one base plus up to 16 transparent PNG layers. output_format controls only the base. Recompose layers using bounding_box and ascending z_index.",
        "Omitting prompt automatically decomposes all major elements. A natural-language prompt selects specific elements; <bbox> markers can precisely locate the elements to extract.",
        "For subject plus environment, select the complete subject as one transparent foreground layer and keep the remaining environment together in the base. Target one base plus one foreground, rather than extracting background as another foreground layer. Exact output count is not guaranteed by a separate parameter.",
        "Coordinate edits use prompt <point> or <bbox> markers normalized to 0..999; layer bounding_box.normalized response coordinates use 0..1000."] } },
  "suno": sunoV6,
  "gpt-4o-mini-tts": { officialId: "gpt-4o-mini-tts", kind: "audio", tools: false, input: ["text"], output: ["audio"], contextWindow: 2000, streaming: true,
    verifiedAt: VERIFIED, sources: [`${OPENAI}models/gpt-4o-mini-tts`, `${OPENAI}guides/text-to-speech`],
    media: { operations: ["speech"], formats: ["mp3", "opus", "aac", "flac", "wav", "pcm"],
      voices: ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"],
      notes: ["Native input limit is 2000 tokens. Gateway input limit is separately 4096 Unicode characters.", "Native speech style instructions do not imply voice cloning, ASR or live calls."] } },
};

export function nativeModel(id: string): NativeModel | undefined {
  const model = Object.hasOwn(MODELS, id) ? MODELS[id] : undefined;
  return model ? structuredClone(model) : undefined;
}

const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
const interfaces: Record<DoneBotProtocol, string> = { messages: "anthropic.messages", gemini: "gemini.generate_content", responses: "openai.responses", chat: "openai.chat_completions" };
const mediaAdapters: Readonly<Record<string, string>> = {
  "gpt-image-2.5-flare": "donebot.images.async.v1",
  "gpt-image-2.5-sunburst": "donebot.images.async.v1",
  "gpt-image-2.6-flare": "donebot.images.async.v1",
  "gpt-image-2.6-sunburst": "donebot.images.async.v1",
  "seedream-5-5": "apimart.images.v1",
  "seedream-5-0-flash": "apimart.images.v1",
  "seedance-2-0": "seedance.videos.v1",
  "seedance-2-0-fast": "seedance.videos.v1",
  "seedance-2-0-mini": "seedance.videos.v1",
  "seedance-2-5": "seedance.videos.v1",
  suno: "apimart.music.v1",
  "gpt-4o-mini-tts": "apimart.speech.v1",
};
const expectedMediaInterface: Record<string, string> = { image: "openai.images", video: "openai.videos", music: "openai.music", audio: "openai.audio.speech" };
const gptImageFields = ["model", "prompt", "images", "n", "size", "quality", "background", "output_format", "output_compression", "moderation", "response_format", "user", "safety_identifier"];
const seedreamFields = ["model", "prompt", "image_urls", "n", "size", "resolution", "layer_decomposition", "background", "output_format", "watermark", "optimize_prompt_options"];

function parameterRules(native: NativeModel, adapter: unknown) {
  if (adapter === "donebot.images.async.v1") return {
    fields: [...gptImageFields.filter(x => x !== "model"), ...(native.media?.animatedGif ? ["frame_count", "frame_duration_ms"] : [])], required: ["prompt"],
    references: "edit operation: images:[{image_url:{local_path:'/allowed/reference.png'}}]; up to 16 images. Use generate without images.",
    rules: ["Mask fields are forbidden by the gateway. The native markup overlay field is not connected in this client; use an annotated reference image plus prompt through edit instead.",
      "n=1..10. Static image size=auto or WIDTHxHEIGHT. Each edge must be a multiple of 16 and <=3840; aspect ratio 1:3–3:1; total pixels 655360..8294400. Above 3686400 pixels is experimental, not forbidden.",
      `quality=auto(default)/low/medium/high/xhigh/max controls rendering quality. ${native.media?.complexity ? "DoneBot always sends complexity=high; do not offer complexity choices or send reasoning fields." : "Do not send reasoning or complexity fields."} Set size and quality as parameters, not only in prompt.`,
      "background=auto(default)/opaque/transparent; output_format=png(default)/jpeg/webp. Transparent output requires PNG or WebP; output_compression=0..100 requires JPEG or WebP.",
      "Requested controls are not proof of output properties. Inspect actual image dimensions and decoded alpha before claiming exact pixel size or successful transparent output; a painted checkerboard is not transparency.",
      "response_format=url/b64_json is a DoneBot gateway compatibility option, not a native GPT Image parameter.",
      ...(native.media?.animatedGif ? ["SVG output and svg settings are forbidden in DoneBot. GIF uses output_format=gif through generate, or edit with still references. frame_count=2..16(default9); frame_duration_ms=20..2000(default200), rounded to 10ms by the provider. These fields require GIF output.",
        "GIF size=auto or positive WIDTHxHEIGHT with both edges divisible by 16; the static minimum pixel count does not apply (512x512 is a documented GIF example). The provider enforces the selected model's frame/size/n pixel budget and requires GIF preview access. GIF has no streaming, partial images, masks or output_compression. Transparent output is limited to PNG/WebP.",
        "For static 2.6 images, DoneBot keeps the 2.5 pixel and edge limits as product policy; the 2.6 native registration only claims the documented alignment and ratio."] : [])],
  };
  if (adapter === "apimart.images.v1" && native.officialId === "seedream-5-5") return seedream55ParameterRules;
  if (adapter === "apimart.images.v1") return {
    fields: seedreamFields.filter(x => x !== "model"), required: [],
    references: "generate operation: image_urls:[{local_path:'/allowed/reference.png'}]; up to 10 images for ordinary generation, exactly one for layer decomposition.",
    rules: ["Prompt required unless layer_decomposition=true. Coordinate edits use <point> or <bbox> markers normalized to 0..999 in prompt; annotated references may also be described in prompt.",
      "n=1; size=auto/1K/1.5K/2K, an available gateway aspect ratio, or WIDTHxHEIGHT with 921600..4624220 total pixels and ratio 1:16..16:1. No 4K tier.",
      "APIMart resolution=1K(default)/1.5K/2K is an adapter extension. A tier in size takes precedence; custom pixel size ignores resolution. Ratio size uses resolution. 1.5K and 1K share a billing tier; prices come from the current gateway catalog.",
      "Layer decomposition requires exactly one PNG/JPEG reference, 262144..36000000 pixels, <=30 MB. size accepts only auto(default)/1K/1.5K/2K, with no ratio or custom pixels. Output is one base plus at most 16 transparent PNG layers; output_format controls only the base.",
      "For layer decomposition, omit prompt only when automatic extraction of all major elements is wanted. For selected objects, name the complete subjects in prompt; optionally locate each with <bbox>x1 y1 x2 y2</bbox>. Inspect the reference before choosing boxes; normalize source-image coordinates to integers 0..999, not raw pixels or guessed locations.",
      "For N selected foreground subjects plus an environment background, ask for N complete foreground layers and keep all remaining environment together in the base: target N+1 images including that base. Do not count the base as another extracted foreground. n=1 is not a layer-count control; there is no layer_count parameter and prompt selection is not an exact output-count guarantee.",
      "Any failed layer fails the whole decomposition. A generic HTTP 400 does not prove selected-object decomposition is unsupported. Inspect actual output count, complete subject content, environment base and decoded alpha before claiming the requested split succeeded; preserve bounding_box and z_index for recomposition. Do not automatically repeat a paid generation to reach a desired count.",
      "background=transparent requires one reference already containing alpha and output_format=png; this is transparent-reference editing, not text-to-transparent-image generation. Do not set it just to decompose an opaque JPEG/PNG: decomposition already returns transparent PNG layers. Output formats: png/jpeg(default).",
      "optimize_prompt_options={mode:'standard'} is optional and defaults to standard; fast mode is unsupported. watermark is boolean."],
    examples: [
      { purpose: "Automatically decompose all major elements", operation: "generate", parameters: { image_urls: [{ local_path: "/allowed/reference.jpg" }], layer_decomposition: true, size: "1.5K" } },
      { purpose: "One complete subject layer plus one environment base; adapt the subject and surroundings to the actual reference", operation: "generate",
        parameters: { prompt: "仅将完整的小老虎主体拆为一个独立透明图层，保留身体、四肢、尾巴和毛发。其余草地、花朵、树林、阳光和光斑全部保留在同一张环境底图中，不再单独拆分。",
          image_urls: [{ local_path: "/allowed/reference.jpg" }], layer_decomposition: true, size: "1.5K" } },
    ],
  };
  if (adapter === "seedance.videos.v1") return seedanceParameterRules(native);
  if (adapter === "apimart.music.v1") return sunoParameterRules;
  return undefined;
}

function registeredModelCapabilities(model: DoneBotGatewayModel) {
  const native = nativeModel(model.id);
  const adapter = record(model.media_parameters?.protocol)?.adapter;
  const matched = native && model.media_types.includes(native.kind) && (native.kind === "text" ? Object.values(interfaces).some(iface => model.interfaces.includes(iface)) : model.interfaces.includes(expectedMediaInterface[native.kind]!));
  const supported = Boolean(matched && (native?.kind === "text" ? true : typeof adapter === "string" && mediaAdapters[model.id] === adapter));
  const clientInput = native?.input.filter(modality => native.kind === "text" ? modality === "text" || modality === "image" : native.kind !== "music" || modality === "text") ?? [];
  const operations = native?.kind === "text" ? ["conversation", ...(model.capabilities?.tool_calling === true ? ["tool_calling"] : [])] : native?.kind === "music" ? ["generate", "custom_lyrics", "instrumental"] : native?.media?.operations.filter(x => !["mask_edit", "markup_edit"].includes(x)) ?? [];
  const fixedParameters: Record<string, unknown> | undefined = native?.kind === "music" ? SUNO_FIXED_PARAMETERS : native?.kind === "video" ? { generate_audio: true } : native?.media?.complexity ? { complexity: "high" } : undefined;
  const referenceBytes = native?.media?.referenceMedia ? native.media.referenceMedia.video.maxMegabytes * 1024 * 1024 : native?.media?.referenceImage?.maxBytes ?? MAX_MEDIA_REFERENCE_BYTES;
  return { model: model.id, native: native ?? null,
    gateway: { capabilities: model.capabilities ?? {}, parameters: model.media_parameters ?? {}, ...(adapter === "apimart.images.v1" ? { adapterSources: [model.id === "seedream-5-5" ? SEEDREAM55_SOURCE : APIMART_SEEDREAM] } : adapter === "apimart.music.v1" ? { adapterSources: [APIMART_SUNO] } : {}), ...(native?.media?.mask === true ? { maskEditing: false, restriction: "DoneBot gateway forbids GPT Image mask edits.", responseFormatCompatibility: ["url", "b64_json"] } : {}) },
    client: { implemented: supported, input: clientInput, operations: supported ? operations : [],
      delivery: native?.kind === "text" || native?.kind === "audio" ? "streaming" : "async", referenceTransport: "gateway_asset_url",
      imageEditEndpoint: native?.kind === "image" && adapter === "donebot.images.async.v1", videoEditAndExtend: supported && native?.kind === "video" && native.media?.operations.includes("edit"),
      ...(native?.media?.operations.includes("markup_edit") ? { markupOverlay: false, annotatedReferenceEdits: supported } : {}),
      fixedParameters,
      ...(native?.media?.complexity ? { svgOutput: false,
        outputFormats: ["png", "jpeg", "webp", "gif"].filter(format => !strings(model.media_parameters?.formats)?.length || strings(model.media_parameters?.formats)!.includes(format)),
        staticSizePolicy: { ...gptImage25Size } } : {}),
      ...(native?.kind === "video" ? { defaultMode: "multimodal_reference", modeSwitch: "Only when explicitly requested by the person.",
        outputFormats: native.media!.formats!.filter(format => !strings(model.media_parameters?.formats)?.length || strings(model.media_parameters?.formats)!.includes(format)),
        unavailableNativeFeatures: [...(native.media?.draft ? ["draft"] : []), ...(native.media?.builtInTools ?? [])],
        referenceValidation: { local: ["file_type", "file_size", "reference_count", "roles", "parameter_values"], provider: ["dimensions", "aspect_ratio", "total_pixels", "codecs", "fps", "per_file_duration", "summed_duration", "portrait_authorization"] } } : {}),
      ...(native?.officialId === "seedream-5-5" ? { referenceValidation: { local: ["file_type", "file_size", "reference_count", "parameter_values"], provider: ["total_pixels", "decoded_format"] } } : {}),
      referenceLimits: { maxFiles: native?.media?.referenceMedia?.maxTotalFiles ?? native?.media?.maxReferences?.image ?? MAX_MEDIA_REFERENCE_FILES, maxBytesPerFile: referenceBytes,
        ...(native?.kind === "video" ? { conversationFileMaxBytes: referenceBytes, generatedArtifactMaxBytes: referenceBytes,
          restriction: "Per-type model limits and the gateway's independently configured upload policy both apply. Chat attachment upload limits are separate; larger allowed files can be read from the conversation workspace." } : {}) },
      textAudioVideoInput: false, reasoningOverride: false, longDecoding: false,
      ...(native?.outputLimits ? { maxOutputPerRequest: native.outputLimits.streamingRequest } : {}),
      ...(native ? { parameterRules: parameterRules(native, supported ? adapter : undefined) } : {}),
      ...(native?.kind === "audio" ? { streaming: true, playbackFormat: "pcm", inputLimit: { maxUnicodeCharacters: 4096, nativeTokenLimit: 2000 } } : {}) },
    availability: { inCatalog: true, locallyVerified: Boolean(native), usable: supported, reason: supported ? null : !native ? "Exact model ID needs official local registration." : "Model kind, native interface or client adapter is unavailable." } };
}

export function modelCapabilities(model: DoneBotGatewayModel) {
  const base = registeredModelCapabilities(model);
  if (nativeModel(model.id)) return base;
  const mediaKinds = { "donebot.images.async.v1": "image", "apimart.images.v1": "image", "apimart.music.v1": "music", "seedance.videos.v1": "video", "apimart.speech.v1": "audio" } as const;
  const adapter = record(model.media_parameters?.protocol)?.adapter;
  const kind = typeof adapter === "string" && Object.hasOwn(mediaKinds, adapter) ? mediaKinds[adapter as keyof typeof mediaKinds] : undefined;
  const text = model.media_types.includes("text") && Object.values(interfaces).some(iface => model.interfaces.includes(iface));
  const supported = text || Boolean(kind && model.media_types.includes(kind) && model.interfaces.includes(expectedMediaInterface[kind]!));
  return { ...base,
    client: { ...base.client, implemented: supported, input: ["text"], operations: supported ? [text ? "conversation" : "generate"] : [], delivery: text || kind === "audio" ? "streaming" : "async" },
    availability: { inCatalog: true, locallyVerified: false, usable: supported, reason: supported ? null : "Unsupported gateway interface or adapter." } };
}

function fail(message: string): never { throw new Error(`Media capability validation failed: ${message}`); }
function choice(value: unknown, allowed: string[], name: string): void {
  if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) fail(`${name} must be one of ${allowed.join(", ")}.`);
}
function integer(value: unknown, min: number, max: number, name: string): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)) fail(`${name} must be an integer from ${min} to ${max}.`);
}
function requiredText(value: unknown, name: string): void { if (typeof value !== "string" || !value.trim()) fail(`${name} is required.`); }
function optionalText(value: unknown, name: string, max?: number): void {
  if (value !== undefined && (typeof value !== "string" || max !== undefined && Array.from(value).length > max)) fail(`${name} must be text${max === undefined ? "" : ` of at most ${max} Unicode characters`}.`);
}
function url(value: unknown): void {
  if (typeof value !== "string") fail("References must contain gateway asset URLs.");
  let parsed: URL;
  try { parsed = new URL(value); } catch { return fail("Invalid reference URL."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) fail("References must use gateway HTTPS asset URLs.");
}
function knownFields(parameters: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(parameters)) if (!allowed.includes(key)) fail(`The current adapter has no verified ${key} parameter.`);
}
function referenceList(value: unknown, max: number, nested?: string): number {
  if (value === undefined) return 0;
  if (!Array.isArray(value) || value.length > max) fail(`Reference count cannot exceed ${max}.`);
  for (const entry of value) {
    if (nested) {
      const obj = record(entry);
      if (!obj || Object.keys(obj).some(key => key !== nested)) fail(`Reference entries must contain only ${nested}.`);
      url(obj[nested]);
    } else url(entry);
  }
  return value.length;
}

function gatewayChoices(model: DoneBotGatewayModel, parameters: Record<string, unknown>): void {
  const seedreamSize = model.id === "seedream-5-0-flash" && typeof parameters.size === "string" ? parameters.size : undefined;
  const seedreamPixels = seedreamSize ? /^(\d+)x(\d+)$/.exec(seedreamSize) : null;
  const fields: [string, string][] = [["resolution", "resolutions"], ["ratio", "aspect_ratios"], ["voice", "voices"], ["response_format", "formats"], ["output_format", "formats"], ["audio_format", "formats"], ["version", "music_versions"]];
  for (const [field, catalog] of fields) {
    if (field === "response_format" && model.media_types.includes("image")) continue;
    if (field === "resolution" && (seedreamPixels || seedreamSize && ["1K", "1.5K", "2K"].includes(seedreamSize))) continue;
    const options = strings(model.media_parameters?.[catalog]);
    if (options?.length) choice(parameters[field], options, field);
  }
  const sizes = strings(model.media_parameters?.sizes);
  if (sizes?.length) {
    if (seedreamPixels) {
      const tiers = Number(seedreamPixels[1]) * Number(seedreamPixels[2]) > 2_601_124 ? ["2K"] : ["1K", "1.5K"];
      const resolutions = strings(model.media_parameters?.resolutions);
      if (!tiers.some(tier => sizes.includes(tier)) || resolutions?.length && !tiers.some(tier => resolutions.includes(tier))) fail("Custom pixels require a currently available gateway resolution tier.");
    } else choice(parameters.size, [...sizes, ...(strings(model.media_parameters?.aspect_ratios) ?? [])], "size");
  }
  const duration = record(model.media_parameters?.duration_seconds);
  if (duration && parameters.duration !== undefined) {
    const seconds = parameters.duration;
    if (seconds === -1 && duration.automatic === true) return;
    if (typeof duration.min !== "number" || typeof duration.max !== "number" || typeof duration.step !== "number" || duration.step <= 0 ||
      typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < duration.min || seconds > duration.max || (seconds - duration.min) % duration.step !== 0 || duration.requires_custom === true && parameters.custom !== true) fail("duration exceeds the current gateway model limits.");
  }
}

function validateGptImage(native: NativeModel, p: Record<string, unknown>, operation: string): void {
  if (Object.hasOwn(p, "mask") || Object.hasOwn(p, "input_image_mask")) fail("GPT Image native mask editing is disabled by the DoneBot gateway.");
  const animation = native.media?.animatedGif;
  knownFields(p, [...gptImageFields, ...(animation ? ["complexity", "frame_count", "frame_duration_ms"] : [])]);
  if (native.media?.complexity) choice(p.complexity, ["high"], "complexity (fixed by DoneBot)");
  requiredText(p.prompt, "prompt");
  const count = referenceList(p.images, 16, "image_url");
  if (operation === "edit" && count === 0) fail("Image editing requires images[].image_url references.");
  if (operation !== "edit" && count) fail("Use the edit operation for reference-image generation.");
  integer(p.n, 1, 10, "n");
  choice(p.quality, gptImage25Qualities, "quality");
  choice(p.background, ["auto", "transparent", "opaque"], "background");
  choice(p.output_format, ["png", "jpeg", "webp", ...(animation ? ["gif"] : [])], "output_format");
  choice(p.response_format, ["url", "b64_json"], "response_format");
  choice(p.moderation, ["auto", "low"], "moderation");
  optionalText(p.user, "user");
  optionalText(p.safety_identifier, "safety_identifier", 128);
  integer(p.output_compression, 0, 100, "output_compression");
  if (p.background === "transparent" && p.output_format !== undefined && p.output_format !== "png" && p.output_format !== "webp") fail("Transparent output needs PNG or WebP.");
  if (p.output_compression !== undefined && p.output_format !== "jpeg" && p.output_format !== "webp") fail("output_compression needs JPEG or WebP.");
  const gif = p.output_format === "gif";
  if (!gif && (p.frame_count !== undefined || p.frame_duration_ms !== undefined)) fail("frame_count and frame_duration_ms require GIF output.");
  if (gif && animation) {
    integer(p.frame_count, animation.frameCount.min, animation.frameCount.max, "frame_count");
    integer(p.frame_duration_ms, animation.frameDurationMs.min, animation.frameDurationMs.max, "frame_duration_ms");
  }
  if (p.size !== undefined && p.size !== "auto") {
    const match = typeof p.size === "string" ? /^(\d+)x(\d+)$/.exec(p.size) : null;
    if (!match) fail("size must be auto or WIDTHxHEIGHT.");
    const width = Number(match[1]), height = Number(match[2]), area = width * height;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width % gptImage25Size.alignment || height % gptImage25Size.alignment) fail("size requires positive safe integer dimensions divisible by 16.");
    if (!gif && (Math.max(width, height) > gptImage25Size.maxEdge || Math.max(width / height, height / width) > gptImage25Size.maxRatio || area < gptImage25Size.minPixels || area > gptImage25Size.maxPixels)) fail("size exceeds the DoneBot GPT Image static pixel, ratio or edge limits.");
  }
}

function validateSeedream(p: Record<string, unknown>): void {
  knownFields(p, seedreamFields);
  optionalText(p.prompt, "prompt");
  const count = referenceList(p.image_urls, 10);
  if (p.layer_decomposition !== true) requiredText(p.prompt, "prompt");
  if (p.layer_decomposition === true && count !== 1) fail("Layer decomposition requires exactly one image.");
  if (p.n !== undefined && p.n !== 1) fail("Seedream 5.0 Flash produces one image per generation.");
  if (p.background === "transparent" && (count !== 1 || p.output_format !== "png")) fail("Transparent Seedream output requires one reference and PNG output.");
  choice(p.background, ["transparent", "opaque"], "background");
  choice(p.resolution, ["1K", "1.5K", "2K"], "resolution");
  const pixelSize = typeof p.size === "string" ? /^(\d+)x(\d+)$/.exec(p.size) : null;
  if (pixelSize) {
    const width = Number(pixelSize[1]), height = Number(pixelSize[2]), area = width * height;
    if (p.layer_decomposition === true || width <= 0 || height <= 0 || area < 921_600 || area > 4_624_220 || Math.max(width / height, height / width) > 16) fail("Seedream pixels exceed the official generation limits or are incompatible with layer decomposition.");
  } else choice(p.size, ["auto", "1K", "1.5K", "2K", ...(p.layer_decomposition === true ? [] : imageRatios)], "size");
  choice(p.output_format, ["png", "jpeg"], "output_format");
  if (p.optimize_prompt_options !== undefined) {
    const options = record(p.optimize_prompt_options);
    if (!options) fail("optimize_prompt_options must be an object.");
    knownFields(options, ["mode"]);
    choice(options.mode, ["standard"], "optimize_prompt_options.mode");
  }
}

function validateSeedream55(p: Record<string, unknown>): void {
  knownFields(p, SEEDREAM55_FIELDS);
  optionalText(p.prompt, "prompt");
  const count = referenceList(p.image_urls, 10), layer = p.layer_decomposition === true;
  if (layer && count !== 1) fail("Layer decomposition requires exactly one image.");
  if (!layer) requiredText(p.prompt, "prompt");
  if (p.n !== undefined && p.n !== 1) fail("Seedream 5.5 n must be 1.");
  if (layer && p.background !== undefined) fail("Layer decomposition cannot include background.");
  choice(p.background, ["auto", "transparent", "opaque"], "background");
  choice(p.output_format, ["png", "jpeg"], "output_format");
  if (p.background === "transparent" && p.output_format === "jpeg") fail("Transparent output requires PNG.");
  const tiers = ["auto", "1K", "1.5K", "2K"];
  const size = p.size ?? (layer ? p.resolution : undefined);
  if (layer) choice(size, tiers, "layer size");
  else {
    choice(p.resolution, tiers.slice(1), "resolution");
    const ratio = typeof size === "string" ? size.replaceAll("x", ":") : "";
    if (!SEEDREAM55_RATIOS.includes(ratio)) {
      const pixels = typeof size === "string" ? /^(\d+)x(\d+)$/.exec(size) : null;
      if (pixels) {
        const w = Number(pixels[1]), h = Number(pixels[2]), area = w*h;
        if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0 || area < 921_600 || area > 4_624_220 || w/h < 1/16 || w/h > 16) fail("Seedream pixel area or aspect ratio exceeds supported limits.");
        if (p.resolution !== undefined) fail("Exact pixel size cannot include resolution.");
      } else choice(size, tiers, "size");
    }
  }
  if (p.layer_decomposition_options !== undefined) {
    const options = record(p.layer_decomposition_options);
    if (!layer || !options) fail("layer_decomposition_options requires layer_decomposition=true and an object.");
    knownFields(options, ["max_images", "text_recognition"]);
    integer(options.max_images, 2, 100, "max_images");
    if (options.text_recognition !== undefined && typeof options.text_recognition !== "boolean") fail("text_recognition must be boolean.");
  }
  if (p.optimize_prompt_options !== undefined) {
    const options = record(p.optimize_prompt_options);
    if (!options) fail("optimize_prompt_options must be an object.");
    knownFields(options, ["mode"]);
    choice(options.mode, ["standard"], "optimize_prompt_options.mode");
  }
}

function validateSeedance(native: NativeModel, p: Record<string, unknown>): void {
  knownFields(p, SEEDANCE_FIELDS);
  if (p.generate_audio !== undefined && p.generate_audio !== true) fail("DoneBot requires generate_audio=true.");
  if (!Array.isArray(p.content) || !p.content.length) fail("Seedance requires native content[].");
  let first = 0, last = 0, textCount = 0, images = 0, videos = 0, audios = 0;
  for (const item of p.content) {
    const part = record(item);
    if (!part) fail("Invalid Seedance content part.");
    if (part.type === "text") { knownFields(part, ["type", "text"]); requiredText(part.text, "content[].text"); textCount++; continue; }
    if (!["image_url", "video_url", "audio_url"].includes(String(part.type))) fail("Unsupported Seedance content type.");
    knownFields(part, ["type", String(part.type), "role"]);
    const data = record(part[String(part.type)]);
    if (data) knownFields(data, ["url"]);
    url(data?.url);
    const role = part.role;
    if (part.type === "image_url") {
      choice(role, ["first_frame", "last_frame", "reference_image"], "image role");
      if (role === "first_frame" || role === undefined) first++;
      else if (role === "last_frame") last++;
      else images++;
    } else if (part.type === "video_url") { if (role !== "reference_video") fail("Video input requires reference_video role."); videos++; }
    else { if (role !== "reference_audio") fail("Audio input requires reference_audio role."); audios++; }
  }
  if (!textCount) fail("The gateway video adapter requires a text prompt.");
  if (first > 1 || last > 1 || last > first || (first + last > 0 && images + videos + audios > 0)) fail("First/last frame and reference modes cannot be mixed.");
  const limits = native.media!.maxReferences!;
  if (images > limits.image || videos > limits.video || audios > limits.audio) fail("Seedance reference count exceeds this model's official limit.");
  if (audios && !images && !videos && !native.media!.audioOnlyReference) fail("This Seedance model requires a visual reference with audio.");
  choice(p.resolution, native.media!.resolutions!, "resolution");
  requiredText(p.resolution, "resolution");
  choice(p.ratio, SEEDANCE_RATIOS, "ratio");
  const duration = native.media!.duration!;
  if (p.duration !== -1) integer(p.duration, duration.min!, duration.max, "duration");
  integer(p.execution_expires_after, 3600, 259200, "execution_expires_after");
  integer(p.priority, 0, 9, "priority");
  optionalText(p.safety_identifier, "safety_identifier", 64);
  if (typeof p.safety_identifier === "string" && !/^[ -~]*$/.test(p.safety_identifier)) fail("safety_identifier must be an ASCII identifier.");
  if (p.output_format !== undefined && !native.media?.explicitTaskTypes) fail("output_format selection is only documented for Seedance 2.5; Seedance 2.0 outputs MP4.");
  choice(p.output_format, native.media?.formats ?? [], "output_format");
  if (p.omni_reference_task_type !== undefined && !native.media?.explicitTaskTypes) fail("omni_reference_task_type is a Seedance 2.5 parameter.");
  choice(p.omni_reference_task_type, native.media?.explicitTaskTypes ?? [], "omni_reference_task_type");
  if (first + last && p.omni_reference_task_type !== undefined) fail("Frame mode cannot use omni_reference_task_type.");
  if (first + last && native.media!.audioOnlyReference && p.ratio !== "adaptive") fail("Seedance 2.5 frame mode requires ratio=adaptive.");
  if (p.omni_reference_task_type === "edit" && (!videos || p.ratio !== "adaptive" || p.duration !== -1)) fail("Video edit requires reference video, ratio=adaptive and duration=-1.");
  if (p.omni_reference_task_type === "extend" && (!videos || p.ratio !== "adaptive" || p.duration === undefined)) fail("Video extension requires reference video, ratio=adaptive and total duration (or -1).");
}

function validateSuno(p: Record<string, unknown>): void {
  knownFields(p, SUNO_FIELDS);
  if (p.auto_lyrics !== false) fail("DoneBot Suno generation requires auto_lyrics=false; automatic lyric rewriting is unavailable.");
  if (p.version !== "v6") fail("DoneBot music generation uses Suno v6 only.");
  if (p.custom !== true) fail("DoneBot music generation requires custom mode.");
  if (typeof p.instrumental !== "boolean") fail("Choose instrumental=true for pure music or false for songs with lyrics.");
  if (p.instrumental) {
    if (p.prompt !== undefined) fail("Instrumental music omits prompt; put the arrangement in style.");
    if (p.vocal_gender !== undefined) fail("vocal_gender is only available for songs with lyrics.");
  } else requiredText(p.prompt, "prompt (complete lyrics)");
  optionalText(p.prompt, "prompt", SUNO_LIMITS.lyrics);
  optionalText(p.title, "title", SUNO_LIMITS.title);
  optionalText(p.style, "style", SUNO_LIMITS.style);
  optionalText(p.negative_tags, "negative_tags");
  integer(p.duration, SUNO_LIMITS.duration.min, SUNO_LIMITS.duration.max, "duration");
  choice(p.audio_format, SUNO_FORMATS, "audio_format");
  choice(p.variety, SUNO_VARIETIES, "variety");
  choice(p.vocal_gender, ["Male", "Female", "m", "f", "male", "female"], "vocal_gender");
  for (const name of ["style_weight", "weirdness_constraint", "audio_weight"]) {
    const value = p[name];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) fail(`${name} must be between 0 and 1.`);
  }
}

export function validateMediaParameters(model: DoneBotGatewayModel, parameters: Record<string, unknown>, operation: "generate" | "edit" | "extend"): void {
  const native = nativeModel(model.id);
  const status = modelCapabilities(model);
  if (!native || native.kind === "text" || !status.availability.usable) fail("This exact model and media adapter need verified local registration.");
  if (parameters.model !== undefined && parameters.model !== model.id) fail("Parameter model differs from the selected model.");
  for (const field of ["custom", "instrumental", "max_mode", "auto_lyrics", "nsfw_check", "layer_decomposition", "watermark", "generate_audio", "camera_fixed", "return_last_frame", "draft"]) {
    if (parameters[field] !== undefined && typeof parameters[field] !== "boolean") fail(`${field} must be boolean.`);
  }
  if (operation === "edit" && native.kind === "image" && record(model.media_parameters?.protocol)?.adapter !== "donebot.images.async.v1") fail("This image adapter has no image edit endpoint.");
  if (operation === "extend" && native.kind !== "video") fail("Only video tasks can be extended.");
  gatewayChoices(model, parameters);
  if (native.kind === "image" && native.media?.mask === true) validateGptImage(native, parameters, operation);
  else if (native.officialId === "seedream-5-5") validateSeedream55(parameters);
  else if (native.kind === "image") validateSeedream(parameters);
  else if (native.kind === "video") validateSeedance(native, parameters);
  else if (native.kind === "music") validateSuno(parameters);
  else fail("Speech uses the existing streaming voice flow.");
}
