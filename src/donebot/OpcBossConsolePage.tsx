import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  FlaskConical,
  GitBranch,
  Layers,
  MessageSquare,
  Plus,
  RefreshCw,
  Store,
} from "lucide-react";
import type {
  OpcBossOverview,
  OpcBossReportAttachment,
  OpcBossReportItem,
} from "../../shared/donebot-opc";
import { BotAvatar } from "@/components/Avatar";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { writeComputerPanelView } from "@/lib/computer-panel-view";
import { cn } from "@/lib/cn";
import { useStore, type Bot } from "@/state/store";
import { formatCny } from "./market-api";
import { OPC_OVERVIEW_CHANGED_EVENT, opcApi } from "./opc-api";
import { OpcArtifactPreviewDialog } from "./OpcArtifactPreviewDialog";
import { OpcBossReportCard, resolvePendingBossReports } from "./OpcBossReportCard";
import { OpcSkillStudioModal } from "./OpcSkillStudioModal";

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
  const botById = useMemo(() => new Map(visibleBots.map(b => [b.id, b])), [visibleBots]);

  const [overview, setOverview] = useState<OpcBossOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [runtimeNotice, setRuntimeNotice] = useState("");
  const [previewState, setPreviewState] = useState<{
    attachment: OpcBossReportAttachment;
    report: OpcBossReportItem;
  } | null>(null);
  const [labBot, setLabBot] = useState<Bot | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setRuntimeNotice("");
    try {
      setOverview(await opcApi.getOverview(30));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
        setRuntimeNotice("当前连接的云端实例镜像版本较旧；升级云端服务镜像后将自动启用正式汇报审批与算力明细。");
      } else {
        setRuntimeNotice(msg || "暂时无法读取老板台运行状态，请稍后重试。");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
    const onChanged = (event: Event) => {
      const source = (event as CustomEvent<{ source?: string }>).detail?.source;
      if (source === "boss-console") return;
      void loadAll();
    };
    window.addEventListener(OPC_OVERVIEW_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(OPC_OVERVIEW_CHANGED_EVENT, onChanged);
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

  const pendingReports = useMemo(() => resolvePendingBossReports(overview), [overview]);

  const handleReportResolved = (reportId: string) => {
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

  const openBotChat = (bot: Bot) => {
    dispatch({ type: "select", id: bot.id });
  };

  const openBotArtifacts = (bot: Bot) => {
    writeComputerPanelView(bot.id, "artifacts");
    dispatch({ type: "select", id: bot.id });
    dispatch({ type: "toggleComputer", open: true });
  };

  const handleJumpReport = (report: OpcBossReportItem) => {
    dispatch({ type: "select", id: report.botId });
    if (report.threadId && report.reportMessageId) {
      dispatch({ type: "focusMessage", threadId: report.threadId, messageId: report.reportMessageId });
    }
  };

  const pendingCount = pendingReports.length;
  const activeWorkflowCount = overview?.activeWorkflowCount ?? 0;
  const activeRoutineCount = useMemo(
    () => (state.routines ?? []).filter(r => r.enabled).length,
    [state.routines],
  );
  const totalSpend = overview?.spend.available ? overview.spend.totalCost : 0;
  const mediaTotalSpend = overview?.spend.available
    ? overview.spend.imageCost + overview.spend.videoCost + overview.spend.musicCost
    : 0;
  const canOpenMarket = state.config?.donebot?.enabled === true && !state.config?.team && window.ogb?.remoteClient?.active !== true;

  const statusLine = pendingCount > 0
    ? `${pendingCount} 份正式汇报等待拍板 · ${visibleBots.length} 位员工在岗`
    : `运行平稳 · ${visibleBots.length} 位 AI 员工在岗`;

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
                <GitBranch size={14} aria-hidden="true" /> 组织与流程
              </button>
              {canOpenMarket && (
                <button
                  type="button"
                  onClick={() => dispatch({ type: "showMarket" })}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-medium text-app transition-opacity hover:opacity-85"
                >
                  <Store size={14} aria-hidden="true" /> 雇佣工作室
                </button>
              )}
              <button
                type="button"
                onClick={() => void loadAll()}
                aria-label="刷新老板台"
                title="刷新"
                className="flex size-9 items-center justify-center rounded-full bg-ink/[0.05] text-ink-secondary transition-colors hover:bg-ink/[0.1] hover:text-ink"
              >
                <RefreshCw size={14} className={loading ? "animate-spin" : ""} aria-hidden="true" />
              </button>
            </div>
          </header>

          {runtimeNotice && (
            <div role="status" className="flex items-start gap-2.5 rounded-xl bg-ink/[0.04] px-4 py-3 text-[12.5px] text-ink-secondary">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
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
            </div>

            <div className="pl-4 sm:px-6">
              <div className="text-[12px] font-medium text-ink-tertiary">待我拍板</div>
              <div className={cn("mt-2 text-[30px] font-semibold leading-none tracking-tight tabular-nums", pendingCount > 0 ? "text-ink" : "text-ink/50")}>
                {pendingCount}
              </div>
              {pendingCount > 0 && (
                <div className="mt-2 text-[11.5px] text-ink-secondary">点击展开汇报并一次通过</div>
              )}
            </div>

            <button
              type="button"
              onClick={() => dispatch({ type: "showRoutines", view: "list" })}
              className="group pr-4 text-left sm:px-6"
            >
              <div className="text-[12px] font-medium text-ink-tertiary transition-colors group-hover:text-ink-secondary">
                自动化与工作流
              </div>
              <div className={cn("mt-2 text-[30px] font-semibold leading-none tracking-tight tabular-nums", activeRoutineCount + activeWorkflowCount > 0 ? "text-ink" : "text-ink/50")}>
                {activeRoutineCount + activeWorkflowCount}
              </div>
              {(activeRoutineCount > 0 || activeWorkflowCount > 0) && (
                <div className="mt-2 truncate text-[11.5px] tabular-nums text-ink-tertiary">
                  自动化 {activeRoutineCount} · 工作流 {activeWorkflowCount}
                </div>
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

          {/* Pending Formal Reports — one click to approve, click header to expand full report & attachments */}
          <section aria-label="待我拍板">
            {pendingReports.length === 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-ink/[0.03] px-4 py-3">
                <div className="flex items-center gap-2.5 text-[13px] text-ink-secondary">
                  <span aria-hidden="true" className="size-2 rounded-full bg-emerald-500/80" />
                  <span>所有汇报与工作流均已拍板，当前无需人工介入。</span>
                </div>
                {canOpenMarket && (
                  <button
                    type="button"
                    onClick={() => dispatch({ type: "showMarket" })}
                    className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ink transition-opacity hover:opacity-75"
                  >
                    去广场逛 AI 工作室 <ArrowRight size={13} aria-hidden="true" />
                  </button>
                )}
              </div>
            ) : (
              <div>
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hairline/50 pb-3">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[13px] font-semibold tracking-wide text-ink">待我拍板</h2>
                    <span className="text-[12px] tabular-nums text-ink-tertiary">{pendingCount}</span>
                  </div>
                  <span className="text-[12px] text-ink-tertiary">点击汇报展开正文与附件，一键通过或打回返工</span>
                </div>
                <div className="divide-y divide-hairline/40 border-b border-hairline/50">
                  {pendingReports.map(report => (
                    <OpcBossReportCard
                      key={report.id}
                      report={report}
                      bot={botById.get(report.botId)}
                      onResolved={handleReportResolved}
                      onPreviewAttachment={(attachment, targetReport) => setPreviewState({ attachment, report: targetReport })}
                      onJumpChat={handleJumpReport}
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
                              <MessageSquare size={12.5} aria-hidden="true" /> 对话
                            </button>
                            <button
                              type="button"
                              onClick={() => openBotArtifacts(bot)}
                              className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink"
                            >
                              <Layers size={12.5} aria-hidden="true" /> 产物
                            </button>
                            <button
                              type="button"
                              onClick={() => setLabBot(bot)}
                              title="版本快照回滚、真题试岗评测与发布广场"
                              className="inline-flex h-7 items-center gap-1 rounded-full bg-ink/[0.06] px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-ink/[0.12]"
                            >
                              <FlaskConical size={12.5} aria-hidden="true" /> 能力实验室
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
                  <Plus size={13.5} aria-hidden="true" /> 从广场一键雇佣 2–8 人 AI 工作室（内容 / 研发 / 运营整包）
                </span>
                <ArrowRight size={13.5} aria-hidden="true" />
              </button>
            )}
          </section>
        </div>
      </div>

      {/* Full-format attachment preview & download modal */}
      <OpcArtifactPreviewDialog
        attachment={previewState?.attachment ?? null}
        onClose={() => setPreviewState(null)}
        onJumpToChat={previewState ? () => handleJumpReport(previewState.report) : undefined}
      />

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
