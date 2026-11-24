import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  Coins,
  Loader2,
  Paperclip,
  RotateCcw,
  Zap,
} from "lucide-react";
import type { OpcBossOverview, OpcBossReportItem } from "../../shared/donebot-opc";
import { closeInbox } from "@/state/inbox";
import { useStore } from "@/state/store";
import { formatCny } from "./market-api";
import { notifyOpcOverviewChanged, OPC_OVERVIEW_CHANGED_EVENT, opcApi } from "./opc-api";
import { resolvePendingBossReports } from "./OpcBossReportCard";
import {
  claimReviseDraftWork,
  clearReviseDraft,
  releaseReviseDraftWork,
  useReviseDraft,
} from "./paperclip-revise-draft-store";
import { OpcDecisionCardFooter, OpcInsetPanel, OpcMetricCard } from "./paperclip-ui";

function CompactReportCard({
  report,
  onResolved,
  onOpenBoss,
  onJump,
}: {
  report: OpcBossReportItem;
  onResolved: (reportId: string) => void;
  onOpenBoss: () => void;
  onJump: (report: OpcBossReportItem) => void;
}) {
  const draftKey = `report:${report.id}`;
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
      notifyOpcOverviewChanged("boss-dashboard");
      onResolved(report.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败，请稍后重试。");
      releaseReviseDraftWork(draftKey);
    }
  };

  const requestChanges = async () => {
    if (!draft.revising) {
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
      notifyOpcOverviewChanged("boss-dashboard");
      onResolved(report.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "派发修改意见失败。");
      releaseReviseDraftWork(draftKey);
    }
  };

  return (
    <article className="flex flex-col gap-2.5 rounded-xl bg-card p-3 ring-[0.5px] ring-hairline/60">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[12px] font-medium text-ink">
          {report.workflow ? `${report.workflow.workflowName} · ${report.workflow.stepName}` : "正式汇报"}
        </span>
        <span className="shrink-0 truncate text-[11px] text-ink-tertiary">
          {report.botName}
        </span>
      </div>

      <OpcInsetPanel>
        <div className="flex items-start justify-between gap-2">
          <button
            type="button"
            onClick={onOpenBoss}
            className="min-w-0 flex-1 text-left"
          >
            <div className="truncate text-[13px] font-medium text-ink hover:underline">{report.title}</div>
            {report.summary && (
              <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-ink-secondary">
                {report.summary}
              </p>
            )}
            {report.attachments.length > 0 && (
              <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-ink-tertiary">
                <Paperclip size={11} aria-hidden="true" />
                <span>{report.attachments.length} 份附件（去工作台展开阅读与下载）</span>
              </div>
            )}
          </button>
          <button
            type="button"
            onClick={() => onJump(report)}
            aria-label={`定位到「${report.title}」`}
            title="查看原对话"
            className="shrink-0 rounded-md p-1 text-ink-tertiary transition-colors hover:bg-raised hover:text-ink"
          >
            <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        </div>

        {draft.revising && (
          <div className="space-y-1.5 pt-1">
            <textarea
              value={draft.reason}
              onChange={e => updateDraft({ reason: e.target.value })}
              rows={2}
              placeholder="写一句修改意见（将自动发给该 Bot 返工）…"
              className="w-full resize-none rounded-lg border border-hairline/70 bg-panel px-2.5 py-1.5 text-[12px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
            />
          </div>
        )}
      </OpcInsetPanel>

      {error && <p role="alert" className="text-[11.5px] text-danger">{error}</p>}

      <OpcDecisionCardFooter
        leading={
          draft.revising ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => updateDraft({ revising: false })}
              className="text-[11.5px] text-ink-tertiary hover:text-ink"
            >
              取消批注
            </button>
          ) : (
            <button
              type="button"
              onClick={onOpenBoss}
              className="text-[11.5px] text-accent hover:underline"
            >
              展开完整报告
            </button>
          )
        }
      >
        <button
          type="button"
          disabled={busy}
          onClick={() => void requestChanges()}
          className="inline-flex h-7 items-center gap-1 rounded-lg bg-raised px-2.5 text-[12px] font-medium text-ink-secondary transition-colors hover:bg-control hover:text-ink disabled:opacity-50"
        >
          {draft.working === "revise" ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={12} aria-hidden="true" />}
          {draft.revising ? "发送修改" : "打回修改"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void approve()}
          className="inline-flex h-7 items-center gap-1 rounded-lg bg-accent px-2.5 text-[12px] font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {draft.working === "approve" ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}
          {approveLabel}
        </button>
      </OpcDecisionCardFooter>
    </article>
  );
}

export function OpcBossDashboard() {
  const { state, dispatch } = useStore();
  const [overview, setOverview] = useState<OpcBossOverview | null>(null);
  const [spendOpen, setSpendOpen] = useState(false);
  const [approvalsExpanded, setApprovalsExpanded] = useState(true);

  const load = useCallback(async () => {
    try {
      setOverview(await opcApi.getOverview(30));
    } catch {
      // Quietly degrade in offline or restricted workspaces.
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 45_000);
    const onChanged = (event: Event) => {
      const source = (event as CustomEvent<{ source?: string }>).detail?.source;
      if (source === "boss-dashboard") return;
      void load();
    };
    window.addEventListener(OPC_OVERVIEW_CHANGED_EVENT, onChanged);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(OPC_OVERVIEW_CHANGED_EVENT, onChanged);
    };
  }, [load]);

  const pendingReports = useMemo(() => resolvePendingBossReports(overview), [overview]);

  if (!overview) return null;

  const handleResolved = (reportId: string) => {
    setOverview(prev => {
      if (!prev) return prev;
      const resolved = resolvePendingBossReports(prev).find(r => r.id === reportId);
      const removedArtifactIds = new Set(resolved?.artifactIds ?? []);
      const removedRunId = resolved?.workflow?.runId;
      const nextReports = resolvePendingBossReports(prev).filter(r => r.id !== reportId);
      const nextArtifacts = prev.pendingArtifacts.filter(a => !removedArtifactIds.has(a.id));
      const nextRuns = removedRunId
        ? (prev.waitingWorkflowRuns ?? []).filter(r => r.id !== removedRunId)
        : (prev.waitingWorkflowRuns ?? []);
      return {
        ...prev,
        pendingReportCount: nextReports.length,
        pendingReports: nextReports,
        pendingArtifactCount: nextArtifacts.length,
        pendingArtifacts: nextArtifacts,
        waitingWorkflowCount: nextRuns.length,
        waitingWorkflowRuns: nextRuns,
      };
    });
  };

  const openBoss = () => {
    closeInbox();
    dispatch({ type: "showBoss" });
  };

  const handleJump = (report: OpcBossReportItem) => {
    closeInbox();
    dispatch({ type: "select", id: report.botId });
    if (report.threadId && report.reportMessageId) {
      dispatch({ type: "focusMessage", threadId: report.threadId, messageId: report.reportMessageId });
    }
  };

  const totalPendingCount = pendingReports.length;
  const activeAutomationCount = (state.routines ?? []).filter(r => r.enabled).length + (overview.activeWorkflowCount ?? 0);

  return (
    <section aria-label="工作台概览" className="mx-[13px] mb-2 mt-1 space-y-2.5">
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[11.5px] font-medium text-ink-secondary">工作台</span>
        <button
          type="button"
          onClick={openBoss}
          className="inline-flex items-center gap-0.5 text-[11.5px] font-medium text-accent hover:underline"
        >
          打开完整工作台 <ArrowUpRight size={12} aria-hidden="true" />
        </button>
      </div>
      <div className="flex gap-2">
        <OpcMetricCard
          icon={CheckCircle2}
          label="待我审批"
          value={totalPendingCount}
          tone={totalPendingCount > 0 ? "accent" : "neutral"}
          active={approvalsExpanded && totalPendingCount > 0}
          onClick={totalPendingCount > 0 ? () => setApprovalsExpanded(v => !v) : undefined}
        />
        <OpcMetricCard
          icon={Zap}
          label="自动化"
          value={activeAutomationCount}
          tone="neutral"
          onClick={() => dispatch({ type: "showRoutines", view: "list" })}
        />
        <OpcMetricCard
          icon={Coins}
          label="30日算力"
          value={overview.spend.available ? formatCny(overview.spend.totalCost) : "—"}
          active={spendOpen}
          onClick={overview.spend.available ? () => setSpendOpen(v => !v) : undefined}
        />
      </div>

      {spendOpen && overview.spend.available && (
        <div
          tabIndex={0}
          role="region"
          aria-label="单 Bot 近 30 日真实算力消耗明细"
          className="max-h-56 overflow-auto rounded-xl bg-card ring-[0.5px] ring-hairline/60"
        >
          <div className="flex items-center justify-between border-b border-hairline/40 px-3 py-2 text-[11.5px] text-ink-secondary">
            <span className="font-medium text-ink">近 {overview.spend.days} 日实际消费透视</span>
            <span className="tabular-nums text-ink-tertiary">
              LLM {formatCny(overview.spend.llmCost)} · 图 {formatCny(overview.spend.imageCost)} · 视 {formatCny(overview.spend.videoCost)} · 乐 {formatCny(overview.spend.musicCost)}
            </span>
          </div>
          {overview.spend.bots.length === 0 ? (
            <p className="px-3 py-4 text-center text-[12px] text-ink-tertiary">暂无单 Bot 消费记录</p>
          ) : (
            <table className="w-full border-collapse text-left text-[12px]">
              <thead className="sticky top-0 bg-card/95 text-[11px] text-ink-tertiary backdrop-blur-sm">
                <tr className="border-b border-hairline/40">
                  <th scope="col" className="px-3 py-1.5 font-medium">员工</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">LLM</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">媒体</th>
                  <th scope="col" className="px-3 py-1.5 text-right font-medium">合计</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline/30">
                {overview.spend.bots.map(row => {
                  const mediaCost = row.imageCost + row.videoCost + row.musicCost;
                  return (
                    <tr key={row.botId} className="hover:bg-raised/40">
                      <th scope="row" className="max-w-[110px] truncate px-3 py-1.5 font-medium text-ink">
                        {row.botName}
                      </th>
                      <td className="px-2 py-1.5 text-right tabular-nums text-ink-secondary">{formatCny(row.llmCost)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-ink-secondary">{formatCny(mediaCost)}</td>
                      <td className="px-3 py-1.5 text-right font-medium tabular-nums text-ink">{formatCny(row.totalCost)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {approvalsExpanded && totalPendingCount > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between px-0.5 text-[11.5px] text-ink-tertiary">
            <span>待审批汇报</span>
            <span className="tabular-nums">{totalPendingCount} 份</span>
          </div>
          {pendingReports.slice(0, 4).map(report => (
            <CompactReportCard
              key={report.id}
              report={report}
              onResolved={handleResolved}
              onOpenBoss={openBoss}
              onJump={handleJump}
            />
          ))}
        </div>
      )}
    </section>
  );
}
