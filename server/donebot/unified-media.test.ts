import { describe, expect, it } from "vitest";
import { doneBotMediaModel } from "./catalog.ts";
import { doneBotClientMediaCatalog } from "./media-registry.ts";
import { mediaModelSchema } from "./media-model-schema.ts";
import { FAKE_DONEBOT_CATALOG } from "../testing/fake-donebot-gateway.ts";
import { UNIFIED_MEDIA_PROTOCOL } from "./unified-media.ts";

const catalog = structuredClone(FAKE_DONEBOT_CATALOG);
for (const id of ["muse-video", "seedance-2-5-flash"]) catalog.models.push({ id, display_name: id, media_types: ["video"], interfaces: ["openai.videos"], platforms: [] });
const local = doneBotClientMediaCatalog(catalog)!;
const video = { protocol: UNIFIED_MEDIA_PROTOCOL, mode: "text", prompt: "Waves", duration: 6, resolution: "720p", aspect_ratio: "16:9" };
const ref = (type = "image", role = "reference") => ({ type, role, url: "https://assets.invalid/reference" });
function validate(id: string, parameters: Record<string, unknown>, kind: "image" | "video" = "video", operation: "generate" | "edit" | "extend" = "generate") {
  const model = doneBotMediaModel(local, id, kind);
  const p = model.normalizeParameters!(parameters, operation);
  model.validate!(p, operation);
  return p;
}

describe("client registered unified media", () => {
  it.each(["muse-video", "seedance-2-5", "seedance-2-5-flash"])("accepts the same text and reference shapes for %s", id => {
    expect(validate(id, video)).toEqual(video);
    expect(validate(id, { ...video, mode: "reference", references: [ref()] })).toMatchObject({ mode: "reference", references: [ref()] });
    const schema = mediaModelSchema(local.models.find(m => m.id === id)!).parameters;
    expect(schema.properties).not.toHaveProperty("content");
    expect(schema.properties).not.toHaveProperty("omni_reference_task_type");
  });
  it("keeps a single reference in reference mode and preserves explicit first/last roles", () => {
    expect(validate("seedance-2-5", { ...video, mode: "reference", references: [ref()] })).toMatchObject({ mode: "reference" });
    expect(() => validate("seedance-2-5", { ...video, aspect_ratio: "adaptive", mode: "first_last_frame", references: [ref("image", "first_frame"), ref("image", "last_frame")] })).not.toThrow();
    expect(() => validate("seedance-2-5", { ...video, aspect_ratio: "adaptive", mode: "first_last_frame", references: [ref("image", "last_frame")] })).toThrow("roles");
  });
  it("rejects unsupported controls and modes without dropping references or reducing resolution", () => {
    for (const patch of [{ resolution: "1080p" }, { mode: "extend", references: [ref("video")] }, { options: { generate_audio: false } }, { content: [] }]) {
      expect(() => validate("seedance-2-5-flash", { ...video, ...patch })).toThrow();
    }
    expect(() => validate("muse-video", { ...video, mode: "reference", references: [ref("video")] })).toThrow("video references");
    expect(() => validate("muse-video", { ...video, options: { stream: false } })).toThrow();
    expect(() => validate("seedance-2-5", { ...video, mode: "edit", references: [ref("video")] }, "video", "edit")).toThrow();
  });
  it.each(["gpt-image-2.6-flare", "seedream-5-5"])("uses common text and edit request fields for %s", id => {
    for (const mode of ["text", "edit"]) expect(() => validate(id, { protocol: UNIFIED_MEDIA_PROTOCOL, mode, prompt: "Preserve the subject", ...(mode === "edit" ? { references: [ref()] } : {}) }, "image", mode === "edit" ? "edit" : "generate")).not.toThrow();
  });
});
