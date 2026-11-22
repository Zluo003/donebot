import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertCircle, ArrowUpRight, CheckCircle2, Cloud, Loader2, RefreshCw } from "lucide-react";
import { api } from "@/state/api";
import { SettingsGroup, SIMPLE_CARD, Switch } from "@/components/SettingsPrimitives";
import { cn } from "@/lib/cn";
import type { DoneBotCloudAction, DoneBotCloudMutation, DoneBotCloudMutationResult, DoneBotCloudSnapshot } from "../../shared/donebot-cloud";
import { DoneBotBotLink } from "./BotLink";

const button = "ui-button inline-flex items-center justify-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50";
const problem = (cause: unknown) => cause instanceof Error ? cause.message : "Cloud 请求未完成，请刷新状态后重试。";
const operationProblems: Record<string, string> = {
  billing_insufficient_balance: "账户余额不足，Cloud 未开通且未扣款。补足余额后可重试。",
  capacity_unavailable: "暂时没有可用服务器，Cloud 未开通且未扣款，请稍后重试。",
  billing_failed: "开通扣款未完成，请刷新账户状态后重试。",
};

type StatusTone = "success" | "accent" | "danger" | "neutral";
const badgeTone: Record<StatusTone, { pill: string; dot: string }> = {
  success: { pill: "bg-success/12 text-success ring-success/25", dot: "bg-success" },
  accent: { pill: "bg-accent/12 text-accent-text ring-accent/25", dot: "bg-accent animate-pulse" },
  danger: { pill: "bg-danger/12 text-danger ring-danger/25", dot: "bg-danger" },
  neutral: { pill: "bg-ink/[0.06] text-ink-secondary ring-ink/10", dot: "bg-ink-tertiary" },
};

function formatBalance(balanceCents: number | string | null): { display: string; full?: string } {
  if (balanceCents === null) return { display: "暂不可用" };
  const value = Number(balanceCents) / 100;
  if (!Number.isFinite(value)) return { display: "暂不可用" };
  return {
    display: value.toLocaleString(undefined, { maximumFractionDigits: 4 }),
    full: value.toLocaleString(undefined, { maximumFractionDigits: 10 }),
  };
}

export function DoneBotCloudAccess({ heading = true }: { heading?: boolean }) {
  const [snapshot, setSnapshot] = useState<DoneBotCloudSnapshot | null>(null);
  const [pending, setPending] = useState<DoneBotCloudMutation | null>(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const renewTitleId = useId(), renewDescId = useId();
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
    } finally {
      if (epoch.current === generation) setLoading(false);
    }
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
  // Personal Cloud operations are ordered oldest-first by donebot-api; ignore historical failures once healthy.
  const latestOperation = snapshot?.operations.at(-1);
  const failed = instance?.actual === "error" && latestOperation?.action === "start" && latestOperation.state === "failed";
  const failure = instance?.error || (!ready && latestOperation?.state === "failed" ? latestOperation.error : "");
  const status = !instance ? "尚未开通" : instance.purge_locked ? "正在永久删除" : failed ? "开通未完成" : !paid ? "已到期，等待续费或回收"
    : ready ? "运行中" : instance.desired === "stopped" && instance.actual === "stopped" ? "已停机" : instance.actual === "error" ? "需要恢复" : "正在准备，请稍候";
  const tone: StatusTone = ready ? "success"
    : (failed || instance?.purge_locked || instance?.actual === "error") ? "danger"
      : (instance && paid && instance.desired === "running" && !ready) ? "accent"
        : "neutral";

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

  const balance = snapshot ? formatBalance(snapshot.balance_cents) : null;
  const showAutoRenewSwitch = Boolean(instance && renewable && !instance.purge_locked);
  const showBotLink = Boolean(instance && window.ogb?.workspaces?.botLink);
  const showSettingsCard = showAutoRenewSwitch || showBotLink;

  return <section data-donebot-cloud-access className="flex w-full flex-col gap-5">
    <div className={cn(SIMPLE_CARD, "flex flex-col gap-4 p-4 sm:p-5")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-ink/[0.06] text-ink ring-1 ring-inset ring-ink/[0.08]">
            <Cloud size={19} aria-hidden="true" />
          </div>
          <div className="min-w-0">
            {heading ? (
              <h3 className="text-[15px] font-semibold leading-5 text-ink">DoneBot Cloud</h3>
            ) : (
              <div className="text-[15px] font-semibold leading-5 text-ink">DoneBot Cloud</div>
            )}
            <p className="mt-0.5 truncate text-[12px] text-ink-secondary">
              {snapshot ? snapshot.email : "使用同一个 DoneBot 账号，开通或管理你的专属云实例。"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {snapshot && (
            <span
              role="status"
              className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium ring-1 ring-inset", badgeTone[tone].pill)}
            >
              <span aria-hidden="true" className={cn("size-1.5 rounded-full", badgeTone[tone].dot)} />
              {status}
            </span>
          )}
          <button
            type="button"
            disabled={busy || loading}
            onClick={() => void refresh()}
            className={`${button} text-[12px]`}
          >
            <RefreshCw size={13} aria-hidden="true" className={loading ? "animate-spin" : ""} />
            刷新 Cloud
          </button>
        </div>
      </div>

      {loading && !snapshot && (
        <p role="status" className="flex items-center gap-2 rounded-xl bg-inset/70 px-3.5 py-3 text-[13px] text-ink-secondary">
          <Loader2 size={14} aria-hidden="true" className="animate-spin" />
          正在加载套餐与余额…
        </p>
      )}

      {snapshot && <>
        <dl className={cn("grid w-full gap-2.5", instance ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-1 sm:grid-cols-2")}>
          <div className="rounded-xl bg-inset/80 px-3.5 py-2.5 ring-1 ring-inset ring-ink/[0.06]">
            <dt className="text-[12px] text-ink-secondary">月费（账户余额单位）</dt>
            <dd className="mt-1 text-[15px] font-semibold tabular-nums text-ink" data-cloud-price>
              {snapshot.plan.monthly_price} / 月
            </dd>
          </div>
          <div className="rounded-xl bg-inset/80 px-3.5 py-2.5 ring-1 ring-inset ring-ink/[0.06]">
            <dt className="text-[12px] text-ink-secondary">可用余额</dt>
            <dd className="mt-1 text-[15px] font-semibold tabular-nums text-ink" data-cloud-balance title={balance?.full}>
              {balance?.display}
            </dd>
          </div>
          {instance && (
            <div className="rounded-xl bg-inset/80 px-3.5 py-2.5 ring-1 ring-inset ring-ink/[0.06]">
              <dt className="text-[12px] text-ink-secondary">已付费至</dt>
              <dd className="mt-1 text-[13px] font-medium tabular-nums text-ink">
                {instance.paid_until ? new Date(instance.paid_until).toLocaleString() : "尚未开通"}
              </dd>
            </div>
          )}
        </dl>

        {failure && (
          <div role="alert" className="flex items-start gap-2.5 rounded-xl bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger ring-1 ring-inset ring-danger/20">
            <AlertCircle size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>{operationProblems[failure] ?? "最近的操作未完成，请刷新状态后重试。"}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2.5">
          {(!instance || !paid || instance.desired !== "running" || failed) && !instance?.purge_locked && (
            <button
              type="button"
              disabled={busy || loading || !!pending || (!renewable && !snapshot.plan.enabled)}
              onClick={() => confirm("start")}
              className={`${button} ui-button-primary`}
            >
              {failed ? "重试开通" : !renewable ? "购买 Cloud 云主机" : "启动 Cloud"}
            </button>
          )}
          {ready && (
            <button
              type="button"
              disabled={busy || loading || !!pending || !snapshot.connection_available}
              onClick={() => void connect()}
              className={`${button} ui-button-primary`}
            >
              <span>连接 Cloud</span>
              <ArrowUpRight size={14} aria-hidden="true" />
            </button>
          )}
          {!snapshot.plan.enabled && !instance && (
            <p className="text-[13px] text-ink-secondary">Cloud 暂未开放开通。</p>
          )}
          {ready && !snapshot.connection_available && (
            <p className="text-[13px] text-ink-secondary">云实例连接尚未配置，请联系管理员。</p>
          )}
        </div>

        {pending && (
          <div role="group" aria-label="Cloud 操作确认" className="flex flex-col gap-3 rounded-xl bg-inset p-4 text-[13px] ring-1 ring-inset ring-hairline/80">
            <h4 className="font-semibold text-ink">
              {pending.action === "keep" ? "确认开启自动续费？" : pending.action === "cancel" ? "确认取消自动续费？" : renewable ? "确认启动 Cloud？" : "确认购买 Cloud 云主机？"}
            </h4>
            <p className="leading-relaxed text-ink-secondary">
              {pending.action === "keep"
                ? `开启后将在已付费期限结束时，从当前账号余额扣除届时的月费（当前 ${pending.monthly_price} / 月）。本次不扣款，不改变当前到期时间。`
                : pending.action === "cancel"
                  ? `仅关闭到期自动续费，Cloud 继续运行至 ${new Date(instance!.paid_until!).toLocaleString()}。到期停机后保留 ${snapshot.plan.retention_days} 天，之后永久删除实例与数据。`
                  : renewable
                    ? "当前已付费期限内启动不重复收费，也不改变自动续费设置。"
                    : `月费 ${pending.monthly_price}，确认后从当前 DoneBot 账号余额扣款，购买一个月 Cloud 服务并开启自动续费。余额不足无法购买或续期。`}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" disabled={busy} onClick={() => { setPending(null); setError(""); }} className={button}>返回</button>
              <button type="button" disabled={busy} onClick={() => void submit()} className={`${button} ui-button-primary`}>
                {busy ? "正在处理…" : error ? "重试确认" : "确认"}
              </button>
            </div>
          </div>
        )}
      </>}

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger ring-1 ring-inset ring-danger/20">
          <AlertCircle size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div role="status" className="flex items-center gap-2 rounded-xl bg-success/10 px-3.5 py-2 text-[13px] text-success ring-1 ring-inset ring-success/20">
          <CheckCircle2 size={14} aria-hidden="true" className="shrink-0" />
          <span>{notice}</span>
        </div>
      )}
    </div>

    {snapshot && showSettingsCard && (
      <SettingsGroup label="订阅与协作">
        <div className={cn(SIMPLE_CARD, "divide-y divide-hairline/40 py-0")}>
          {showAutoRenewSwitch && (
            <div className="flex items-start justify-between gap-4 px-4 py-3.5">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div id={renewTitleId} className="text-[14px] font-medium leading-5 text-ink">到期自动续费</div>
                <p id={renewDescId} className="text-[12px] leading-relaxed text-ink-secondary">
                  {autoRenew
                    ? "已开启，到期时自动从当前账号余额续费。"
                    : `已关闭，到期后停止服务并保留 ${snapshot.plan.retention_days} 天。`}
                </p>
              </div>
              <div className="flex shrink-0 items-center pt-0.5">
                <Switch
                  data-cloud-auto-renew-switch=""
                  checked={autoRenew}
                  aria-labelledby={renewTitleId}
                  aria-describedby={renewDescId}
                  disabled={busy || loading || !!pending}
                  onClick={() => confirm(autoRenew ? "cancel" : "keep")}
                />
              </div>
            </div>
          )}
          {instance && <DoneBotBotLink key={`${snapshot.account_id}:${instance.id}`} accountId={snapshot.account_id} instanceId={instance.id} ready={ready && snapshot.connection_available} />}
        </div>
      </SettingsGroup>
    )}

    {snapshot && (
      <p className="px-1 text-[12px] leading-relaxed text-ink-tertiary">
        按月预付，启用自动续费后到期从同一账号余额扣款。取消自动续费后可继续使用至已付费期限结束。余额不足不开通、不续期；到期停机后保留 {snapshot.plan.retention_days} 天，之后永久删除实例与数据。
      </p>
    )}
  </section>;
}
