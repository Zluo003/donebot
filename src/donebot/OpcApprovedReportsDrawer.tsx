import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  Paperclip,
  Search,
  X,
} from "lucide-react";
import type {
  OpcBossReportAttachment,
  OpcBossReportItem,
} from "../../shared/donebot-opc";
import { BotAvatar } from "@/components/Avatar";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { cn } from "@/lib/cn";
import type { Bot } from "@/state/store";
import { ReportAttachmentTile } from "./OpcBossReportCard";

interface DateGroup {
  dayKey: string;
  label: string;
  items: OpcBossReportItem[];
}

function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDayHeading(ts: number, now: Date): string {
  const d = new Date(ts);
  const todayKey = localDayKey(now.getTime());
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterdayKey = localDayKey(yesterday.getTime());
  const key = localDayKey(ts);
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  if (key === todayKey) return `今天 · ${md}`;
  if (key === yesterdayKey) return `昨天 · ${md}`;
  if (d.getFullYear() === now.getFullYear()) {
    const weekday = d.toLocaleDateString("zh-CN", { weekday: "short" });
    return `${md} · ${weekday}`;
  }
  return `${d.getFullYear()}年${md}`;
}

function formatTimeOnly(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatFullTime(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function groupApprovedReportsByDate(
  reports: readonly OpcBossReportItem[],
  now = new Date(),
): DateGroup[] {
  const sorted = [...reports].sort(
    (a, b) => (b.approvedAt ?? b.at) - (a.approvedAt ?? a.at) || a.id.localeCompare(b.id),
  );
  const groups: DateGroup[] = [];
  const byDay = new Map<string, DateGroup>();
  for (const report of sorted) {
    const ts = report.approvedAt ?? report.at;
    const key = ts > 0 ? localDayKey(ts) : "unknown";
    let group = byDay.get(key);
    if (!group) {
      group = {
        dayKey: key,
        label: ts > 0 ? formatDayHeading(ts, now) : "历史归档",
        items: [],
      };
      byDay.set(key, group);
      groups.push(group);
    }
    group.items.push(report);
  }
  return groups;
}

export function OpcApprovedReportsDrawer({
  id,
  open,
  reports,
  botById,
  modalActive,
  onClose,
  onPreviewAttachment,
  onJumpChat,
}: {
  id: string;
  open: boolean;
  reports: readonly OpcBossReportItem[];
  botById: ReadonlyMap<string, Bot>;
  /** True when a higher-level modal (e.g., attachment preview) is open so Escape does not close both. */
  modalActive: boolean;
  onClose: () => void;
  onPreviewAttachment: (att: OpcBossReportAttachment, report: OpcBossReportItem) => void;
  onJumpChat: (report: OpcBossReportItem) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      setSelectedId(null);
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || modalActive) return;
      if (selectedId) {
        setSelectedId(null);
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, modalActive, selectedId, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return reports;
    return reports.filter(r =>
      r.title.toLowerCase().includes(q)
      || r.summary.toLowerCase().includes(q)
      || r.botName.toLowerCase().includes(q)
      || (r.department ?? "").toLowerCase().includes(q)
      || (r.workflow?.workflowName ?? "").toLowerCase().includes(q),
    );
  }, [reports, query]);

  const groups = useMemo(() => groupApprovedReportsByDate(filtered), [filtered]);
  const selected = useMemo(
    () => (selectedId ? reports.find(r => r.id === selectedId) ?? null : null),
    [reports, selectedId],
  );

  if (!open) return null;

  const selectedAuthor = selected
    ? [selected.botName, selected.department, selected.roleTitle].filter(Boolean).join(" · ")
    : "";
  const selectedBot = selected ? botById.get(selected.botId) : undefined;
  const selectedApprovedAt = selected ? (selected.approvedAt ?? selected.at) : 0;

  return (
    <>
      {/* Light backdrop on narrow viewports where the drawer overlays the main column */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 z-20 bg-black/35 backdrop-blur-[1px] lg:hidden"
      />

      <aside
        id={id}
        aria-label="已通过汇报"
        className={cn(
          "z-30 flex h-full shrink-0 flex-col border-l border-hairline/55 bg-panel/95 text-ink backdrop-blur-md",
          "fixed inset-y-0 right-0 w-[min(92vw,440px)] shadow-2xl lg:static lg:shadow-none",
          selected ? "lg:w-[460px]" : "lg:w-[390px]",
        )}
      >
        {/* Top bar */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline/50 px-4 py-3">
          {selected ? (
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="inline-flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1 text-[12.5px] font-medium text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink"
            >
              <ArrowLeft size={14} aria-hidden="true" />
              <span className="truncate">返回已通过汇报</span>
            </button>
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <Archive size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
              <h2 className="truncate text-[13.5px] font-semibold text-ink">已通过汇报</h2>
              <span className="rounded-full bg-ink/[0.07] px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-ink-secondary">
                {reports.length}
              </span>
            </div>
          )}

          <div className="flex shrink-0 items-center gap-1">
            {selected && (
              <button
                type="button"
                onClick={() => onJumpChat(selected)}
                className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink"
              >
                原对话 <ArrowUpRight size={12.5} aria-hidden="true" />
              </button>
            )}
            <button
              ref={closeBtnRef}
              type="button"
              onClick={onClose}
              aria-label="关闭已通过汇报栏"
              className="flex size-7 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Body: either full formal report reader or date-grouped list */}
        {selected ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="border-b border-hairline/45 bg-ink/[0.02] px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 size={11} aria-hidden="true" /> 已通过
                </span>
                <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] text-ink-secondary">
                  {selected.workflow ? selected.workflow.workflowName : "正式汇报"}
                </span>
              </div>
              <h3 className="mt-2.5 text-[16px] font-semibold leading-snug text-ink">
                {selected.title}
              </h3>
              <div className="mt-2.5 flex items-center gap-2.5">
                {selectedBot && <BotAvatar bot={selectedBot} size={24} />}
                <div className="min-w-0 text-[12px]">
                  <div className="truncate font-medium text-ink">{selectedAuthor}</div>
                  {selectedApprovedAt > 0 && (
                    <div className="tabular-nums text-ink-tertiary">
                      通过时间：{formatFullTime(selectedApprovedAt)}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="px-5 py-4 text-[13.5px] leading-7 text-ink">
              <ChatMarkdown text={selected.body} />
            </div>

            {selected.attachments.length > 0 && (
              <div className="border-t border-hairline/45 bg-ink/[0.015] px-5 py-4">
                <div className="mb-2.5 flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary">
                  <Paperclip size={12.5} aria-hidden="true" />
                  <span>汇报附件（{selected.attachments.length}）</span>
                </div>
                <div className="space-y-2">
                  {selected.attachments.map(att => (
                    <ReportAttachmentTile
                      key={att.id}
                      attachment={att}
                      onPreview={() => onPreviewAttachment(att, selected)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            {reports.length >= 4 && (
              <search className="shrink-0 border-b border-hairline/40 px-4 py-2.5">
                <label className="relative block">
                  <span className="sr-only">搜索已通过汇报</span>
                  <Search
                    size={13.5}
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-tertiary"
                  />
                  <input
                    type="search"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="按标题、汇报人或部门筛选…"
                    className="h-8 w-full rounded-lg border border-hairline/60 bg-inset/80 pl-8 pr-3 text-[12.5px] text-ink outline-none placeholder:text-ink-tertiary focus:border-ink/35"
                  />
                </label>
              </search>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {groups.length === 0 ? (
                <div className="flex flex-col items-center justify-center px-4 py-14 text-center">
                  <Archive size={24} className="text-ink-tertiary/70" aria-hidden="true" />
                  <p className="mt-3 text-[13px] font-medium text-ink-secondary">
                    {query.trim() ? "没有匹配的已通过汇报" : "暂无已通过的汇报"}
                  </p>
                  <p className="mt-1 text-[12px] leading-relaxed text-ink-tertiary">
                    {query.trim()
                      ? "试试更换关键词或清空筛选。"
                      : "你在老板台点击「通过」的汇报与附件都会按日期归档在这里，随时查阅和下载。"}
                  </p>
                </div>
              ) : (
                <div className="space-y-5">
                  {groups.map(group => (
                    <section key={group.dayKey} aria-label={group.label}>
                      <div className="sticky top-0 z-10 -mx-1 mb-2 bg-panel/95 px-1 py-1 text-[11.5px] font-medium text-ink-tertiary backdrop-blur-sm">
                        {group.label}
                      </div>
                      <ul className="space-y-2">
                        {group.items.map(report => {
                          const ts = report.approvedAt ?? report.at;
                          const author = [report.botName, report.department].filter(Boolean).join(" · ");
                          return (
                            <li key={report.id}>
                              <button
                                type="button"
                                onClick={() => setSelectedId(report.id)}
                                className="group block w-full rounded-xl border border-hairline/45 bg-card/85 p-3 text-left transition-colors hover:border-hairline/80 hover:bg-card"
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <span className="line-clamp-1 text-[13.5px] font-medium text-ink group-hover:underline">
                                    {report.title}
                                  </span>
                                  {ts > 0 && (
                                    <span className="shrink-0 text-[11px] tabular-nums text-ink-tertiary">
                                      {formatTimeOnly(ts)}
                                    </span>
                                  )}
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-tertiary">
                                  <span className="truncate">{author}</span>
                                  <span aria-hidden="true">·</span>
                                  <span>{report.workflow ? report.workflow.workflowName : "正式汇报"}</span>
                                  {report.attachments.length > 0 && (
                                    <span className="inline-flex items-center gap-0.5 text-ink-secondary">
                                      <Paperclip size={10.5} aria-hidden="true" />
                                      {report.attachments.length}
                                    </span>
                                  )}
                                </div>
                                {report.summary && (
                                  <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-ink-secondary">
                                    {report.summary}
                                  </p>
                                )}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
