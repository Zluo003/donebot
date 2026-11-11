import { describe, expect, it } from "vitest";
import { FAKE_DONEBOT_CATALOG } from "../testing/fake-donebot-gateway.ts";
import { modelCapabilities } from "./capabilities.ts";
import { doneBotMediaModel, doneBotModelCapabilities, mediaModelSummary } from "./catalog.ts";

describe("DoneBot media discovery and wrong-model recovery", () => {
  it("returns all model choices in a compact catalog with explicit effective availability", () => {
    const summaries = FAKE_DONEBOT_CATALOG.models.map(modelCapabilities).map(mediaModelSummary);
    expect(JSON.stringify(summaries).length).toBeLessThan(6000);
    expect(summaries).toContainEqual(expect.objectContaining({ model: "gpt-image-2.5-flare", kind: "image", operations: ["generate", "edit"], availability: expect.objectContaining({ usable: true }) }));
    expect(summaries).toContainEqual(expect.objectContaining({ model: "gemini-4-argon", kind: "text" }));
    expect(summaries.every(model => !("gateway" in model) && !("native" in model))).toBe(true);
  });

  it("admits new public media IDs only through fixed matching adapters", () => {
    const entry = { id: "public-new-image", display_name: "New image", media_types: ["image" as const], platforms: [], interfaces: ["openai.images"], media_parameters: { protocol: { adapter: "donebot.images.async.v1" } } };
    const catalog = { ...FAKE_DONEBOT_CATALOG, models: [entry] };
    expect(doneBotMediaModel(catalog, entry.id, "image").adapter).toBe("donebot.images.async.v1");
    for (const invalid of [{ ...entry, interfaces: ["openai.videos"] }, { ...entry, media_parameters: { protocol: { adapter: "https://untrusted.invalid/generate" } } }]) {
      expect(() => doneBotMediaModel({ ...catalog, models: [invalid] }, entry.id, "image")).toThrow("unavailable");
    }
  });

  it("rejects a chat model with usable image choices instead of suggesting missing provider keys", () => {
    expect(() => doneBotMediaModel(FAKE_DONEBOT_CATALOG, "gemini-4-argon", "image")).toThrow("It is registered for text, not image generation");
    try { doneBotMediaModel(FAKE_DONEBOT_CATALOG, "gemini-4-argon", "image"); }
    catch (error) {
      expect(error).toMatchObject({ status: 400 });
      expect((error as Error).message).toContain("gpt-image-2.5-flare");
      expect((error as Error).message).toContain("No paid generation was submitted");
      expect((error as Error).message).toContain("Do not request third-party model API keys");
    }
  });

  it("rejects an incompatible capability query instead of returning a successful empty list", () => {
    expect(() => doneBotModelCapabilities(FAKE_DONEBOT_CATALOG, { kind: "image", model: "gemini-4-argon" }))
      .toThrow("It is registered for text, not image generation");
    try { doneBotModelCapabilities(FAKE_DONEBOT_CATALOG, { kind: "image", model: "gemini-4-argon" }); }
    catch (error) {
      expect(error).toMatchObject({ status: 400 });
      expect((error as Error).message).toContain("gpt-image-2.5-flare");
      expect((error as Error).message).toContain("correct the request in this same conversation");
      expect((error as Error).message).toContain("Do not repeat the mismatched model query");
    }
    expect(doneBotModelCapabilities(FAKE_DONEBOT_CATALOG, { kind: "image" })).toHaveLength(4);
    expect(doneBotModelCapabilities(FAKE_DONEBOT_CATALOG, { model: "gpt-image-2.5-flare", kind: "image" }))
      .toEqual([expect.objectContaining({ model: "gpt-image-2.5-flare", native: expect.any(Object) })]);
  });

  it("distinguishes unknown exact IDs and lists the registered Suno music model", () => {
    expect(() => doneBotModelCapabilities(FAKE_DONEBOT_CATALOG, { model: "unknown" })).toThrow("No registered model matches");
    expect(() => doneBotModelCapabilities(FAKE_DONEBOT_CATALOG, { model: "gpt-image-2.5-flare", kind: "llm" })).toThrow("No registered model matches");
    expect(doneBotModelCapabilities(FAKE_DONEBOT_CATALOG, { kind: "music" })).toMatchObject([{ model: "suno", kind: "music", availability: { usable: true } }]);
    expect(doneBotModelCapabilities(null, { kind: "image" })).toEqual([]);
  });

  it("does not offer unavailable or unverified media models or silently choose another", () => {
    const catalog = structuredClone(FAKE_DONEBOT_CATALOG);
    catalog.models = catalog.models.filter(model => !model.media_types.includes("image"));
    expect(() => doneBotMediaModel(catalog, "gpt-image-2.5-flare", "image")).toThrow("No verified image model is currently available in this account");
    expect(() => doneBotMediaModel(null, "unknown", "video")).toThrow("No verified video model");
    expect(doneBotMediaModel(FAKE_DONEBOT_CATALOG, "gpt-image-2.5-flare", "image").id).toBe("gpt-image-2.5-flare");
  });
});
