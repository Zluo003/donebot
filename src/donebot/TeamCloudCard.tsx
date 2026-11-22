import { useCallback, useEffect, useRef, useState } from "react";
import { Cloud, Loader2 } from "lucide-react";
import { api } from "@/state/api";
import type { DoneBotTeamCloudAction, DoneBotTeamCloudSnapshot, DoneBotTeamIdentity, DoneBotTeamPlan } from "../../shared/donebot-teams";

const button = "ui-button inline-flex items-center gap-2 disabled:opacity-50";
const field = "w-full rounded-lg border border-line bg-app px-3 py-2 text-sm text-ink";
const problem = (cause: unknown) => cause instanceof Error ? cause.message : "团队 Cloud 请求未完成，请刷新后重试。";
const failureMessages: Record<string, string> = {
  billing_insufficient_balance: "所有者账户余额不足，团队 Cloud 未开通且未扣款。",
  capacity_unavailable: "暂时没有支持团队协作的可用节点，未扣款，请稍后重试。",
  billing_failed: "团队 Cloud 扣款未完成，请稍后重试。",
};
const formatBytes = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(n / 1024 ** 2)} MiB`;

export function TeamCloudCard({ accountId, team }: { accountId: string; team: DoneBotTeamIdentity }) {
  const [cloud, setCloud] = useState<DoneBotTeamCloudSnapshot | null>(null);
  const [plans, setPlans] = useState<DoneBotTeamPlan[]>([]);
  const [planId, setPlanId] = useState("");
  const [pending, setPending] = useState<{ action: DoneBotTeamCloudAction; key: string; plan_id?: string } | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
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
  const failedStart = instance?.actual === "error" && cloud?.operations[0]?.action === "start" && cloud.operations[0].state === "failed";
  const failureCode = instance?.error || (cloud?.operations[0]?.state === "failed" ? cloud.operations[0].error : "");
  const chosenPlan = plans.find(plan => plan.id === planId) ?? null;
  const status = !instance ? "尚未开通" : instance.purge_locked ? "正在永久删除" : failedStart ? "开通未完成" : !paid ? "已到期，等待续费或回收"
    : ready ? "运行中" : instance.desired === "stopped" && instance.actual === "stopped" ? "已停机" : instance.actual === "error" ? "需要恢复" : "正在准备，请稍候";

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

  return <div data-team-cloud-card className="flex flex-col gap-3 rounded-lg border border-line p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2 font-medium text-ink"><Cloud size={16} aria-hidden="true" />团队 Cloud · {status}</div>
      {instance && <span className="text-xs text-ink-secondary">{!paid ? "已到期" : instance.auto_renew ? "自动续费已开启" : "自动续费已关闭"}</span>}
    </div>
    {loading && !cloud && <p role="status" className="flex items-center gap-2 text-xs text-ink-secondary"><Loader2 size={14} className="animate-spin" />正在加载团队 Cloud…</p>}
    {cloud && <>
      {instance ? <>
        <p className="text-xs text-ink-secondary">
          已付费至：{instance.paid_until ? new Date(instance.paid_until).toLocaleString() : "尚未开通"}
          {instance.plan_name ? ` · 规格：${instance.plan_name}` : ""}
        </p>
        {failureCode && <p role="alert" className="text-xs text-danger">{failureMessages[failureCode] ?? "最近一次团队 Cloud 操作未完成，请刷新查看状态。"}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={busy || !ready || !cloud.connection_available} onClick={() => void connect()}>进入团队工作空间</button>
          {team.role === "owner" && !instance.purge_locked && <>
            {(!paid || instance.desired !== "running" || failedStart) && <button type="button" className={button} disabled={busy} onClick={() => confirmAction("start")}>{failedStart ? "重试开通" : !renewable ? "续费并启动" : "启动团队 Cloud"}</button>}
            {renewable && <button type="button" className={button} disabled={busy} onClick={() => confirmAction(instance.auto_renew ? "cancel" : "keep")}>{instance.auto_renew ? "取消自动续费" : "开启自动续费"}</button>}
          </>}
        </div>
      </> : team.role === "owner" ? (
        plans.length === 0 ? <p className="text-xs text-ink-secondary">网关管理员尚未配置可售团队 Cloud 套餐。</p> : <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-xs">选择团队套餐<select aria-label="团队套餐" className={field} value={planId} disabled={busy} onChange={event => setPlanId(event.target.value)}>
            {plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name} · {plan.monthly_price}/月（{(plan.runtime.cpu_millis / 1000).toFixed(1)}核/{(plan.runtime.memory_mib / 1024).toFixed(1)}GiB，共享文件 {formatBytes(plan.shared_quota_bytes)}，保留 {plan.retention_days} 天）</option>)}
          </select></label>
          <div><button type="button" className={button} disabled={busy || !chosenPlan} onClick={() => confirmAction("start")}>开通团队 Cloud</button></div>
        </div>
      ) : <p className="text-xs text-ink-secondary">团队 Cloud 尚未开通，请联系团队所有者开通后进入团队工作空间。</p>}

      {pending && <div role="region" aria-label="确认团队 Cloud 操作" className="flex flex-col gap-2 rounded-lg border border-line bg-app p-3 text-xs">
        <p>{pending.action === "cancel" ? "仅关闭自动续费，团队 Cloud 将继续运行至已付费期限结束。"
          : pending.action === "keep" ? "开启到期自动续费，本次不扣款。"
          : renewable ? "当前已付费期限内启动不重复扣款。"
          : chosenPlan ? `确认使用所有者账户余额按月预付 ${chosenPlan.monthly_price}/月 开通「${chosenPlan.name}」并开启自动续费？到期停机后保留 ${chosenPlan.retention_days} 天，超时将永久删除团队数据。`
          : "确认从所有者账户余额续费并启动团队 Cloud？"}</p>
        <div className="flex gap-2">
          <button type="button" className={button} disabled={busy} onClick={() => void submit()}>{busy ? "正在处理…" : "确认"}</button>
          <button type="button" className={button} disabled={busy} onClick={() => setPending(null)}>取消</button>
        </div>
      </div>}
      {notice && <p role="status" className="text-xs text-ink-secondary">{notice}</p>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </>}
  </div>;
}
