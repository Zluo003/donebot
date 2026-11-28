import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileText,
  Inbox,
  Paperclip,
  Search,
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

export type WorkbenchReportsTab = "briefings" | "approved" | "attachments";
type AttachmentKindFilter = "all" | OpcBossReportAttachment["kind"];

export const WORKBENCH_REPORTS_PAGE_SIZE = 10;

function buildPageNumbers(currentPage: number, totalPages: number): Array<number | "ellipsis"> {
  if (totalPages <= 1) return [1];
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const pages = new Set<number>([1, totalPages]);
  const start = currentPage <= 4 ? 2 : currentPage >= totalPages - 3 ? totalPages - 4 : currentPage - 1;
  const end = currentPage <= 4 ? 5 : currentPage >= totalPages - 3 ? totalPages - 1 : currentPage + 1;
  for (let p = start; p <= end; p++) {
    if (p > 1 && p < totalPages) pages.add(p);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const out: Array<number | "ellipsis"> = [];
  for (const p of sorted) {
    const prev = out.at(-1);
    if (typeof prev === "number" && p - prev > 1) out.push("ellipsis");
    out.push(p);
  }
  return out;
}

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
  const key = localDayKey(ts);
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  if (key === todayKey) return `今天 · ${md}`;
  if (key === localDayKey(yesterday.getTime())) return `昨天 · ${md}`;
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
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function groupReportsByDate(
  reports: readonly OpcBossReportItem[],
  stamp: (item: OpcBossReportItem) => number,
  now = new Date(),
): DateGroup[] {
  const sorted = [...reports].sort((a, b) => stamp(b) - stamp(a) || a.id.localeCompare(b.id));
  const groups: DateGroup[] = [];
  const byDay = new Map<string, DateGroup>();
  for (const report of sorted) {
    const ts = stamp(report);
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

function sourceBadgeLabel(report: OpcBossReportItem): string {
  if (report.workflow) return `${report.workflow.workflowName} · 已完成`;
  if (report.source === "routine") return "定时汇报";
  return "工作报告";
}

function ExpandableReportRow({
  report,
  mode,
  bot,
  busyRead,
  onToggleRead,
  onPreviewAttachment,
  onJumpChat,
}: {
  report: OpcBossReportItem;
  mode: "briefing" | "approved";
  bot?: Bot;
  busyRead?: boolean;
  onToggleRead?: (report: OpcBossReportItem, read: boolean) => void;
  onPreviewAttachment: (att: OpcBossReportAttachment, report: OpcBossReportItem) => void;
  onJumpChat: (report: OpcBossReportItem) => void;
}) {
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const unread = mode === "briefing" && report.readAt === undefined;
  const displayTs = mode === "approved" ? (report.approvedAt ?? report.at) : report.at;
  const authorMeta = [report.botName, report.department, report.roleTitle].filter(Boolean).join(" · ");

  return (
    <article className="py-3">
      <div className="flex flex-wrap items-start gap-2.5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded(v => !v)}
          className="group flex min-w-0 flex-1 items-start gap-2.5 rounded-xl px-1.5 py-1 text-left transition-colors hover:bg-ink/[0.03]"
        >
          <ChevronRight
            size={15}
            aria-hidden="true"
            className={cn(
              "mt-1 shrink-0 text-ink-tertiary transition-transform duration-150 group-hover:text-ink",
              expanded && "rotate-90 text-ink",
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {unread && (
                <span
                  aria-label="未读"
                  className="size-2 shrink-0 rounded-full bg-accent"
                />
              )}
              <span className={cn("truncate text-[14px] font-medium", unread ? "text-ink" : "text-ink/85")}>
                {report.title}
              </span>
              {mode === "approved" ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 size={10.5} aria-hidden="true" /> 已通过
                </span>
              ) : (
                <span className="shrink-0 rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
                  {sourceBadgeLabel(report)}
                </span>
              )}
              {report.attachments.length > 0 && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ink/[0.05] px-2 py-0.5 text-[11px] tabular-nums text-ink-secondary">
                  <Paperclip size={10.5} aria-hidden="true" />
                  {report.attachments.length} 份附件
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-tertiary">
              <span>{authorMeta}</span>
              {displayTs > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">{formatTimeOnly(displayTs)}</span>
                </>
              )}
              {!expanded && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-ink-secondary">点击展开正文</span>
                </>
              )}
            </div>
            {!expanded && report.summary && (
              <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink-secondary">
                {report.summary}
              </p>
            )}
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          {mode === "briefing" && onToggleRead && (
            <button
              type="button"
              disabled={busyRead}
              onClick={() => onToggleRead(report, unread)}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium transition-colors disabled:opacity-45",
                unread
                  ? "bg-ink/[0.07] text-ink hover:bg-ink/[0.13]"
                  : "text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink-secondary",
              )}
            >
              <Check size={12} aria-hidden="true" />
              {unread ? "标为已读" : "已读"}
            </button>
          )}
          <button
            type="button"
            onClick={() => onJumpChat(report)}
            aria-label={`查看「${report.title}」原对话`}
            title="查看原对话"
            className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink"
          >
            原对话 <ArrowUpRight size={12} aria-hidden="true" />
          </button>
        </div>
      </div>

      {expanded && (
        <div id={panelId} className="mt-2.5 overflow-hidden rounded-2xl border border-hairline/55 bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline/45 bg-ink/[0.02] px-5 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              {bot && <BotAvatar bot={bot} size={24} />}
              <div className="min-w-0 text-[12px]">
                <div className="truncate font-medium text-ink">汇报人：{authorMeta}</div>
                <div className="tabular-nums text-ink-tertiary">
                  {mode === "approved" ? "通过时间：" : "提交时间："}
                  {formatFullTime(displayTs)}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onJumpChat(report)}
              className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink"
            >
              查看原对话 <ArrowUpRight size={12.5} aria-hidden="true" />
            </button>
          </div>

          <div className="px-5 py-4 text-[14px] leading-7 text-ink">
            <ChatMarkdown text={report.body} />
          </div>

          {report.attachments.length > 0 && (
            <div className="border-t border-hairline/45 bg-ink/[0.015] px-5 py-3.5">
              <div className="mb-2.5 flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary">
                <Paperclip size={12.5} aria-hidden="true" />
                <span>汇报附件（{report.attachments.length}）</span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {report.attachments.map(att => (
                  <ReportAttachmentTile
                    key={att.id}
                    attachment={att}
                    onPreview={() => onPreviewAttachment(att, report)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export function OpcBriefingReportsPanel({
  activeTab,
  onTabChange,
  briefingReports,
  approvedReports,
  pendingReports,
  botById,
  unreadOnly,
  onUnreadOnlyChange,
  onMarkReportsRead,
  onPreviewAttachment,
  onJumpChat,
}: {
  activeTab: WorkbenchReportsTab;
  onTabChange: (tab: WorkbenchReportsTab) => void;
  briefingReports: readonly OpcBossReportItem[];
  approvedReports: readonly OpcBossReportItem[];
  pendingReports: readonly OpcBossReportItem[];
  botById: ReadonlyMap<string, Bot>;
  unreadOnly: boolean;
  onUnreadOnlyChange: (value: boolean) => void;
  onMarkReportsRead: (reportIds: string[], read: boolean) => Promise<void>;
  onPreviewAttachment: (att: OpcBossReportAttachment, report: OpcBossReportItem) => void;
  onJumpChat: (report: OpcBossReportItem) => void;
}) {
  const tabPrefix = useId();
  const sectionTopRef = useRef<HTMLElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [department, setDepartment] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [attachmentKind, setAttachmentKind] = useState<AttachmentKindFilter>("all");
  const [page, setPage] = useState(1);
  const [busyReadIds, setBusyReadIds] = useState<ReadonlySet<string>>(() => new Set());
  const [markingAll, setMarkingAll] = useState(false);

  useEffect(() => {
    setPage(1);
  }, [activeTab, unreadOnly, department, query, attachmentKind]);

  const unreadBriefings = useMemo(
    () => briefingReports.filter(r => r.readAt === undefined),
    [briefingReports],
  );

  const allAttachments = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ attachment: OpcBossReportAttachment; report: OpcBossReportItem; at: number }> = [];
    for (const list of [pendingReports, briefingReports, approvedReports]) {
      for (const report of list) {
        for (const attachment of report.attachments) {
          if (seen.has(attachment.id)) continue;
          seen.add(attachment.id);
          out.push({ attachment, report, at: report.approvedAt ?? report.at });
        }
      }
    }
    return out.sort((a, b) => b.at - a.at || a.attachment.id.localeCompare(b.attachment.id));
  }, [pendingReports, briefingReports, approvedReports]);

  const activeList = activeTab === "approved" ? approvedReports : briefingReports;

  const departments = useMemo(() => {
    const set = new Set<string>();
    for (const r of activeList) {
      if (r.department?.trim()) set.add(r.department.trim());
    }
    return [...set].sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [activeList]);

  const effectiveDepartment = department !== "all" && departments.includes(department) ? department : "all";

  const filteredReports = useMemo(() => {
    const q = query.trim().toLowerCase();
    return activeList.filter(r => {
      if (activeTab === "briefings" && unreadOnly && r.readAt !== undefined) return false;
      if (effectiveDepartment !== "all" && (r.department?.trim() ?? "") !== effectiveDepartment) return false;
      if (!q) return true;
      return (
        r.title.toLowerCase().includes(q)
        || r.summary.toLowerCase().includes(q)
        || r.botName.toLowerCase().includes(q)
        || (r.department ?? "").toLowerCase().includes(q)
        || (r.workflow?.workflowName ?? "").toLowerCase().includes(q)
      );
    });
  }, [activeList, activeTab, unreadOnly, effectiveDepartment, query]);

  const sortedFilteredReports = useMemo(() => {
    const stamp = (item: OpcBossReportItem) => (activeTab === "approved" ? (item.approvedAt ?? item.at) : item.at);
    return [...filteredReports].sort((a, b) => stamp(b) - stamp(a) || a.id.localeCompare(b.id));
  }, [filteredReports, activeTab]);

  const filteredAttachments = useMemo(
    () => attachmentKind === "all"
      ? allAttachments
      : allAttachments.filter(entry => entry.attachment.kind === attachmentKind),
    [allAttachments, attachmentKind],
  );

  const totalItems = activeTab === "attachments" ? filteredAttachments.length : sortedFilteredReports.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / WORKBENCH_REPORTS_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  const pagedReports = useMemo(() => {
    const start = (safePage - 1) * WORKBENCH_REPORTS_PAGE_SIZE;
    return sortedFilteredReports.slice(start, start + WORKBENCH_REPORTS_PAGE_SIZE);
  }, [sortedFilteredReports, safePage]);

  const pagedAttachments = useMemo(() => {
    const start = (safePage - 1) * WORKBENCH_REPORTS_PAGE_SIZE;
    return filteredAttachments.slice(start, start + WORKBENCH_REPORTS_PAGE_SIZE);
  }, [filteredAttachments, safePage]);

  const dateGroups = useMemo(
    () => groupReportsByDate(
      pagedReports,
      item => (activeTab === "approved" ? (item.approvedAt ?? item.at) : item.at),
    ),
    [pagedReports, activeTab],
  );

  const goToPage = (nextPage: number) => {
    const clamped = Math.max(1, Math.min(totalPages, nextPage));
    if (clamped === safePage) return;
    setPage(clamped);
    if (typeof sectionTopRef.current?.scrollIntoView === "function") {
      sectionTopRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  };

  const tabs: Array<{ key: WorkbenchReportsTab; label: string; count: number; highlight?: number }> = [
    { key: "briefings", label: "最新报告", count: briefingReports.length, highlight: unreadBriefings.length },
    { key: "approved", label: "已通过归档", count: approvedReports.length },
    { key: "attachments", label: "交付附件", count: allAttachments.length },
  ];

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = -1;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const target = tabs[nextIndex]!;
    onTabChange(target.key);
    tabRefs.current[nextIndex]?.focus();
  };

  const handleToggleRead = async (report: OpcBossReportItem, read: boolean) => {
    setBusyReadIds(prev => new Set(prev).add(report.id));
    try {
      await onMarkReportsRead([report.id], read);
    } finally {
      setBusyReadIds(prev => {
        const next = new Set(prev);
        next.delete(report.id);
        return next;
      });
    }
  };

  const handleMarkAllRead = async () => {
    if (unreadBriefings.length === 0 || markingAll) return;
    setMarkingAll(true);
    try {
      await onMarkReportsRead(unreadBriefings.map(r => r.id), true);
    } finally {
      setMarkingAll(false);
    }
  };

  const activeTabId = `${tabPrefix}-tab-${activeTab}`;

  return (
    <section ref={sectionTopRef} aria-label="工作报告">
      {/* Single-row WAI-ARIA tablist styled from aria-selected with border underline */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline/55">
        <div
          role="tablist"
          aria-label="工作报告视图"
          className="flex flex-nowrap items-center gap-1 overflow-x-auto"
        >
          {tabs.map((item, idx) => {
            const selected = activeTab === item.key;
            return (
              <button
                key={item.key}
                ref={el => { tabRefs.current[idx] = el; }}
                id={`${tabPrefix}-tab-${item.key}`}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => onTabChange(item.key)}
                onKeyDown={e => handleTabKeyDown(e, idx)}
                className={cn(
                  "relative inline-flex shrink-0 items-center gap-1.5 px-3 pb-3 pt-1 text-[13px] font-medium transition-colors",
                  "text-ink-secondary hover:text-ink aria-selected:text-ink",
                  "after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:border-b-2 after:border-transparent aria-selected:after:border-ink",
                )}
              >
                <span>{item.label}</span>
                {item.highlight && item.highlight > 0 ? (
                  <span className="rounded-full bg-accent/14 px-1.5 py-0.5 text-[11px] leading-none tabular-nums text-accent">
                    {item.highlight} 未读
                  </span>
                ) : item.count > 0 ? (
                  <span className="rounded-full bg-ink/[0.07] px-1.5 py-0.5 text-[11px] leading-none tabular-nums text-ink-secondary">
                    {item.count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        {activeTab === "briefings" && unreadBriefings.length > 0 && (
          <button
            type="button"
            disabled={markingAll}
            onClick={() => void handleMarkAllRead()}
            className="mb-2 inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink disabled:opacity-45"
          >
            <CheckCheck size={13} aria-hidden="true" />
            全部标为已读
          </button>
        )}
      </div>

      {/* Tabpanel */}
      <div role="tabpanel" aria-labelledby={activeTabId} className="pt-4">
        {activeTab === "attachments" ? (
          <div className="space-y-4">
            {allAttachments.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {([
                  { key: "all", label: "全部" },
                  { key: "image", label: "图片" },
                  { key: "video", label: "视频" },
                  { key: "audio", label: "音频" },
                  { key: "document", label: "文档" },
                ] as const).map(opt => {
                  const count = opt.key === "all"
                    ? allAttachments.length
                    : allAttachments.filter(e => e.attachment.kind === opt.key).length;
                  if (opt.key !== "all" && count === 0) return null;
                  const active = attachmentKind === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setAttachmentKind(opt.key)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-3 py-1 text-[12px] font-medium transition-colors",
                        active ? "bg-ink text-app" : "bg-ink/[0.05] text-ink-secondary hover:bg-ink/[0.1] hover:text-ink",
                      )}
                    >
                      <span>{opt.label}</span>
                      <span className="tabular-nums opacity-75">{count}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {filteredAttachments.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-hairline/45 bg-ink/[0.015] px-6 py-12 text-center">
                <FileText size={22} className="text-ink-tertiary/70" aria-hidden="true" />
                <p className="mt-2.5 text-[13px] font-medium text-ink-secondary">暂无可预览的交付附件</p>
                <p className="mt-1 text-[12px] text-ink-tertiary">
                  AI 员工在汇报中附带的图片、视频、文档与表格会统一汇集在这里，方便一键预览与保存。
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {pagedAttachments.map(({ attachment, report, at }) => (
                  <div key={attachment.id} className="space-y-1">
                    <ReportAttachmentTile
                      attachment={attachment}
                      onPreview={() => onPreviewAttachment(attachment, report)}
                    />
                    <div className="flex items-center justify-between gap-2 px-1 text-[11px] text-ink-tertiary">
                      <span className="truncate">
                        {report.botName} · {report.title}
                      </span>
                      <span className="shrink-0 tabular-nums">{formatFullTime(at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {/* Compact filter toolbar for briefings & approved archive */}
            {(activeTab === "briefings" || departments.length >= 2 || activeList.length >= 4) && activeList.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  {activeTab === "briefings" && (
                    <div role="group" aria-label="已读状态筛选" className="inline-flex rounded-full bg-ink/[0.05] p-0.5">
                      <button
                        type="button"
                        onClick={() => onUnreadOnlyChange(false)}
                        className={cn(
                          "rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors",
                          !unreadOnly ? "bg-card text-ink shadow-xs" : "text-ink-secondary hover:text-ink",
                        )}
                      >
                        全部
                      </button>
                      <button
                        type="button"
                        onClick={() => onUnreadOnlyChange(true)}
                        className={cn(
                          "rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors",
                          unreadOnly ? "bg-card text-ink shadow-xs" : "text-ink-secondary hover:text-ink",
                        )}
                      >
                        仅未读{unreadBriefings.length > 0 ? ` (${unreadBriefings.length})` : ""}
                      </button>
                    </div>
                  )}

                  {departments.length >= 2 && (
                    <div className="flex flex-wrap items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setDepartment("all")}
                        className={cn(
                          "rounded-full px-2.5 py-1 text-[12px] transition-colors",
                          effectiveDepartment === "all"
                            ? "bg-ink text-app"
                            : "bg-ink/[0.05] text-ink-secondary hover:bg-ink/[0.1] hover:text-ink",
                        )}
                      >
                        全部部门
                      </button>
                      {departments.map(dept => (
                        <button
                          key={dept}
                          type="button"
                          onClick={() => setDepartment(dept)}
                          className={cn(
                            "rounded-full px-2.5 py-1 text-[12px] transition-colors",
                            effectiveDepartment === dept
                              ? "bg-ink text-app"
                              : "bg-ink/[0.05] text-ink-secondary hover:bg-ink/[0.1] hover:text-ink",
                          )}
                        >
                          {dept}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {activeList.length >= 4 && (
                  <label className="relative block">
                    <span className="sr-only">搜索工作报告</span>
                    <Search
                      size={13}
                      aria-hidden="true"
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-tertiary"
                    />
                    <input
                      type="search"
                      value={query}
                      onChange={e => setQuery(e.target.value)}
                      placeholder="按标题、汇报人或部门筛选…"
                      className="h-8 w-52 rounded-full border border-hairline/60 bg-card pl-8 pr-3 text-[12px] text-ink outline-none placeholder:text-ink-tertiary focus:border-ink/35"
                    />
                  </label>
                )}
              </div>
            )}

            {dateGroups.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-hairline/45 bg-ink/[0.015] px-6 py-12 text-center">
                <Inbox size={22} className="text-ink-tertiary/70" aria-hidden="true" />
                <p className="mt-2.5 text-[13px] font-medium text-ink-secondary">
                  {query.trim()
                    ? "没有匹配的报告"
                    : activeTab === "approved"
                      ? "暂无已通过归档的汇报"
                      : unreadOnly && briefingReports.length > 0
                        ? "全部报告均已阅读"
                        : "暂无免审批工作报告"}
                </p>
                <p className="mt-1 max-w-md text-[12px] leading-relaxed text-ink-tertiary">
                  {query.trim()
                    ? "试试更换关键词或清空筛选条件。"
                    : activeTab === "approved"
                      ? "在上方「待我处理」点击「通过」的汇报与工作流产物，会按日期自动归档在这里。"
                      : unreadOnly && briefingReports.length > 0
                        ? "可以切换到「全部」回顾近期历史报告。"
                        : "无需审批的员工报告、结构化总结、无审批门工作流结果以及定时任务简报，都会自动汇聚在这里供你随时阅览。"}
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                {dateGroups.map(group => (
                  <div key={group.dayKey}>
                    <div className="mb-1 text-[12px] font-medium text-ink-tertiary">
                      {group.label}
                    </div>
                    <div className="divide-y divide-hairline/40 border-y border-hairline/50">
                      {group.items.map(report => (
                        <ExpandableReportRow
                          key={report.id}
                          report={report}
                          mode={activeTab === "approved" ? "approved" : "briefing"}
                          bot={botById.get(report.botId)}
                          busyRead={busyReadIds.has(report.id)}
                          onToggleRead={activeTab === "briefings" ? (item, read) => void handleToggleRead(item, read) : undefined}
                          onPreviewAttachment={onPreviewAttachment}
                          onJumpChat={onJumpChat}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {totalItems > 0 && (
          <nav
            aria-label="工作报告分页"
            className="mt-4 flex flex-wrap items-center justify-between gap-3 pt-1"
          >
            <div className="text-[12px] tabular-nums text-ink-secondary">
              共 {totalItems} 条 · 第 {safePage} / {totalPages} 页
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                aria-disabled={safePage <= 1}
                onClick={() => goToPage(safePage - 1)}
                className={cn(
                  "inline-flex min-h-8 items-center gap-1 rounded-full border border-hairline/65 bg-card px-2.5 text-[12px] text-ink-secondary transition-colors",
                  safePage <= 1 ? "cursor-not-allowed opacity-45" : "hover:bg-raised hover:text-ink",
                )}
              >
                <ChevronLeft size={14} aria-hidden="true" />
                上一页
              </button>
              {buildPageNumbers(safePage, totalPages).map((entry, idx) => (
                entry === "ellipsis" ? (
                  <span
                    key={`ellipsis-${idx}`}
                    aria-hidden="true"
                    className="inline-flex min-h-8 min-w-6 items-center justify-center text-[12px] text-ink-tertiary"
                  >
                    …
                  </span>
                ) : (
                  <button
                    key={entry}
                    type="button"
                    aria-label={`第 ${entry} 页`}
                    aria-current={entry === safePage ? "page" : undefined}
                    onClick={() => goToPage(entry)}
                    className={cn(
                      "inline-flex min-h-8 min-w-8 items-center justify-center rounded-full px-2 text-[12px] font-medium tabular-nums transition-colors",
                      entry === safePage
                        ? "bg-ink text-app"
                        : "border border-hairline/65 bg-card text-ink-secondary hover:bg-raised hover:text-ink",
                    )}
                  >
                    {entry}
                  </button>
                )
              ))}
              <button
                type="button"
                aria-disabled={safePage >= totalPages}
                onClick={() => goToPage(safePage + 1)}
                className={cn(
                  "inline-flex min-h-8 items-center gap-1 rounded-full border border-hairline/65 bg-card px-2.5 text-[12px] text-ink-secondary transition-colors",
                  safePage >= totalPages ? "cursor-not-allowed opacity-45" : "hover:bg-raised hover:text-ink",
                )}
              >
                下一页
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </div>
          </nav>
        )}
      </div>
    </section>
  );
}
