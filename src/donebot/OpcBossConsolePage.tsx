import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type {
  OpcBossOverview,
  OpcBossReportAttachment,
  OpcBossReportItem,
} from "../../shared/donebot-opc";
import type { InboxRow } from "../../shared/inbox";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { answerThread } from "@/components/inbox/inbox-view";
import {
  attentionJumpAction,
  crossBotAttentionThreads,
  runningRoutineRuns,
  type AttentionThread,
} from "@/components/SidebarBotActivity";
import type { CardResponse } from "@/lib/card-answer";
import { cn } from "@/lib/cn";
import { isCountedSkip, isRoutineProblemRun } from "@/lib/routines";
import { readInboxRow, refreshInbox, settleInboxRow, useInboxView } from "@/state/inbox";
import { useStore } from "@/state/store";
import { notifyOpcOverviewChanged, OPC_OVERVIEW_CHANGED_EVENT, opcApi } from "./opc-api";
import { computeActionQueueCounts, OpcActionQueueSection } from "./OpcActionQueueSection";
import { OpcArtifactPreviewDialog } from "./OpcArtifactPreviewDialog";
import { resolvePendingBossReports } from "./OpcBossReportCard";
import { OpcBriefingReportsPanel, type WorkbenchReportsTab } from "./OpcBriefingReportsPanel";
import { OpcActiveWorkBanner, OpcAutomationFooterSection } from "./OpcWorkbenchAutomationSection";

function greetingByHour(): string {
  const hour = new Date().getHours();
  if (hour < 6) return "夜深了";
  if (hour < 12) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function formattedToday(): string {
  return new Date().toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}

function isSameLocalDay(ts: number, now: Date): boolean {
  if (!ts) return false;
  const d = new Date(ts);
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
}

/**
 * Action-and-Briefing Workspace Console ("工作台"):
 * focuses on items needing Boss action, live running work, non-approval reports & deliverables,
 * and recent automation activity — without duplicating the sidebar employee list or billing ledger.
 */
export function OpcBossConsolePage() {
  const { state, dispatch } = useStore();
  const { dragProps } = useCaptionChrome();
  const inboxView = useInboxView();
  const reportsSectionRef = useRef<HTMLDivElement>(null);

  const visibleBots = useMemo(() => state.bots.filter(b => !b.hidden), [state.bots]);
  const botById = useMemo(() => new Map(visibleBots.map(b => [b.id, b])), [visibleBots]);
  const routines = useMemo(() => state.routines ?? [], [state.routines]);
  const routineRuns = useMemo(() => state.routineRuns ?? [], [state.routineRuns]);

  const [overview, setOverview] = useState<OpcBossOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [runtimeNotice, setRuntimeNotice] = useState("");
  const [reportsTab, setReportsTab] = useState<WorkbenchReportsTab>("briefings");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [previewState, setPreviewState] = useState<{
    attachment: OpcBossReportAttachment;
    report: OpcBossReportItem;
  } | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setRuntimeNotice("");
    try {
      setOverview(await opcApi.getOverview(30));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
        setRuntimeNotice("当前连接的云端实例镜像版本较旧；升级云端服务镜像后将自动启用完整工作台汇报与工作流能力。");
      } else {
        setRuntimeNotice(msg || "暂时无法读取工作台运行状态，请稍后重试。");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
    void refreshInbox();
    const timer = window.setInterval(() => void loadAll(), 45_000);
    const onChanged = (event: Event) => {
      const source = (event as CustomEvent<{ source?: string }>).detail?.source;
      if (source === "boss-console") return;
      void loadAll();
    };
    window.addEventListener(OPC_OVERVIEW_CHANGED_EVENT, onChanged);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(OPC_OVERVIEW_CHANGED_EVENT, onChanged);
    };
  }, [loadAll]);

  const pendingReports = useMemo(() => resolvePendingBossReports(overview), [overview]);
  const briefingReports = useMemo(() => overview?.briefingReports ?? [], [overview]);
  const approvedReports = useMemo(() => overview?.approvedReports ?? [], [overview]);
  const workflows = useMemo(() => overview?.workflows ?? [], [overview]);
  const activeWorkflowRuns = useMemo(() => overview?.activeWorkflowRuns ?? [], [overview]);
  const recentWorkflowRuns = useMemo(() => overview?.recentWorkflowRuns ?? [], [overview]);
  const heartbeats = useMemo(() => overview?.heartbeats ?? [], [overview]);

  // Live bot/group attention threads from client store
  const attentionThreads = useMemo(
    () => crossBotAttentionThreads(visibleBots, state.pendingQueued ?? {}, undefined, state.groups ?? []),
    [visibleBots, state.pendingQueued, state.groups],
  );

  const inboxAsks = useMemo(
    () => (inboxView?.rows ?? []).filter(row => row.tab === "needs-you"),
    [inboxView],
  );

  const inboxAskedThreadIds = useMemo(
    () => new Set(inboxAsks.map(r => r.origin?.threadId).filter((id): id is string => Boolean(id))),
    [inboxAsks],
  );

  const waitingThreads = useMemo(
    () => attentionThreads.filter(
      entry => entry.task.activity === "waiting-on-you" && !inboxAskedThreadIds.has(entry.task.threadId),
    ),
    [attentionThreads, inboxAskedThreadIds],
  );

  const runningThreads = useMemo(() => {
    const busy = attentionThreads.filter(
      entry => entry.task.activity !== "waiting-on-you"
        && (entry.task.activity === "working" || entry.task.busy === true || entry.task.queued === true),
    );
    const seen = new Set(busy.map(e => e.task.threadId));
    const routineBusy: AttentionThread[] = [];
    for (const bot of visibleBots) {
      for (const task of runningRoutineRuns(bot)) {
        if (seen.has(task.threadId)) continue;
        seen.add(task.threadId);
        routineBusy.push({ kind: "bot", botId: bot.id, botName: bot.name, task });
      }
    }
    return [...busy, ...routineBusy];
  }, [attentionThreads, visibleBots]);

  // Alerts: tripped circuit breakers, recent unrecovered workflow failures, unseen problem routine runs
  const trippedWorkflows = useMemo(
    () => workflows.filter(w => w.pausedByCircuitBreaker),
    [workflows],
  );

  const failedWorkflowRuns = useMemo(() => {
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    const latestByWorkflow = new Map<string, (typeof recentWorkflowRuns)[number]>();
    for (const run of recentWorkflowRuns) {
      const existing = latestByWorkflow.get(run.workflowId);
      if (!existing || run.startedAt > existing.startedAt) {
        latestByWorkflow.set(run.workflowId, run);
      }
    }
    const trippedIds = new Set(trippedWorkflows.map(w => w.id));
    return [...latestByWorkflow.values()].filter(
      run => run.status === "failed"
        && !trippedIds.has(run.workflowId)
        && (run.finishedAt ?? run.startedAt) >= cutoff,
    );
  }, [recentWorkflowRuns, trippedWorkflows]);

  const trippedHeartbeats = useMemo(
    () => heartbeats.filter(h => h.pausedByCircuitBreaker),
    [heartbeats],
  );

  const problemRoutineRuns = useMemo(
    () => routineRuns.filter(run => isRoutineProblemRun(run) && !isCountedSkip(run) && !run.seenAt),
    [routineRuns],
  );

  const actionCounts = useMemo(
    () => computeActionQueueCounts({
      pendingReports,
      inboxAsks,
      waitingThreads,
      trippedWorkflows,
      failedWorkflowRuns,
      trippedHeartbeats,
      problemRoutineRuns,
    }),
    [pendingReports, inboxAsks, waitingThreads, trippedWorkflows, failedWorkflowRuns, trippedHeartbeats, problemRoutineRuns],
  );

  const runningCount = activeWorkflowRuns.length + runningThreads.length;
  const unreadBriefingCount = useMemo(
    () => briefingReports.filter(r => r.readAt === undefined).length,
    [briefingReports],
  );
  const todayReportCount = useMemo(() => {
    const now = new Date();
    const seen = new Set<string>();
    for (const r of [...briefingReports, ...approvedReports, ...pendingReports]) {
      if (isSameLocalDay(r.approvedAt ?? r.at, now)) seen.add(r.id);
    }
    return seen.size;
  }, [briefingReports, approvedReports, pendingReports]);

  const activeRoutineCount = useMemo(
    () => routines.filter(r => r.enabled).length,
    [routines],
  );
  const activeWorkflowCount = overview?.activeWorkflowCount
    ?? workflows.filter(w => w.enabled && !w.pausedByCircuitBreaker).length;
  const dayAutomationCompleted = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const rtOk = routineRuns.filter(
      r => !isCountedSkip(r) && r.status === "completed" && (r.finishedAt ?? r.startedAt ?? r.createdAt) >= cutoff,
    ).length;
    const wfOk = recentWorkflowRuns.filter(
      r => r.status === "completed" && (r.finishedAt ?? r.startedAt) >= cutoff,
    ).length;
    return rtOk + wfOk;
  }, [routineRuns, recentWorkflowRuns]);

  const handleReportResolved = (reportId: string, decision: "approved" | "changes_requested") => {
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
      const prevApproved = prev.approvedReports ?? [];
      const nextApproved = decision === "approved" && resolved
        ? [{ ...resolved, approvedAt: Date.now() }, ...prevApproved.filter(r => r.id !== resolved.id)]
        : prevApproved;
      return {
        ...prev,
        pendingReportCount: nextReports.length,
        pendingReports: nextReports,
        approvedReportCount: decision === "approved" && resolved
          ? Math.max(nextApproved.length, (prev.approvedReportCount ?? prevApproved.length) + (prevApproved.some(r => r.id === resolved.id) ? 0 : 1))
          : (prev.approvedReportCount ?? prevApproved.length),
        approvedReports: nextApproved,
        pendingArtifactCount: nextArtifacts.length,
        pendingArtifacts: nextArtifacts,
        waitingWorkflowCount: nextRuns.length,
        waitingWorkflowRuns: nextRuns,
      };
    });
  };

  const handleMarkReportsRead = async (reportIds: string[], read: boolean) => {
    const res = await opcApi.markReportsRead(reportIds, read);
    const idSet = new Set(reportIds);
    const stamp = res.readAt ?? (read ? Date.now() : undefined);
    setOverview(prev => {
      if (!prev) return prev;
      const nextBriefings: OpcBossReportItem[] = (prev.briefingReports ?? []).map(item => {
        if (!idSet.has(item.id)) return item;
        if (read) return { ...item, readAt: stamp };
        const { readAt: _removed, ...rest } = item;
        return rest;
      });
      return {
        ...prev,
        briefingReports: nextBriefings,
        unreadBriefingCount: nextBriefings.filter(r => r.readAt === undefined).length,
      };
    });
    notifyOpcOverviewChanged("boss-console");
  };

  const handleJumpReport = (report: OpcBossReportItem) => {
    dispatch({ type: "select", id: report.botId });
    if (report.threadId && report.reportMessageId) {
      dispatch({ type: "focusMessage", threadId: report.threadId, messageId: report.reportMessageId });
    }
  };

  const handleAnswerInboxRow = (row: InboxRow, response: CardResponse) => {
    const threadId = answerThread(inboxView, row);
    if (!threadId || !row.card?.requestId) return;
    readInboxRow(row);
    settleInboxRow(row);
    dispatch({
      type: "decideRequest",
      threadId,
      requestId: row.card.requestId,
      behavior: response.behavior,
      ...(response.message ? { message: response.message } : {}),
      onError: () => { void refreshInbox(); },
    });
  };

  const handleOpenInboxRow = (row: InboxRow) => {
    readInboxRow(row);
    const botId = row.origin?.botId ?? inboxView?.botId;
    const threadId = row.origin?.threadId ?? inboxView?.threadId;
    const messageId = row.origin?.messageId ?? row.id;
    if (row.origin?.groupId && threadId) {
      dispatch({ type: "switchGroupTask", groupId: row.origin.groupId, threadId });
    } else if (botId && threadId) {
      dispatch({ type: "switchTask", botId, threadId });
    } else if (botId) {
      dispatch({ type: "select", id: botId });
    }
    if (threadId && messageId) {
      dispatch({ type: "focusMessage", threadId, messageId });
    }
  };

  const handleJumpThread = (entry: AttentionThread) => {
    dispatch(attentionJumpAction(entry));
  };

  const handleResetWorkflowBreaker = async (workflowId: string) => {
    await opcApi.updateWorkflow(workflowId, {
      pausedByCircuitBreaker: false,
      consecutiveFailures: 0,
      enabled: true,
    });
    notifyOpcOverviewChanged("boss-console");
    await loadAll();
  };

  const handleRunWorkflow = async (workflowId: string, variables: Record<string, string>) => {
    await opcApi.runWorkflow(workflowId, variables);
    notifyOpcOverviewChanged("boss-console");
    await loadAll();
  };

  const handleCancelWorkflowRun = async (runId: string) => {
    await opcApi.decideWorkflowRun(runId, { action: "cancel" });
    notifyOpcOverviewChanged("boss-console");
    await loadAll();
  };

  const handleResetHeartbeatBreaker = async (heartbeatId: string) => {
    await opcApi.resetCircuitBreaker(heartbeatId, true);
    notifyOpcOverviewChanged("boss-console");
    await loadAll();
  };

  const focusBriefings = (onlyUnread: boolean) => {
    setReportsTab("briefings");
    setUnreadOnly(onlyUnread);
    if (typeof reportsSectionRef.current?.scrollIntoView === "function") {
      reportsSectionRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const statusLine = actionCounts.total > 0
    ? [
      actionCounts.approvals > 0 ? `${actionCounts.approvals} 项待审批` : "",
      actionCounts.questions > 0 ? `${actionCounts.questions} 项待回复/确认` : "",
      actionCounts.alerts > 0 ? `${actionCounts.alerts} 项异常告警` : "",
    ].filter(Boolean).join(" · ")
    : runningCount > 0
      ? `运行平稳 · ${runningCount} 项任务正在后台推进`
      : unreadBriefingCount > 0
        ? `运行平稳 · 有 ${unreadBriefingCount} 份新报告待查阅`
        : "运行平稳 · 当前暂无待处理事项";

  return (
    <main data-opc-boss-console="" className="flex min-w-0 flex-1 flex-col bg-app text-ink">
      <div {...dragProps} className="h-7 shrink-0" />

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 pb-16 pt-2 sm:px-10">
        <div className="mx-auto max-w-[900px] space-y-9">
          {/* Editorial Hero Header */}
          <header className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[12px] font-medium tracking-wide text-ink-tertiary">
                {formattedToday()} · 工作台
              </p>
              <h1 className="mt-1.5 text-[28px] font-semibold leading-tight tracking-[-0.025em] text-ink">
                {greetingByHour()}
              </h1>
              <p className="mt-1.5 text-[14px] text-ink-secondary">
                {statusLine}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  void loadAll();
                  void refreshInbox();
                }}
                aria-label="刷新工作台"
                title="刷新"
                className="flex size-9 items-center justify-center rounded-full bg-ink/[0.05] text-ink-secondary transition-colors hover:bg-ink/[0.1] hover:text-ink"
              >
                <RefreshCw size={14} className={loading ? "animate-spin" : ""} aria-hidden="true" />
              </button>
            </div>
          </header>

          {runtimeNotice && (
            <div role="status" className="flex items-start gap-2.5 rounded-xl bg-ink/[0.04] px-4 py-3 text-[13px] text-ink-secondary">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
              <span>{runtimeNotice}</span>
            </div>
          )}

          {/* Focused 4-Metric Action & Briefing KPI Strip */}
          <section
            aria-label="核心运行指标"
            className="grid grid-cols-2 gap-y-5 border-y border-hairline/50 py-5 sm:grid-cols-4 sm:divide-x sm:divide-hairline/40"
          >
            <div className="pr-4 sm:pr-6">
              <div className="text-[12px] font-medium text-ink-tertiary">待我处理</div>
              <div className={cn("mt-2 text-[30px] font-semibold leading-none tracking-tight tabular-nums", actionCounts.total > 0 ? "text-ink" : "text-ink/50")}>
                {actionCounts.total}
              </div>
              <div className="mt-2 truncate text-[12px] tabular-nums text-ink-tertiary">
                {actionCounts.total > 0
                  ? [
                    actionCounts.approvals > 0 ? `审批 ${actionCounts.approvals}` : "",
                    actionCounts.questions > 0 ? `提问 ${actionCounts.questions}` : "",
                    actionCounts.alerts > 0 ? `告警 ${actionCounts.alerts}` : "",
                  ].filter(Boolean).join(" · ")
                  : "全部已清空"}
              </div>
            </div>

            <div className="pl-4 sm:px-6">
              <div className="text-[12px] font-medium text-ink-tertiary">正在进行</div>
              <div className={cn("mt-2 text-[30px] font-semibold leading-none tracking-tight tabular-nums", runningCount > 0 ? "text-ink" : "text-ink/50")}>
                {runningCount}
              </div>
              <div className="mt-2 truncate text-[12px] tabular-nums text-ink-tertiary">
                {runningCount > 0
                  ? [
                    activeWorkflowRuns.length > 0 ? `工作流 ${activeWorkflowRuns.length}` : "",
                    runningThreads.length > 0 ? `任务 ${runningThreads.length}` : "",
                  ].filter(Boolean).join(" · ")
                  : "当前空闲"}
              </div>
            </div>

            <button
              type="button"
              onClick={() => focusBriefings(unreadBriefingCount > 0)}
              className="group pr-4 text-left sm:px-6"
            >
              <div className="text-[12px] font-medium text-ink-tertiary transition-colors group-hover:text-ink-secondary">
                今日报告
              </div>
              <div className={cn("mt-2 text-[30px] font-semibold leading-none tracking-tight tabular-nums", todayReportCount > 0 ? "text-ink" : "text-ink/50")}>
                {todayReportCount}
              </div>
              <div className="mt-2 truncate text-[12px] tabular-nums text-ink-tertiary">
                {unreadBriefingCount > 0
                  ? `${unreadBriefingCount} 份未读报告`
                  : `累计归档 ${approvedReports.length + briefingReports.length} 份`}
              </div>
            </button>

            <button
              type="button"
              onClick={() => dispatch({ type: "showRoutines", view: "list" })}
              className="group pl-4 text-left sm:pl-6"
            >
              <div className="text-[12px] font-medium text-ink-tertiary transition-colors group-hover:text-ink-secondary">
                自动化运行
              </div>
              <div className={cn("mt-2 text-[30px] font-semibold leading-none tracking-tight tabular-nums", activeRoutineCount + activeWorkflowCount > 0 ? "text-ink" : "text-ink/50")}>
                {activeRoutineCount + activeWorkflowCount}
              </div>
              <div className="mt-2 truncate text-[12px] tabular-nums text-ink-tertiary">
                {actionCounts.alerts > 0
                  ? `${actionCounts.alerts} 项异常待处理`
                  : `近 24h 完成 ${dayAutomationCompleted} 次`}
              </div>
            </button>
          </section>

          {/* 1. Unified Action Queue (Approvals + Questions/Permissions + Alerts) */}
          <OpcActionQueueSection
            pendingReports={pendingReports}
            inboxView={inboxView}
            inboxAsks={inboxAsks}
            waitingThreads={waitingThreads}
            trippedWorkflows={trippedWorkflows}
            failedWorkflowRuns={failedWorkflowRuns}
            trippedHeartbeats={trippedHeartbeats}
            problemRoutineRuns={problemRoutineRuns}
            unreadBriefingCount={unreadBriefingCount}
            botById={botById}
            onReportResolved={handleReportResolved}
            onPreviewAttachment={(attachment, report) => setPreviewState({ attachment, report })}
            onJumpReport={handleJumpReport}
            onAnswerInboxRow={handleAnswerInboxRow}
            onOpenInboxRow={handleOpenInboxRow}
            onJumpThread={handleJumpThread}
            onResetWorkflowBreaker={handleResetWorkflowBreaker}
            onRetryWorkflow={wfId => handleRunWorkflow(wfId, {})}
            onResetHeartbeatBreaker={handleResetHeartbeatBreaker}
            onOpenRoutinesProblems={() => dispatch({ type: "showRoutines", section: "logs", runStatus: "problems" })}
            onOpenWorkflows={() => dispatch({ type: "showTeamMap" })}
            onFocusUnreadBriefings={() => focusBriefings(true)}
          />

          {/* 2. Live Running Work (auto-hides when idle) */}
          <OpcActiveWorkBanner
            activeWorkflowRuns={activeWorkflowRuns}
            runningThreads={runningThreads}
            botById={botById}
            onCancelWorkflowRun={handleCancelWorkflowRun}
            onJumpThread={handleJumpThread}
            onOpenWorkflows={() => dispatch({ type: "showTeamMap" })}
          />

          {/* 3. Primary Hub: Non-Approval Reports, Approved Archive & Deliverables */}
          <div ref={reportsSectionRef}>
            <OpcBriefingReportsPanel
              activeTab={reportsTab}
              onTabChange={setReportsTab}
              briefingReports={briefingReports}
              approvedReports={approvedReports}
              pendingReports={pendingReports}
              botById={botById}
              unreadOnly={unreadOnly}
              onUnreadOnlyChange={setUnreadOnly}
              onMarkReportsRead={handleMarkReportsRead}
              onPreviewAttachment={(attachment, report) => setPreviewState({ attachment, report })}
              onJumpChat={handleJumpReport}
            />
          </div>

          {/* 4. Lightweight Footer: Automation Pulse & Quick-Launch Workflows */}
          <OpcAutomationFooterSection
            workflows={workflows}
            recentWorkflowRuns={recentWorkflowRuns}
            routines={routines}
            routineRuns={routineRuns}
            botById={botById}
            onRunWorkflow={handleRunWorkflow}
            onOpenRoutines={() => dispatch({ type: "showRoutines", view: "list" })}
            onOpenWorkflows={() => dispatch({ type: "showTeamMap" })}
          />
        </div>
      </div>

      {/* Full-format attachment preview & download modal */}
      <OpcArtifactPreviewDialog
        attachment={previewState?.attachment ?? null}
        onClose={() => setPreviewState(null)}
        onJumpToChat={previewState ? () => handleJumpReport(previewState.report) : undefined}
      />
    </main>
  );
}
