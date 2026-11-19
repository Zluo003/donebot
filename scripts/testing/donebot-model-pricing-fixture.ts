import type { DoneBotCatalog } from "../../shared/donebot.ts";
import { FAKE_DONEBOT_CATALOG } from "../../server/testing/fake-donebot-gateway.ts";

export const MODEL_PRICING_CATALOG: DoneBotCatalog = {
  ...structuredClone(FAKE_DONEBOT_CATALOG),
  models: [
    ...FAKE_DONEBOT_CATALOG.models.map(model => ({ ...structuredClone(model), pricing: model.media_types.includes("text")
      ? { currency: "CNY", input_per_million: 2, output_per_million: 8 }
      : model.media_types.includes("image") ? { currency: "CNY", image_sizes: { "1K": 0.5, "2K": 1, input: 0.1 } }
      : model.media_types.includes("video") ? { currency: "CNY", unit: "second", tiers: { "720p|standard": 2.5, "720p|reference": 1.25, "1080p|standard": 5 } }
      : model.media_types.includes("music") ? { currency: "CNY", unit: "request", per_request: 1.2, tiers: { v6: 1.2, "v6-mini": 0.6 } }
      : { currency: "CNY", unit: "million_characters", per_request: 12 } })),
    { id: "muse-video", display_name: "Muse Video", media_types: ["video"], interfaces: ["openai.videos"], platforms: [],
      pricing: { currency: "CNY", unit: "second", per_request: 2, tiers: { "720p": 1.5 } } },
    { id: "future-image-model-with-a-long-public-identifier-for-layout-testing", display_name: "尚未登记生成能力的图片模型（隔离测试）", media_types: ["image"], interfaces: ["openai.images"], platforms: [],
      pricing: { currency: "CNY", image_sizes: { "1K": 0 } } },
    { id: "fixture-audio-unpriced", display_name: "未提供价格的音频模型（隔离测试）", media_types: ["audio"], interfaces: ["openai.audio.speech"], platforms: [] },
  ],
};
