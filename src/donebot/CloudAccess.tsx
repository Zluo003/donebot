import { useCallback, useEffect, useRef, useState } from "react";
import { Cloud, Loader2, RefreshCw } from "lucide-react";
import { api } from "@/state/api";
import type { DoneBotCloudAction, DoneBotCloudMutation, DoneBotCloudMutationResult, DoneBotCloudSnapshot } from "../../shared/donebot-cloud";
import { DoneBotBotLink } from "./BotLink";

const button = "ui-button inline-flex items-center gap-2 disabled:opacity-50";
const problem = (cause: unknown) => cause instanceof Error ? cause.message : "Cloud 请求未完成，请刷新状态后重试。";
const operationProblems: Record<string, string> = {
  billing_insufficient_balance: "账户余额不足，Cloud 未开通且未扣款。补足余额后可重试。",
  capacity_unavailable: "暂时没有可用服务器，Cloud 未开通且未扣款，请稍后重试。",
  billing_failed: "开通扣款未完成，请刷新账户状态后重试。",
};

export function DoneBotCloudAccess({ heading = true }: { heading?: boolean }) {
  const [snapshot, setSnapshot] = useState<DoneBotCloudSnapshot | null>(null);
  const [pending, setPending] = useState<DoneBotCloudMutation | null>(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const epoch = useRef(0);
  const flight = useRef(false);
  const alive = useRef(true);
  const refresh = useCallback(async (background = false) => {
    const generation = ++epoch.current;
    if (!background) setLoading(true);
    try {
      const next = await api<DoneBotCloudSnapshot>("/api/donebot/cloud", { background });
      if (epoch.current !== generation) return;
      setSnapshot(next); setError("");
      setPending(current => current && current.account_id === next.account_id && current.monthly_price === next.plan.monthly_price ? current : null);
    } catch (cause) {
      if (epoch.current === generation) { setSnapshot(null); setError(problem(cause)); }
    }
    finally { if (epoch.current === generation) setLoading(false); }
  }, []);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; epoch.current++; }; }, [refresh]);
  useEffect(() => {
    if (busy || loading || pending) return;
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(true); }, 3000);
    return () => window.clearInterval(timer);
  }, [busy, loading, pending, refresh]);

  const instance = snapshot?.instance;
  const paid = !!instance?.paid_until && Date.parse(instance.paid_until) > Date.now();
  const renewable = paid && (instance?.subscription_state === "active" || instance?.subscription_state === "pending");
  const autoRenew = instance?.auto_renew ?? instance?.subscription_state !== "cancelled";
  const ready = !!instance && instance.actual === "running" && instance.desired === "running" && instance.subscription_state === "active" && paid && !instance.purge_locked;
  const failed = instance?.actual === "error" && snapshot?.operations[0]?.action === "start" && snapshot.operations[0].state === "failed";
  const failure = instance?.error || (snapshot?.operations[0]?.state === "failed" ? snapshot.operations[0].error : "");
  const status = !instance ? "尚未开通" : instance.purge_locked ? "正在永久删除" : failed ? "开通未完成" : !paid ? "已到期，等待续费或回收"
    : ready ? "运行中" : instance.desired === "stopped" && instance.actual === "stopped" ? "已停机" : instance.actual === "error" ? "需要恢复" : "正在准备，请稍候";
  const confirm = (action: DoneBotCloudAction) => {
    if (!snapshot || flight.current || pending) return;
    setError(""); setNotice("");
    setPending({ action, id: instance?.id, key: crypto.randomUUID(), account_id: snapshot.account_id, monthly_price: snapshot.plan.monthly_price });
  };
  const submit = async () => {
    if (!pending || flight.current) return;
    const generation = ++epoch.current;
    flight.current = true; setLoading(false); setBusy(true); setError("");
    try {
      const result = await api<DoneBotCloudMutationResult>("/api/donebot/cloud", { method: "POST", body: JSON.stringify(pending) });
      if (generation !== epoch.current) return;
      setPending(null); setNotice(result.operation.state === "failed" ? "" : "操作已受理，实例状态会自动更新。");
      await refresh();
    } catch (cause) { if (generation === epoch.current) setError(problem(cause)); }
    finally { flight.current = false; if (alive.current) setBusy(false); }
  };
  const connect = async () => {
    if (!instance || !snapshot || !ready || flight.current) return;
    const workspaces = window.ogb?.workspaces;
    if (!workspaces?.add) { setError("请在 DoneBot 桌面客户端连接云实例。"); return; }
    const generation = ++epoch.current;
    flight.current = true; setLoading(false); setBusy(true); setError(""); setNotice("");
    try {
      if (workspaces.openCloud) {
        const outcome = await workspaces.openCloud(instance.id, snapshot.account_id);
        if (epoch.current === generation && outcome.outcome === "connected") setNotice("已连接 Cloud。");
        return;
      }
      const result = await api<{ url: string }>("/api/donebot/cloud/connect", { method: "POST", body: JSON.stringify({ id: instance.id, account_id: snapshot.account_id }) });
      const current = await api<DoneBotCloudSnapshot>("/api/donebot/cloud");
      if (epoch.current !== generation) return;
      if (current.account_id !== snapshot.account_id || current.instance?.id !== instance.id) {
        setSnapshot(current); setPending(null); throw new Error("Account changed");
      }
      if (current.instance.actual !== "running" || current.instance.desired !== "running" || current.instance.subscription_state !== "active" ||
        current.instance.purge_locked || !current.instance.paid_until || Date.parse(current.instance.paid_until) <= Date.now()) throw new Error("Instance unavailable");
      const outcome = await workspaces.add("link", result.url);
      if (epoch.current !== generation) return;
      if (outcome === false || typeof outcome === "object" && outcome?.outcome !== "connected") throw new Error("Cloud pairing failed");
      setNotice("已连接 Cloud。");
    } catch { if (epoch.current === generation) setError("连接 Cloud 未完成，请刷新实例状态后重试。"); }
    finally { flight.current = false; if (alive.current) setBusy(false); }
  };

  return <section data-donebot-cloud-access className="flex flex-col items-start gap-3">
    {heading && <h3 className="flex items-center gap-2 text-[15px] font-semibold text-ink"><Cloud size={18} aria-hidden="true" />DoneBot Cloud</h3>}
    {loading && !snapshot && <p role="status" className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />正在加载套餐与余额…</p>}
    {snapshot && <>
      <p className="break-all text-[13px] text-ink-secondary">{snapshot.email}</p>
      <dl className="grid w-full grid-cols-2 gap-x-5 gap-y-3 text-[13px]">
        <div><dt className="text-ink-secondary">月费（账户余额单位）</dt><dd className="mt-1 font-semibold text-ink" data-cloud-price>{snapshot.plan.monthly_price} / 月</dd></div>
        <div><dt className="text-ink-secondary">可用余额</dt><dd className="mt-1 font-semibold text-ink" data-cloud-balance>{snapshot.balance_cents === null ? "暂不可用" : (Number(snapshot.balance_cents) / 100).toLocaleString(undefined, { maximumFractionDigits: 10 })}</dd></div>
      </dl>
      <p className="text-[12px] leading-relaxed text-ink-secondary">按月预付，启用自动续费后到期从同一账号余额扣款。取消自动续费后可继续使用至已付费期限结束。余额不足不开通、不续期；到期停机后保留 {snapshot.plan.retention_days} 天，之后永久删除实例与数据。</p>
      {instance && <div className="space-y-1 text-[13px] text-ink-secondary">
        <p role="status">{status}</p>
        <p>已付费至：{instance.paid_until ? new Date(instance.paid_until).toLocaleString() : "尚未开通"}</p>
        {renewable && <p>{autoRenew ? "自动续费已开启" : "自动续费已关闭，到期后停止服务"}</p>}
        {failure && <p role="alert" className="text-danger">{operationProblems[failure] ?? "最近的操作未完成，请刷新状态后重试。"}</p>}
      </div>}
      <div className="flex flex-wrap gap-2">
        {(!instance || !paid || instance.desired !== "running" || failed) && !instance?.purge_locked && <button type="button" disabled={busy || loading || !!pending || !renewable && !snapshot.plan.enabled} onClick={() => confirm("start")} className={`${button} ui-button-primary`}>
          {failed ? "重试开通" : !renewable ? "购买 Cloud 云主机" : "启动 Cloud"}
        </button>}
        {ready && <button type="button" disabled={busy || loading || !!pending || !snapshot.connection_available} onClick={() => void connect()} className={`${button} ui-button-primary`}>连接 Cloud</button>}
        {instance && renewable && !instance.purge_locked && <button type="button" disabled={busy || loading || !!pending} onClick={() => confirm(autoRenew ? "cancel" : "keep")} className={button}>{autoRenew ? "取消自动续费" : "自动续费"}</button>}
      </div>
      {!snapshot.plan.enabled && !instance && <p className="text-[13px] text-ink-secondary">Cloud 暂未开放开通。</p>}
      {ready && !snapshot.connection_available && <p className="text-[13px] text-ink-secondary">云实例连接尚未配置，请联系管理员。</p>}
      {instance && <DoneBotBotLink key={`${snapshot.account_id}:${instance.id}`} accountId={snapshot.account_id} instanceId={instance.id} ready={ready && snapshot.connection_available} />}
      {pending && <div role="group" aria-label="Cloud 操作确认" className="w-full space-y-3 rounded-lg border border-hairline bg-inset p-4 text-[13px]">
        <h4 className="font-semibold text-ink">{pending.action === "keep" ? "确认开启自动续费？" : pending.action === "cancel" ? "确认取消自动续费？" : renewable ? "确认启动 Cloud？" : "确认购买 Cloud 云主机？"}</h4>
        <p className="leading-relaxed text-ink-secondary">{pending.action === "keep" ? `开启后将在已付费期限结束时，从当前账号余额扣除届时的月费（当前 ${pending.monthly_price} / 月）。本次不扣款，不改变当前到期时间。`
          : pending.action === "cancel" ? `仅关闭到期自动续费，Cloud 继续运行至 ${new Date(instance!.paid_until!).toLocaleString()}。到期停机后保留 ${snapshot.plan.retention_days} 天，之后永久删除实例与数据。`
            : renewable ? "当前已付费期限内启动不重复收费，也不改变自动续费设置。"
              : `月费 ${pending.monthly_price}，确认后从当前 DoneBot 账号余额扣款，购买一个月 Cloud 服务并开启自动续费。余额不足无法购买或续期。`}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => { setPending(null); setError(""); }} className={button}>返回</button>
          <button type="button" disabled={busy} onClick={() => void submit()} className={`${button} ui-button-primary`}>{busy ? "正在处理…" : error ? "重试确认" : "确认"}</button>
        </div>
      </div>}
    </>}
    {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    {notice && <p role="status" className="text-[13px] text-ink-secondary">{notice}</p>}
    <button type="button" disabled={busy || loading} onClick={() => void refresh()} className={`${button} text-[12px]`}><RefreshCw size={13} />刷新 Cloud</button>
  </section>;
}
