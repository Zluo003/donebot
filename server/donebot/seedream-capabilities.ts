import type { NativeModel } from "./capabilities.ts";
import type { MediaReferencePolicy } from "./media-assets.ts";

export const SEEDREAM55_SOURCE = "https://docs.apimart.ai/cn/api-reference/images/seedream-5-5/generation";
export const SEEDREAM55_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "2:1", "1:2", "21:9"];
export const SEEDREAM55_FIELDS = ["model", "prompt", "image_urls", "size", "resolution", "background", "output_format", "n", "watermark", "optimize_prompt_options", "layer_decomposition", "layer_decomposition_options"];
export const SEEDREAM55_REFERENCE_LIMITS = { formats: ["jpeg", "png", "webp", "bmp", "tiff", "gif", "heic", "heif"], maxMegabytes: 30, maxBytes: 30 * 1024 * 1024, maxPixels: 36_000_000 };

export const seedream55: NativeModel = {
  officialId: "seedream-5-5", kind: "image", tools: false, input: ["text", "image"], output: ["image"], streaming: false,
  verifiedAt: "2026-11-11", sources: [SEEDREAM55_SOURCE],
  media: { operations: ["generate", "reference_edit", "layer_decomposition"], maxReferences: { image: 10, video: 0, audio: 0 },
    resolutions: ["1K", "1.5K", "2K"], aspectRatios: SEEDREAM55_RATIOS, formats: ["png", "jpeg"],
    backgrounds: ["auto", "transparent", "opaque"], transparentFormats: ["png"],
    referenceImage: SEEDREAM55_REFERENCE_LIMITS,
    layerDecomposition: { referenceCount: 1, referenceImage: SEEDREAM55_REFERENCE_LIMITS, baseImages: 1,
      maxImages: { min: 2, max: 100, default: 30, includesBase: true }, layerFormat: "png", sizes: ["auto", "1K", "1.5K", "2K"], defaultSize: "auto",
      metadata: ["z_index", "name", "description", "bounding_box", "text_recognition"], textRecognition: { optional: true, default: false, promptMaySuppress: true } },
    customSize: { minPixels: 921_600, maxPixels: 4_624_220, maxRatio: 16 },
    promptOptimization: { field: "optimize_prompt_options.mode", modes: ["standard"], default: "standard" },
    notes: ["Generation defaults to 2K and PNG. Layer size defaults to auto; size takes precedence over resolution.",
      "Layer decomposition requires exactly one reference, excludes background, and accepts layer_decomposition_options.max_images=2..100 (default 30, including the base) and text_recognition=true/false.",
      "All input references are billed separately. Layers are billed individually by actual pixel area. OCR metadata is optional."] },
};

export const seedream55ParameterRules = {
  fields: SEEDREAM55_FIELDS.filter(field => field !== "model"), required: [],
  references: "Use image_urls:[{local_path:'/allowed/reference.png'}]. Generation accepts 0..10 references; layer decomposition requires exactly one.",
  rules: ["Prompt is required for generation and optional for layer decomposition. n=1; no streaming, tools or sequential_image_generation.",
    "size=1K/1.5K/2K/auto (default 2K), a ratio 1:1/4:3/3:4/16:9/9:16/3:2/2:3/21:9/2:1/1:2 (also 16x9 notation), or WIDTHxHEIGHT. Pixel area must be 921600..4624220; width/height 1/16..16. No 3K or 4K.",
    "With a ratio, resolution=1K/1.5K/2K (default 2K). Omit resolution for exact pixel sizes.",
    "background=auto(default)/transparent/opaque. Transparent generation works without references and requires output_format=png(default); jpeg is also supported for opaque images.",
    "layer_decomposition=true requires one reference and no background field. size (or resolution when size is omitted) must be auto/1K/1.5K/2K, default auto. layer_decomposition_options={max_images:2..100,text_recognition:boolean}; max_images defaults to 30 including the base. It is a maximum, not a guaranteed count. OCR is optional, defaults false; supplying prompt may suppress OCR. Omit prompt when OCR is the main goal, without assuming OCR will be returned.",
    "Reference formats: JPEG/PNG/WebP/BMP/TIFF/GIF/HEIC/HEIF; each <=30 MiB and <=36000000 pixels. AVIF and JP2 are unsupported.",
    "optimize_prompt_options supports only {mode:'standard'} and cannot disable optimization. watermark is boolean.",
    "Submit once; the client saves the asynchronous task, polls it in the background and attaches outputs in this conversation. Layer tasks may take several minutes. Do not poll or resubmit using tools."],
};

export const seedream55ReferencePolicy: MediaReferencePolicy = {
  maxFiles: 10, maxBytesPerFile: SEEDREAM55_REFERENCE_LIMITS.maxBytes,
  validateFile(file) {
    if (!/^(image\/(jpeg|png|webp|bmp|tiff|gif|heic|heif))$/.test(file.mime) || file.bytes.byteLength > SEEDREAM55_REFERENCE_LIMITS.maxBytes) {
      throw new Error("Seedream 5.5 references require JPEG, PNG, WebP, BMP, TIFF, GIF, HEIC or HEIF, up to 30 MiB each.");
    }
  },
};

export const seedream55ParameterSchema = {
  type: "object", additionalProperties: false,
  properties: {
    prompt: { type: "string", description: "Complete image prompt; optional only for layer decomposition." },
    image_urls: { type: "array", maxItems: 10, description: "0..10 reference images; exactly one for layers. JPEG/PNG/WebP/BMP/TIFF/GIF/HEIC/HEIF, <=30 MiB and <=36000000 pixels each.", items: { type: "object", additionalProperties: false, properties: { local_path: { type: "string" } }, required: ["local_path"] } },
    size: { type: "string", description: "1K/1.5K/2K/auto, documented ratio, or WIDTHxHEIGHT. Default 2K; layer default auto." },
    resolution: { type: "string", enum: ["1K", "1.5K", "2K", "auto"] },
    background: { type: "string", enum: ["auto", "transparent", "opaque"] },
    output_format: { type: "string", enum: ["png", "jpeg"] }, n: { type: "integer", enum: [1] }, watermark: { type: "boolean" },
    optimize_prompt_options: { type: "object", additionalProperties: false, properties: { mode: { type: "string", enum: ["standard"] } } },
    layer_decomposition: { type: "boolean" },
    layer_decomposition_options: { type: "object", additionalProperties: false, properties: {
      max_images: { type: "integer", minimum: 2, maximum: 100 }, text_recognition: { type: "boolean" },
    } },
  },
};
