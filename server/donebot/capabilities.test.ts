import { describe, expect, it } from "vitest";
import type { DoneBotCatalog, DoneBotGatewayModel, DoneBotModelKind } from "../../shared/donebot.ts";
import { doneBotMediaModel, doneBotProtocol, doneBotTextModels } from "./catalog.ts";
import { modelCapabilities, nativeModel, validateMediaParameters } from "./capabilities.ts";

const textModels = [
  ["claude-fable-5-1", "messages", "anthropic.messages"],
  ["claude-haiku-5-5", "messages", "anthropic.messages"],
  ["claude-opus-5-5", "messages", "anthropic.messages"],
  ["claude-sonnet-5-5", "messages", "anthropic.messages"],
  ["deepseek-flash", "chat", "openai.chat_completions"],
  ["gemini-3.8-flash", "gemini", "gemini.generate_content"],
  ["gemini-4-argon", "gemini", "gemini.generate_content"],
  ["glm-5.3-flash", "chat", "openai.chat_completions"],
  ["gpt-6-astra", "responses", "openai.responses"],
  ["gpt-6.1-sol", "responses", "openai.responses"],
  ["gpt-6.1-terra", "responses", "openai.responses"],
] as const;
const mediaModels = [
  ["gpt-image-2.5-flare", "image", "openai.images", "donebot.images.async.v1"],
  ["gpt-image-2.5-sunburst", "image", "openai.images", "donebot.images.async.v1"],
  ["gpt-image-2.6-flare", "image", "openai.images", "donebot.images.async.v1"],
  ["gpt-image-2.6-sunburst", "image", "openai.images", "donebot.images.async.v1"],
  ["seedream-5-0-flash", "image", "openai.images", "apimart.images.v1"],
  ["seedance-2-0", "video", "openai.videos", "seedance.videos.v1"],
  ["seedance-2-0-fast", "video", "openai.videos", "seedance.videos.v1"],
  ["seedance-2-0-mini", "video", "openai.videos", "seedance.videos.v1"],
  ["seedance-2-5", "video", "openai.videos", "seedance.videos.v1"],
  ["suno", "music", "openai.music", "apimart.music.v1"],
  ["gpt-4o-mini-tts", "audio", "openai.audio.speech", "apimart.speech.v1"],
] as const;
function model(id: string, kind: DoneBotModelKind, nativeInterface: string, adapter?: string): DoneBotGatewayModel {
  return { id, display_name: id, platforms: [], media_types: [kind], interfaces: [nativeInterface],
    capabilities: { tool_calling: kind === "text", reasoning: { supported: false } },
    ...(adapter ? { media_parameters: { protocol: { adapter } } } : {}) };
}
const models = [...textModels.map(([id, , nativeInterface]) => model(id, "text", nativeInterface)),
  ...mediaModels.map(([id, kind, nativeInterface, adapter]) => model(id, kind, nativeInterface, adapter))];
const catalog = (entries: DoneBotGatewayModel[]): DoneBotCatalog => ({ gateway_contract_version: 3, catalog_scope_id: "fixture", catalog_version: "fixture-v1", defaults: { text: "gpt-6.1-sol" }, models: entries });
function media(id: string): DoneBotGatewayModel { return structuredClone(models.find(item => item.id === id)!); }
const validate = (id: string, parameters: Record<string, unknown>, operation: "generate" | "edit" = "generate") => validateMediaParameters(media(id), parameters, operation);
const prompt = { type: "text", text: "Synthetic fixture" };
const gptImage25Models = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"];
const gptImage26Models = ["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"];
const reference = (type: "image" | "video" | "audio", role: string) => ({ type: `${type}_url`, [`${type}_url`]: { url: `https://assets.example.test/fixture.${type}` }, role });

describe("DoneBot local model registration", () => {
  it("keeps registered media constraints and accepts public text IDs by their gateway interface", () => {
    expect(models).toHaveLength(22);
    for (const entry of models) {
      const result = modelCapabilities(entry);
      expect(result.availability).toMatchObject({ locallyVerified: true, usable: true });
      expect(result.native!.sources.length).toBeGreaterThan(0);
      for (const source of result.native!.sources) {
        expect(new URL(source).protocol).toBe("https:");
        expect(["developers.openai.com", "platform.claude.com", "docs.cloud.google.com", "api-docs.deepseek.com", "docs.z.ai", "docs.volcengine.com", "help.suno.com"]).toContain(new URL(source).hostname);
      }
    }
    for (const id of ["gateway-new-text", "toString", "__proto__"]) {
      expect(nativeModel(id)).toBeUndefined();
      expect(modelCapabilities(model(id, "text", "openai.responses")).availability).toMatchObject({ locallyVerified: false, usable: true });
    }
  });

  it.each(textModels)("uses the verified native protocol for %s", (id, protocol) => {
    expect(doneBotProtocol(id)).toBe(protocol);
    expect(modelCapabilities(media(id)).native).toMatchObject({ protocol, tools: true, structuredOutput: true });
  });

  it("offers GLM-5.3-Flash through the existing Chat Completions route", () => {
    const entry = model("glm-5.3-flash", "text", "openai.chat_completions");
    expect(modelCapabilities(entry)).toMatchObject({
      native: { officialId: "glm-5.3-flash", protocol: "chat", input: ["text", "image"], output: ["text"], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: { field: "reasoning_effort", levels: ["low", "high", "max"], default: "max" } },
      client: { implemented: true, input: ["text", "image"], operations: ["conversation", "tool_calling"], reasoningOverride: false, textAudioVideoInput: false },
      availability: { locallyVerified: true, usable: true },
    });
    expect(doneBotTextModels(catalog([entry])).options).toEqual([{ id: "glm-5.3-flash", label: "glm-5.3-flash", contextWindow: 1_000_000 }]);
    expect(doneBotProtocol(entry.id, catalog([{ ...entry, interfaces: ["openai.responses"] }]))).toBe("responses");
    expect(doneBotTextModels(catalog([{ ...entry, interfaces: ["unsupported"] }])).options).toEqual([]);
  });

  it("keeps native reasoning independent of missing or negative gateway reasoning metadata", () => {
    const entry = media("claude-sonnet-5-5");
    expect(modelCapabilities(entry)).toMatchObject({ native: { reasoning: { field: "output_config.effort", default: "high", modes: ["adaptive", "between_tools"] } }, gateway: { capabilities: { reasoning: { supported: false } } }, client: { reasoningOverride: false } });
    expect(nativeModel("gpt-6-astra")!.reasoning).not.toHaveProperty("default");
    expect(nativeModel("gpt-6.1-terra")!.reasoning!.levels).toContain("none");
    expect(nativeModel("gpt-6.1-sol")!.reasoning!.levels).not.toContain("none");
  });

  it("separates Gemini long decoding from one streaming request and current client support", () => {
    expect(modelCapabilities(media("gemini-4-argon"))).toMatchObject({
      native: { maxOutput: 1_048_576, input: ["text", "image", "audio", "video"], outputLimits: { sharedWithInput: true, streamingRequest: 65_536, nonStreamingRequest: 32_768, continuation: { apiVersion: "v1beta1", field: "continuation_token" } } },
      client: { input: ["text", "image"], textAudioVideoInput: false, longDecoding: false, maxOutputPerRequest: 65_536 },
    });
  });

  it("returns isolated native records so a catalog consumer cannot rewrite future decisions", () => {
    const first = nativeModel("gpt-image-2.5-flare")!;
    first.media!.mask = false; first.sources.length = 0;
    expect(nativeModel("gpt-image-2.5-flare")!.media!.mask).toBe(true);
    expect(nativeModel("gpt-image-2.5-flare")!.sources.length).toBeGreaterThan(0);
  });

  it("uses supported declared text protocols and rejects incompatible media adapters", () => {
    const llm = media("gpt-6.1-sol"), wrongProtocol = { ...llm, interfaces: ["openai.chat_completions"] }, noTools = { ...llm, capabilities: { tool_calling: false } };
    expect(doneBotTextModels(catalog([wrongProtocol, media("deepseek-flash")])).options.map(option => option.id)).toEqual([llm.id, "deepseek-flash"]);
    expect(doneBotTextModels(catalog([noTools])).options.map(option => option.id)).toEqual([llm.id]);
    expect(doneBotTextModels(null).options).toEqual([]);
    const image = media("gpt-image-2.5-flare");
    for (const entry of [{ ...image, interfaces: ["openai.videos"] }, { ...image, media_parameters: { protocol: { adapter: "apimart.images.v1" } } }]) {
      expect(modelCapabilities(entry).availability.usable).toBe(false);
      expect(() => doneBotMediaModel(catalog([entry]), entry.id, "image")).toThrow("unavailable");
    }
    const legacy = { ...image, media_parameters: { protocol: { adapter: "openai.images.v1" } } };
    expect(() => doneBotMediaModel(catalog([legacy]), legacy.id, "image")).toThrow("asynchronous image update");
  });

  it("shows GPT Image native mask editing and disables it only at the gateway/client layer", () => {
    expect(modelCapabilities(media("gpt-image-2.5-sunburst"))).toMatchObject({ native: { media: { mask: true, operations: expect.arrayContaining(["mask_edit"]) } }, gateway: { maskEditing: false }, client: { delivery: "async", imageEditEndpoint: true } });
    expect(modelCapabilities(media("gpt-image-2.5-sunburst")).client.operations).not.toContain("mask_edit");
    expect(modelCapabilities(media("gpt-image-2.5-sunburst"))).toMatchObject({
      native: { media: { operations: expect.arrayContaining(["markup_edit"]) } },
      client: { operations: ["generate", "edit"], markupOverlay: false, annotatedReferenceEdits: true },
      gateway: { responseFormatCompatibility: ["url", "b64_json"] },
    });
    expect(() => validate("gpt-image-2.5-flare", { prompt: "fixture", mask: "https://assets.example.test/mask.png" })).toThrow("disabled");
    expect(() => validate("gpt-image-2.5-flare", { prompt: "fixture", input_image_mask: {} })).toThrow("disabled");
  });

  it.each(gptImage25Models)("records rendering controls, defaults and experimental dimensions for %s", (id) => {
    const capabilities = modelCapabilities(media(id));
    expect(capabilities.native).toMatchObject({
      officialId: id, verifiedAt: "2026-11-06", input: ["text", "image"], output: ["image"],
      media: {
        qualities: ["auto", "low", "medium", "high", "xhigh", "max"], backgrounds: ["auto", "opaque", "transparent"],
        transparentFormats: ["png", "webp"], formats: ["png", "jpeg", "webp"],
        defaults: { size: "auto", quality: "auto", background: "auto", output_format: "png" },
        customSize: { minPixels: 655_360, maxPixels: 8_294_400, maxRatio: 3, alignment: 16, maxEdge: 3840, experimentalAbovePixels: 3_686_400 },
      },
    });
    expect(capabilities.native!.sources).toContain("https://developers.openai.com/api/docs/guides/image-prompting?model=gpt-image-2.5");
    expect(capabilities.native).not.toHaveProperty("reasoning");
    for (const field of ["complexity", "reasoning"]) expect(capabilities.client.parameterRules!.fields).not.toContain(field);
    expect(nativeModel("gpt-image-2.7-sunburst")).toBeUndefined();
  });

  it.each(gptImage26Models)("separates %s native complexity/SVG/GIF from product policy and current catalog", (id) => {
    const entry = media(id), capabilities = modelCapabilities(entry);
    expect(capabilities.native).toMatchObject({ officialId: id, kind: "image", verifiedAt: "2026-11-07",
      input: ["text", "image"], output: ["image"], media: {
        formats: ["png", "jpeg", "webp", "svg", "gif"], transparentFormats: ["png", "webp", "svg"], qualities: ["auto", "low", "medium", "high", "xhigh", "max"],
        customSize: { alignment: 16, maxRatio: 3 }, complexity: { levels: ["low", "medium", "high"], default: "high" },
        animatedGif: { operations: ["generate", "edit"], frameCount: { min: 2, max: 16, default: 9 },
          frameDurationMs: { min: 20, max: 2000, default: 200, rounding: 10, encodedMax: 655_350 },
          requiresPreviewAccess: true, streaming: false, outputCompression: false },
      } });
    expect(capabilities.native!.media!.customSize).not.toHaveProperty("minPixels");
    expect(capabilities.client).toMatchObject({ fixedParameters: { complexity: "high" }, svgOutput: false,
      outputFormats: ["png", "jpeg", "webp", "gif"], staticSizePolicy: { minPixels: 655_360, maxPixels: 8_294_400, maxEdge: 3840 } });
    const rules = capabilities.client.parameterRules!;
    expect(rules.fields).toEqual(expect.arrayContaining(["frame_count", "frame_duration_ms"]));
    for (const field of ["complexity", "svg", "input_fidelity", "reasoning", "stream", "partial_images"]) expect(rules.fields).not.toContain(field);
    const resolved = doneBotMediaModel(catalog([entry]), id, "image");
    expect(resolved.fixedParameters).toEqual({ complexity: "high" });
    expect(() => doneBotMediaModel(catalog([]), id, "image")).toThrow("unavailable");
    entry.media_parameters!.formats = ["png", "jpeg", "webp"];
    expect(modelCapabilities(entry).client.outputFormats).not.toContain("gif");
    expect(() => validateMediaParameters(entry, { prompt: "fixture", output_format: "gif" }, "generate")).toThrow("output_format");
    expect(() => validateMediaParameters(entry, { prompt: "fixture", response_format: "url" }, "generate")).not.toThrow();
  });

  it("separates Suno native editing and 480 seconds from primary gateway generation", () => {
    const entry = media("suno");
    entry.media_parameters = { ...entry.media_parameters, duration_seconds: { min: 10, max: 360, step: 1, requires_custom: true } };
    expect(modelCapabilities(entry)).toMatchObject({ native: { media: { duration: { max: 480 }, operations: expect.arrayContaining(["cover", "extend"]) } }, client: { input: ["text"], operations: ["generate", "custom_lyrics", "instrumental"] } });
    expect(() => validateMediaParameters(entry, { version: "v6", custom: true, instrumental: true, duration: 480 }, "generate")).toThrow("gateway model limits");
  });

  it("keeps native TTS voices and tokens separate from gateway voices and Unicode limits", () => {
    const entry = media("gpt-4o-mini-tts");
    entry.media_parameters = { ...entry.media_parameters, voices: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"], formats: ["pcm"] };
    const capabilities = modelCapabilities(entry);
    expect(capabilities.native!.media!.voices).toHaveLength(13);
    expect(capabilities.gateway.parameters.voices).toHaveLength(6);
    expect(capabilities.client).toMatchObject({ delivery: "streaming", playbackFormat: "pcm", inputLimit: { maxUnicodeCharacters: 4096, nativeTokenLimit: 2000 } });
    expect(() => validateMediaParameters(entry, { input: "fixture" }, "generate")).toThrow("Speech");
  });
});

describe("DoneBot media parameters", () => {
  it.each(gptImage26Models)("validates %s animation controls independently of static pixels and keeps high fixed", (id) => {
    for (const quality of ["auto", "low", "medium", "high", "xhigh", "max"]) {
      for (const size of [undefined, "auto", "512x512"]) {
        const parameters = { prompt: "A synthetic loop", output_format: "gif", size, quality, complexity: "high" };
        expect(() => validate(id, parameters)).not.toThrow();
        expect(() => validate(id, { ...parameters, images: [{ image_url: "https://assets.example.test/still.png" }] }, "edit")).not.toThrow();
      }
    }
    for (const frame_count of [2, 9, 16]) for (const frame_duration_ms of [20, 25, 200, 2000]) {
      expect(() => validate(id, { prompt: "fixture", output_format: "gif", frame_count, frame_duration_ms })).not.toThrow();
    }
    for (const frame_count of [1, 17, 2.5, "9"]) expect(() => validate(id, { prompt: "fixture", output_format: "gif", frame_count })).toThrow("frame_count");
    for (const frame_duration_ms of [19, 2001, 655350, 20.5, "200"]) expect(() => validate(id, { prompt: "fixture", output_format: "gif", frame_duration_ms })).toThrow("frame_duration_ms");
    for (const size of ["0x512", "513x512", "2K", "16:9", "9007199254740992x512"]) expect(() => validate(id, { prompt: "fixture", output_format: "gif", size })).toThrow("size");
    expect(() => validate(id, { prompt: "fixture", output_format: "png", size: "512x512" })).toThrow("static");
    for (const format of ["png", "webp"]) expect(() => validate(id, { prompt: "fixture", background: "transparent", output_format: format, size: "1536x864" })).not.toThrow();
    for (const parameters of [{ output_format: "svg" }, { svg: { model: "author" } }, { output_format: "gif", output_compression: 80 },
      { output_format: "gif", background: "transparent" }, { output_format: "gif", stream: false }, { output_format: "gif", partial_images: 0 },
      { frame_count: 9 }, { frame_duration_ms: 200 }, { complexity: "low" }, { complexity: "medium" }, { complexity: null }, { reasoning: { summary: "auto" } }, { input_fidelity: "high" }]) {
      expect(() => validate(id, { prompt: "fixture", ...parameters })).toThrow();
    }
    expect(() => validate(id, { prompt: "fixture", complexity: "high" })).not.toThrow();
    for (const old of gptImage25Models) expect(() => validate(old, { prompt: "fixture", output_format: "gif" })).toThrow();
  });

  it.each(gptImage25Models)("accepts supported custom dimensions and rejects each size boundary for %s", (id) => {
    for (const size of ["auto", "640x1024", "1920x640", "640x1920", "1024x1024", "1536x864", "2048x1152", "2560x1440", "2048x2048", "2880x2880", "3840x2160", "2160x3840"]) {
      expect(() => validate(id, { prompt: "fixture", size }), size).not.toThrow();
    }
    for (const size of ["1025x1024", "4000x1024", "640x1008", "2048x672", "3840x3840", "4K", "2K", "16:9", "0x1024"]) {
      expect(() => validate(id, { prompt: "fixture", size }), size).toThrow();
    }
  });

  it.each(gptImage25Models)("accepts all quality levels and transparent PNG/WebP generation and edits for %s", (id) => {
    for (const quality of [undefined, "auto", "low", "medium", "high", "xhigh", "max"]) {
      for (const output_format of ["png", "webp"]) {
        const parameters = { prompt: "fixture", size: "1536x864", quality, output_format, background: "transparent" };
        expect(() => validate(id, parameters)).not.toThrow();
        expect(() => validate(id, { ...parameters, images: [{ image_url: "https://assets.example.test/reference.png" }] }, "edit")).not.toThrow();
      }
    }
    expect(() => validate(id, { prompt: "fixture", background: "transparent" })).not.toThrow();
    expect(() => validate(id, { prompt: "fixture", background: "transparent", output_format: "jpeg" })).toThrow("Transparent");
    for (const quality of ["hd", "standard", "none", "ultra", 1]) expect(() => validate(id, { prompt: "fixture", quality })).toThrow("quality");
    for (const parameters of [{ complexity: "high" }, { reasoning: { effort: "max" } }, { markup: { image_url: "https://assets.example.test/overlay.png" } }, { output_format: "svg" }, { output_format: "gif" }]) {
      expect(() => validate(id, { prompt: "fixture", ...parameters })).toThrow();
    }
    for (const response_format of ["url", "b64_json"]) expect(() => validate(id, { prompt: "fixture", response_format })).not.toThrow();
  });

  it("accepts native GPT Image edits and verifies alignment, reference count and transparent format", () => {
    const images = [{ image_url: "https://assets.example.test/reference.png" }];
    expect(() => validate("gpt-image-2.5-flare", { prompt: "fixture", images, size: "1024x1024", quality: "max", output_format: "png", background: "transparent" }, "edit")).not.toThrow();
    expect(() => validate("gpt-image-2.5-flare", { prompt: "fixture", images })).toThrow("edit operation");
    expect(() => validate("gpt-image-2.5-flare", { prompt: "fixture" }, "edit")).toThrow("requires");
    for (const size of ["1025x1024", "4096x2048", "512x512", "3840x256"]) expect(() => validate("gpt-image-2.5-flare", { prompt: "fixture", size })).toThrow();
    expect(() => validate("gpt-image-2.5-flare", { prompt: "fixture", images: Array.from({ length: 17 }, () => images[0]) }, "edit")).toThrow("count");
    expect(() => validate("gpt-image-2.5-flare", { prompt: "fixture", background: "transparent", output_format: "jpeg" })).toThrow("Transparent");
    expect(() => validate("gpt-image-2.5-flare", { prompt: "fixture", output_compression: 80 })).toThrow("JPEG or WebP");
  });

  it("validates Seedream generation, native layer decomposition and custom pixel boundaries", () => {
    expect(() => validate("seedream-5-0-flash", { prompt: "fixture", size: "960x960", output_format: "png" })).not.toThrow();
    expect(() => validate("seedream-5-0-flash", { layer_decomposition: true, image_urls: ["https://assets.example.test/ref.png"], size: "2K" })).not.toThrow();
    expect(() => validate("seedream-5-0-flash", { prompt: "fixture", n: 2 })).toThrow("one image");
    expect(() => validate("seedream-5-0-flash", { layer_decomposition: true })).toThrow("exactly one");
    expect(() => validate("seedream-5-0-flash", { layer_decomposition: true, image_urls: ["https://assets.example.test/ref.png"], prompt: 42 })).toThrow("text");
    for (const size of ["512x512", "4096x4096"]) expect(() => validate("seedream-5-0-flash", { prompt: "fixture", size })).toThrow("pixels");
    expect(() => validate("seedream-5-0-flash", { prompt: "fixture", background: "transparent", output_format: "png" })).toThrow("one reference");
  });

  it("registers Seedream Flash layers and 1.5K without inheriting other Seedream models' 4K or fast mode", () => {
    const capabilities = modelCapabilities(media("seedream-5-0-flash"));
    expect(capabilities.native).toMatchObject({ verifiedAt: "2026-11-07", media: {
      resolutions: ["1K", "1.5K", "2K"], maxReferences: { image: 10 },
      layerDecomposition: { referenceCount: 1, referenceImage: { formats: ["png", "jpeg"], minPixels: 262_144 },
        maxLayers: 16, baseImages: 1, layerFormat: "png", partialSuccess: false,
        metadata: expect.arrayContaining(["z_index", "bounding_box.absolute", "bounding_box.normalized"]) },
      promptOptimization: { field: "optimize_prompt_options.mode", modes: ["standard"] },
    } });
    expect(capabilities.gateway.adapterSources).toContain("https://docs.apimart.ai/cn/api-reference/images/seedream-5-0-flash/generation");
    for (const size of ["1K", "1.5K", "2K"]) {
      expect(() => validate("seedream-5-0-flash", { prompt: "fixture", size })).not.toThrow();
      expect(() => validate("seedream-5-0-flash", { prompt: "fixture", resolution: size, size: "16:9" })).not.toThrow();
      expect(() => validate("seedream-5-0-flash", { layer_decomposition: true, image_urls: ["https://assets.example.test/ref.png"], size })).not.toThrow();
    }
    for (const parameters of [{ size: "4K" }, { resolution: "4K" }, { optimize_prompt_options: { mode: "fast" } }, { optimize_prompt_options: [] }, { optimize_prompt_options: { strength: 1 } }]) {
      expect(() => validate("seedream-5-0-flash", { prompt: "fixture", ...parameters })).toThrow();
    }
    expect(() => validate("seedream-5-0-flash", { prompt: "fixture", optimize_prompt_options: { mode: "standard" } })).not.toThrow();
    for (const size of ["16:9", "1536x1536"]) expect(() => validate("seedream-5-0-flash", { layer_decomposition: true, image_urls: ["https://assets.example.test/ref.png"], size })).toThrow();
    expect(() => validate("seedream-5-0-flash", { layer_decomposition: true, image_urls: Array(2).fill("https://assets.example.test/ref.png") })).toThrow("exactly one");
    expect(() => validate("seedream-5-0-flash", { prompt: "fixture", image_urls: ["https://assets.example.test/alpha.png"], output_format: "png", background: "transparent" })).not.toThrow();
    expect(() => validate("seedream-5-0-flash", { prompt: "fixture", image_urls: ["data:image/png;base64,ZmFrZQ=="] })).toThrow("HTTPS");
  });

  it("uses Seedream's effective size and shared 1K/1.5K pixel billing tier when checking the catalog", () => {
    const entry = media("seedream-5-0-flash");
    entry.media_parameters = { ...entry.media_parameters, sizes: ["1.5K", "auto"], resolutions: ["1.5K"], aspect_ratios: ["16:9"] };
    for (const size of ["1536x1536", "1600x1600", "1.5K"]) {
      expect(() => validateMediaParameters(entry, { prompt: "fixture", size, resolution: "2K" }, "generate")).not.toThrow();
    }
    expect(() => validateMediaParameters(entry, { prompt: "fixture", size: "16:9", resolution: "2K" }, "generate")).toThrow("resolution");
    expect(() => validateMediaParameters(entry, { prompt: "fixture", size: "2048x2048" }, "generate")).toThrow("resolution tier");
    entry.media_parameters = { ...entry.media_parameters, sizes: ["2K"], resolutions: ["2K"] };
    expect(() => validateMediaParameters(entry, { prompt: "fixture", size: "2048x2048", resolution: "1K" }, "generate")).not.toThrow();
    expect(() => validateMediaParameters(entry, { prompt: "fixture", size: "2K", resolution: "1K" }, "generate")).not.toThrow();
    expect(() => validateMediaParameters(entry, { prompt: "fixture", size: "1600x1600" }, "generate")).toThrow("resolution tier");
  });

  it("applies live catalog restrictions without rewriting the native model", () => {
    const entry = media("seedance-2-0");
    entry.media_parameters = { ...entry.media_parameters, resolutions: ["720p"], duration_seconds: { min: 4, max: 10, step: 1, automatic: true } };
    expect(modelCapabilities(entry).native!.media!.resolutions).toContain("4k");
    expect(() => validateMediaParameters(entry, { content: [prompt], resolution: "4k" }, "generate")).toThrow("resolution");
    expect(() => validateMediaParameters(entry, { content: [prompt], resolution: "720p", duration: 11 }, "generate")).toThrow("gateway model limits");
    expect(() => validateMediaParameters(entry, { content: [prompt], resolution: "720p", duration: -1 }, "generate")).not.toThrow();
  });

  it.each(gptImage25Models)("keeps %s pricing tiers separate from native dimensions and honors explicit gateway size restrictions", (id) => {
    const entry = media(id);
    entry.pricing = { image_sizes: ["1K", "2K", "4K"] };
    expect(() => validateMediaParameters(entry, { prompt: "fixture", size: "1536x864", quality: "medium" }, "generate")).not.toThrow();
    entry.media_parameters = { ...entry.media_parameters, sizes: ["1024x1024"] };
    expect(() => validateMediaParameters(entry, { prompt: "fixture", size: "1536x864" }, "generate")).toThrow("size");
    expect(nativeModel(id)!.media!.customSize!.maxPixels).toBe(8_294_400);
  });

  it("retains video editing in every Seedance model while advertising the 2.5-only task type precisely", () => {
    for (const id of ["seedance-2-0", "seedance-2-0-fast", "seedance-2-0-mini", "seedance-2-5"]) {
      const capabilities = modelCapabilities(media(id));
      expect(capabilities.native!.media!.operations).toEqual(expect.arrayContaining(["edit", "extend"]));
      expect(capabilities.client.videoEditAndExtend).toBe(true);
      expect(capabilities.client.parameterRules!.fields.includes("omni_reference_task_type")).toBe(id === "seedance-2-5");
      expect(capabilities.client.parameterRules!.fields.includes("output_format")).toBe(id === "seedance-2-5");
      expect(() => validate(id, { content: [prompt, reference("video", "reference_video")], resolution: "720p" })).not.toThrow();
    }
    expect(() => validate("seedance-2-0", { content: [prompt], resolution: "720p", omni_reference_task_type: "edit" })).toThrow("2.5");
    expect(() => validate("seedance-2-5", { content: [prompt, reference("video", "reference_video")], resolution: "1080p", ratio: "adaptive", duration: -1, omni_reference_task_type: "edit", output_format: "mov" })).not.toThrow();
    expect(() => validate("seedance-2-5", { content: [prompt, reference("video", "reference_video")], resolution: "720p", ratio: "16:9", duration: -1, omni_reference_task_type: "edit" })).toThrow("ratio=adaptive");
  });

  it.each(["seedance-2-0", "seedance-2-0-fast", "seedance-2-0-mini", "seedance-2-5"])("exposes complete reference constraints and DoneBot video policy for %s", id => {
    const result = modelCapabilities(media(id)), newer = id === "seedance-2-5";
    const native = result.native!.media!;
    expect(native.referenceMedia).toMatchObject({
      maxTotalFiles: newer ? 50 : 15, requestBodyMaxMegabytes: 64,
      image: { formats: ["jpeg", "png", "webp", "bmp", "tiff", "gif", "heic", "heif"], maxMegabytes: 30, sizeLimitExclusive: true,
        edgePixels: { min: 300, max: 6000 }, widthHeightRatio: { min: 0.4, max: 2.5 }, count: { reference: newer ? 30 : 9, firstFrame: 1, firstLastFrame: 2 } },
      video: { formats: ["mp4", "mov"], resolutions: ["480p", "720p", "1080p", "4k"], videoCodecs: ["h264", "hevc"], maxMegabytes: 200,
        edgePixels: { min: 300, max: 6000 }, widthHeightRatio: { min: 0.4, max: 2.5 }, totalPixels: { min: 407_696, max: 8_295_044 },
        fps: { min: 24, max: 60 }, maxCount: newer ? 10 : 3, durationSeconds: { min: 2, max: newer ? 30 : 15, totalMax: newer ? 30 : 15 } },
      audio: { formats: ["wav", "mp3"], maxMegabytes: 15, maxCount: newer ? 10 : 3,
        durationSeconds: { min: 2, max: newer ? 30 : 15, totalMax: newer ? 30 : 15 }, requiresVisualReference: !newer },
      portrait: { directHumanFaceReferences: false, trustedGeneratedVideo: { sameUpstreamAccount: true, originalOnly: true, withinDays: 30 } },
    });
    expect(native.referenceMedia!.video.durationSeconds.editMin).toBe(newer ? 4 : undefined);
    expect(native.formats).toEqual(newer ? ["mp4", "mov"] : ["mp4"]);
    expect(native.audioOnlyReference).toBe(newer);
    expect(native).not.toHaveProperty("builtInTools");
    expect(JSON.stringify(result)).not.toMatch(/draft|web_search/);
    expect(result.client).toMatchObject({ fixedParameters: { generate_audio: true }, defaultMode: "multimodal_reference",
      referenceLimits: { maxFiles: newer ? 50 : 15, conversationFileMaxBytes: 25 * 1024 * 1024 },
      referenceValidation: { provider: expect.arrayContaining(["dimensions", "per_file_duration", "summed_duration"]) } });
    const rules = result.client.parameterRules!;
    expect(rules.references).toContain("reference_image");
    expect(rules.fields).not.toContain("tools");
    for (const parameters of [{ generate_audio: false }, { tools: [{ type: "web_search" }] }, { draft: true }, { output_format: "webm" }]) {
      expect(() => validate(id, { content: [prompt], resolution: "720p", ...parameters })).toThrow();
    }
    expect(() => validate(id, { content: [prompt], resolution: "720p", generate_audio: true })).not.toThrow();
    if (newer) expect(() => validate(id, { content: [prompt], resolution: "720p", output_format: "mp4", generate_audio: true })).not.toThrow();
    else for (const output_format of ["mp4", "mov"]) expect(() => validate(id, { content: [prompt], resolution: "720p", output_format })).toThrow("output_format");
  });

  it("validates frame modes, model-specific resolution and reference modality/count limits", () => {
    expect(() => validate("seedance-2-0-fast", { content: [prompt], resolution: "1080p" })).toThrow("resolution");
    expect(() => validate("seedance-2-0", { content: [prompt, reference("audio", "reference_audio")], resolution: "720p" })).toThrow("visual reference");
    expect(() => validate("seedance-2-5", { content: [prompt, reference("audio", "reference_audio")], resolution: "720p" })).not.toThrow();
    expect(() => validate("seedance-2-0", { content: [prompt, reference("image", "last_frame")], resolution: "720p" })).toThrow("cannot be mixed");
    expect(() => validate("seedance-2-0", { content: [prompt, reference("image", "first_frame"), reference("video", "reference_video")], resolution: "720p" })).toThrow("cannot be mixed");
    expect(() => validate("seedance-2-5", { content: [prompt, reference("image", "first_frame")], resolution: "720p", ratio: "16:9" })).toThrow("adaptive");
    expect(() => validate("seedance-2-0", { content: [prompt, ...Array.from({ length: 10 }, () => reference("image", "reference_image"))], resolution: "720p" })).toThrow("official limit");
    expect(() => validate("seedance-2-5", { content: [prompt], resolution: "720p", draft: true })).toThrow("no verified draft");
  });

  it("accepts Suno custom lyrics/instrumentals and rejects unsupported media input or invalid controls", () => {
    expect(() => validate("suno", { version: "v6", custom: true, prompt: "Synthetic lyrics", title: "Fixture", style: "ambient", duration: 360, audio_format: "wav", audio_weight: 0.5, auto_lyrics: false })).not.toThrow();
    expect(() => validate("suno", { version: "v6-mini", custom: true, instrumental: true, auto_lyrics: false })).not.toThrow();
    expect(() => validate("suno", { version: "v6", custom: true, prompt: "Synthetic lyrics", auto_lyrics: true })).toThrow("auto_lyrics=false");
    expect(() => validate("suno", { version: "v6", custom: true, prompt: "Synthetic lyrics" })).toThrow("auto_lyrics=false");
    expect(() => validate("suno", { version: "v6", custom_model_id: "fixture", prompt: "fixture", auto_lyrics: false })).toThrow("cannot mix");
    expect(() => validate("suno", { version: "v6", prompt: "fixture", duration: 30, auto_lyrics: false })).toThrow("custom mode");
    expect(() => validate("suno", { version: "v6", prompt: "😀".repeat(3001), auto_lyrics: false })).toThrow("character limit");
    expect(() => validate("suno", { version: "v6", prompt: "fixture", audio_weight: 1.1, auto_lyrics: false })).toThrow("between 0 and 1");
    expect(() => validate("suno", { version: "v6", prompt: "fixture", audio_url: "https://assets.example.test/ref.mp3", auto_lyrics: false })).toThrow("no verified audio_url");
  });

  it("rejects forged model selection, malformed booleans, unknown fields and non-HTTPS references", () => {
    expect(() => validate("gpt-image-2.5-flare", { prompt: "fixture", model: "gpt-image-2.5-sunburst" })).toThrow("differs");
    expect(() => validate("suno", { version: "v6", prompt: "fixture", instrumental: "true" })).toThrow("boolean");
    expect(() => validate("seedance-2-0", { content: [prompt], resolution: "720p", camera_fixed: true })).toThrow("no verified camera_fixed");
    for (const image_url of ["asset://supplier-id", "http://assets.example.test/ref.png", "https://user:pass@assets.example.test/ref.png"]) {
      expect(() => validate("gpt-image-2.5-flare", { prompt: "fixture", images: [{ image_url }] }, "edit")).toThrow();
    }
  });
});
