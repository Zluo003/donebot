import { UPSTREAM_SERVICES } from "@/donebot/services";
import type { CloudBackend } from "../../shared/wire";
import { cn } from "@/lib/cn";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";

export function CloudBackendPicker({
  value,
  compact = false,
  onChange,
}: {
  value: CloudBackend;
  compact?: boolean;
  onChange: (backend: CloudBackend) => void;
}) {
  const { state } = useStore();
  const selected = value === "box" && !UPSTREAM_SERVICES.boat ? "donebot" : value;
  if (state.config?.cloudHome) return null;
  return (
    <div className="mt-3 rounded-lg bg-inset p-3">
      <div className="text-[12px] font-medium text-ink">{compact ? t("botAccess.cloud.provider") : t("botAccess.cloud.backend")}</div>
      {(UPSTREAM_SERVICES.boat || value === "vps") && <div className="mt-0.5 text-[12px] text-ink-secondary">
        {compact
          ? value === "vps" ? t("botAccess.cloud.vpsDescription") : t("botAccess.cloud.hostedDescription")
          : value === "vps"
          ? t("botAccess.cloud.vpsAutoDescription")
          : t("botAccess.cloud.hostedBackendDescription")}
      </div>}
      <div className="mt-2 flex overflow-hidden rounded-lg border border-hairline/40">
        {(["donebot", "box", "vps"] as const).filter(backend => backend !== "box" || UPSTREAM_SERVICES.boat).map((backend, i) => (
          <button
            key={backend}
            onClick={() => onChange(backend)}
            className={cn(
              "flex-1 py-1.5 text-[12px]",
              i > 0 && "border-l border-hairline/40",
              selected === backend ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
            )}
          >
            {backend === "donebot" ? "DoneBot Cloud" : backend === "vps" ? t("botAccess.cloud.selfHostedVps") : t("botAccess.cloud.boat")}
          </button>
        ))}
      </div>
    </div>
  );
}
