import { useEffect, useState } from "react";
import { LayoutDashboard } from "lucide-react";
import { cn } from "@/lib/cn";
import { closeInbox } from "@/state/inbox";
import { useStore } from "@/state/store";
import { OPC_OVERVIEW_CHANGED_EVENT, opcApi } from "./opc-api";

/**
 * Primary top-of-sidebar entry for the OPC Workspace Console ("工作台").
 * Mirrors SidebarInboxRow's exact geometry across Simple, Advanced, and Icon-rail modes.
 */
export function OpcBossSidebarRow({
  icons,
  large,
  onOpened,
}: {
  icons: boolean;
  large: boolean;
  onOpened?: () => void;
}) {
  const { state, dispatch } = useStore();
  const active = state.activeView === "boss";
  const [badge, setBadge] = useState<{ pending: number; tripped: number }>({ pending: 0, tripped: 0 });

  useEffect(() => {
    let alive = true;
    const poll = () => {
      void opcApi.getOverview(30).then(res => {
        if (alive) {
          setBadge({
            pending: res.pendingReportCount ?? ((res.pendingArtifactCount ?? 0) + (res.waitingWorkflowCount ?? 0)),
            tripped: res.trippedCircuitBreakerCount ?? 0,
          });
        }
      }).catch(() => {
        // Keep the entry visible even when connected to an older remote runtime.
      });
    };
    poll();
    const timer = window.setInterval(poll, 45_000);
    window.addEventListener(OPC_OVERVIEW_CHANGED_EVENT, poll);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener(OPC_OVERVIEW_CHANGED_EVENT, poll);
    };
  }, [active]);

  const count = badge.pending;
  const shown = count > 9 ? "9+" : String(count);
  const openBoss = () => {
    closeInbox();
    dispatch({ type: "showBoss" });
    onOpened?.();
  };

  if (icons) {
    return (
      <button
        type="button"
        data-sidebar-boss={count}
        aria-label={count > 0 ? `工作台（${count} 项待审批）` : "工作台"}
        title={count > 0 ? `工作台（${count} 项待审批）` : "工作台"}
        aria-current={active ? "page" : undefined}
        onClick={openBoss}
        className={cn(
          "relative mx-auto mb-1 flex size-[46px] shrink-0 items-center justify-center rounded-xl text-ink-secondary transition-colors hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
          active && "bg-raised text-ink",
        )}
      >
        <LayoutDashboard size={20} strokeWidth={1.5} aria-hidden="true" />
        {count > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-accent px-0.5 text-[10px] font-semibold leading-4 text-accent-ink tabular-nums"
          >
            {shown}
          </span>
        )}
        {badge.tripped > 0 && (
          <span
            aria-hidden="true"
            className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-panel bg-danger"
          />
        )}
      </button>
    );
  }

  return (
    <div className="px-3 pb-1">
      <button
        type="button"
        data-sidebar-boss={count}
        aria-current={active ? "page" : undefined}
        onClick={openBoss}
        className={cn(
          "flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-raised/60 focus-visible:ring-2 focus-visible:ring-accent/60",
          active && "bg-raised/85",
        )}
      >
        <span
          className={cn(
            "relative grid shrink-0 place-items-center rounded-full transition-colors",
            active ? "bg-ink/[0.16] text-ink" : "bg-raised text-ink-secondary",
            large ? "size-9" : "size-8",
          )}
        >
          <LayoutDashboard size={large ? 18 : 16} strokeWidth={1.75} aria-hidden="true" />
          {badge.tripped > 0 && (
            <span
              aria-hidden="true"
              className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-panel bg-danger"
            />
          )}
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-ink", large ? "text-[14px] font-medium leading-5" : "text-[15px] font-semibold leading-5")}>
          工作台
        </span>
        {count > 0 && (
          <span
            aria-hidden="true"
            className="shrink-0 rounded-full bg-ink/[0.12] px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-ink"
          >
            {shown}
          </span>
        )}
      </button>
    </div>
  );
}
