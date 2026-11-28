import { useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Check,
  Loader2,
  MessageCircleQuestion,
  RotateCcw,
  ShieldAlert,
  X,
} from "lucide-react";
import type {
  OpcBossReportAttachment,
  OpcBossReportItem,
  OpcHeartbeatConfig,
  OpcWorkflowDefinition,
  OpcWorkflowRun,
} from "../../shared/donebot-opc";
import type { InboxRow, InboxView } from "../../shared/inbox";
import { BotAvatar } from "@/components/Avatar";
import {
  askOf,
  choiceResponse,
  choicesOf,
  senderLabel,
  subjectOf,
  textOf,
} from "@/components/inbox/inbox-view";
import { attentionOwnerName, type AttentionThread } from "@/components/SidebarBotActivity";
import type { CardResponse } from "@/lib/card-answer";
import type { RoutineRun } from "@/lib/routines";
import type { Bot } from "@/state/store";
import { OpcBossReportCard } from "./OpcBossReportCard";

function formatShortTime(ts?: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export interface ActionQueueCounts {
  approvals: number;
  questions: number;
  alerts: number;
  total: number;
}

export function computeActionQueueCounts(params: {
  pendingReports: readonly OpcBossReportItem[];
  inboxAsks: readonly InboxRow[];
  waitingThreads: readonly AttentionThread[];
  trippedWorkflows: readonly OpcWorkflowDefinition[];
  failedWorkflowRuns: readonly OpcWorkflowRun[];
  trippedHeartbeats: readonly OpcHeartbeatConfig[];
  problemRoutineRuns: readonly RoutineRun[];
}): ActionQueueCounts {
  const approvals = params.pendingReports.length;
  const questions = params.inboxAsks.length + params.waitingThreads.length;
  const alerts = params.trippedWorkflows.length
    + params.failedWorkflowRuns.length
    + params.trippedHeartbeats.length
    + params.problemRoutineRuns.length;
  return { approvals, questions, alerts, total: approvals + questions + alerts };
}

export function OpcActionQueueSection({
  pendingReports,
  inboxView,
  inboxAsks,
  waitingThreads,
  trippedWorkflows,
  failedWorkflowRuns,
  trippedHeartbeats,
  problemRoutineRuns,
  unreadBriefingCount,
  botById,
  onReportResolved,
  onPreviewAttachment,
  onJumpReport,
  onAnswerInboxRow,
  onOpenInboxRow,
  onJumpThread,
  onResetWorkflowBreaker,
  onRetryWorkflow,
  onResetHeartbeatBreaker,
  onOpenRoutinesProblems,
  onOpenWorkflows,
  onFocusUnreadBriefings,
}: {
  pendingReports: readonly OpcBossReportItem[];
  inboxView: InboxView | null;
  inboxAsks: readonly InboxRow[];
  waitingThreads: readonly AttentionThread[];
  trippedWorkflows: readonly OpcWorkflowDefinition[];
  failedWorkflowRuns: readonly OpcWorkflowRun[];
  trippedHeartbeats: readonly OpcHeartbeatConfig[];
  problemRoutineRuns: readonly RoutineRun[];
  unreadBriefingCount: number;
  botById: ReadonlyMap<string, Bot>;
  onReportResolved: (reportId: string, decision: "approved" | "changes_requested") => void;
  onPreviewAttachment: (att: OpcBossReportAttachment, report: OpcBossReportItem) => void;
  onJumpReport: (report: OpcBossReportItem) => void;
  onAnswerInboxRow: (row: InboxRow, response: CardResponse) => void;
  onOpenInboxRow: (row: InboxRow) => void;
  onJumpThread: (entry: AttentionThread) => void;
  onResetWorkflowBreaker: (workflowId: string) => Promise<void>;
  onRetryWorkflow: (workflowId: string) => Promise<void>;
  onResetHeartbeatBreaker: (heartbeatId: string) => Promise<void>;
  onOpenRoutinesProblems: () => void;
  onOpenWorkflows: () => void;
  onFocusUnreadBriefings: () => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [answeredIds, setAnsweredIds] = useState<ReadonlySet<string>>(() => new Set());
  const [actionError, setActionError] = useState("");

  const visibleInboxAsks = inboxAsks.filter(row => !answeredIds.has(row.id));
  const counts = computeActionQueueCounts({
    pendingReports,
    inboxAsks: visibleInboxAsks,
    waitingThreads,
    trippedWorkflows,
    failedWorkflowRuns,
    trippedHeartbeats,
    problemRoutineRuns,
  });

  const runAlertAction = async (key: string, fn: () => Promise<void>) => {
    setBusyKey(key);
    setActionError("");
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "操作失败，请稍后重试。");
    } finally {
      setBusyKey(null);
    }
  };

  const handleInlineAnswer = (row: InboxRow, response: CardResponse) => {
    setAnsweredIds(prev => new Set(prev).add(row.id));
    onAnswerInboxRow(row, response);
  };

  if (counts.total === 0) {
    return (
      <section aria-label="待我处理">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-ink/[0.03] px-4 py-3">
          <div className="flex items-center gap-2.5 text-[13px] text-ink-secondary">
            <span aria-hidden="true" className="size-2 rounded-full bg-emerald-500/80" />
            <span>一切运转顺畅，当前没有待审批、提问或异常事项。</span>
          </div>
          {unreadBriefingCount > 0 && (
            <button
              type="button"
              onClick={onFocusUnreadBriefings}
              className="inline-flex items-center gap-1 text-[13px] font-medium text-ink transition-opacity hover:opacity-75"
            >
              查看未读报告（{unreadBriefingCount}） <ArrowRight size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      </section>
    );
  }

  const breakdown = [
    counts.approvals > 0 ? `审批 ${counts.approvals}` : "",
    counts.questions > 0 ? `提问与确认 ${counts.questions}` : "",
    counts.alerts > 0 ? `告警 ${counts.alerts}` : "",
  ].filter(Boolean).join(" · ");

  return (
    <section aria-label="待我处理" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hairline/50 pb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold tracking-wide text-ink">待我处理</h2>
          <span className="rounded-full bg-accent/14 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-accent">
            {counts.total}
          </span>
        </div>
        <span className="text-[12px] tabular-nums text-ink-tertiary">{breakdown}</span>
      </div>

      {actionError && (
        <div role="alert" className="rounded-xl bg-danger/10 px-3.5 py-2 text-[12px] text-danger">
          {actionError}
        </div>
      )}

      {/* 1. Formal report & workflow approvals */}
      {pendingReports.length > 0 && (
        <div className="divide-y divide-hairline/40 border-b border-hairline/50">
          {pendingReports.map(report => (
            <OpcBossReportCard
              key={report.id}
              report={report}
              bot={botById.get(report.botId)}
              onResolved={onReportResolved}
              onPreviewAttachment={onPreviewAttachment}
              onJumpChat={onJumpReport}
            />
          ))}
        </div>
      )}

      {/* 2. Bot questions & permission confirmations */}
      {(visibleInboxAsks.length > 0 || waitingThreads.length > 0) && (
        <div className="space-y-2">
          {pendingReports.length > 0 && (
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary">
              <MessageCircleQuestion size={13.5} className="text-warning" aria-hidden="true" />
              <span>待回复与确认</span>
            </div>
          )}
          <div className="divide-y divide-hairline/40 overflow-hidden rounded-2xl border border-hairline/55 bg-card">
            {visibleInboxAsks.map(row => {
              const bot = row.from.botId ? botById.get(row.from.botId) : undefined;
              const askKind = askOf(row);
              const choices = choicesOf(row);
              const canAnswerInline = Boolean(row.card?.requestId && (inboxView?.threadId || row.origin?.threadId));
              const content = textOf(row) || row.card?.title || row.card?.subtitle || "等待你回复或确认";
              return (
                <article key={row.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    {bot ? (
                      <BotAvatar bot={bot} size={30} />
                    ) : (
                      <span className="grid size-[30px] shrink-0 place-items-center rounded-full bg-warning/15 text-warning">
                        <MessageCircleQuestion size={15} aria-hidden="true" />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[14px] font-medium text-ink">{senderLabel(row)}</span>
                        <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning">
                          {subjectOf(row)}
                        </span>
                        {row.origin?.title && (
                          <span className="truncate text-[12px] text-ink-tertiary">{row.origin.title}</span>
                        )}
                        {row.at > 0 && (
                          <span className="text-[11px] tabular-nums text-ink-tertiary">{formatShortTime(row.at)}</span>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink-secondary">
                        {content}
                      </p>
                      {canAnswerInline && askKind === "question" && choices.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {choices.slice(0, 4).map(choice => (
                            <button
                              key={choice}
                              type="button"
                              onClick={() => handleInlineAnswer(row, choiceResponse(row, choice))}
                              className="inline-flex h-7 items-center rounded-full border border-hairline/70 bg-panel px-2.5 text-[12px] font-medium text-ink transition-colors hover:border-accent/60 hover:bg-accent/10 hover:text-accent"
                            >
                              {choice}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {canAnswerInline && askKind === "approval" && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleInlineAnswer(row, { behavior: "deny" })}
                          className="inline-flex h-8 items-center gap-1 rounded-full bg-ink/[0.06] px-3 text-[12px] font-medium text-ink transition-colors hover:bg-ink/[0.11]"
                        >
                          <X size={12.5} aria-hidden="true" /> 拒绝
                        </button>
                        <button
                          type="button"
                          onClick={() => handleInlineAnswer(row, { behavior: "allow" })}
                          className="inline-flex h-8 items-center gap-1 rounded-full bg-ink px-3 text-[12px] font-medium text-app transition-opacity hover:opacity-85"
                        >
                          <Check size={12.5} aria-hidden="true" /> 允许
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpenInboxRow(row)}
                      className="inline-flex h-8 items-center gap-1 rounded-full bg-ink/[0.06] px-3 text-[12px] font-medium text-ink transition-colors hover:bg-ink/[0.11]"
                    >
                      {askKind === "approval" ? "原对话" : "去回复"} <ArrowUpRight size={12.5} aria-hidden="true" />
                    </button>
                  </div>
                </article>
              );
            })}

            {waitingThreads.map(entry => {
              const bot = entry.kind === "bot" ? botById.get(entry.botId) : undefined;
              const owner = attentionOwnerName(entry);
              return (
                <article
                  key={`${entry.kind}:${entry.task.threadId}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    {bot ? (
                      <BotAvatar bot={bot} size={30} />
                    ) : (
                      <span className="grid size-[30px] shrink-0 place-items-center rounded-full bg-warning/15 text-warning">
                        <MessageCircleQuestion size={15} aria-hidden="true" />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[14px] font-medium text-ink">{owner}</span>
                        <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning">
                          等待回复或确认
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[12px] text-ink-secondary">
                        {entry.task.title || "当前对话有提问或授权请求等待你处理"}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onJumpThread(entry)}
                    className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-ink px-3 text-[12px] font-medium text-app transition-opacity hover:opacity-85"
                  >
                    去处理 <ArrowUpRight size={12.5} aria-hidden="true" />
                  </button>
                </article>
              );
            })}
          </div>
        </div>
      )}

      {/* 3. Failures & circuit breaker alerts */}
      {counts.alerts > 0 && (
        <div className="space-y-2">
          {(pendingReports.length > 0 || counts.questions > 0) && (
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-danger">
              <ShieldAlert size={13.5} aria-hidden="true" />
              <span>异常与熔断告警</span>
            </div>
          )}
          <div className="divide-y divide-hairline/40 overflow-hidden rounded-2xl border border-danger/25 bg-danger/[0.04]">
            {trippedWorkflows.map(wf => {
              const key = `wf-breaker:${wf.id}`;
              return (
                <div key={key} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <AlertTriangle size={14} className="shrink-0 text-danger" aria-hidden="true" />
                      <span className="truncate text-[13px] font-medium text-ink">工作流「{wf.name}」已熔断暂停</span>
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-[12px] text-ink-secondary">
                      {wf.circuitBreakerReason || `连续失败 ${wf.consecutiveFailures} 次，已自动暂停调度。`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      disabled={busyKey === key}
                      onClick={() => void runAlertAction(key, () => onResetWorkflowBreaker(wf.id))}
                      className="inline-flex h-7 items-center gap-1 rounded-full bg-ink px-3 text-[12px] font-medium text-app transition-opacity hover:opacity-85 disabled:opacity-45"
                    >
                      {busyKey === key ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={12} aria-hidden="true" />}
                      恢复启用
                    </button>
                    <button
                      type="button"
                      onClick={onOpenWorkflows}
                      className="inline-flex h-7 items-center gap-1 rounded-full bg-ink/[0.06] px-2.5 text-[12px] text-ink-secondary hover:bg-ink/[0.11] hover:text-ink"
                    >
                      查看流程
                    </button>
                  </div>
                </div>
              );
            })}

            {failedWorkflowRuns.map(run => {
              const key = `wf-retry:${run.id}`;
              const failedStep = run.stepResults.find(s => s.status === "failed");
              return (
                <div key={key} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <AlertTriangle size={14} className="shrink-0 text-danger" aria-hidden="true" />
                      <span className="truncate text-[13px] font-medium text-ink">
                        工作流「{run.workflowName}」执行失败
                      </span>
                      {failedStep && (
                        <span className="text-[12px] text-ink-tertiary">· {failedStep.stepName}</span>
                      )}
                      {run.finishedAt && (
                        <span className="text-[11px] tabular-nums text-ink-tertiary">{formatShortTime(run.finishedAt)}</span>
                      )}
                    </div>
                    {failedStep?.error && (
                      <p className="mt-0.5 line-clamp-1 text-[12px] text-ink-secondary">{failedStep.error}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      disabled={busyKey === key}
                      onClick={() => void runAlertAction(key, () => onRetryWorkflow(run.workflowId))}
                      className="inline-flex h-7 items-center gap-1 rounded-full bg-ink/[0.08] px-3 text-[12px] font-medium text-ink transition-colors hover:bg-ink/[0.14] disabled:opacity-45"
                    >
                      {busyKey === key ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={12} aria-hidden="true" />}
                      重新运行
                    </button>
                    <button
                      type="button"
                      onClick={onOpenWorkflows}
                      className="inline-flex h-7 items-center gap-1 rounded-full bg-ink/[0.05] px-2.5 text-[12px] text-ink-secondary hover:bg-ink/[0.1] hover:text-ink"
                    >
                      查看流程
                    </button>
                  </div>
                </div>
              );
            })}

            {trippedHeartbeats.map(hb => {
              const key = `hb-breaker:${hb.id}`;
              return (
                <div key={key} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <AlertTriangle size={14} className="shrink-0 text-danger" aria-hidden="true" />
                      <span className="truncate text-[13px] font-medium text-ink">
                        巡检「{hb.name}」已触发熔断
                      </span>
                      {hb.botName && <span className="text-[12px] text-ink-tertiary">· {hb.botName}</span>}
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-[12px] text-ink-secondary">
                      {hb.circuitBreakerReason || hb.lastSummary || "连续失败已自动暂停。"}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busyKey === key}
                    onClick={() => void runAlertAction(key, () => onResetHeartbeatBreaker(hb.id))}
                    className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-ink px-3 text-[12px] font-medium text-app transition-opacity hover:opacity-85 disabled:opacity-45"
                  >
                    {busyKey === key ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={12} aria-hidden="true" />}
                    恢复巡检
                  </button>
                </div>
              );
            })}

            {problemRoutineRuns.slice(0, 4).map(run => {
              const bot = botById.get(run.botId);
              return (
                <div key={`routine:${run.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <AlertTriangle size={14} className="shrink-0 text-danger" aria-hidden="true" />
                      <span className="truncate text-[13px] font-medium text-ink">
                        定时任务「{run.routineName}」{run.status === "missed" ? "未按时触发" : "执行失败"}
                      </span>
                      {bot && <span className="text-[12px] text-ink-tertiary">· {bot.name}</span>}
                    </div>
                    {run.error && (
                      <p className="mt-0.5 line-clamp-1 text-[12px] text-ink-secondary">{run.error}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={onOpenRoutinesProblems}
                    className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-ink/[0.07] px-3 text-[12px] font-medium text-ink transition-colors hover:bg-ink/[0.12]"
                  >
                    去查看 <ArrowUpRight size={12} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
