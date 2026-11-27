import { CircleAlert, Info, RefreshCw } from "lucide-react";
import { describePartialCause } from "@/lib/failed-turn";
import { t } from "@/lib/i18n";

/** A turn whose reply came back but an intermediate step failed or wasn't allowed. Ordinary failures stay a quiet,
 * collapsible note so completed replies don't look blocked; permission refusals keep a gentle warning accent. */
export function PartlyDoneRow({ cause, onRetry }: { cause: string; onRetry?: () => void }) {
  const view = describePartialCause(cause);
  const tone = view.refused
    ? "border-warning/25 bg-warning/8 text-warning"
    : "border-hairline/70 bg-raised/55 text-ink-secondary";
  return (
    <div className="flex justify-start">
      <div className={`w-fit max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] rounded-xl border px-3 py-2 text-[13px] ${tone}`}>
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 select-none [&::-webkit-details-marker]:hidden">
            {view.refused
              ? <CircleAlert size={13} className="shrink-0" />
              : <Info size={13} className="shrink-0 text-ink-tertiary" />}
            <span className="min-w-0 break-words">{view.summary}</span>
            <span className="ml-1 shrink-0 text-[12px] text-ink-tertiary underline-offset-2 group-hover:underline">{t("chat.error.details")}</span>
          </summary>
          <div className="mt-2 space-y-1.5 border-t border-hairline/40 pt-2 text-[12px] text-ink-secondary">
            {view.detail !== cause && <p className="break-words leading-relaxed">{view.detail}</p>}
            <p className="break-words text-[12px] text-ink-tertiary">{cause}</p>
            {onRetry && (
              <button
                onClick={onRetry}
                className="ui-button ui-button-sm mt-1 rounded-full border-hairline/80 bg-transparent text-ink-secondary hover:bg-raised hover:text-ink"
              >
                <RefreshCw size={11} /> {t("chat.retry")}
              </button>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}
