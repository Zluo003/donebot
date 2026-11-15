import { describe, expect, it } from "vitest";
import { doneBotMediaModel } from "./catalog.ts";
import { doneBotClientMediaCatalog } from "./media-registry.ts";
import { validateMediaParameters, modelCapabilities } from "./capabilities.ts";
import { FAKE_DONEBOT_CATALOG } from "../testing/fake-donebot-gateway.ts";

const museCatalog = { ...FAKE_DONEBOT_CATALOG, models: [...FAKE_DONEBOT_CATALOG.models,
  { id: "muse-video", display_name: "Muse", media_types: ["video" as const], interfaces: ["openai.videos"], platforms: [] }] };
const model = doneBotClientMediaCatalog(museCatalog)!.models.find(model => model.id === "muse-video")!;
const parameters = { prompt: "海浪轻轻拍打沙滩", resolution: "720p", aspect_ratio: "16:9", duration: 6 };

describe("Muse gateway contract", () => {
  it("selects the local Muse adapter from the enabled catalog without trusting gateway capability fields", () => {
    expect(modelCapabilities(model)).toMatchObject({ availability: { usable: true }, client: { operations: ["generate"], fixedParameters: undefined } });
    const resolved = doneBotMediaModel(doneBotClientMediaCatalog(museCatalog), "muse-video", "video");
    expect(resolved.adapter).toBe("muse.videos.v1");
    expect(resolved.normalizeParameters?.({ prompt: "海浪" }, "generate")).toEqual({ ...parameters, prompt: "海浪" });
    const disabled = { ...museCatalog, models: museCatalog.models.filter(model => model.id !== "muse-video") };
    expect(() => doneBotMediaModel(doneBotClientMediaCatalog(disabled), "muse-video", "video")).toThrow(/unavailable/);
  });

  it.each([4, 6, 10])("accepts integer duration %i and uploaded reference images", duration => {
    expect(() => validateMediaParameters(model, { ...parameters, duration, reference_images: ["https://assets.invalid/reference.png"] }, "generate")).not.toThrow();
  });

  it.each([{ duration: 3 }, { duration: 11 }, { duration: 30 }, { duration: -1 }, { duration: 6.5 }, { resolution: "1080p" }, { aspect_ratio: "1:1" }, { prompt: " " },
    { stream: true }, { reference_videos: ["https://assets.invalid/video.mp4"] }, { reference_audios: [] }, { generate_audio: true },
    { reference_images: Array.from({ length: 11 }, () => "https://assets.invalid/image.png") }])("rejects unsupported native fields before submission: %j", patch => {
    expect(() => validateMediaParameters(model, { ...parameters, ...patch }, "generate")).toThrow();
  });

  it.each(["edit", "extend"] as const)("does not borrow Seedance's %s operation", operation => {
    expect(() => validateMediaParameters(model, parameters, operation)).toThrow(/only generation/);
  });
});
