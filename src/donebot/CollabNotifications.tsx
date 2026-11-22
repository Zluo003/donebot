import { useEffect, useRef, useState } from "react";
import { Check, UserPlus, Users, X } from "lucide-react";
import { api } from "@/state/api";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import {
  dismissCollabToast,
  isCollabEligible,
  openCollabDestination,
  refreshCollabOverview,
  setCollabUiContext,
  syncCollabAccount,
  useCollabStore,
  type CollabToastItem,
} from "./collab-store";
import { COLLAB_BUTTON } from "./collab-types";

const POLL_INTERVAL_MS = 10_000;

function supportsPopoverApi(): boolean {
  return typeof HTMLElement !== "undefined" && Object.hasOwn(HTMLElement.prototype, "popover");
}

export function CollabSyncHost() {
  const { state } = useStore();
  const eligible = isCollabEligible(state.config);
  const authenticated = state.config?.donebot?.authenticated === true;
  const accountId = authenticated ? (state.config?.donebot?.user?.id ?? null) : null;
  const modalOpen = state.appSettingsOpen || state.pluginsOpen || state.shortcutsOpen;

  useEffect(() => {
    setCollabUiContext({ activeView: state.activeView, modalOpen });
  }, [state.activeView, modalOpen]);

  useEffect(() => {
    syncCollabAccount(eligible && authenticated ? accountId : null);
  }, [eligible, authenticated, accountId]);

  useEffect(() => {
    if (!eligible || !authenticated || !state.hydrated) return;
    void refreshCollabOverview({ silent: true });

    const poll = () => {
      void refreshCollabOverview({ silent: true });
    };
    const refreshOnVisible = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void refreshCollabOverview({ silent: true });
      }
    };

    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    window.addEventListener("focus", poll);
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", poll);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [eligible, authenticated, state.hydrated, accountId]);

  return null;
}

export function CollabToastHost() {
  const { state, dispatch } = useStore();
  const { toasts, announcement, modalOpen: storeModalOpen } = useCollabStore();
  const [busyId, setBusyId] = useState<string | null>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  const priorFocusRef = useRef<HTMLElement | null>(null);
  const nativePopover = supportsPopoverApi();
  const modalOpen = storeModalOpen || state.appSettingsOpen || state.pluginsOpen || state.shortcutsOpen;
  const visible = isCollabEligible(state.config) && !modalOpen && toasts.length > 0;

  useEffect(() => {
    const el = regionRef.current as (HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    if (!el || !nativePopover) return;
    try {
      if (visible) {
        if (!el.matches(":popover-open")) el.showPopover?.();
      } else if (el.matches(":popover-open")) {
        el.hidePopover?.();
      }
    } catch { /* Safe fallback if detached or unsupported */ }
  }, [visible, nativePopover]);

  const dismissWithFocus = (toastId: string) => {
    const remaining = toasts.filter(item => item.id !== toastId);
    const active = typeof document !== "undefined" ? document.activeElement : null;
    const focusInside = Boolean(active && regionRef.current?.contains(active));
    dismissCollabToast(toastId);
    if (!focusInside) return;
    queueMicrotask(() => {
      if (remaining.length > 0) {
        const nextBtn = regionRef.current?.querySelector<HTMLElement>(`[data-collab-toast-close="${CSS.escape(remaining[0]!.id)}"]`);
        nextBtn?.focus();
      } else {
        priorFocusRef.current?.focus();
        priorFocusRef.current = null;
      }
    });
  };

  const quickAccept = async (toast: CollabToastItem) => {
    if (busyId) return;
    setBusyId(toast.id);
    try {
      if (toast.kind === "friend-request" && toast.requestId) {
        await api(`/api/donebot/collab/friends/requests/${toast.requestId}/accept`, { method: "POST", body: "{}" });
      } else if (toast.kind === "team-invitation" && toast.invitationId) {
        await api(`/api/donebot/collab/teams/invitations/${toast.invitationId}/accept`, { method: "POST", body: "{}" });
      }
      dismissWithFocus(toast.id);
      await refreshCollabOverview({ silent: true });
    } catch {
      openCollabDestination(dispatch, { kind: "inbox" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <p className="sr-only">协作通知播报</p>
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      <div
        ref={regionRef}
        role="region"
        aria-label="协作通知"
        data-collab-toast-region=""
        popover={nativePopover ? "manual" : undefined}
        onFocusCapture={(e) => {
          if (e.relatedTarget instanceof HTMLElement && !regionRef.current?.contains(e.relatedTarget)) {
            priorFocusRef.current = e.relatedTarget;
          }
        }}
        className={cn(
          "m-0 border-0 bg-transparent p-0 text-ink",
          "fixed right-4 top-12 z-50 w-[min(360px,calc(100vw-2rem))] flex-col gap-2.5",
          visible ? "flex" : "hidden",
        )}
        style={{ inset: "3rem 1rem auto auto" }}
      >
        {visible && toasts.map(toast => {
          const Icon = toast.kind === "friend-request" ? UserPlus : Users;
          const busy = busyId === toast.id;
          return (
            <div
              key={toast.id}
              data-collab-toast={toast.id}
              className="flex flex-col gap-2.5 rounded-2xl border border-hairline/70 bg-menu/95 p-3.5 shadow-xl backdrop-blur-md motion-safe:transition-opacity"
            >
              <div className="flex items-start gap-2.5">
                <span className={cn(
                  "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ring-1 ring-inset",
                  toast.kind === "friend-request"
                    ? "bg-danger/14 text-danger ring-danger/25"
                    : "bg-accent/14 text-accent-text ring-accent/25",
                )}>
                  <Icon size={15} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-ink">{toast.title}</div>
                  <p className="mt-0.5 break-words text-[12px] leading-snug text-ink-secondary">{toast.body}</p>
                </div>
                <button
                  type="button"
                  data-collab-toast-close={toast.id}
                  aria-label="关闭通知"
                  onClick={() => dismissWithFocus(toast.id)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-tertiary hover:bg-ink/[0.08] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    dismissCollabToast(toast.id);
                    openCollabDestination(dispatch, { kind: "inbox" });
                  }}
                  className={`${COLLAB_BUTTON} h-7 px-2.5 text-[12px]`}
                >
                  查看
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void quickAccept(toast)}
                  className={`${COLLAB_BUTTON} ui-button-primary h-7 px-2.5 text-[12px]`}
                >
                  <Check size={12} aria-hidden="true" />
                  {toast.kind === "friend-request" ? "同意" : "加入团队"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
