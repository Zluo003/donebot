import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { MENU_SHEET } from "@/components/menu-recipe";
import { cn } from "@/lib/cn";

export interface CollabSelectOption {
  value: string;
  label: string;
  hint?: string;
  dotClass?: string;
}

export interface CollabSelectProps {
  id?: string;
  value: string;
  options: readonly CollabSelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  placeholder?: string;
  variant?: "pill" | "field";
  disabled?: boolean;
  className?: string;
  menuMinWidth?: number;
  testAttr?: string;
}

interface MenuPosition {
  top?: number;
  bottom?: number;
  left: number;
  minWidth: number;
  maxHeight: number;
}

export function CollabSelect({
  id,
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = "请选择",
  variant = "field",
  disabled = false,
  className,
  menuMinWidth = 148,
  testAttr,
}: CollabSelectProps) {
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [pos, setPos] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const selectedIndex = useMemo(
    () => options.findIndex(opt => opt.value === value),
    [options, value],
  );
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const computePosition = () => {
    const el = triggerRef.current;
    if (!el || typeof window === "undefined") return;
    const rect = el.getBoundingClientRect();
    const minWidth = Math.max(Math.round(rect.width), menuMinWidth);
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - 12);
    const spaceAbove = Math.max(0, rect.top - 12);
    const openUp = spaceBelow < 210 && spaceAbove > spaceBelow;
    const maxLeft = Math.max(8, window.innerWidth - minWidth - 8);
    const left = Math.max(8, Math.min(rect.left, maxLeft));
    if (openUp) {
      setPos({
        bottom: Math.max(8, window.innerHeight - rect.top + 6),
        left,
        minWidth,
        maxHeight: Math.min(280, Math.max(120, spaceAbove - 6)),
      });
    } else {
      setPos({
        top: rect.bottom + 6,
        left,
        minWidth,
        maxHeight: Math.min(280, Math.max(120, spaceBelow - 6)),
      });
    }
  };

  useLayoutEffect(() => {
    if (!open) return;
    computePosition();
    setHighlightIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [open, selectedIndex, menuMinWidth]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (evt: MouseEvent) => {
      const target = evt.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key === "Escape") {
        evt.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      } else if (evt.key === "ArrowDown") {
        evt.preventDefault();
        setHighlightIndex(prev => (options.length === 0 ? -1 : (prev + 1 + options.length) % options.length));
      } else if (evt.key === "ArrowUp") {
        evt.preventDefault();
        setHighlightIndex(prev => (options.length === 0 ? -1 : (prev - 1 + options.length) % options.length));
      } else if (evt.key === "Home") {
        evt.preventDefault();
        if (options.length > 0) setHighlightIndex(0);
      } else if (evt.key === "End") {
        evt.preventDefault();
        if (options.length > 0) setHighlightIndex(options.length - 1);
      } else if (evt.key === "Enter") {
        const picked = options[highlightIndex];
        if (picked) {
          evt.preventDefault();
          onChange(picked.value);
          setOpen(false);
          triggerRef.current?.focus();
        }
      }
    };
    const onResize = () => computePosition();
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, options, highlightIndex, onChange]);

  const choose = (nextVal: string) => {
    onChange(nextVal);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const triggerProps: Record<string, unknown> = {};
  if (testAttr) triggerProps[testAttr] = "";

  const menuNode = open && pos ? (
    <div
      ref={menuRef}
      id={listboxId}
      role="listbox"
      aria-label={ariaLabel}
      data-collab-select-menu={testAttr || id || ariaLabel || ""}
      style={{
        position: "fixed",
        left: `${pos.left}px`,
        top: pos.top !== undefined ? `${pos.top}px` : undefined,
        bottom: pos.bottom !== undefined ? `${pos.bottom}px` : undefined,
        minWidth: `${pos.minWidth}px`,
        maxHeight: `${pos.maxHeight}px`,
      }}
      className={cn(MENU_SHEET, "z-[120] overflow-y-auto")}
    >
      {options.map((opt, idx) => {
        const isSelected = opt.value === value;
        const isHighlighted = idx === highlightIndex;
        return (
          <button
            key={opt.value}
            type="button"
            role="option"
            aria-selected={isSelected}
            data-collab-select-option={opt.value}
            onMouseEnter={() => setHighlightIndex(idx)}
            onClick={() => choose(opt.value)}
            className={cn(
              "flex min-h-[30px] w-full shrink-0 items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] leading-[18px] transition-colors",
              isSelected
                ? "bg-accent/12 font-medium text-accent-text"
                : isHighlighted
                  ? "bg-ink/[0.07] text-ink"
                  : "text-ink hover:bg-ink/[0.06]",
            )}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {opt.dotClass && <span className={cn("size-2 shrink-0 rounded-full", opt.dotClass)} aria-hidden="true" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{opt.label}</span>
                {opt.hint && (
                  <span className="block truncate text-[11px] font-normal text-ink-tertiary">{opt.hint}</span>
                )}
              </span>
            </span>
            {isSelected && <Check size={13} className="shrink-0 text-accent-text" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => { if (!disabled) setOpen(prev => !prev); }}
        onKeyDown={evt => {
          if (disabled) return;
          if (!open && (evt.key === "ArrowDown" || evt.key === "ArrowUp" || evt.key === "Enter" || evt.key === " ")) {
            evt.preventDefault();
            setOpen(true);
          }
        }}
        {...triggerProps}
        className={cn(
          "inline-flex min-w-0 items-center justify-between gap-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50",
          variant === "pill"
            ? "h-7 rounded-full bg-ink/[0.05] px-2.5 text-[12px] text-ink ring-1 ring-inset ring-ink/[0.08] hover:bg-ink/[0.08]"
            : "w-full rounded-xl bg-inset/90 px-3 py-2 text-[13px] text-ink ring-1 ring-inset ring-ink/[0.09] hover:ring-ink/[0.16]",
          open && "ring-accent/45",
          className,
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {selected?.dotClass && (
            <span className={cn("size-2 shrink-0 rounded-full", selected.dotClass)} aria-hidden="true" />
          )}
          <span className={cn("truncate", !selected && "text-ink-tertiary")}>
            {selected?.label ?? placeholder}
          </span>
        </span>
        <ChevronDown
          size={variant === "pill" ? 12 : 14}
          aria-hidden="true"
          className={cn(
            "shrink-0 text-ink-tertiary transition-transform duration-150",
            open && "rotate-180 text-ink-secondary",
          )}
        />
      </button>
      {menuNode && typeof document !== "undefined" ? createPortal(menuNode, document.body) : menuNode}
    </>
  );
}
