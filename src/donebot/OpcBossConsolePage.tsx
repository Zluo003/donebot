import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Coins,
  Eye,
  FileText,
  Film,
  FlaskConical,
  Image as ImageIcon,
  Layers,
  LayoutDashboard,
  Loader2,
  MessageSquare,
  Music,
  Plus,
  RefreshCw,
  RotateCcw,
  Store,
  Target,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type { OpcArtifactItem, OpcBossOverview, OpcProjectGoal } from "../../shared/donebot-opc";
import { BotAvatar } from "@/components/Avatar";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { writeComputerPanelView } from "@/lib/computer-panel-view";
import { cn } from "@/lib/cn";
import { useStore, type Bot } from "@/state/store";
import { formatCny } from "./market-api";
import { opcApi } from "./opc-api";
import { OpcHeartbeatPanel } from "./OpcHeartbeatPanel";
import { OpcSkillStudioModal } from "./OpcSkillStudioModal";
import {
  claimReviseDraftWork,
  clearReviseDraft,
  releaseReviseDraftWork,
  useReviseDraft,
} from "./paperclip-revise-draft-store";
import { OpcDecisionCardFooter, OpcInsetPanel, OpcMetricCard, OpcNativeDialog } from "./paperclip-ui";

function KindIcon({ kind }: { kind: OpcArtifactItem["kind"] }) {
  switch (kind) {
    case "image": return <ImageIcon size={15} className="shrink-0 text-ink-tertiary" />;
    case "video": return <Film size={15} className="shrink-0 text-ink-tertiary" />;
    case "audio": return <Music size={15} className="shrink-0 text-ink-tertiary" />;
    default: return <FileText size={15} className="shrink-0 text-ink-tertiary" />;
  }
}

function ConsoleApprovalCard({
  item,
  onResolved,
  onPreview,
  onJump,
}: {
  item: OpcArtifactItem;
  onResolved: (artifactId: string) => void;
  onPreview: (item: OpcArtifactItem) => void;
  onJump: (item: OpcArtifactItem) => void;
}) {
  const draftKey = `artifact:${item.id}`;
  const [draft, updateDraft] = useReviseDraft(draftKey);
  const [error, setError] = useState("");
  const busy = draft.working !== null;

  const approve = async () => {
    if (!claimReviseDraftWork(draftKey, "approve")) return;
    setError("");
    try {
      await opcApi.reviewArtifact(item.id, {
        botId: item.botId,
        status: "approved",
        threadId: item.threadId,
        artifactTitle: item.title,
      });
      clearReviseDraft(draftKey);
      onResolved(item.id);
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
      await opcApi.reviewArtifact(item.id, {
        botId: item.botId,
        status: "changes_requested",
        note: draft.reason.trim(),
        threadId: item.threadId,
        artifactTitle: item.title,
        dispatchRevision: true,
      });
      clearReviseDraft(draftKey);
      onResolved(item.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "派发修改意见失败。");
      releaseReviseDraftWork(draftKey);
    }
  };

  return (
    <article className="flex flex-col gap-3 rounded-2xl bg-card p-3.5 ring-[0.5px] ring-hairline/70">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[12px] font-medium text-ink-secondary">
          {item.botName}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-ink-tertiary">
          v{item.version} · {new Date(item.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>

      <OpcInsetPanel>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onPreview(item)}
            aria-label={`预览「${item.title || item.name}」`}
            className="group relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-raised ring-[0.5px] ring-hairline/50"
          >
            {item.kind === "image" ? (
              <img src={item.previewUrl} alt={item.title} loading="lazy" className="size-full object-cover transition-transform group-hover:scale-105" />
            ) : (
              <KindIcon kind={item.kind} />
            )}
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-medium text-ink">{item.title || item.name}</div>
            <div className="mt-0.5 truncate text-[12px] text-ink-tertiary">{item.threadTitle || item.name}</div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => onPreview(item)}
              title="灯箱预览"
              className="rounded-lg p-1.5 text-ink-tertiary transition-colors hover:bg-raised hover:text-ink"
            >
              <Eye size={14} />
            </button>
            <button
              type="button"
              onClick={() => onJump(item)}
              title="定位原对话"
              className="rounded-lg p-1.5 text-ink-tertiary transition-colors hover:bg-raised hover:text-ink"
            >
              <ArrowUpRight size={14} />
            </button>
          </div>
        </div>

        {draft.revising && (
          <textarea
            value={draft.reason}
            onChange={(e) => updateDraft({ reason: e.target.value })}
            rows={2}
            placeholder="写一句修改意见，点击发送后将自动派发给该员工返工…"
            className="mt-1 w-full resize-none rounded-lg border border-hairline/70 bg-panel px-2.5 py-1.5 text-[12.5px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
          />
        )}
      </OpcInsetPanel>

      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}

      <OpcDecisionCardFooter
        leading={
          draft.revising ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => updateDraft({ revising: false })}
              className="text-[12px] text-ink-tertiary hover:text-ink"
            >
              取消批注
            </button>
          ) : null
        }
      >
        <button
          type="button"
          disabled={busy}
          onClick={() => void requestChanges()}
          className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-raised px-3 text-[12.5px] font-medium text-ink-secondary transition-colors hover:bg-control hover:text-ink disabled:opacity-50"
        >
          {draft.working === "revise" ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
          {draft.revising ? "发送修改" : "打回修改"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void approve()}
          className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-accent px-3.5 text-[12.5px] font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {draft.working === "approve" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          通过
        </button>
      </OpcDecisionCardFooter>
    </article>
  );
}

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
        setRuntimeNotice("当前连接的远端服务镜像版本较旧，尚未启用老板台后端接口；升级云端服务镜像或切回本机即可解锁审批、目标注入与 24h 巡检。");
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
      // Ignored; refreshed on reload.
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

  const botNameById = useMemo(() => new Map(visibleBots.map(b => [b.id, b.name])), [visibleBots]);
  const pendingArtifacts = overview?.pendingArtifacts ?? [];
  const activeGoalCount = goals.filter(g => g.status === "active").length;
  const canOpenMarket = state.config?.donebot?.enabled === true && !state.config?.team && window.ogb?.remoteClient?.active !== true;

  return (
    <main data-opc-boss-console="" className="flex min-w-0 flex-1 flex-col bg-app text-ink">
      <header {...dragProps} className="flex h-[54px] shrink-0 items-center justify-between border-b border-hairline px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <LayoutDashboard size={18} className="shrink-0 text-accent" />
          <h1 className="truncate text-[15.5px] font-semibold">老板台</h1>
          <span className="hidden truncate text-[12px] text-ink-tertiary sm:inline">
            你的一人公司总控台 · 目标、待拍板作品、员工真实算力与 24h 巡检
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {canOpenMarket && (
            <button
              type="button"
              onClick={() => dispatch({ type: "showMarket" })}
              className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-accent px-3.5 text-[12.5px] font-medium text-accent-ink transition-opacity hover:opacity-90"
            >
              <Store size={14} /> 雇佣工作室
            </button>
          )}
          <button
            type="button"
            onClick={() => void loadAll()}
            aria-label="刷新老板台"
            title="刷新老板台"
            className="flex size-8 items-center justify-center rounded-xl border border-hairline/70 text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-6xl space-y-6">
          {runtimeNotice && (
            <div role="status" className="flex items-start gap-2.5 rounded-2xl bg-card px-4 py-3 text-[12.5px] text-ink-secondary ring-[0.5px] ring-hairline/70">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
              <span>{runtimeNotice}</span>
            </div>
          )}

          {/* 4-card KPI strip */}
          <section aria-label="核心运行指标" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <OpcMetricCard
              icon={Users}
              label="在岗员工"
              value={visibleBots.length}
              hint={activeGoalCount > 0 ? `${activeGoalCount} 个项目目标生效中` : "在下方管理员工与实验室"}
            />
            <OpcMetricCard
              icon={CheckCircle2}
              label="待我拍板"
              value={overview?.pendingArtifactCount ?? 0}
              tone={(overview?.pendingArtifactCount ?? 0) > 0 ? "accent" : "neutral"}
              hint={(overview?.pendingArtifactCount ?? 0) > 0 ? "待审交付物可直接打回返工" : "所有交付已清空"}
            />
            <OpcMetricCard
              icon={(overview?.trippedCircuitBreakerCount ?? 0) > 0 ? AlertTriangle : Activity}
              label="24h 静默巡检"
              value={
                (overview?.trippedCircuitBreakerCount ?? 0) > 0
                  ? `${overview!.trippedCircuitBreakerCount} 熔断`
                  : (overview?.activeHeartbeatCount ?? 0)
              }
              tone={(overview?.trippedCircuitBreakerCount ?? 0) > 0 ? "danger" : "neutral"}
              hint={(overview?.trippedCircuitBreakerCount ?? 0) > 0 ? "连续失败已自动停机保护" : "无事静默，有异常才推送"}
              onClick={() => dispatch({ type: "showRoutines", view: "list" })}
            />
            <OpcMetricCard
              icon={Coins}
              label="30 日真实算力"
              value={overview?.spend.available ? formatCny(overview.spend.totalCost) : "¥0.00"}
              hint={
                overview?.spend.available
                  ? `LLM ${formatCny(overview.spend.llmCost)} · 媒体 ${formatCny(overview.spend.imageCost + overview.spend.videoCost + overview.spend.musicCost)}`
                  : "网关按员工真实消耗归因"
              }
            />
          </section>

          {/* Main 2-column workspace */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            {/* Left column (7/12): Pending approvals + Employees & Real Spend */}
            <div className="space-y-6 lg:col-span-7">
              <section aria-label="待我拍板" className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[14px] font-semibold text-ink">待我拍板</h2>
                    <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] font-medium tabular-nums text-ink-secondary">
                      {pendingArtifacts.length}
                    </span>
                  </div>
                  <span className="text-[12px] text-ink-tertiary">通过归档，或打回自动派发返工</span>
                </div>

                {pendingArtifacts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center rounded-2xl bg-card/70 px-6 py-8 text-center ring-[0.5px] ring-hairline/60">
                    <CheckCircle2 size={22} className="mb-2 text-ink-tertiary/60" />
                    <p className="text-[13px] font-medium text-ink">当前没有待拍板的交付物</p>
                    <p className="mt-1 max-w-sm text-[12px] text-ink-tertiary">
                      员工在对话或巡检中生成文档、海报、视频等产物后，会自动按版本汇总到这里等你审片。
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {pendingArtifacts.map(item => (
                      <ConsoleApprovalCard
                        key={item.id}
                        item={item}
                        onResolved={handleResolved}
                        onPreview={setPreviewItem}
                        onJump={handleJumpArtifact}
                      />
                    ))}
                  </div>
                )}
              </section>

              <section aria-label="我的 AI 员工与算力" className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[14px] font-semibold text-ink">我的 AI 员工与算力</h2>
                    <span className="text-[12px] tabular-nums text-ink-tertiary">{employeeRows.length} 位</span>
                  </div>
                  <span className="text-[12px] text-ink-tertiary">近 30 日网关真实消耗</span>
                </div>

                <div
                  tabIndex={0}
                  role="region"
                  aria-label="AI 员工列表与近 30 日真实算力消耗"
                  className="overflow-x-auto rounded-2xl bg-card ring-[0.5px] ring-hairline/70"
                >
                  {employeeRows.length === 0 ? (
                    <div className="px-5 py-8 text-center text-[12.5px] text-ink-tertiary">
                      还没有 AI 员工，点击右上角「雇佣工作室」即可一键组建团队。
                    </div>
                  ) : (
                    <table className="w-full border-collapse text-left text-[12.5px]">
                      <thead className="border-b border-hairline/50 text-[11px] text-ink-tertiary">
                        <tr>
                          <th scope="col" className="px-4 py-2.5 font-medium">员工</th>
                          <th scope="col" className="px-2.5 py-2.5 text-right font-medium">LLM</th>
                          <th scope="col" className="px-2.5 py-2.5 text-right font-medium">媒体</th>
                          <th scope="col" className="px-3 py-2.5 text-right font-medium">合计</th>
                          <th scope="col" className="px-4 py-2.5 text-right font-medium">快捷入口</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-hairline/40">
                        {employeeRows.map(({ bot, llmCost, mediaCost, totalCost }) => (
                          <tr key={bot.id} className="transition-colors hover:bg-raised/40">
                            <th scope="row" className="px-4 py-2.5 font-normal">
                              <div className="flex min-w-0 items-center gap-2.5">
                                <BotAvatar bot={bot} size={26} />
                                <div className="min-w-0">
                                  <div className="truncate text-[13px] font-medium text-ink">{bot.name}</div>
                                  {bot.section && (
                                    <div className="truncate text-[11px] text-ink-tertiary">{bot.section}</div>
                                  )}
                                </div>
                              </div>
                            </th>
                            <td className="px-2.5 py-2.5 text-right tabular-nums text-ink-secondary">{formatCny(llmCost)}</td>
                            <td className="px-2.5 py-2.5 text-right tabular-nums text-ink-secondary">{formatCny(mediaCost)}</td>
                            <td className="px-3 py-2.5 text-right font-medium tabular-nums text-ink">{formatCny(totalCost)}</td>
                            <td className="px-4 py-2.5 text-right">
                              <div className="inline-flex items-center justify-end gap-1">
                                <button
                                  type="button"
                                  onClick={() => openBotChat(bot)}
                                  title="打开对话"
                                  className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11.5px] text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
                                >
                                  <MessageSquare size={12.5} /> 对话
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openBotArtifacts(bot)}
                                  title="查看作品柜"
                                  className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11.5px] text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
                                >
                                  <Layers size={12.5} /> 产物
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setLabBot(bot)}
                                  title="打开能力实验室（快照回滚 / 真题试岗）"
                                  className="inline-flex h-7 items-center gap-1 rounded-lg bg-raised/80 px-2 text-[11.5px] font-medium text-ink transition-colors hover:bg-control"
                                >
                                  <FlaskConical size={12.5} /> 实验室
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </section>
            </div>

            {/* Right column (5/12): Project Goals + 24h Silent Heartbeat */}
            <div className="space-y-6 lg:col-span-5">
              <section aria-label="项目目标卡" className="rounded-2xl bg-card p-4 ring-[0.5px] ring-hairline/70">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Target size={15} className="text-accent" />
                    <h2 className="text-[14px] font-semibold text-ink">项目目标卡</h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setGoalFormOpen(v => !v);
                      setGoalError("");
                    }}
                    className="inline-flex h-7 items-center gap-1 rounded-lg bg-raised px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-control"
                  >
                    <Plus size={13} /> {goalFormOpen ? "收起" : "新建目标"}
                  </button>
                </div>
                <p className="mt-1 text-[12px] text-ink-tertiary">
                  启用中的目标会自动注入所有员工的上下文，确保多员工围绕同一交付标准与红线执行。
                </p>

                {goalFormOpen && (
                  <div className="mt-3 space-y-2.5 rounded-xl bg-app/75 p-3 ring-[0.5px] ring-hairline/50">
                    {visibleBots.length > 0 && (
                      <select
                        value={goalBotId}
                        onChange={e => setGoalBotId(e.target.value)}
                        aria-label="负责员工"
                        className="h-8 w-full rounded-lg border border-hairline/70 bg-panel px-2.5 text-[12.5px] text-ink outline-none focus:border-accent"
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
                      className="h-8 w-full rounded-lg border border-hairline/70 bg-panel px-2.5 text-[12.5px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
                    />
                    <textarea
                      value={goalObjective}
                      onChange={e => setGoalObjective(e.target.value)}
                      rows={2}
                      placeholder="核心愿景与业务目标（必填）"
                      className="w-full resize-none rounded-lg border border-hairline/70 bg-panel px-2.5 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
                    />
                    <textarea
                      value={goalDeliverables}
                      onChange={e => setGoalDeliverables(e.target.value)}
                      rows={2}
                      placeholder="交付清单（每行一条，可选）"
                      className="w-full resize-none rounded-lg border border-hairline/70 bg-panel px-2.5 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
                    />
                    <textarea
                      value={goalRedlines}
                      onChange={e => setGoalRedlines(e.target.value)}
                      rows={2}
                      placeholder="红线约束（每行一条，可选）"
                      className="w-full resize-none rounded-lg border border-hairline/70 bg-panel px-2.5 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
                    />
                    {goalError && <p role="alert" className="text-[12px] text-danger">{goalError}</p>}
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setGoalFormOpen(false)}
                        className="h-7 rounded-lg px-2.5 text-[12px] text-ink-secondary hover:bg-raised"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        disabled={goalSaving}
                        onClick={() => void handleCreateGoal()}
                        className="inline-flex h-7 items-center gap-1 rounded-lg bg-accent px-3 text-[12px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
                      >
                        {goalSaving && <Loader2 size={12} className="animate-spin" />}
                        保存并启用
                      </button>
                    </div>
                  </div>
                )}

                {goals.length === 0 && !goalFormOpen ? (
                  <div className="mt-3 rounded-xl bg-app/60 px-3.5 py-4 text-center text-[12px] text-ink-tertiary ring-[0.5px] ring-hairline/40">
                    尚未设定项目目标。点击「新建目标」给工作室定下北极星指标与红线。
                  </div>
                ) : goals.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    {goals.map(goal => {
                      const isActive = goal.status === "active";
                      const botLabel = botNameById.get(goal.botId);
                      return (
                        <div
                          key={goal.id}
                          className={cn(
                            "rounded-xl p-3 ring-[0.5px] transition-colors",
                            isActive ? "bg-app/75 ring-accent/40" : "bg-app/40 opacity-75 ring-hairline/50",
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span
                                  className={cn(
                                    "size-1.5 shrink-0 rounded-full",
                                    isActive ? "bg-emerald-500" : "bg-ink-tertiary/40",
                                  )}
                                />
                                <span className="truncate text-[13px] font-medium text-ink">{goal.title}</span>
                                {botLabel && (
                                  <span className="shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-[10.5px] text-ink-tertiary">
                                    {botLabel}
                                  </span>
                                )}
                              </div>
                              <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{goal.objective}</p>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <button
                                type="button"
                                onClick={() => void toggleGoalStatus(goal)}
                                className="rounded-md px-2 py-0.5 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink"
                              >
                                {isActive ? "归档" : "启用"}
                              </button>
                              <button
                                type="button"
                                onClick={() => void deleteGoal(goal.id)}
                                aria-label={`删除目标「${goal.title}」`}
                                className="rounded-md p-1 text-ink-tertiary hover:bg-raised hover:text-danger"
                              >
                                <Trash2 size={12.5} />
                              </button>
                            </div>
                          </div>

                          {(goal.deliverables.length > 0 || goal.redlines.length > 0) && (
                            <details className="mt-2 border-t border-hairline/40 pt-1.5 text-[11.5px] text-ink-tertiary">
                              <summary className="cursor-pointer select-none hover:text-ink-secondary">
                                查看交付清单与红线（{goal.deliverables.length + goal.redlines.length} 项）
                              </summary>
                              <div className="mt-1.5 space-y-2">
                                {goal.deliverables.length > 0 && (
                                  <ul className="space-y-1 text-ink-secondary">
                                    {goal.deliverables.map(d => (
                                      <li key={d.id} className="flex items-center gap-1.5">
                                        <input
                                          type="checkbox"
                                          checked={d.done}
                                          onChange={e => void toggleDeliverable(goal, d.id, e.target.checked)}
                                          className="size-3.5 rounded accent-accent"
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

              <OpcHeartbeatPanel bots={visibleBots} compact />
            </div>
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
                className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
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
                    className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-accent-ink"
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
