import type { DoneBotGatewayModel, DoneBotModelKind } from "../../shared/donebot";
import { t } from "@/lib/i18n";

export const MODEL_PRICE_CATEGORIES = [
  { kind: "text", labelKey: "donebot.pricing.llm" },
  { kind: "image", labelKey: "donebot.pricing.image" },
  { kind: "video", labelKey: "donebot.pricing.video" },
  { kind: "music", labelKey: "donebot.pricing.music" },
  { kind: "audio", labelKey: "donebot.pricing.audio" },
] as const;

export interface ModelPriceLine {
  label: string;
  amount: number;
  unit: "millionTokens" | "thousandCharacters" | "image" | "second" | "request";
}

const price = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const prices = (value: unknown): Array<[string, number]> => value && typeof value === "object" && !Array.isArray(value)
  ? Object.entries(value).filter((entry): entry is [string, number] => price(entry[1])).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })) : [];

export function hasReferenceVideoPrice(model: DoneBotGatewayModel): boolean {
  return model.pricing?.currency === "CNY" && prices(model.pricing.tiers).some(([tier]) => tier.endsWith("|reference"));
}

export function doneBotModelPrices(model: DoneBotGatewayModel, kind: DoneBotModelKind): ModelPriceLine[] {
  const p = model.pricing;
  if (!p || p.currency !== "CNY") return [];
  const lines: ModelPriceLine[] = [];
  const add = (label: string, amount: unknown, unit: ModelPriceLine["unit"], divisor = 1) => {
    if (price(amount)) lines.push({ label, amount: amount / divisor, unit });
  };
  if (kind === "text") {
    add(t("donebot.pricing.input"), p.input_per_million, "millionTokens");
    add(t("donebot.pricing.output"), p.output_per_million, "millionTokens");
  } else if (kind === "image") {
    for (const [tier, amount] of prices(p.image_sizes)) add(tier === "input" ? t("donebot.pricing.referenceImage") : tier, amount, "image");
  } else {
    const unit = p.unit === "million_characters" ? "thousandCharacters"
      : p.unit === "second" ? "second" : p.unit === "request" || kind === "music" ? "request" : undefined;
    if (!unit) return [];
    const divisor = unit === "thousandCharacters" ? 1000 : 1;
    add(t("donebot.pricing.base"), p.per_request, unit, divisor);
    for (const [tier, amount] of prices(p.tiers)) {
      const [resolution, reference, ...rest] = tier.split("|");
      const label = kind === "video" && !rest.length && (reference === "standard" || reference === "reference")
        ? `${resolution} · ${t(reference === "reference" ? "donebot.pricing.withVideo" : "donebot.pricing.withoutVideo")}` : tier;
      add(label, amount, unit, divisor);
    }
  }
  return lines;
}

export function formatModelPrice(amount: number): string {
  return amount.toLocaleString("zh-CN", { maximumSignificantDigits: 12 });
}
