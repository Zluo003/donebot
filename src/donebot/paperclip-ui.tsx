// MetricCard, DecisionCardFooter, NeedsYouPanel & NativeModalDialog adapted from Paperclip
// (https://github.com/paperclipai/paperclip) — Copyright (c) 2025 Paperclip AI (MIT License).

import { useEffect, useRef, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

export function OpcMetricCard({
  icon: Icon,
  value,
  label,
  hint,
  tone = "neutral",
  active,
  onClick,
}: {
  icon: LucideIcon;
  value: string | number;
  label: string;
  hint?: string;
  tone?: "neutral" | "accent" | "danger";
  active?: boolean;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "flex min-w-0 flex-1 flex-col rounded-xl bg-card/80 px-3 py-2.5 text-left ring-[0.5px] ring-hairline/60 transition-colors",
        onClick && "cursor-pointer hover:bg-raised/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        active && "bg-raised ring-accent/50",
      )}
    >
      <div className="flex items-center justify-between gap-1.5">
        <span className="truncate text-[11px] font-medium text-ink-tertiary">{label}</span>
        <Icon
          size={13}
          aria-hidden="true"
          className={cn(
            "shrink-0",
            tone === "danger" ? "text-danger" : tone === "accent" ? "text-accent" : "text-ink-tertiary/80",
          )}
        />
      </div>
      <div
        className={cn(
          "mt-1 truncate text-[17px] font-semibold leading-tight tracking-tight tabular-nums",
          tone === "danger" ? "text-danger" : "text-ink",
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 truncate text-[11px] text-ink-tertiary">{hint}</div>}
    </Tag>
  );
}

/** Keeps an approval card's metadata link on the left and action buttons aligned on the right. */
export function OpcDecisionCardFooter({
  leading,
  children,
  className,
}: {
  leading?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-2", className)}>
      {leading ? <div className="min-w-0 flex-1">{leading}</div> : null}
      {children ? <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">{children}</div> : null}
    </div>
  );
}

/** Calm inset context panel inside a Boss Approval card. */
export function OpcInsetPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 rounded-lg bg-app/75 p-2.5 ring-[0.5px] ring-hairline/40", className)}>
      {children}
    </div>
  );
}

/**
 * Native <dialog> modal following modern-web-guidance:
 * - Uses showModal() for browser-managed top layer, Esc dismissal, inert background, and focus return.
 * - Sets closedby="any" when lightDismiss is enabled, with pointerdown/pointerup bounds fallback for Safari.
 * - Uses overscroll-behavior: contain on dialog and ::backdrop (no body overflow locking).
 */
export function OpcNativeDialog({
  open,
  onClose,
  ariaLabelledBy,
  ariaLabel,
  lightDismiss = true,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  ariaLabelledBy?: string;
  ariaLabel?: string;
  lightDismiss?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handleClose = () => {
      dialog.returnValue = "";
      onCloseRef.current();
    };
    dialog.addEventListener("close", handleClose);
    if (!lightDismiss || (typeof HTMLDialogElement !== "undefined" && "closedBy" in HTMLDialogElement.prototype)) {
      return () => dialog.removeEventListener("close", handleClose);
    }
    const outside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let pressedOutside = false;
    const onDown = (e: PointerEvent) => { pressedOutside = outside(e); };
    const onUp = (e: PointerEvent) => { if (pressedOutside && outside(e) && dialog.open) dialog.close(); };
    dialog.addEventListener("pointerdown", onDown);
    dialog.addEventListener("pointerup", onUp);
    return () => {
      dialog.removeEventListener("close", handleClose);
      dialog.removeEventListener("pointerdown", onDown);
      dialog.removeEventListener("pointerup", onUp);
    };
  }, [lightDismiss, open]);

  if (!open) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby={ariaLabelledBy}
      aria-label={ariaLabelledBy ? undefined : ariaLabel}
      {...(lightDismiss ? ({ closedby: "any" } as Record<string, string>) : {})}
      className={cn(
        "m-auto max-h-[90dvh] w-[min(92vw,760px)] overflow-hidden rounded-2xl border border-hairline/70 bg-panel p-0 text-ink shadow-2xl",
        "overscroll-contain backdrop:overflow-hidden backdrop:bg-black/60 backdrop:backdrop-blur-[2px] backdrop:overscroll-contain",
        "open:flex open:flex-col",
        className,
      )}
    >
      {children}
    </dialog>
  );
}
