import { beforeEach, describe, expect, it } from "vitest";
import type { DoneBotGatewayModel, DoneBotModelKind } from "../../shared/donebot";
import { setLocale } from "@/lib/i18n";
import { doneBotModelPrices, formatModelPrice, hasReferenceVideoPrice } from "./model-pricing";

const model = (pricing?: Record<string, unknown>): DoneBotGatewayModel => ({ id: "fixture-model", display_name: "Fixture model", media_types: ["text"], interfaces: [], platforms: [], pricing });
beforeEach(() => setLocale("zh"));

describe("DoneBot catalog selling prices", () => {
  it("keeps CNY input and output prices per million tokens, including zero", () => {
    expect(doneBotModelPrices(model({ currency: "CNY", input_per_million: 0, output_per_million: 8 }), "text")).toEqual([
      { label: "输入", amount: 0, unit: "millionTokens" }, { label: "输出", amount: 8, unit: "millionTokens" },
    ]);
  });
  it("shows image sizes and reference image charges", () => {
    expect(doneBotModelPrices(model({ currency: "CNY", image_sizes: { "2K": 1, input: 0.1, "1K": 0.5 } }), "image")).toEqual([
      { label: "1K", amount: 0.5, unit: "image" }, { label: "2K", amount: 1, unit: "image" }, { label: "参考图片", amount: 0.1, unit: "image" },
    ]);
  });
  it("converts base and tier TTS prices from million characters to thousand characters", () => {
    const lines = doneBotModelPrices(model({ currency: "CNY", unit: "million_characters", per_request: 12, tiers: { hd: 24, free: 0, small: 0.01 } }), "audio");
    expect(lines).toEqual([
      { label: "基础价格", amount: 0.012, unit: "thousandCharacters" },
      { label: "free", amount: 0, unit: "thousandCharacters" },
      { label: "hd", amount: 0.024, unit: "thousandCharacters" },
      { label: "small", amount: 0.00001, unit: "thousandCharacters" },
    ]);
    expect(formatModelPrice(lines[3]!.amount)).toBe("0.00001");
  });
  it("distinguishes video reference tiers without treating reference images as videos", () => {
    const video = model({ currency: "CNY", unit: "second", tiers: { "720p|standard": 2.5, "720p|reference": 1.25 } });
    expect(doneBotModelPrices(video, "video")).toEqual([
      { label: "720p · 有参考视频", amount: 1.25, unit: "second" },
      { label: "720p · 无参考视频", amount: 2.5, unit: "second" },
    ]);
    expect(hasReferenceVideoPrice(video)).toBe(true);
  });
  it("uses the explicit per-second unit for Muse base and resolution prices", () => {
    expect(doneBotModelPrices(model({ currency: "CNY", unit: "second", per_request: 2, tiers: { "720p": 1.5 } }), "video")).toEqual([
      { label: "基础价格", amount: 2, unit: "second" }, { label: "720p", amount: 1.5, unit: "second" },
    ]);
  });
  it.each(["music", "audio"] as const)("shows per-request %s tiers without changing their amounts", kind => {
    expect(doneBotModelPrices(model({ currency: "CNY", unit: "request", per_request: 1.2, tiers: { v6: 1.2 } }), kind)).toEqual([
      { label: "基础价格", amount: 1.2, unit: "request" }, { label: "v6", amount: 1.2, unit: "request" },
    ]);
  });
  it.each([undefined, {}, { currency: "USD", input_per_million: 2 }, { currency: "CNY", input_per_million: -1, output_per_million: "8" }])("does not invent or convert unavailable prices (%j)", pricing => {
    expect(doneBotModelPrices(model(pricing), "text")).toEqual([]);
  });
  it.each(["video", "audio"] as const)("does not guess a missing or unknown %s billing unit", kind => {
    for (const unit of [undefined, "unknown"]) expect(doneBotModelPrices(model({ currency: "CNY", per_request: 12, unit }), kind)).toEqual([]);
  });
  it("ignores malformed tiers and nonfinite prices without losing valid zero prices", () => {
    expect(doneBotModelPrices(model({ currency: "CNY", image_sizes: { "1K": 0, "2K": NaN, "3K": Infinity, "4K": -1, "5K": "2" } }), "image")).toEqual([{ label: "1K", amount: 0, unit: "image" }]);
    for (const tiers of [null, "invalid", [], 12]) {
      const invalid = model({ currency: "CNY", unit: "second", tiers });
      expect(doneBotModelPrices(invalid, "video")).toEqual([]);
      expect(hasReferenceVideoPrice(invalid)).toBe(false);
    }
  });
  it("keeps category-specific units when a model has multiple media types", () => {
    const multimodal = model({ currency: "CNY", input_per_million: 2, image_sizes: { "1K": 0.5 } });
    for (const [kind, unit] of [["text", "millionTokens"], ["image", "image"]] as const satisfies ReadonlyArray<readonly [DoneBotModelKind, string]>) {
      expect(doneBotModelPrices(multimodal, kind)[0]?.unit).toBe(unit);
    }
  });
});
