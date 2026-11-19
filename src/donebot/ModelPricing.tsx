import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { DoneBotCatalog } from "../../shared/donebot";
import { api } from "@/state/api";
import { useStore } from "@/state/store";
import { Card } from "@/components/SettingsPrimitives";
import { t } from "@/lib/i18n";
import { doneBotModelPrices, formatModelPrice, hasReferenceVideoPrice, MODEL_PRICE_CATEGORIES } from "./model-pricing";

export function DoneBotModelPricing() {
  const { state } = useStore();
  const account = state.config?.donebot?.user?.id;
  return account ? <ModelPricingCatalog key={account} /> : <p className="text-[13px] text-ink-secondary">{t("donebot.pricing.signIn")}</p>;
}

function ModelPricingCatalog() {
  const [catalog, setCatalog] = useState<DoneBotCatalog | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const refresh = async () => {
    const generation = ++epoch.current;
    setBusy(true); setCatalog(null); setError("");
    try {
      const result = await api<DoneBotCatalog>("/api/donebot/catalog");
      if (generation === epoch.current) setCatalog(result);
    } catch (error) {
      if (generation === epoch.current) setError(error instanceof Error ? error.message : t("donebot.pricing.failed"));
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  };
  useEffect(() => { void refresh(); return () => { epoch.current++; }; }, []);
  return <div data-donebot-model-pricing className="flex min-w-0 flex-col gap-4" aria-busy={busy}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <p className="max-w-lg text-[13px] leading-relaxed text-ink-secondary">{t("donebot.pricing.subtitle")}</p>
      <button type="button" disabled={busy} onClick={() => void refresh()} className="ui-button inline-flex shrink-0 items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50">
        <RefreshCw size={14} className={busy ? "animate-spin" : ""} />{t("donebot.pricing.refresh")}
      </button>
    </div>
    {busy && <p role="status" className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />{t("donebot.pricing.loading")}</p>}
    {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    {catalog && MODEL_PRICE_CATEGORIES.map(({ kind, labelKey }) => {
      const models = catalog.models.filter(model => model.media_types.includes(kind));
      return <section key={kind} data-model-price-category={kind} aria-label={t(labelKey)}>
        <Card title={`${t(labelKey)} · ${models.length}`}>
          {models.length === 0 ? <p className="text-[13px] text-ink-secondary">{t("donebot.pricing.empty")}</p> : <ul className="divide-y divide-hairline">
            {models.map(model => {
              const lines = doneBotModelPrices(model, kind);
              return <li key={model.id} data-model-price-id={model.id} className="min-w-0 py-3 first:pt-0 last:pb-0">
                <p className="break-words text-[14px] font-medium text-ink [overflow-wrap:anywhere]">{model.display_name || model.id}</p>
                {model.display_name && model.display_name !== model.id && <p className="mt-0.5 break-all text-[12px] text-ink-secondary">{model.id}</p>}
                {lines.length ? <dl className="mt-2 grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2">
                  {lines.map((line, index) => <div key={index} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <dt className="break-words text-ink-secondary">{line.label}</dt>
                    <dd className="m-0 text-ink tabular-nums">{formatModelPrice(line.amount)} {t(`donebot.pricing.unit.${line.unit}`)}</dd>
                  </div>)}
                </dl> : <p className="mt-2 text-[13px] text-ink-secondary">{t("donebot.pricing.unavailable")}</p>}
                {kind === "video" && hasReferenceVideoPrice(model) && <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("donebot.pricing.referenceBilling")}</p>}
              </li>;
            })}
          </ul>}
        </Card>
      </section>;
    })}
  </div>;
}
