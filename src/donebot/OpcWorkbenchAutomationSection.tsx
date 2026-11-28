import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  Clock,
  Loader2,
  Play,
  Square,
  Workflow,
  Zap,
} from "lucide-react";
import type {
  OpcWorkflowDefinition,
  OpcWorkflowRun,
} from "../../shared/donebot-opc";
import { BotAvatar } from "@/components/Avatar";
import { attentionOwnerName, type AttentionThread } from "@/components/SidebarBotActivity";
import { cn } from "@/lib/cn";
import { isCountedSkip, isRoutineProblemRun, type Routine, type RoutineRun } from "@/lib/routines";
import type { Bot } from "@/state/store";

function formatShortTime(ts?: number | null): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatNextRunTime(ts: number): string {
  const target = new Date(ts);
  const now = new Date();
  const sameDay = target.getFullYear() === now.getFullYear()
    && target.getMonth() === now.getMonth()
    && target.getDate() === now.getDate();
  const hhmm = formatShortTime(ts);
  if (sameDay) return `今天 ${hhmm}`;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const isTomorrow = target.getFullYear() === tomorrow.getFullYear()
    && target.getMonth() === tomorrow.getMonth()
    && target.getDate() === tomorrow.getDate();
  return isTomorrow ? `明天 ${hhmm}` : `${target.getMonth() + 1}月${target.getDate()}日 ${hhmm}`;
}

export function OpcActiveWorkBanner({
  activeWorkflowRuns,
  runningThreads,
  botById,
  onCancelWorkflowRun,
  onJumpThread,
  onOpenWorkflows,
}: {
  activeWorkflowRuns: readonly OpcWorkflowRun[];
  runningThreads: readonly AttentionThread[];
  botById: ReadonlyMap<string, Bot>;
  onCancelWorkflowRun: (runId: string) => Promise<void>;
  onJumpThread: (entry: AttentionThread) => void;
  onOpenWorkflows: () => void;
}) {
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const totalRunning = activeWorkflowRuns.length + runningThreads.length;
  if (totalRunning === 0) return null;

  const cancelRun = async (runId: string) => {
    setCancellingId(runId);
    try {
      await onCancelWorkflowRun(runId);
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <section aria-label="正在进行中" className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Loader2 size={13.5} className="animate-spin text-accent" aria-hidden="true" />
          <h2 className="text-[13px] font-semibold tracking-wide text-ink">正在进行中</h2>
          <span className="text-[12px] tabular-nums text-ink-tertiary">{totalRunning} 项</span>
        </div>
      </div>

      <div className="divide-y divide-hairline/40 overflow-hidden rounded-2xl border border-hairline/55 bg-card">
        {activeWorkflowRuns.map(run => {
          const totalSteps = Math.max(1, run.stepResults.length);
          const stepIndex = Math.min(run.currentStepIndex, totalSteps - 1);
          const currentStep = run.stepResults[stepIndex];
          const pct = Math.min(100, Math.max(12, Math.round(((stepIndex + 0.5) / totalSteps) * 100)));
          return (
            <div key={`active-wf:${run.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <Workflow size={14} className="shrink-0 text-accent" aria-hidden="true" />
                  <span className="truncate font-medium text-ink">{run.workflowName}</span>
                  <span className="rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-medium tabular-nums text-accent">
                    第 {stepIndex + 1}/{totalSteps} 步
                  </span>
                  {currentStep && (
                    <span className="truncate text-[12px] text-ink-secondary">
                      {currentStep.stepName} · {currentStep.botName}
                    </span>
                  )}
                </div>
                <div className="h-1.5 w-full max-w-md overflow-hidden rounded-full bg-ink/[0.07]">
                  <div
                    className="h-full rounded-full bg-accent transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={onOpenWorkflows}
                  className="inline-flex h-7 items-center gap-1 rounded-full bg-ink/[0.06] px-2.5 text-[12px] text-ink-secondary hover:bg-ink/[0.11] hover:text-ink"
                >
                  查看流程
                </button>
                <button
                  type="button"
                  disabled={cancellingId === run.id}
                  onClick={() => void cancelRun(run.id)}
                  className="inline-flex h-7 items-center gap-1 rounded-full bg-ink/[0.06] px-2.5 text-[12px] text-ink-secondary hover:bg-danger/12 hover:text-danger disabled:opacity-45"
                >
                  {cancellingId === run.id ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : <Square size={10} aria-hidden="true" />}
                  中止
                </button>
              </div>
            </div>
          );
        })}

        {runningThreads.map(entry => {
          const bot = entry.kind === "bot" ? botById.get(entry.botId) : undefined;
          const owner = attentionOwnerName(entry);
          const isQueued = entry.task.queued && !entry.task.busy && entry.task.activity !== "working";
          return (
            <div
              key={`running:${entry.kind}:${entry.task.threadId}`}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                {bot ? (
                  <BotAvatar bot={bot} size={26} />
                ) : (
                  <span className="grid size-[26px] shrink-0 place-items-center rounded-full bg-accent/12 text-accent">
                    <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-ink">{owner}</span>
                    <span className="text-[11px] text-ink-tertiary">
                      {isQueued ? "排队执行中" : "执行中…"}
                    </span>
                  </div>
                  {entry.task.title && (
                    <p className="truncate text-[12px] text-ink-secondary">{entry.task.title}</p>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onJumpThread(entry)}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-ink/[0.06] px-2.5 text-[12px] text-ink-secondary transition-colors hover:bg-ink/[0.11] hover:text-ink"
              >
                查看进度 <ArrowUpRight size={12} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

interface AutomationFeedRow {
  id: string;
  kind: "workflow" | "routine";
  name: string;
  actor: string;
  at: number;
  tone: "ok" | "running" | "waiting" | "error";
  statusLabel: string;
  detail?: string;
}

export function OpcAutomationFooterSection({
  workflows,
  recentWorkflowRuns,
  routines,
  routineRuns,
  botById,
  onRunWorkflow,
  onOpenRoutines,
  onOpenWorkflows,
}: {
  workflows: readonly OpcWorkflowDefinition[];
  recentWorkflowRuns: readonly OpcWorkflowRun[];
  routines: readonly Routine[];
  routineRuns: readonly RoutineRun[];
  botById: ReadonlyMap<string, Bot>;
  onRunWorkflow: (workflowId: string, variables: Record<string, string>) => Promise<void>;
  onOpenRoutines: () => void;
  onOpenWorkflows: () => void;
}) {
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [promptingWf, setPromptingWf] = useState<OpcWorkflowDefinition | null>(null);
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const [launchNotice, setLaunchNotice] = useState("");
  const [launchError, setLaunchError] = useState("");

  const quickWorkflows = useMemo(
    () => workflows.filter(w => !w.pausedByCircuitBreaker).slice(0, 6),
    [workflows],
  );

  const nextScheduledRoutine = useMemo(() => {
    const now = Date.now();
    return routines
      .filter(r => r.enabled && typeof r.nextRunAt === "number" && r.nextRunAt > now)
      .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0] ?? null;
  }, [routines]);

  const { dayCompleted, dayProblems, feed } = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let completed = 0;
    let problems = 0;
    const rows: AutomationFeedRow[] = [];

    for (const run of routineRuns) {
      if (isCountedSkip(run)) continue;
      const ts = run.finishedAt ?? run.startedAt ?? run.scheduledFor ?? run.createdAt;
      if (ts >= cutoff) {
        if (run.status === "completed") completed += 1;
        else if (isRoutineProblemRun(run)) problems += 1;
      }
      const bot = botById.get(run.botId);
      const tone: AutomationFeedRow["tone"] =
        run.status === "completed" ? "ok"
          : run.status === "running" || run.status === "queued" ? "running"
            : run.status === "waiting" ? "waiting"
              : "error";
      const statusLabel =
        run.status === "completed" ? "已完成"
          : run.status === "running" ? "运行中"
            : run.status === "queued" ? "排队中"
              : run.status === "waiting" ? "等待中"
                : run.status === "missed" ? "未触发"
                  : run.status === "cancelled" ? "已取消"
                    : "失败";
      rows.push({
        id: `rt:${run.id}`,
        kind: "routine",
        name: run.routineName,
        actor: bot?.name ?? "",
        at: ts,
        tone,
        statusLabel,
        detail: run.error || run.output?.slice(0, 80),
      });
    }

    for (const run of recentWorkflowRuns) {
      const ts = run.finishedAt ?? run.startedAt;
      if (ts >= cutoff) {
        if (run.status === "completed") completed += 1;
        else if (run.status === "failed") problems += 1;
      }
      const tone: AutomationFeedRow["tone"] =
        run.status === "completed" ? "ok"
          : run.status === "running" ? "running"
            : run.status === "waiting_approval" ? "waiting"
              : "error";
      const statusLabel =
        run.status === "completed" ? "已完成"
          : run.status === "running" ? "运行中"
            : run.status === "waiting_approval" ? "待审批"
              : run.status === "cancelled" ? "已中止"
                : "失败";
      rows.push({
        id: `wf:${run.id}`,
        kind: "workflow",
        name: run.workflowName,
        actor: `${run.stepResults.length} 步流程`,
        at: ts,
        tone,
        statusLabel,
      });
    }

    rows.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
    return { dayCompleted: completed, dayProblems: problems, feed: rows.slice(0, 5) };
  }, [routineRuns, recentWorkflowRuns, botById]);

  const executeWorkflow = async (wf: OpcWorkflowDefinition, vars: Record<string, string>) => {
    setLaunchingId(wf.id);
    setLaunchError("");
    setLaunchNotice("");
    try {
      await onRunWorkflow(wf.id, vars);
      setPromptingWf(null);
      setVarValues({});
      setLaunchNotice(`已启动工作流「${wf.name}」`);
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : "启动工作流失败，请稍后重试。");
    } finally {
      setLaunchingId(null);
    }
  };

  const handleQuickClick = (wf: OpcWorkflowDefinition) => {
    setLaunchError("");
    setLaunchNotice("");
    if (wf.variables.length > 0) {
      setPromptingWf(prev => (prev?.id === wf.id ? null : wf));
      setVarValues({});
      return;
    }
    void executeWorkflow(wf, {});
  };

  const hasContent = quickWorkflows.length > 0 || feed.length > 0 || nextScheduledRoutine !== null;

  return (
    <section aria-label="自动化动态与快捷启动" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hairline/50 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[13px] font-semibold tracking-wide text-ink">自动化动态与快捷启动</h2>
          <span className="text-[12px] tabular-nums text-ink-tertiary">
            近 24h 完成 {dayCompleted} 次{dayProblems > 0 ? ` · 异常 ${dayProblems} 次` : ""}
          </span>
        </div>
        <div className="flex items-center gap-3 text-[12px]">
          <button
            type="button"
            onClick={onOpenRoutines}
            className="inline-flex items-center gap-0.5 text-ink-secondary transition-colors hover:text-ink"
          >
            定时任务 <ArrowUpRight size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onOpenWorkflows}
            className="inline-flex items-center gap-0.5 text-ink-secondary transition-colors hover:text-ink"
          >
            工作流 <ArrowUpRight size={12} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Quick-launch workflows */}
      {quickWorkflows.length > 0 && (
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-ink-tertiary">快捷启动：</span>
            {quickWorkflows.map(wf => (
              <button
                key={wf.id}
                type="button"
                disabled={launchingId === wf.id}
                onClick={() => handleQuickClick(wf)}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-full border border-hairline/65 bg-card px-3 text-[12px] font-medium text-ink transition-colors hover:border-accent/55 hover:bg-raised disabled:opacity-45",
                  promptingWf?.id === wf.id && "border-accent bg-accent/10 text-accent",
                )}
              >
                {launchingId === wf.id
                  ? <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                  : <Play size={11} aria-hidden="true" />}
                <span>{wf.name}</span>
              </button>
            ))}
          </div>

          {promptingWf && (
            <form
              onSubmit={e => {
                e.preventDefault();
                void executeWorkflow(promptingWf, varValues);
              }}
              className="rounded-xl border border-hairline/60 bg-card p-3.5 space-y-3"
            >
              <div className="flex items-center justify-between gap-2 text-[12px]">
                <span className="font-medium text-ink">填写「{promptingWf.name}」启动参数</span>
                <button
                  type="button"
                  onClick={() => setPromptingWf(null)}
                  className="text-ink-tertiary hover:text-ink"
                >
                  取消
                </button>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {promptingWf.variables.map(name => (
                  <label key={name} className="block space-y-1 text-[12px]">
                    <span className="text-ink-secondary">{name}</span>
                    <input
                      type="text"
                      value={varValues[name] ?? ""}
                      onChange={e => setVarValues(prev => ({ ...prev, [name]: e.target.value }))}
                      placeholder={`输入 ${name}…`}
                      className="h-8 w-full rounded-lg border border-hairline/70 bg-panel px-2.5 text-[12px] text-ink outline-none focus:border-accent"
                    />
                  </label>
                ))}
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={launchingId === promptingWf.id}
                  className="inline-flex h-7 items-center gap-1 rounded-full bg-ink px-3.5 text-[12px] font-medium text-app transition-opacity hover:opacity-85 disabled:opacity-45"
                >
                  {launchingId === promptingWf.id ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Play size={11} aria-hidden="true" />}
                  立即执行
                </button>
              </div>
            </form>
          )}

          {launchNotice && (
            <p role="status" className="text-[12px] text-emerald-600 dark:text-emerald-400">{launchNotice}</p>
          )}
          {launchError && (
            <p role="alert" className="text-[12px] text-danger">{launchError}</p>
          )}
        </div>
      )}

      {/* Next upcoming scheduled run */}
      {nextScheduledRoutine && nextScheduledRoutine.nextRunAt && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-ink/[0.03] px-3.5 py-2.5 text-[12px]">
          <div className="flex min-w-0 items-center gap-2 text-ink-secondary">
            <Clock size={13} className="shrink-0 text-ink-tertiary" aria-hidden="true" />
            <span className="truncate">
              下次定时：<strong className="font-medium text-ink">{nextScheduledRoutine.name}</strong>
              {botById.get(nextScheduledRoutine.botId) ? `（${botById.get(nextScheduledRoutine.botId)!.name}）` : ""}
            </span>
          </div>
          <span className="shrink-0 tabular-nums text-ink-tertiary">
            {formatNextRunTime(nextScheduledRoutine.nextRunAt)}
          </span>
        </div>
      )}

      {/* Recent execution feed */}
      {feed.length > 0 ? (
        <ul className="divide-y divide-hairline/35 border-y border-hairline/45">
          {feed.map(row => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[12px]">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    row.tone === "ok" && "bg-emerald-500",
                    row.tone === "running" && "bg-accent",
                    row.tone === "waiting" && "bg-warning",
                    row.tone === "error" && "bg-danger",
                  )}
                />
                {row.kind === "workflow"
                  ? <Workflow size={12.5} className="shrink-0 text-ink-tertiary" aria-hidden="true" />
                  : <Zap size={12.5} className="shrink-0 text-ink-tertiary" aria-hidden="true" />}
                <span className="truncate font-medium text-ink">{row.name}</span>
                {row.actor && <span className="truncate text-ink-tertiary">· {row.actor}</span>}
              </div>
              <div className="flex shrink-0 items-center gap-2.5 tabular-nums text-ink-tertiary">
                <span
                  className={cn(
                    "font-medium",
                    row.tone === "error" && "text-danger",
                    row.tone === "waiting" && "text-warning",
                    row.tone === "running" && "text-accent",
                  )}
                >
                  {row.statusLabel}
                </span>
                {row.at > 0 && <span>{formatShortTime(row.at)}</span>}
              </div>
            </li>
          ))}
        </ul>
      ) : !hasContent ? (
        <div className="rounded-xl bg-ink/[0.025] px-4 py-3 text-[12px] text-ink-tertiary">
          尚未配置定时任务或固定工作流，可在左侧「自动化」或「组织与流程」创建。
        </div>
      ) : null}
    </section>
  );
}
