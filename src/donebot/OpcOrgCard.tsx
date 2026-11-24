import type { PointerEvent as ReactPointerEvent } from "react";
import {
  BookOpen,
  Brain,
  Crown,
  GripVertical,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import type { OpcOrgNodeConfig } from "../../shared/donebot-opc";
import { BotAvatar } from "@/components/Avatar";
import { openBotSettings } from "@/components/bot-panel/panel-link";
import { InstanceProviderMark, ProviderMark } from "@/components/ProviderIcons";
import { cn } from "@/lib/cn";
import { teamMapStatus } from "@/lib/team-map";
import { useShowThreads } from "@/lib/thread-preferences";
import { openBot, useStore, type Bot } from "@/state/store";
import { formatCny } from "./market-api";
import type { TopDownLayoutNode } from "./paperclip-org-layout";

export function OpcDeptMenu({
  sectionKey,
  label,
  onEditTeam,
  onInstructions,
  onMemory,
  onRenameGeneralDepartment,
  onDeleteTeam,
}: {
  sectionKey: string;
  label: string;
  onEditTeam: (sectionKey: string, rename?: boolean) => void;
  onInstructions: (sectionKey: string, label: string) => void;
  onMemory: (sectionKey: string, label: string) => void;
  onRenameGeneralDepartment: (currentLabel: string) => void;
  onDeleteTeam: (sectionKey: string) => void;
}) {
  return (
    <details className="relative" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
      <summary
        aria-label={`管理「${label}」部门`}
        className="flex size-7 cursor-pointer list-none items-center justify-center rounded-lg text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink [&::-webkit-details-marker]:hidden"
      >
        <MoreHorizontal size={15} />
      </summary>
      <div
        className="absolute right-0 top-8 z-30 w-44 rounded-xl border border-hairline/70 bg-panel p-1.5 text-[12px] shadow-xl"
        onClick={(e) => {
          const details = e.currentTarget.closest("details");
          details?.removeAttribute("open");
        }}
      >
        <button type="button" onClick={() => onEditTeam(sectionKey)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-ink-secondary hover:bg-ink/[0.06] hover:text-ink">
          <Users size={13} /> 管理部门成员
        </button>
        <button type="button" onClick={() => onInstructions(sectionKey, label)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-ink-secondary hover:bg-ink/[0.06] hover:text-ink">
          <BookOpen size={13} /> 部门公共指令
        </button>
        <button type="button" onClick={() => onMemory(sectionKey, label)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-ink-secondary hover:bg-ink/[0.06] hover:text-ink">
          <Brain size={13} /> 部门共享记忆
        </button>
        <button
          type="button"
          onClick={() => (sectionKey ? onEditTeam(sectionKey, true) : onRenameGeneralDepartment(label))}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-ink-secondary hover:bg-ink/[0.06] hover:text-ink"
        >
          <Pencil size={13} /> 重命名部门
        </button>
        {sectionKey && (
          <button type="button" onClick={() => onDeleteTeam(sectionKey)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-ink-secondary hover:bg-danger/10 hover:text-danger">
            <Trash2 size={13} /> 删除部门
          </button>
        )}
      </div>
    </details>
  );
}

export function OpcOrgNodeCard({
  node,
  isBoss,
  bot,
  cfg,
  spend,
  selected,
  tagged,
  sentKey,
  isDraggingSource,
  isDropTarget,
  hoverInvalid,
  isWireTarget,
  wiringActive,
  hasNamedDepartments,
  deptLabel,
  onPointerDown,
  onSelect,
  onHandoffPortDown,
}: {
  node: TopDownLayoutNode;
  isBoss: boolean;
  bot: Bot | null;
  cfg?: OpcOrgNodeConfig;
  spend: number;
  selected: boolean;
  tagged: boolean;
  sentKey?: number;
  isDraggingSource: boolean;
  isDropTarget: boolean;
  hoverInvalid: boolean;
  isWireTarget: boolean;
  wiringActive: boolean;
  hasNamedDepartments: boolean;
  deptLabel: string;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onSelect: () => void;
  onHandoffPortDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const status = bot ? teamMapStatus(bot) : null;
  const instance = bot ? state.instances?.find(item => item.instanceId === bot.modelSelection?.instanceId) : undefined;
  const modelLabel = bot
    ? (instance?.models.options.find(item => item.id === bot.modelSelection?.model)?.label ?? bot.modelSelection?.model ?? "")
    : "";

  return (
    <div
      data-org-node={node.id}
      tabIndex={isBoss ? undefined : 0}
      onPointerDown={onPointerDown}
      onClick={e => {
        if (isBoss) return;
        if ((e.target as HTMLElement).closest("button")) return;
        e.stopPropagation();
        onSelect();
      }}
      onKeyDown={e => {
        if (!isBoss && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect();
        }
      }}
      style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
      className={cn(
        "group absolute flex flex-col justify-between rounded-2xl transition-[box-shadow,transform,opacity] duration-150 select-none",
        isBoss
          ? "cursor-default bg-ink px-4 py-3 text-app shadow-sm"
          : "cursor-grab bg-panel/95 text-ink ring-[0.75px] ring-hairline/80 hover:ring-ink/40 active:cursor-grabbing",
        selected && !isBoss && "ring-2 ring-ink shadow-md",
        tagged && !isBoss && "ring-2 ring-accent shadow-md",
        isDraggingSource && "opacity-35 ring-1 ring-ink/30",
        isDropTarget && !hoverInvalid && "scale-[1.03] ring-2 ring-accent shadow-lg",
        isDropTarget && hoverInvalid && "ring-2 ring-danger",
        isWireTarget && "ring-2 ring-accent shadow-lg",
      )}
    >
      {sentKey !== undefined && (
        <span key={sentKey} data-sent-highlight aria-hidden className="pointer-events-none absolute -inset-px animate-sent-border rounded-2xl border-2 border-accent" />
      )}

      {isBoss ? (
        <div className="flex h-full items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-app/15">
            <Crown size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold">{node.name}</div>
            <div className="mt-0.5 truncate text-[11.5px] text-app/75">{node.role}</div>
          </div>
        </div>
      ) : bot ? (
        <>
          <div className="flex items-center gap-2.5 px-3.5 pt-3">
            <BotAvatar bot={bot} size={32} motion="none" motionKey={0} animated={false} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[13.5px] font-semibold">{node.name}</span>
                {bot.chiefOfStaff && <Crown size={11.5} className="shrink-0 text-warning" aria-label={node.section ? "部门负责人" : "系统总协调"} />}
                {status && status.tone !== "idle" && (
                  <span
                    title={status.label}
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      status.tone === "success" ? "bg-success animate-pulse" : status.tone === "warning" ? "bg-warning" : "bg-danger",
                    )}
                  />
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-tertiary">
                <span className="truncate">{node.role}</span>
                {hasNamedDepartments && (
                  <span className="shrink-0 rounded bg-ink/[0.06] px-1.5 py-0.2 text-[10px] text-ink-secondary">
                    {deptLabel}
                  </span>
                )}
              </div>
            </div>
            <GripVertical size={13} className="shrink-0 text-ink-tertiary/40 group-hover:text-ink-tertiary" aria-hidden="true" />
          </div>

          <div className="flex items-center gap-1 border-t border-hairline/35 px-2.5 py-1.5 text-[10.5px] text-ink-tertiary">
            <button
              type="button"
              onClick={e => { e.stopPropagation(); openBot(dispatch, bot, showThreads); }}
              aria-label={`与 ${bot.name} 对话`}
              title="打开对话"
              className="flex size-6.5 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-ink/[0.06] hover:text-ink"
            >
              <MessageCircle size={12.5} />
            </button>
            <button
              type="button"
              onClick={e => { e.stopPropagation(); openBotSettings(dispatch, "model", { botId: bot.id }); }}
              title={`默认模型：${modelLabel || "默认"}`}
              className="flex h-6.5 min-w-0 max-w-[116px] items-center gap-1 rounded-md px-1.5 text-ink-secondary hover:bg-ink/[0.06] hover:text-ink"
            >
              <span className="flex size-3 shrink-0 items-center justify-center">
                {instance ? <InstanceProviderMark instance={instance} size={12} /> : <ProviderMark driverKind="" size={12} />}
              </span>
              <span className="truncate">{modelLabel || "默认模型"}</span>
            </button>
            {cfg?.requireBossApproval && (
              <span title="产物须老板拍板" className="inline-flex shrink-0 items-center text-accent">
                <ShieldCheck size={11.5} />
              </span>
            )}
            <span className="ml-auto shrink-0 tabular-nums">{formatCny(spend)}</span>
          </div>

          <button
            type="button"
            aria-label={`从「${bot.name}」拉出交接连线`}
            title="按住拖向另一员工建立交接连线（支持跨部门）"
            onPointerDown={onHandoffPortDown}
            className={cn(
              "absolute -right-2 top-1/2 flex size-4 -translate-y-1/2 cursor-crosshair items-center justify-center rounded-full border-2 border-panel bg-accent shadow-xs transition-all hover:scale-125",
              wiringActive ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
          />
        </>
      ) : null}
    </div>
  );
}
