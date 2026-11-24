import { useId, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Download,
  Eye,
  FileText,
  Film,
  Image as ImageIcon,
  Loader2,
  Music,
  Paperclip,
  RotateCcw,
} from "lucide-react";
import type {
  OpcBossOverview,
  OpcBossReportAttachment,
  OpcBossReportItem,
} from "../../shared/donebot-opc";
import { useLocalFileSave } from "@/components/AttachmentPreview";
import { BotAvatar } from "@/components/Avatar";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { cn } from "@/lib/cn";
import type { Bot } from "@/state/store";
import { notifyOpcOverviewChanged, opcApi } from "./opc-api";
import {
  claimReviseDraftWork,
  clearReviseDraft,
  releaseReviseDraftWork,
  useReviseDraft,
} from "./paperclip-revise-draft-store";

function AttachmentKindIcon({ kind }: { kind: OpcBossReportAttachment["kind"] }) {
  switch (kind) {
    case "image": return <ImageIcon size={15} className="shrink-0 text-ink-tertiary" aria-hidden="true" />;
    case "video": return <Film size={15} className="shrink-0 text-ink-tertiary" aria-hidden="true" />;
    case "audio": return <Music size={15} className="shrink-0 text-ink-tertiary" aria-hidden="true" />;
    default: return <FileText size={15} className="shrink-0 text-ink-tertiary" aria-hidden="true" />;
  }
}

function attachmentKindLabel(kind: OpcBossReportAttachment["kind"]): string {
  switch (kind) {
    case "image": return "图片附件";
    case "video": return "视频附件";
    case "audio": return "音频附件";
    default: return "文档附件";
  }
}

function formatReportTime(at: number): string {
  if (!at) return "";
  return new Date(at).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ReportAttachmentTile({
  attachment,
  onPreview,
}: {
  attachment: OpcBossReportAttachment;
  onPreview: () => void;
}) {
  const save = useLocalFileSave(
    attachment.path,
    attachment.name,
    { threadId: attachment.threadId, messageId: attachment.messageId },
  );

  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-hairline/45 bg-panel px-3 py-2.5 transition-colors hover:border-hairline/75">
      <button
        type="button"
        onClick={onPreview}
        aria-label={`预览附件「${attachment.name}」`}
        className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-ink/[0.04] ring-[0.5px] ring-hairline/40"
      >
        {attachment.kind === "image" ? (
          <img
            src={attachment.previewUrl}
            alt={attachment.name}
            loading="lazy"
            className="size-full object-cover"
          />
        ) : (
          <AttachmentKindIcon kind={attachment.kind} />
        )}
      </button>

      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onPreview}
          className="block max-w-full truncate text-left text-[13px] font-medium text-ink hover:underline"
        >
          {attachment.name}
        </button>
        <div className="mt-0.5 text-[11.5px] text-ink-tertiary">
          {save.state === "failed" && save.reason ? (
            <span className="text-danger">{save.reason}</span>
          ) : save.state === "saved" ? (
            <span className="text-emerald-600 dark:text-emerald-400">已保存到本地</span>
          ) : (
            attachmentKindLabel(attachment.kind)
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onPreview}
          className="inline-flex h-7 items-center gap-1 rounded-full bg-ink/[0.05] px-2.5 text-[11.5px] font-medium text-ink-secondary transition-colors hover:bg-ink/[0.1] hover:text-ink"
        >
          <Eye size={12} aria-hidden="true" /> 预览
        </button>
        <button
          type="button"
          disabled={save.state === "saving"}
          onClick={() => void save.save()}
          className="inline-flex h-7 items-center gap-1 rounded-full bg-ink/[0.05] px-2.5 text-[11.5px] font-medium text-ink-secondary transition-colors hover:bg-ink/[0.1] hover:text-ink disabled:opacity-45"
        >
          {save.state === "saving"
            ? <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            : save.state === "saved"
              ? <Check size={12} aria-hidden="true" />
              : <Download size={12} aria-hidden="true" />}
          {save.state === "saving" ? "下载中" : save.state === "saved" ? "已保存" : "下载"}
        </button>
      </div>
    </div>
  );
}

/**
 * Fallback normalizer for older remote runtimes that only return `waitingWorkflowRuns` +
 * `pendingArtifacts` without the unified `pendingReports` field.
 */
export function resolvePendingBossReports(overview: OpcBossOverview | null): OpcBossReportItem[] {
  if (!overview) return [];
  if (Array.isArray(overview.pendingReports)) return overview.pendingReports;

  const out: OpcBossReportItem[] = [];
  for (const run of overview.waitingWorkflowRuns ?? []) {
    const step = run.stepResults[run.currentStepIndex];
    if (!step) continue;
    const body = step.output?.trim() || "（该步骤已完成，暂无补充说明正文）";
    out.push({
      id: `wf:${run.id}:${run.currentStepIndex}`,
      source: "workflow",
      title: `${run.workflowName} · ${step.stepName}`,
      summary: body.replace(/\s+/g, " ").slice(0, 120),
      body,
      botId: step.botId,
      botName: step.botName,
      botColor: "blue",
      at: step.finishedAt ?? step.startedAt ?? run.startedAt,
      threadId: step.threadId ?? "",
      attachments: [],
      artifactIds: [],
      workflow: {
        runId: run.id,
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        stepIndex: run.currentStepIndex,
        totalSteps: run.stepResults.length,
        stepName: step.stepName,
        isLastStep: run.currentStepIndex + 1 >= run.stepResults.length,
      },
    });
  }

  const byMsg = new Map<string, typeof overview.pendingArtifacts>();
  for (const art of overview.pendingArtifacts ?? []) {
    const key = `${art.botId}:${art.threadId}:${art.reportMessageId}`;
    const list = byMsg.get(key) ?? [];
    list.push(art);
    byMsg.set(key, list);
  }
  for (const items of byMsg.values()) {
    const primary = items[0]!;
    out.push({
      id: `msg:${primary.threadId}:${primary.reportMessageId}`,
      source: "bot_report",
      title: primary.title || primary.name,
      summary: primary.threadTitle || primary.name,
      body: `**交付附件**：${items.map(i => `\`${i.name}\``).join("、")}`,
      botId: primary.botId,
      botName: primary.botName,
      botColor: primary.botColor,
      at: Math.max(...items.map(i => i.at)),
      threadId: primary.threadId,
      reportMessageId: primary.reportMessageId,
      attachments: items.map(i => ({
        id: i.id,
        name: i.name,
        path: i.path,
        kind: i.kind,
        mime: i.mime,
        threadId: i.threadId,
        messageId: i.messageId,
        previewUrl: i.previewUrl,
      })),
      artifactIds: items.map(i => i.id),
    });
  }
  return out.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

export function OpcBossReportCard({
  report,
  bot,
  defaultExpanded = false,
  onResolved,
  onPreviewAttachment,
  onJumpChat,
}: {
  report: OpcBossReportItem;
  bot?: Bot;
  defaultExpanded?: boolean;
  onResolved: (reportId: string, decision: "approved" | "changes_requested") => void;
  onPreviewAttachment: (att: OpcBossReportAttachment, report: OpcBossReportItem) => void;
  onJumpChat: (report: OpcBossReportItem) => void;
}) {
  const panelId = useId();
  const draftKey = `report:${report.id}`;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [draft, updateDraft] = useReviseDraft(draftKey);
  const [error, setError] = useState("");
  const busy = draft.working !== null;

  const approveLabel = report.workflow && !report.workflow.isLastStep ? "通过并继续" : "通过";

  const approve = async () => {
    if (!claimReviseDraftWork(draftKey, "approve")) return;
    setError("");
    try {
      if (report.source === "workflow" && report.workflow) {
        await opcApi.decideWorkflowRun(report.workflow.runId, { action: "approve" });
      } else if (report.artifactIds.length > 1) {
        await opcApi.reviewReport({
          botId: report.botId,
          status: "approved",
          artifactIds: report.artifactIds,
          threadId: report.threadId,
          reportTitle: report.title,
        });
      } else if (report.artifactIds.length === 1) {
        await opcApi.reviewArtifact(report.artifactIds[0]!, {
          botId: report.botId,
          status: "approved",
          threadId: report.threadId,
          artifactTitle: report.title,
        });
      }
      clearReviseDraft(draftKey);
      notifyOpcOverviewChanged("boss-console");
      onResolved(report.id, "approved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "审批操作失败，请稍后重试。");
      releaseReviseDraftWork(draftKey);
    }
  };

  const requestChanges = async () => {
    if (!draft.revising) {
      setExpanded(true);
      updateDraft({ revising: true });
      return;
    }
    if (!claimReviseDraftWork(draftKey, "revise")) return;
    setError("");
    try {
      const note = draft.reason.trim();
      if (report.source === "workflow" && report.workflow) {
        await opcApi.decideWorkflowRun(report.workflow.runId, { action: "revise", note });
      } else if (report.artifactIds.length > 1) {
        await opcApi.reviewReport({
          botId: report.botId,
          status: "changes_requested",
          artifactIds: report.artifactIds,
          note,
          threadId: report.threadId,
          reportTitle: report.title,
          dispatchRevision: true,
        });
      } else if (report.artifactIds.length === 1) {
        await opcApi.reviewArtifact(report.artifactIds[0]!, {
          botId: report.botId,
          status: "changes_requested",
          note,
          threadId: report.threadId,
          artifactTitle: report.title,
          dispatchRevision: true,
        });
      }
      clearReviseDraft(draftKey);
      notifyOpcOverviewChanged("boss-console");
      onResolved(report.id, "changes_requested");
    } catch (err) {
      setError(err instanceof Error ? err.message : "派发修改意见失败。");
      releaseReviseDraftWork(draftKey);
    }
  };

  const authorMeta = [
    report.botName,
    report.department,
    report.roleTitle,
  ].filter(Boolean).join(" · ");

  return (
    <article className="py-3.5">
      {/* Header row: expandable disclosure trigger on the left, one-click decision actions on the right */}
      <div className="flex flex-wrap items-start gap-3">
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
              <span className="truncate text-[14.5px] font-semibold text-ink">{report.title}</span>
              <span className="shrink-0 rounded-full bg-ink/[0.06] px-2 py-0.5 text-[10.5px] font-medium text-ink-secondary">
                {report.workflow
                  ? `${report.workflow.workflowName} · ${report.workflow.stepIndex + 1}/${report.workflow.totalSteps}`
                  : "正式汇报"}
              </span>
              {report.attachments.length > 0 && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ink/[0.05] px-2 py-0.5 text-[10.5px] tabular-nums text-ink-secondary">
                  <Paperclip size={10.5} aria-hidden="true" />
                  {report.attachments.length} 份附件
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-tertiary">
              <span>{authorMeta}</span>
              {report.at > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">{formatReportTime(report.at)}</span>
                </>
              )}
              {!expanded && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-ink-secondary">点击展开报告</span>
                </>
              )}
            </div>
            {!expanded && report.summary && (
              <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-relaxed text-ink-secondary">
                {report.summary}
              </p>
            )}
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => void requestChanges()}
            className="inline-flex h-8 items-center gap-1 rounded-full bg-ink/[0.06] px-3 text-[12.5px] font-medium text-ink transition-colors hover:bg-ink/[0.11] disabled:opacity-45"
          >
            {draft.working === "revise" ? <Loader2 size={12.5} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={12.5} aria-hidden="true" />}
            {draft.revising ? "发送修改" : "打回修改"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void approve()}
            className="inline-flex h-8 items-center gap-1 rounded-full bg-ink px-3.5 text-[12.5px] font-medium text-app transition-opacity hover:opacity-85 disabled:opacity-45"
          >
            {draft.working === "approve" ? <Loader2 size={12.5} className="animate-spin" aria-hidden="true" /> : <Check size={12.5} aria-hidden="true" />}
            {approveLabel}
          </button>
        </div>
      </div>

      {/* Expanded formal report document sheet */}
      {expanded && (
        <div
          id={panelId}
          className="mt-3 overflow-hidden rounded-2xl border border-hairline/55 bg-card"
        >
          {/* Report masthead */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline/45 bg-ink/[0.02] px-5 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              {bot && <BotAvatar bot={bot} size={26} />}
              <div className="min-w-0">
                <div className="truncate text-[12.5px] font-medium text-ink">
                  汇报人：{authorMeta}
                </div>
                <div className="text-[11.5px] text-ink-tertiary">
                  {report.workflow
                    ? `来源：固定工作流「${report.workflow.workflowName}」第 ${report.workflow.stepIndex + 1}/${report.workflow.totalSteps} 步「${report.workflow.stepName}」`
                    : "来源：员工正式交付汇报"}
                  {report.at > 0 ? ` · ${formatReportTime(report.at)}` : ""}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onJumpChat(report)}
              className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink"
            >
              查看原对话 <ArrowUpRight size={13} aria-hidden="true" />
            </button>
          </div>

          {/* Formal Markdown report body */}
          <div className="px-5 py-4 text-[13.5px] leading-7 text-ink">
            <ChatMarkdown text={report.body} />
          </div>

          {/* Report attachments section */}
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

          {/* Optional revision note box */}
          {draft.revising && (
            <div className="border-t border-hairline/45 bg-inset/50 px-5 py-3.5">
              <label className="block space-y-1.5">
                <span className="text-[12px] font-medium text-ink-secondary">打回修改意见</span>
                <textarea
                  value={draft.reason}
                  onChange={e => updateDraft({ reason: e.target.value })}
                  rows={2}
                  placeholder="写一句具体修改意见，点击「发送修改」后将自动派发给汇报人返工并重交正式汇报…"
                  className="w-full resize-none rounded-xl border border-hairline/70 bg-panel px-3 py-2 text-[12.5px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary focus:border-ink/40"
                />
              </label>
              <div className="mt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => updateDraft({ revising: false })}
                  className="h-7 rounded-full px-3 text-[12px] text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink"
                >
                  取消批注
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void requestChanges()}
                  className="inline-flex h-7 items-center gap-1 rounded-full bg-ink/[0.08] px-3 text-[12px] font-medium text-ink hover:bg-ink/[0.14] disabled:opacity-45"
                >
                  {draft.working === "revise" ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={12} aria-hidden="true" />}
                  发送修改
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {error && <p role="alert" className="mt-2 pl-6 text-[12px] text-danger">{error}</p>}
    </article>
  );
}
