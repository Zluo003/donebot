import { describe, expect, it } from "vitest";
import { FAKE_DONEBOT_CATALOG } from "../testing/fake-donebot-gateway.ts";
import { doneBotMediaModel } from "./catalog.ts";
import { doneBotClientMediaCatalog } from "./media-registry.ts";
import { modelCapabilities } from "./capabilities.ts";
import { mediaLayer } from "./media-layers.ts";

const catalog = () => doneBotClientMediaCatalog(FAKE_DONEBOT_CATALOG)!;
const image = () => doneBotMediaModel(catalog(), "seedream-5-5", "image");
const reference = "https://assets.example.test/reference.png";

describe("Seedream 5.5 client registration", () => {
  it("registers one model per media kind independently of gateway capability metadata", () => {
    const entries = catalog().models;
    expect(entries.map(entry => entry.id)).toEqual(["seedream-5-5", "seedance-2-5", "suno"]);
    const capabilities = modelCapabilities(entries[0]!);
    expect(capabilities.availability.usable).toBe(true);
    expect(capabilities.client.delivery).toBe("async");
    expect(capabilities.native?.media?.customSize).toMatchObject({ minPixels: 921_600, maxPixels: 4_624_220 });
    expect(capabilities.native?.media?.referenceImage).toMatchObject({ maxBytes: 31_457_280, maxPixels: 36_000_000 });
    expect(capabilities.native?.media?.referenceImage).not.toHaveProperty("minPixels");
    expect(capabilities.native?.media?.layerDecomposition).toMatchObject({ referenceCount: 1,
      maxImages: { min: 2, max: 100, default: 30, includesBase: true }, textRecognition: { optional: true, promptMaySuppress: true } });
    expect(capabilities.client).toMatchObject({ referenceLimits: { maxFiles: 10, maxBytesPerFile: 31_457_280 }, referenceValidation: { provider: ["total_pixels", "decoded_format"] } });
    expect(() => doneBotMediaModel(catalog(), "gemini-4-argon", "image")).toThrow("unavailable");
    expect(() => doneBotMediaModel(catalog(), "gpt-image-2.5-flare", "image")).toThrow("unavailable");
  });

  it.each([
    { prompt: "transparent orange cat sticker", background: "transparent" },
    { prompt: "cat", size: "16x9", resolution: "1.5K" },
    { prompt: "cat", size: "2048x1152" },
    { layer_decomposition: true, image_urls: [reference] },
    { layer_decomposition: true, image_urls: [reference], resolution: "auto", layer_decomposition_options: { max_images: 100, text_recognition: true } },
    { layer_decomposition: true, image_urls: [reference], size: "1K", resolution: "2K", layer_decomposition_options: { max_images: 2 } },
  ])("accepts documented generation and layer controls: %j", parameters => {
    expect(() => image().validate!(parameters, "generate")).not.toThrow();
  });

  it.each([
    { prompt: "cat", reason: "draw this" }, { prompt: "cat", n: 2 }, { prompt: "cat", size: "4K" },
    { prompt: "cat", size: "512x512" }, { prompt: "cat", size: "2048x1152", resolution: "1K" },
    { prompt: "cat", background: "transparent", output_format: "jpeg" },
    { layer_decomposition: true, image_urls: [] },
    { layer_decomposition: true, image_urls: [reference], background: "auto" },
    { layer_decomposition: true, image_urls: [reference], size: "16:9" },
    { layer_decomposition: true, image_urls: [reference], layer_decomposition_options: { max_images: 101 } },
    { layer_decomposition: true, image_urls: [reference], layer_decomposition_options: { max_images: 2.5 } },
    { prompt: "cat", layer_decomposition_options: { max_images: 10 } },
    { prompt: "cat", optimize_prompt_options: { mode: "disabled" } },
  ])("rejects an invalid request before generation: %j", parameters => {
    expect(() => image().validate!(parameters, "generate")).toThrow("validation");
  });

  it("checks reference formats and size before upload and retains optional OCR on all 100 layers", () => {
    const policy = image().referencePolicy!;
    expect(policy.maxFiles).toBe(10);
    expect(() => policy.validateFile!({ mime: "image/avif", name: "ref.avif", bytes: new Uint8Array(10) })).toThrow("Seedream 5.5");
    expect(() => policy.validateFile!({ mime: "image/png", name: "ref.png", bytes: new Uint8Array(30 * 1024 * 1024 + 1) })).toThrow("30 MiB");
    expect(mediaLayer({ z_index: 99, background: "transparent", text_recognition: { text: "SALE", lines: [{ runs: [{ text: "SALE", style: { bold: true } }] }] } }))
      .toMatchObject({ z_index: 99, text_recognition: { text: "SALE" } });
    expect(mediaLayer({ z_index: 100 })).toBeUndefined();
  });

  it("fixes Suno v6 and supplies native output defaults in the client", () => {
    const music = doneBotMediaModel(catalog(), "suno", "music");
    expect(music.fixedParameters).toEqual({ version: "v6", custom: true, auto_lyrics: false });
    expect(music.normalizeParameters!({ prompt: "cat" }, "generate")).toEqual({ prompt: "cat", audio_format: "mp3" });
    expect(() => music.validate!({ version: "v6-mini", auto_lyrics: false, prompt: "cat" }, "generate")).toThrow();
    expect(() => music.validate!({ custom_model_id: "another-model", auto_lyrics: false, prompt: "cat" }, "generate")).toThrow("v6 only");
  });

  it("supplies registered Seedance 2.5 defaults without gateway parameter metadata", () => {
    const video = doneBotMediaModel(catalog(), "seedance-2-5", "video");
    const parameters = video.normalizeParameters!({ content: [{ type: "text", text: "A tracking shot" }] }, "generate");
    expect(parameters).toMatchObject({ resolution: "720p", ratio: "adaptive", duration: -1 });
    expect(() => video.validate!({ ...parameters, ...video.fixedParameters }, "generate")).not.toThrow();
    expect(parameters).not.toHaveProperty("omni_reference_task_type");
  });

  it.each(["image", "video", "audio"])("defaults %s references to multimodal reference without changing the material", type => {
    const video = doneBotMediaModel(catalog(), "seedance-2-5", "video");
    const part = { type: `${type}_url`, [`${type}_url`]: { url: `https://assets.example.test/reference.${type}` }, role: `reference_${type}` };
    const input = { content: [{ type: "text", text: "Use the supplied reference" }, part] };
    const parameters = video.normalizeParameters!(input, "generate");
    expect(parameters).toMatchObject({ content: input.content, omni_reference_task_type: "reference" });
    expect(input).not.toHaveProperty("omni_reference_task_type");
    expect(() => video.validate!({ ...parameters, ...video.fixedParameters }, "generate")).not.toThrow();
  });

  it("treats a single unlabelled image as a reference and preserves explicitly selected frame or edit modes", () => {
    const video = doneBotMediaModel(catalog(), "seedance-2-5", "video");
    const text = { type: "text", text: "Use the supplied image" };
    const image = { type: "image_url", image_url: { url: reference } };
    expect(video.normalizeParameters!({ content: [text, image] }, "generate")).toMatchObject({
      omni_reference_task_type: "reference", content: [text, { ...image, role: "reference_image" }],
    });
    const frames = video.normalizeParameters!({ content: [text, { ...image, role: "first_frame" }] }, "generate");
    expect(frames).not.toHaveProperty("omni_reference_task_type");
    expect(frames.content).toEqual([text, { ...image, role: "first_frame" }]);
    const edit = video.normalizeParameters!({ content: [text, { type: "video_url", video_url: { url: "https://assets.example.test/reference.mp4" }, role: "reference_video" }] }, "edit");
    expect(edit).toMatchObject({ omni_reference_task_type: "edit", ratio: "adaptive", duration: -1 });
  });
});
