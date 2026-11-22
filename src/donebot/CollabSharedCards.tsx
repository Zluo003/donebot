import { useRef, useState } from "react";
import { Bot, Download, Eye, FolderOpen, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import type { DoneBotSharedBot, DoneBotSharedFolder } from "../../shared/donebot-collab";
import { accessLabel, COLLAB_BUTTON, displayPersonName, sourceText } from "./collab-types";
import { CollabAvatar } from "./CollabAvatar";
import { CollabFolderBrowser } from "./CollabFolderBrowser";

export function SectionTabBar<T extends string>({
  label,
  tabs,
  active,
  onChange,
  idPrefix,
}: {
  label: string;
  tabs: ReadonlyArray<{ id: T; label: string; count?: number }>;
  active: T;
  onChange: (next: T) => void;
  idPrefix: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: React.KeyboardEvent, idx: number) => {
    let nextIdx = -1;
    if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = tabs.length - 1;
    if (nextIdx < 0) return;
    e.preventDefault();
    const target = tabs[nextIdx];
    if (target) {
      onChange(target.id);
      refs.current[nextIdx]?.focus();
    }
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex gap-1 overflow-x-auto border-b border-ink/[0.08]"
    >
      {tabs.map((tab, idx) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={el => { refs.current[idx] = el; }}
            id={`${idPrefix}-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={e => onKeyDown(e, idx)}
            className={cn(
              "donebot-collab-tab inline-flex shrink-0 items-center gap-1.5 px-3.5 py-2.5 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus",
              selected ? "text-ink" : "text-ink-secondary hover:text-ink",
            )}
          >
            <span>{tab.label}</span>
            {tab.count !== undefined && (
              <span className="rounded-full bg-ink/[0.07] px-1.5 py-0.5 text-[10.5px] tabular-nums text-ink-secondary">
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function SharedFolderCards({
  folders,
  emptyText,
}: {
  folders: readonly DoneBotSharedFolder[];
  emptyText: string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (folders.length === 0) {
    return <p className="px-5 py-6 text-center text-[12.5px] text-ink-tertiary">{emptyText}</p>;
  }
  return (
    <ul className="divide-y divide-ink/[0.06]">
      {folders.map(folder => {
        const isOpen = openId === folder.id;
        const ownerName = displayPersonName({
          remark: folder.owner_remark,
          nickname: folder.owner_nickname,
          email: folder.owner_email,
        });
        return (
          <li key={folder.id} className="flex flex-col gap-3.5 px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-[#009957]/14 text-[#4CC98C] ring-1 ring-inset ring-[#009957]/24">
                  <FolderOpen size={16} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[14px] font-semibold text-ink">{folder.name}</span>
                    <span className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1 ring-inset",
                      folder.online
                        ? "bg-success/12 text-success ring-success/25"
                        : "bg-ink/[0.05] text-ink-tertiary ring-ink/10",
                    )}>
                      <span className={cn("size-1.5 rounded-full", folder.online ? "bg-success" : "bg-ink-tertiary/50")} aria-hidden="true" />
                      {folder.online ? "在线" : "对方离线"}
                    </span>
                    <span className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1 ring-inset",
                      folder.access === "write"
                        ? "bg-accent/14 text-accent-text ring-accent/25"
                        : "bg-ink/[0.05] text-ink-secondary ring-ink/10",
                    )}>
                      {accessLabel(folder.access)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-secondary">
                    <CollabAvatar
                      avatarUrl={folder.owner_avatar_url}
                      remark={folder.owner_remark}
                      nickname={folder.owner_nickname}
                      email={folder.owner_email}
                      size={18}
                    />
                    <span>{ownerName}</span>
                    <span className="text-ink-tertiary">· {folder.device_name} · {sourceText(folder.sources)}</span>
                  </div>
                </div>
              </div>
              <button
                type="button"
                disabled={!folder.online}
                onClick={() => setOpenId(isOpen ? null : folder.id)}
                className={cn(COLLAB_BUTTON, "text-[12px]", isOpen && "ui-button-primary")}
              >
                <Eye size={13} aria-hidden="true" />
                {isOpen ? "收起浏览" : "浏览文件"}
              </button>
            </div>
            {isOpen && <CollabFolderBrowser folder={folder} />}
          </li>
        );
      })}
    </ul>
  );
}

export function SharedBotCards({
  bots,
  emptyText,
  installingId,
  onInstall,
}: {
  bots: readonly DoneBotSharedBot[];
  emptyText: string;
  installingId: string | null;
  onInstall: (bot: DoneBotSharedBot) => void;
}) {
  if (bots.length === 0) {
    return <p className="px-5 py-6 text-center text-[12.5px] text-ink-tertiary">{emptyText}</p>;
  }
  return (
    <ul className="divide-y divide-ink/[0.06]">
      {bots.map(item => {
        const loading = installingId === item.id;
        const ownerName = displayPersonName({
          remark: item.owner_remark,
          nickname: item.owner_nickname,
          email: item.owner_email,
        });
        return (
          <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent/14 text-accent-text ring-1 ring-inset ring-accent/24">
                <Bot size={16} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[14px] font-semibold text-ink">{item.name}</span>
                  {item.has_soul && (
                    <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[10.5px] text-ink-secondary">SOUL.md</span>
                  )}
                  <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[10.5px] text-ink-secondary">{item.skill_count} 技能</span>
                </div>
                {item.title && <div className="mt-0.5 text-[12.5px] text-ink-secondary">{item.title}</div>}
                {item.description && <p className="mt-1 line-clamp-2 text-[12px] text-ink-tertiary">{item.description}</p>}
                <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-ink-tertiary">
                  <CollabAvatar
                    avatarUrl={item.owner_avatar_url}
                    remark={item.owner_remark}
                    nickname={item.owner_nickname}
                    email={item.owner_email}
                    size={16}
                  />
                  <span>来自 {ownerName}</span>
                </div>
              </div>
            </div>
            <button
              type="button"
              disabled={installingId !== null}
              onClick={() => onInstall(item)}
              className={`${COLLAB_BUTTON} ui-button-primary shrink-0 text-[12px]`}
            >
              {loading ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}
              {loading ? "正在添加…" : "添加到我的电脑"}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
