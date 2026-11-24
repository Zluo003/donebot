import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Check,
  FileText,
  FlaskConical,
  GitBranch,
  Layers,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  RotateCcw,
  Store,
  Trash2,
  X,
} from "lucide-react";
import type { OpcArtifactItem, OpcBossOverview, OpcProjectGoal, OpcWorkflowRun } from "../../shared/donebot-opc";
import { BotAvatar } from "@/components/Avatar";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { writeComputerPanelView } from "@/lib/computer-panel-view";
import { cn } from "@/lib/cn";
import { useStore, type Bot } from "@/state/store";
import { formatCny } from "./market-api";
import { opcApi } from "./opc-api";
import { OpcBossApprovalRow } from "./OpcBossApprovalRow";
import { OpcHeartbeatPanel } from "./OpcHeartbeatPanel";
import { OpcSkillStudioModal } from "./OpcSkillStudioModal";
import { OpcNativeDialog } from "./paperclip-ui";

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

/**
 * Editorial, borderless-first Boss Console ("老板台") inspired by Paperclip's plain MetricCard
 * hierarchy and Linear's hairline layout. Adapts cleanly to all 16 light/dark DoneBot skins.
 */
export function OpcBossConsolePage() {
  const { state, dispatch } = useStore();
  const { dragProps } = useCaptionChrome();
  const visibleBots = useMemo(() => state.bots.filter(b => !b.hidden), [state.bots]);

  const [overview, setOverview] = useState<OpcBossOverview | null>(null);
  const [goals, setGoals] = useState<OpcProjectGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [runtimeNotice, setRuntimeNotice] = useState("");
  const [previewItem, setPreviewItem] = useState<OpcArtifactItem | null>(null);
  const [labBot, setLabBot] = useState<Bot | null>(null);
  const [wfBusyId, setWfBusyId] = useState<string | null>(null);
  const [wfReviseId, setWfReviseId] = useState<string | null>(null);
  const [wfReviseNote, setWfReviseNote] = useState("");

  const [goalFormOpen, setGoalFormOpen] = useState(false);
  const [goalBotId, setGoalBotId] = useState(visibleBots[0]?.id ?? "");
  const [goalTitle, setGoalTitle] = useState("");
  const [goalObjective, setGoalObjective] = useState("");
  const [goalDeliverables, setGoalDeliverables] = useState("");
  const [goalRedlines, setGoalRedlines] = useState("");
  const [goalSaving, setGoalSaving] = useState(false);
  const [goalError, setGoalError] = useState("");

  useEffect(() => {
    if (!goalBotId && visibleBots[0]?.id) setGoalBotId(visibleBots[0].id);
  }, [goalBotId, visibleBots]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setRuntimeNotice("");
    try {
      const [ov, gs] = await Promise.all([
        opcApi.getOverview(30),
        opcApi.listGoals(),
      ]);
      setOverview(ov);
      setGoals(gs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
        setRuntimeNotice("当前连接的云端实例镜像版本较旧；升级云端服务镜像后将自动启用审批、目标注入与 24h 巡检。");
      } else {
        setRuntimeNotice(msg || "暂时无法读取老板台运行状态，请稍后重试。");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const spendByBotId = useMemo(() => {
    const map = new Map<string, OpcBossOverview["spend"]["bots"][number]>();
    for (const row of overview?.spend.bots ?? []) {
      map.set(row.botId, row);
    }
    return map;
  }, [overview]);

  const employeeRows = useMemo(() => {
    const rows = visibleBots.map(bot => {
      const spend = spendByBotId.get(bot.id);
      return {
        bot,
        llmCost: spend?.llmCost ?? 0,
        mediaCost: (spend?.imageCost ?? 0) + (spend?.videoCost ?? 0) + (spend?.musicCost ?? 0),
        totalCost: spend?.totalCost ?? 0,
      };
    });
    rows.sort((a, b) => b.totalCost - a.totalCost || a.bot.name.localeCompare(b.bot.name, "zh-CN"));
    return rows;
  }, [visibleBots, spendByBotId]);

  const handleResolved = (artifactId: string) => {
    setOverview(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        pendingArtifactCount: Math.max(0, prev.pendingArtifactCount - 1),
        pendingArtifacts: prev.pendingArtifacts.filter(a => a.id !== artifactId),
      };
    });
  };

  const openBotChat = (bot: Bot) => {
    dispatch({ type: "select", id: bot.id });
  };

  const openBotArtifacts = (bot: Bot) => {
    writeComputerPanelView(bot.id, "artifacts");
    dispatch({ type: "select", id: bot.id });
    dispatch({ type: "toggleComputer", open: true });
  };

  const handleJumpArtifact = (item: OpcArtifactItem) => {
    dispatch({ type: "select", id: item.botId });
    dispatch({ type: "focusMessage", threadId: item.threadId, messageId: item.reportMessageId });
  };

  const handleCreateGoal = async () => {
    const targetBotId = goalBotId || visibleBots[0]?.id || "";
    if (!targetBotId) {
      setGoalError("请先在左侧创建或雇佣至少一位员工。");
      return;
    }
    if (!goalTitle.trim() || !goalObjective.trim()) {
      setGoalError("请填写目标名称与核心愿景。");
      return;
    }
    setGoalSaving(true);
    setGoalError("");
    try {
      const created = await opcApi.saveGoal({
        botId: targetBotId,
        title: goalTitle.trim(),
        objective: goalObjective.trim(),
        deliverables: goalDeliverables
          .split("\n")
          .map(s => s.trim())
          .filter(Boolean)
          .map(title => ({ title, done: false })),
        redlines: goalRedlines.split("\n").map(s => s.trim()).filter(Boolean),
        status: "active",
      });
      setGoals(prev => [created, ...prev.filter(g => g.id !== created.id)]);
      setGoalTitle("");
      setGoalObjective("");
      setGoalDeliverables("");
      setGoalRedlines("");
      setGoalFormOpen(false);
    } catch (err) {
      setGoalError(err instanceof Error ? err.message : "创建目标失败。");
    } finally {
      setGoalSaving(false);
    }
  };

  const toggleGoalStatus = async (goal: OpcProjectGoal) => {
    try {
      const updated = await opcApi.saveGoal({
        id: goal.id,
        botId: goal.botId,
        title: goal.title,
        objective: goal.objective,
        redlines: goal.redlines,
        deliverables: goal.deliverables,
        status: goal.status === "active" ? "archived" : "active",
      });
      setGoals(prev => prev.map(g => (g.id === goal.id ? updated : g)));
    } catch {
      // Refreshed on next load.
    }
  };

  const toggleDeliverable = async (goal: OpcProjectGoal, deliverableId: string, done: boolean) => {
    try {
      const updated = await opcApi.toggleDeliverable(goal.id, deliverableId, done);
      setGoals(prev => prev.map(g => (g.id === goal.id ? updated : g)));
    } catch {
      // Ignored.
    }
  };

  const deleteGoal = async (id: string) => {
    try {
      await opcApi.deleteGoal(id);
      setGoals(prev => prev.filter(g => g.id !== id));
    } catch {
      // Ignored.
    }
  };

  const handleWorkflowDecision = async (run: OpcWorkflowRun, action: "approve" | "revise") => {
    setWfBusyId(run.id);
    try {
      await opcApi.decideWorkflowRun(run.id, {
        action,
        ...(action === "revise" ? { note: wfReviseNote.trim() } : {}),
      });
      setWfReviseId(null);
      setWfReviseNote("");
      await loadAll();
    } finally {
      setWfBusyId(null);
    }
  };

  const botNameById = useMemo(() => new Map(visibleBots.map(b => [b.id, b.name])), [visibleBots]);
  const pendingArtifacts = overview?.pendingArtifacts ?? [];
  const waitingWorkflowRuns = overview?.waitingWorkflowRuns ?? [];
  const pendingCount = (overview?.pendingArtifactCount ?? 0) + waitingWorkflowRuns.length;
  const activeHeartbeats = overview?.activeHeartbeatCount ?? 0;
  const trippedCount = overview?.trippedCircuitBreakerCount ?? 0;
  const totalSpend = overview?.spend.available ? overview.spend.totalCost : 0;
  const mediaTotalSpend = overview?.spend.available
    ? overview.spend.imageCost + overview.spend.videoCost + overview.spend.musicCost
    : 0;
  const activeGoalCount = goals.filter(g => g.status === "active").length;
  const canOpenMarket = state.config?.donebot?.enabled === true && !state.config?.team && window.ogb?.remoteClient?.active !== true;

  const statusLine = trippedCount > 0
    ? `${trippedCount} 项 24h 巡检触发熔断保护，等待确认`
    : pendingCount > 0
      ? `${pendingCount} 份作品等待拍板 · ${visibleBots.length} 位员工在岗`
      : `运行平稳 · ${visibleBots.length} 位 AI 员工在岗${activeGoalCount > 0 ? ` · ${activeGoalCount} 个目标生效中` : ""}`;

  return (
    <main data-opc-boss-console="" className="flex min-w-0 flex-1 flex-col bg-app text-ink">
      {/* Subtle window drag handle — no heavy divider bar */}
      <div {...dragProps} className="h-7 shrink-0" />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-16 pt-2 sm:px-10">
        <div className="mx-auto max-w-[900px] space-y-10">
          {/* Editorial Hero Header */}
          <header className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[12px] font-medium tracking-wide text-ink-tertiary">
                {formattedToday()} · 老板台
              </p>
              <h1 className="mt-1.5 text-[28px] font-semibold leading-tight tracking-[-0.025em] text-ink">
                {greetingByHour()}
              </h1>
              <p className="mt-1.5 text-[13.5px] text-ink-secondary">
                {statusLine}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => dispatch({ type: "showTeamMap" })}
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-ink/[0.06] px-3.5 text-[13px] font-medium text-ink transition-colors hover:bg-ink/[0.11]"
              >
                <GitBranch size={14} /> 组织架构
              </button>
              {canOpenMarket && (
                <button
                  type="button"
                  onClick={() => dispatch({ type: "showMarket" })}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-medium text-app transition-opacity hover:opacity-85"
                >
                  <Store size={14} /> 雇佣工作室
                </button>
              )}
              <button
                type="button"
                onClick={() => void loadAll()}
                aria-label="刷新老板台"
                title="刷新"
                className="flex size-9 items-center justify-center rounded-full bg-ink/[0.05] text-ink-secondary transition-colors hover:bg-ink/[0.1] hover:text-ink"
              >
                <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              </button>
            </div>
          </header>

          {runtimeNotice && (
            <div role="status" className="flex items-start gap-2.5 rounded-xl bg-ink/[0.04] px-4 py-3 text-[12.5px] text-ink-secondary">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
              <span>{runtimeNotice}</span>
            </div>
          )}

          {/* Paperclip-inspired borderless hairline KPI strip */}
          <section aria-label="核心运行指标" className="grid grid-cols-2 gap-y-5 border-y border-hairline/50 py-5 sm:grid-cols-4 sm:divide-x sm:divide-hairline/40">
            <div className="pr-4 sm:pr-6">
              <div className="text-[12px] font-medium text-ink-tertiary">在岗员工</div>
              <div className="mt-2 text-[30px] font-semibold leading-none tracking-tight tabular-nums text-ink">
                {visibleBots.length}
              </div>
              {activeGoalCount > 0 && (
                <div className="mt-2 text-[11.5px] text-ink-tertiary">{activeGoalCount} 个目标生效中</div>
              )}
            </div>

            <div className="pl-4 sm:px-6">
              <div className="text-[12px] font-medium text-ink-tertiary">待我拍板</div>
              <div className={cn("mt-2 text-[30px] font-semibold leading-none tracking-tight tabular-nums", pendingCount > 0 ? "text-ink" : "text-ink/50")}>
                {pendingCount}
              </div>
              {pendingCount > 0 && (
                <div className="mt-2 text-[11.5px] text-ink-secondary">等待审片或返工</div>
              )}
            </div>

            <button
              type="button"
              onClick={() => dispatch({ type: "showRoutines", view: "list" })}
              className="group pr-4 text-left sm:px-6"
            >
              <div className="text-[12px] font-medium text-ink-tertiary transition-colors group-hover:text-ink-secondary">
                24h 巡检
              </div>
              <div className={cn("mt-2 text-[30px] font-semibold leading-none tracking-tight tabular-nums", trippedCount > 0 ? "text-danger" : activeHeartbeats > 0 ? "text-ink" : "text-ink/50")}>
                {trippedCount > 0 ? `${trippedCount} 熔断` : activeHeartbeats}
              </div>
              {trippedCount > 0 && (
                <div className="mt-2 text-[11.5px] text-danger">已自动停机保护</div>
              )}
            </button>

            <div className="pl-4 sm:pl-6">
              <div className="text-[12px] font-medium text-ink-tertiary">30 日真实算力</div>
              <div className={cn("mt-2 text-[30px] font-semibold leading-none tracking-tight tabular-nums", totalSpend > 0 ? "text-ink" : "text-ink/50")}>
                {formatCny(totalSpend)}
              </div>
              {totalSpend > 0 && overview?.spend.available && (
                <div className="mt-2 truncate text-[11.5px] tabular-nums text-ink-tertiary">
                  LLM {formatCny(overview.spend.llmCost)} · 媒体 {formatCny(mediaTotalSpend)}
                </div>
              )}
            </div>
          </section>

          {/* Pending Approvals — prominent only when items exist; calm single-line status bar when empty */}
          <section aria-label="待我拍板">
            {pendingArtifacts.length === 0 && waitingWorkflowRuns.length === 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-ink/[0.03] px-4 py-3">
                <div className="flex items-center gap-2.5 text-[13px] text-ink-secondary">
                  <span aria-hidden="true" className="size-2 rounded-full bg-emerald-500/80" />
                  <span>所有交付与工作流均已拍板，当前无需人工介入。</span>
                </div>
                {canOpenMarket && (
                  <button
                    type="button"
                    onClick={() => dispatch({ type: "showMarket" })}
                    className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ink transition-opacity hover:opacity-75"
                  >
                    去广场逛 AI 工作室 <ArrowRight size={13} />
                  </button>
                )}
              </div>
            ) : (
              <div>
                <div className="flex items-baseline justify-between border-b border-hairline/50 pb-3">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[13px] font-semibold tracking-wide text-ink">待我拍板</h2>
                    <span className="text-[12px] tabular-nums text-ink-tertiary">{pendingCount}</span>
                  </div>
                  <span className="text-[12px] text-ink-tertiary">通过继续/归档，或打回自动派发返工</span>
                </div>
                <div className="divide-y divide-hairline/40 border-b border-hairline/50">
                  {waitingWorkflowRuns.map(run => {
                    const step = run.stepResults[run.currentStepIndex];
                    const isLastStep = run.currentStepIndex + 1 >= run.stepResults.length;
                    const busy = wfBusyId === run.id;
                    return (
                      <article key={run.id} className="py-3.5 space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="rounded-full bg-ink/[0.08] px-2 py-0.5 text-[10.5px] font-medium text-ink">工作流门禁</span>
                              <span className="truncate text-[14px] font-medium text-ink">
                                {run.workflowName} · 第 {run.currentStepIndex + 1}/{run.stepResults.length} 步「{step?.stepName}」
                              </span>
                            </div>
                            <div className="mt-0.5 flex items-center gap-2.5 text-[12px] text-ink-tertiary">
                              <span>执行员工：{step?.botName}</span>
                              {step?.botId && (
                                <button
                                  type="button"
                                  onClick={() => dispatch({ type: "select", id: step.botId })}
                                  className="text-[11.5px] font-medium text-accent hover:underline"
                                >
                                  查看对话
                                </button>
                              )}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                if (wfReviseId !== run.id) {
                                  setWfReviseId(run.id);
                                  setWfReviseNote("");
                                  return;
                                }
                                void handleWorkflowDecision(run, "revise");
                              }}
                              className="inline-flex h-8 items-center gap-1 rounded-full bg-ink/[0.06] px-3 text-[12.5px] font-medium text-ink hover:bg-ink/[0.11] disabled:opacity-45"
                            >
                              <RotateCcw size={12.5} /> {wfReviseId === run.id ? "发送返工" : "打回返工"}
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleWorkflowDecision(run, "approve")}
                              className="inline-flex h-8 items-center gap-1 rounded-full bg-ink px-3.5 text-[12.5px] font-medium text-app hover:opacity-85 disabled:opacity-45"
                            >
                              {busy ? <Loader2 size={12.5} className="animate-spin" /> : <Check size={12.5} />}
                              {isLastStep ? "批准定稿" : "通过并继续"}
                            </button>
                          </div>
                        </div>
                        <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-xl bg-ink/[0.03] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink-secondary">
                          {step?.output?.trim() || "（正在同步员工对话产出内容…）"}
                        </div>
                        {wfReviseId === run.id && (
                          <textarea
                            value={wfReviseNote}
                            onChange={e => setWfReviseNote(e.target.value)}
                            rows={2}
                            placeholder="写一句修改意见，发送后当前步骤自动返工…"
                            className="w-full resize-none rounded-xl border border-hairline/70 bg-inset px-3 py-2 text-[12.5px] text-ink outline-none focus:border-ink/40"
                          />
                        )}
                      </article>
                    );
                  })}
                  {pendingArtifacts.map(item => (
                    <OpcBossApprovalRow
                      key={item.id}
                      item={item}
                      onResolved={handleResolved}
                      onPreview={setPreviewItem}
                      onJump={handleJumpArtifact}
                    />
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Linear-style hairline Employee & Real Spend Directory */}
          <section aria-label="我的 AI 员工与算力">
            <div className="flex items-baseline justify-between pb-3">
              <div className="flex items-center gap-2">
                <h2 className="text-[13px] font-semibold tracking-wide text-ink">我的 AI 员工与算力</h2>
                <span className="text-[12px] tabular-nums text-ink-tertiary">{employeeRows.length} 位</span>
              </div>
              <span className="text-[12px] text-ink-tertiary">近 30 日网关真实消费</span>
            </div>

            <div
              tabIndex={0}
              role="region"
              aria-label="AI 员工列表与近 30 日真实算力消耗"
              className="overflow-x-auto border-y border-hairline/50"
            >
              {employeeRows.length === 0 ? (
                <div className="py-8 text-center text-[13px] text-ink-tertiary">
                  还没有 AI 员工，点击右上角「雇佣工作室」即可一键组建团队。
                </div>
              ) : (
                <table className="w-full border-collapse text-left text-[13px]">
                  <thead className="border-b border-hairline/40 text-[11.5px] text-ink-tertiary">
                    <tr>
                      <th scope="col" className="py-2.5 pr-4 font-normal">员工</th>
                      <th scope="col" className="px-3 py-2.5 text-right font-normal">LLM</th>
                      <th scope="col" className="px-3 py-2.5 text-right font-normal">媒体</th>
                      <th scope="col" className="px-3 py-2.5 text-right font-normal">合计</th>
                      <th scope="col" className="py-2.5 pl-4 text-right font-normal">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline/35">
                    {employeeRows.map(({ bot, llmCost, mediaCost, totalCost }) => (
                      <tr key={bot.id} className="group transition-colors hover:bg-ink/[0.025]">
                        <th scope="row" className="py-3 pr-4 font-normal">
                          <div className="flex min-w-0 items-center gap-3">
                            <BotAvatar bot={bot} size={30} />
                            <div className="min-w-0">
                              <div className="truncate text-[14px] font-medium text-ink">{bot.name}</div>
                              {bot.section && (
                                <div className="truncate text-[11.5px] text-ink-tertiary">{bot.section}</div>
                              )}
                            </div>
                          </div>
                        </th>
                        <td className="px-3 py-3 text-right tabular-nums text-ink-tertiary">{formatCny(llmCost)}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-ink-tertiary">{formatCny(mediaCost)}</td>
                        <td className={cn("px-3 py-3 text-right font-medium tabular-nums", totalCost > 0 ? "text-ink" : "text-ink-tertiary")}>
                          {formatCny(totalCost)}
                        </td>
                        <td className="py-3 pl-4 text-right">
                          <div className="inline-flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => openBotChat(bot)}
                              className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink"
                            >
                              <MessageSquare size={12.5} /> 对话
                            </button>
                            <button
                              type="button"
                              onClick={() => openBotArtifacts(bot)}
                              className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink"
                            >
                              <Layers size={12.5} /> 产物
                            </button>
                            <button
                              type="button"
                              onClick={() => setLabBot(bot)}
                              title="版本快照回滚、真题试岗评测与发布广场"
                              className="inline-flex h-7 items-center gap-1 rounded-full bg-ink/[0.06] px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-ink/[0.12]"
                            >
                              <FlaskConical size={12.5} /> 能力实验室
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {canOpenMarket && employeeRows.length <= 2 && (
              <button
                type="button"
                onClick={() => dispatch({ type: "showMarket" })}
                className="mt-2.5 flex w-full items-center justify-between rounded-xl px-2 py-2 text-left text-[12.5px] text-ink-tertiary transition-colors hover:bg-ink/[0.03] hover:text-ink"
              >
                <span className="inline-flex items-center gap-2">
                  <Plus size={13.5} /> 从广场一键雇佣 2–8 人 AI 工作室（内容 / 研发 / 运营整包）
                </span>
                <ArrowRight size={13.5} />
              </button>
            )}
          </section>

          {/* Balanced 2-column hairline footer: Project Goals & 24h Silent Heartbeats */}
          <div className="grid grid-cols-1 gap-10 md:grid-cols-2">
            {/* Left: Project Goals */}
            <section aria-label="项目目标卡" className="space-y-3">
              <div className="flex items-center justify-between border-b border-hairline/50 pb-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-[13px] font-semibold tracking-wide text-ink">项目目标卡</h2>
                  {goals.length > 0 && (
                    <span className="text-[12px] tabular-nums text-ink-tertiary">{goals.length}</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setGoalFormOpen(v => !v);
                    setGoalError("");
                  }}
                  className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink"
                >
                  <Plus size={13} /> {goalFormOpen ? "收起" : "新建"}
                </button>
              </div>

              {goalFormOpen && (
                <div className="space-y-2.5 rounded-2xl bg-ink/[0.03] p-4 ring-[0.5px] ring-hairline/50">
                  {visibleBots.length > 0 && (
                    <select
                      value={goalBotId}
                      onChange={e => setGoalBotId(e.target.value)}
                      aria-label="负责员工"
                      className="h-8 w-full rounded-lg border border-hairline/70 bg-panel px-2.5 text-[12.5px] text-ink outline-none focus:border-ink/40"
                    >
                      {visibleBots.map(b => (
                        <option key={b.id} value={b.id}>负责员工：{b.name}</option>
                      ))}
                    </select>
                  )}
                  <input
                    value={goalTitle}
                    onChange={e => setGoalTitle(e.target.value)}
                    placeholder="目标名称（如：12 月小红书爆款日更计划）"
                    className="h-8 w-full rounded-lg border border-hairline/70 bg-panel px-2.5 text-[12.5px] text-ink outline-none placeholder:text-ink-tertiary focus:border-ink/40"
                  />
                  <textarea
                    value={goalObjective}
                    onChange={e => setGoalObjective(e.target.value)}
                    rows={2}
                    placeholder="核心愿景与业务目标（必填）"
                    className="w-full resize-none rounded-lg border border-hairline/70 bg-panel px-2.5 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-ink-tertiary focus:border-ink/40"
                  />
                  <textarea
                    value={goalDeliverables}
                    onChange={e => setGoalDeliverables(e.target.value)}
                    rows={2}
                    placeholder="交付清单（每行一条，可选）"
                    className="w-full resize-none rounded-lg border border-hairline/70 bg-panel px-2.5 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-tertiary focus:border-ink/40"
                  />
                  <textarea
                    value={goalRedlines}
                    onChange={e => setGoalRedlines(e.target.value)}
                    rows={2}
                    placeholder="红线约束（每行一条，可选）"
                    className="w-full resize-none rounded-lg border border-hairline/70 bg-panel px-2.5 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-tertiary focus:border-ink/40"
                  />
                  {goalError && <p role="alert" className="text-[12px] text-danger">{goalError}</p>}
                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setGoalFormOpen(false)}
                      className="h-8 rounded-full px-3 text-[12px] text-ink-secondary hover:bg-ink/[0.06]"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      disabled={goalSaving}
                      onClick={() => void handleCreateGoal()}
                      className="inline-flex h-8 items-center gap-1 rounded-full bg-ink px-3.5 text-[12px] font-medium text-app hover:opacity-85 disabled:opacity-45"
                    >
                      {goalSaving && <Loader2 size={12} className="animate-spin" />}
                      保存并启用
                    </button>
                  </div>
                </div>
              )}

              {goals.length === 0 && !goalFormOpen ? (
                <div className="py-2">
                  <p className="text-[13px] leading-relaxed text-ink-tertiary">
                    为工作室定下北极星目标、交付清单与红线约束，启用后自动注入负责员工的每轮对话。
                  </p>
                  <button
                    type="button"
                    onClick={() => setGoalFormOpen(true)}
                    className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-full bg-ink/[0.06] px-3.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-ink/[0.11]"
                  >
                    <Plus size={13} /> 设定首个目标
                  </button>
                </div>
              ) : goals.length > 0 ? (
                <div className="divide-y divide-hairline/40">
                  {goals.map(goal => {
                    const isActive = goal.status === "active";
                    const botLabel = botNameById.get(goal.botId);
                    return (
                      <div key={goal.id} className={cn("py-3", !isActive && "opacity-60")}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span
                                aria-hidden="true"
                                className={cn(
                                  "size-1.5 shrink-0 rounded-full",
                                  isActive ? "bg-emerald-500" : "bg-ink-tertiary/40",
                                )}
                              />
                              <span className="truncate text-[13.5px] font-medium text-ink">{goal.title}</span>
                              {botLabel && (
                                <span className="shrink-0 text-[11.5px] text-ink-tertiary">{botLabel}</span>
                              )}
                            </div>
                            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{goal.objective}</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              onClick={() => void toggleGoalStatus(goal)}
                              className="rounded-full px-2 py-0.5 text-[11.5px] text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink"
                            >
                              {isActive ? "归档" : "启用"}
                            </button>
                            <button
                              type="button"
                              onClick={() => void deleteGoal(goal.id)}
                              aria-label={`删除目标「${goal.title}」`}
                              className="rounded-full p-1 text-ink-tertiary hover:bg-ink/[0.06] hover:text-danger"
                            >
                              <Trash2 size={12.5} />
                            </button>
                          </div>
                        </div>

                        {(goal.deliverables.length > 0 || goal.redlines.length > 0) && (
                          <details className="mt-2 text-[12px] text-ink-tertiary">
                            <summary className="cursor-pointer select-none hover:text-ink-secondary">
                              交付清单与红线（{goal.deliverables.length + goal.redlines.length}）
                            </summary>
                            <div className="mt-2 space-y-2 pl-3.5">
                              {goal.deliverables.length > 0 && (
                                <ul className="space-y-1 text-ink-secondary">
                                  {goal.deliverables.map(d => (
                                    <li key={d.id} className="flex items-center gap-2">
                                      <input
                                        type="checkbox"
                                        checked={d.done}
                                        onChange={e => void toggleDeliverable(goal, d.id, e.target.checked)}
                                        className="size-3.5 rounded accent-ink"
                                      />
                                      <span className={d.done ? "line-through text-ink-tertiary" : ""}>{d.title}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                              {goal.redlines.length > 0 && (
                                <ul className="list-disc space-y-0.5 pl-4 text-danger/90">
                                  {goal.redlines.map((r, idx) => <li key={idx}>{r}</li>)}
                                </ul>
                              )}
                            </div>
                          </details>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </section>

            {/* Right: 24h Silent Heartbeat — aligned on the exact same hairline baseline */}
            <OpcHeartbeatPanel bots={visibleBots} variant="editorial" />
          </div>
        </div>
      </div>

      {/* Native <dialog> lightbox for quick artifact preview */}
      <OpcNativeDialog
        open={previewItem !== null}
        onClose={() => setPreviewItem(null)}
        ariaLabel={previewItem ? `预览 ${previewItem.title}` : "产物预览"}
        className="w-[min(94vw,860px)]"
      >
        {previewItem && (
          <>
            <div className="flex items-center justify-between border-b border-hairline/60 px-5 py-3.5">
              <div className="min-w-0">
                <div className="truncate text-[14px] font-semibold text-ink">{previewItem.title || previewItem.name}</div>
                <div className="text-[12px] text-ink-tertiary">
                  {previewItem.botName} · v{previewItem.version} · {previewItem.threadTitle || previewItem.name}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPreviewItem(null)}
                aria-label="关闭预览"
                className="rounded-full p-1.5 text-ink-secondary hover:bg-ink/[0.06] hover:text-ink"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex min-h-[260px] flex-1 items-center justify-center overflow-auto bg-app/70 p-6">
              {previewItem.kind === "image" ? (
                <img src={previewItem.previewUrl} alt={previewItem.title} className="max-h-[65dvh] max-w-full rounded-xl object-contain" />
              ) : previewItem.kind === "video" ? (
                <video src={previewItem.previewUrl} controls className="max-h-[65dvh] max-w-full rounded-xl" />
              ) : previewItem.kind === "audio" ? (
                <audio src={previewItem.previewUrl} controls className="w-full max-w-md" />
              ) : (
                <div className="space-y-3 text-center">
                  <FileText size={32} className="mx-auto text-ink-tertiary" />
                  <p className="text-[13px] text-ink-secondary">{previewItem.name}</p>
                  <button
                    type="button"
                    onClick={() => {
                      const target = previewItem;
                      setPreviewItem(null);
                      handleJumpArtifact(target);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-1.5 text-[12.5px] font-medium text-app"
                  >
                    <ArrowUpRight size={14} /> 在原对话中打开
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </OpcNativeDialog>

      {/* Skill & Bot Studio Modal launched directly from any employee row */}
      {labBot && (
        <OpcSkillStudioModal
          bot={labBot}
          open
          onClose={() => setLabBot(null)}
        />
      )}
    </main>
  );
}
