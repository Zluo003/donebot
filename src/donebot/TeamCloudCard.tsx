import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertCircle, ArrowUpRight, CheckCircle2, Cloud, Loader2 } from "lucide-react";
import { api } from "@/state/api";
import { SettingsGroup, SIMPLE_CARD, Switch } from "@/components/SettingsPrimitives";
import { cn } from "@/lib/cn";
import type { DoneBotTeamCloudAction, DoneBotTeamCloudSnapshot, DoneBotTeamIdentity, DoneBotTeamPlan } from "../../shared/donebot-teams";

const button = "ui-button inline-flex items-center justify-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50";
const problem = (cause: unknown) => cause instanceof Error ? cause.message : "团队 Cloud 请求未完成，请刷新后重试。";
const failureMessages: Record<string, string> = {
  billing_insufficient_balance: "所有者账户余额不足，团队 Cloud 未开通且未扣款。",
  capacity_unavailable: "暂时没有支持团队协作的可用节点，未扣款，请稍后重试。",
  billing_failed: "团队 Cloud 扣款未完成，请稍后重试。",
};
const formatBytes = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(n / 1024 ** 2)} MiB`;

type StatusTone = "success" | "accent" | "danger" | "neutral";
const badgeTone: Record<StatusTone, { pill: string; dot: string }> = {
  success: { pill: "bg-success/12 text-success ring-success/25", dot: "bg-success" },
  accent: { pill: "bg-accent/12 text-accent-text ring-accent/25", dot: "bg-accent animate-pulse" },
  danger: { pill: "bg-danger/12 text-danger ring-danger/25", dot: "bg-danger" },
  neutral: { pill: "bg-ink/[0.06] text-ink-secondary ring-ink/10", dot: "bg-ink-tertiary" },
};

export function TeamCloudCard({ accountId, team }: { accountId: string; team: DoneBotTeamIdentity }) {
  const [cloud, setCloud] = useState<DoneBotTeamCloudSnapshot | null>(null);
  const [plans, setPlans] = useState<DoneBotTeamPlan[]>([]);
  const [planId, setPlanId] = useState("");
  const [pending, setPending] = useState<{ action: DoneBotTeamCloudAction; key: string; plan_id?: string } | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const renewTitleId = useId(), renewDescId = useId();
  const generation = useRef(0), flight = useRef(false), alive = useRef(true);

  const refresh = useCallback(async (background = false) => {
    const mine = ++generation.current;
    if (!background) setLoading(true);
    try {
      const [nextCloud, nextPlans] = await Promise.all([
        api<DoneBotTeamCloudSnapshot>(`/api/donebot/teams/${team.id}/cloud`, { background }),
        team.role === "owner" ? api<DoneBotTeamPlan[]>("/api/donebot/teams/plans", { background }).catch(() => []) : Promise.resolve([]),
      ]);
      if (generation.current !== mine) return;
      setCloud(nextCloud);
      setPlans(nextPlans);
      setPlanId(current => nextPlans.some(plan => plan.id === current) ? current : (nextPlans[0]?.id ?? ""));
      setError("");
    } catch (cause) {
      if (generation.current === mine && !background) setError(problem(cause));
    } finally {
      if (generation.current === mine) setLoading(false);
    }
  }, [team.id, team.role]);

  useEffect(() => {
    alive.current = true; setCloud(null); setPending(null); setNotice(""); setError("");
    void refresh();
    return () => { alive.current = false; generation.current++; };
  }, [refresh]);

  useEffect(() => {
    if (busy || loading || pending) return;
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(true); }, 4000);
    return () => window.clearInterval(timer);
  }, [busy, loading, pending, refresh]);

  const instance = cloud?.instance ?? null;
  const paid = !!instance?.paid_until && Date.parse(instance.paid_until) > Date.now();
  const renewable = paid && (instance?.subscription_state === "active" || instance?.subscription_state === "pending");
  const ready = !!instance && instance.actual === "running" && instance.desired === "running" && instance.subscription_state === "active" && paid && !instance.purge_locked;
  const latestOp = cloud?.operations[0];
  const staleOp = latestOp?.generation !== undefined && instance?.generation !== undefined && latestOp.generation < instance.generation;
  const failedStart = instance?.actual === "error" && !staleOp && latestOp?.action === "start" && latestOp.state === "failed";
  const failureCode = instance?.error || (!ready && !staleOp && latestOp?.state === "failed" ? latestOp.error : "");
  const chosenPlan = plans.find(plan => plan.id === planId) ?? null;
  const status = !instance ? "尚未开通" : instance.purge_locked ? "正在永久删除" : failedStart ? "开通未完成" : !paid ? "已到期，等待续费或回收"
    : ready ? "运行中" : instance.desired === "stopped" && instance.actual === "stopped" ? "已停机" : instance.actual === "error" ? "需要恢复" : "正在准备，请稍候";
  const tone: StatusTone = ready ? "success"
    : (failedStart || instance?.purge_locked || instance?.actual === "error") ? "danger"
      : (instance && paid && instance.desired === "running" && !ready) ? "accent"
        : "neutral";

  const confirmAction = (action: DoneBotTeamCloudAction) => {
    if (flight.current || pending) return;
    setError(""); setNotice("");
    setPending({ action, key: crypto.randomUUID(), ...(!instance && action === "start" && planId ? { plan_id: planId } : {}) });
  };

  const submit = async () => {
    if (!pending || flight.current) return;
    const mine = ++generation.current;
    flight.current = true; setBusy(true); setError("");
    try {
      const result = await api<{ operation: { state: string } }>(`/api/donebot/teams/${team.id}/cloud`, {
        method: "POST",
        body: JSON.stringify({ account_id: accountId, ...pending }),
      });
      if (mine !== generation.current) return;
      setPending(null);
      setNotice(result.operation.state === "failed" ? "" : "团队 Cloud 操作已受理，状态将自动更新。");
      await refresh();
    } catch (cause) { if (mine === generation.current) setError(problem(cause)); }
    finally { flight.current = false; if (alive.current) setBusy(false); }
  };

  const connect = async () => {
    if (!instance || !ready || flight.current) return;
    const workspaces = window.ogb?.workspaces;
    if (!workspaces?.openTeamCloud) { setError("请在 DoneBot 桌面客户端打开团队 Cloud。"); return; }
    const mine = ++generation.current;
    flight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const outcome = await workspaces.openTeamCloud(team.id, instance.instance_id, accountId, team.name, team.role);
      if (mine === generation.current && outcome.outcome === "connected") setNotice(`已切换到团队「${team.name}」。`);
    } catch (cause) { if (mine === generation.current) setError(problem(cause)); }
    finally { flight.current = false; if (alive.current) setBusy(false); }
  };

  const showAutoRenewSwitch = Boolean(instance && team.role === "owner" && renewable && !instance.purge_locked);

  return <SettingsGroup label="团队云服务器">
    <div data-team-cloud-card className={cn(SIMPLE_CARD, "divide-y divide-hairline/40 py-0")}>
      <div className="flex flex-col gap-3.5 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-ink/[0.06] text-ink ring-1 ring-inset ring-ink/[0.08]">
              <Cloud size={17} aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-medium leading-5 text-ink">团队 Cloud</span>
                {cloud && (
                  <span role="status" className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", badgeTone[tone].pill)}>
                    <span aria-hidden="true" className={cn("size-1.5 rounded-full", badgeTone[tone].dot)} />
                    {status}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-[12px] text-ink-secondary">
                共享会话、团队知识与团队 Bot 均独立保存在团队 Cloud 中。
              </p>
            </div>
          </div>
          {cloud && instance && (
            <button
              type="button"
              className={ready && cloud.connection_available ? `${button} ui-button-primary` : button}
              disabled={busy || !ready || !cloud.connection_available}
              onClick={() => void connect()}
            >
              <span>进入团队工作空间</span>
              <ArrowUpRight size={14} aria-hidden="true" />
            </button>
          )}
        </div>

        {loading && !cloud && (
          <p role="status" className="flex items-center gap-2 rounded-xl bg-inset/70 px-3 py-2.5 text-[12px] text-ink-secondary">
            <Loader2 size={14} aria-hidden="true" className="animate-spin" />
            正在加载团队 Cloud…
          </p>
        )}

        {cloud && <>
          {instance ? <>
            <dl className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div className="rounded-xl bg-inset/80 px-3.5 py-2.5 ring-1 ring-inset ring-ink/[0.06]">
                <dt className="text-[12px] text-ink-secondary">套餐规格</dt>
                <dd className="mt-1 text-[13px] font-medium text-ink">{instance.plan_name || "标准团队规格"}</dd>
              </div>
              <div className="rounded-xl bg-inset/80 px-3.5 py-2.5 ring-1 ring-inset ring-ink/[0.06]">
                <dt className="text-[12px] text-ink-secondary">已付费至</dt>
                <dd className="mt-1 text-[13px] font-medium tabular-nums text-ink">
                  {instance.paid_until ? new Date(instance.paid_until).toLocaleString() : "尚未开通"}
                </dd>
              </div>
            </dl>

            {failureCode && (
              <p role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
                <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span>{failureMessages[failureCode] ?? "最近一次团队 Cloud 操作未完成，请刷新查看状态。"}</span>
              </p>
            )}

            {team.role === "owner" && !instance.purge_locked && (!paid || instance.desired !== "running" || failedStart) && (
              <div className="flex flex-wrap gap-2">
                <button type="button" className={`${button} ui-button-primary`} disabled={busy} onClick={() => confirmAction("start")}>
                  {failedStart ? "重试开通" : !renewable ? "续费并启动" : "启动团队 Cloud"}
                </button>
              </div>
            )}
          </> : team.role === "owner" ? (
            plans.length === 0 ? (
              <p className="rounded-xl bg-inset/70 px-3.5 py-3 text-[12px] text-ink-secondary">网关管理员尚未配置可售团队 Cloud 套餐。</p>
            ) : (
              <div className="flex flex-col gap-3">
                <div role="radiogroup" aria-label="选择团队套餐" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {plans.map(plan => {
                    const selected = plan.id === planId;
                    return (
                      <button
                        key={plan.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={busy}
                        onClick={() => setPlanId(plan.id)}
                        className={cn(
                          "flex cursor-pointer flex-col gap-1.5 rounded-xl px-3.5 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50",
                          selected
                            ? "bg-ink/[0.08] ring-1 ring-inset ring-ink/35"
                            : "bg-inset/70 ring-1 ring-inset ring-ink/[0.07] hover:bg-ink/[0.05]",
                        )}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[13px] font-medium text-ink">{plan.name}</span>
                          <span className="text-[14px] font-semibold tabular-nums text-ink">{plan.monthly_price} / 月</span>
                        </div>
                        <span className="text-[11px] leading-relaxed text-ink-secondary">
                          {(plan.runtime.cpu_millis / 1000).toFixed(1)} 核 / {(plan.runtime.memory_mib / 1024).toFixed(1)} GiB · 共享文件 {formatBytes(plan.shared_quota_bytes)} · 保留 {plan.retention_days} 天
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div>
                  <button type="button" className={`${button} ui-button-primary`} disabled={busy || !chosenPlan} onClick={() => confirmAction("start")}>
                    开通团队 Cloud
                  </button>
                </div>
              </div>
            )
          ) : (
            <p className="rounded-xl bg-inset/70 px-3.5 py-3 text-[12px] text-ink-secondary">
              团队 Cloud 尚未开通，请联系团队所有者开通后进入团队工作空间。
            </p>
          )}

          {pending && (
            <div role="region" aria-label="确认团队 Cloud 操作" className="flex flex-col gap-3 rounded-xl bg-inset p-3.5 text-[12px] ring-1 ring-inset ring-hairline/80">
              <p className="leading-relaxed text-ink-secondary">
                {pending.action === "cancel" ? "仅关闭自动续费，团队 Cloud 将继续运行至已付费期限结束。"
                  : pending.action === "keep" ? "开启到期自动续费，本次不扣款。"
                    : renewable ? "当前已付费期限内启动不重复扣款。"
                      : chosenPlan ? `确认使用所有者账户余额按月预付 ${chosenPlan.monthly_price}/月 开通「${chosenPlan.name}」并开启自动续费？到期停机后保留 ${chosenPlan.retention_days} 天，超时将永久删除团队数据。`
                        : "确认从所有者账户余额续费并启动团队 Cloud？"}
              </p>
              <div className="flex justify-end gap-2">
                <button type="button" className={button} disabled={busy} onClick={() => setPending(null)}>取消</button>
                <button type="button" className={`${button} ui-button-primary`} disabled={busy} onClick={() => void submit()}>
                  {busy ? "正在处理…" : "确认"}
                </button>
              </div>
            </div>
          )}

          {notice && (
            <p role="status" className="flex items-center gap-2 rounded-xl bg-success/10 px-3 py-2 text-[12px] text-success ring-1 ring-inset ring-success/20">
              <CheckCircle2 size={14} aria-hidden="true" className="shrink-0" />
              <span>{notice}</span>
            </p>
          )}
          {error && (
            <p role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
              <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </p>
          )}
        </>}
      </div>

      {showAutoRenewSwitch && instance && (
        <div className="flex items-start justify-between gap-4 px-4 py-3.5">
          <div className="min-w-0 flex-1 space-y-0.5">
            <div id={renewTitleId} className="text-[14px] font-medium leading-5 text-ink">到期自动续费</div>
            <p id={renewDescId} className="text-[12px] leading-relaxed text-ink-secondary">
              {instance.auto_renew ? "已开启，到期时自动从团队所有者余额续费。" : "已关闭，到期后停止团队 Cloud 服务。"}
            </p>
          </div>
          <div className="flex shrink-0 items-center pt-0.5">
            <Switch
              data-team-cloud-auto-renew-switch=""
              checked={instance.auto_renew}
              aria-labelledby={renewTitleId}
              aria-describedby={renewDescId}
              disabled={busy || !!pending}
              onClick={() => confirmAction(instance.auto_renew ? "cancel" : "keep")}
            />
          </div>
        </div>
      )}
    </div>
  </SettingsGroup>;
}
