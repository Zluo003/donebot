import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Card } from "@/components/SettingsPrimitives";
import { api } from "@/state/api";
import { useStore } from "@/state/store";
import { activeLocale, t } from "@/lib/i18n";
import { doneBotPaymentPending, doneBotPaymentQuote, type DoneBotPaymentOrder, type DoneBotPaymentSnapshot } from "../../shared/donebot-payments";

const button = "ui-button inline-flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50";
const problem = (cause: unknown) => cause instanceof Error ? cause.message : t("donebot.payments.error");
const money = (value: number, currency = "CNY") => new Intl.NumberFormat(activeLocale(), { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
const date = (value: string) => new Date(value).toLocaleString(activeLocale());
const storageKey = (account: string) => `donebot.payment.${account}`;
const statusLabel = (status: string) => t(status === "COMPLETED" ? "donebot.payments.completed" : ["PAID", "RECHARGING"].includes(status) ? "donebot.payments.crediting"
  : status === "PENDING" ? "donebot.payments.pending" : status === "CANCELLED" ? "donebot.payments.cancelled" : status === "EXPIRED" ? "donebot.payments.expired"
  : status.startsWith("REFUND") || status === "PARTIALLY_REFUNDED" ? "donebot.payments.refund" : "donebot.payments.failed");

function recoverCode(account: string, order: DoneBotPaymentOrder): DoneBotPaymentOrder {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey(account)) ?? "null") as DoneBotPaymentOrder | null;
    if (saved?.id === order.id && saved.out_trade_no === order.out_trade_no && saved.amount === order.amount && saved.pay_amount === order.pay_amount &&
      saved.payment_type === order.payment_type && typeof saved.qr_code === "string" && saved.qr_code.length <= 4096) return { ...order, qr_code: saved.qr_code };
  } catch {}
  return order;
}

export function DoneBotPayments() {
  const { state } = useStore();
  const accountID = state.config?.donebot?.user?.id ?? "";
  const [snapshot, setSnapshot] = useState<DoneBotPaymentSnapshot | null>(null);
  const [amount, setAmount] = useState("100"), [methodID, setMethodID] = useState("");
  const [order, setOrder] = useState<DoneBotPaymentOrder | null>(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState(""), [now, setNow] = useState(Date.now());
  const epoch = useRef(0), reads = useRef(0), flight = useRef(false), polling = useRef(false);
  const refresh = useCallback(async () => {
    const generation = epoch.current, sequence = ++reads.current;
    setLoading(true); setError("");
    try {
      const next = await api<DoneBotPaymentSnapshot>("/api/donebot/payments");
      if (generation !== epoch.current || sequence !== reads.current) return;
      if (next.account_id !== accountID) throw new Error(t("donebot.payments.accountChanged"));
      setSnapshot(next); setUncertain(false);
      setMethodID(current => next.methods.some(method => method.id === current && method.available) ? current : next.methods.find(method => method.available)?.id ?? "");
      setOrder(current => {
        const pending = next.orders.find(item => doneBotPaymentPending(item.status));
        const previous = current && next.orders.find(item => item.id === current.id);
        const selected = previous && doneBotPaymentPending(previous.status) ? previous : pending ?? previous;
        return selected ? recoverCode(accountID, selected) : null;
      });
    } catch (cause) { if (generation === epoch.current && sequence === reads.current) setError(problem(cause)); }
    finally { if (generation === epoch.current && sequence === reads.current) setLoading(false); }
  }, [accountID]);

  useEffect(() => {
    epoch.current++;
    setSnapshot(null); setOrder(null); setUncertain(false); setBusy(false); flight.current = false;
    void refresh();
    return () => { epoch.current++; };
  }, [refresh]);

  const updateOrder = useCallback((next: DoneBotPaymentOrder) => {
    setOrder(current => current?.id === next.id ? { ...next, ...(current.qr_code ? { qr_code: current.qr_code } : {}) } : next);
    if (!doneBotPaymentPending(next.status)) {
      try { sessionStorage.removeItem(storageKey(accountID)); } catch {}
    }
    setSnapshot(current => current ? { ...current, orders: [next, ...current.orders.filter(item => item.id !== next.id)] } : current);
  }, [accountID]);

  const readOrder = useCallback(async (action: "status" | "verify" | "cancel" = "status") => {
    if (!order || polling.current || flight.current || loading) return;
    const generation = epoch.current;
    polling.current = true;
    if (action !== "status") { flight.current = true; setBusy(true); }
    try {
      const next = await api<DoneBotPaymentOrder>(`/api/donebot/payments/orders/${order.id}/${action}`, {
        method: "POST", body: JSON.stringify({ account_id: accountID }), background: action === "status",
      });
      if (generation !== epoch.current) return;
      updateOrder(next); setError("");
      if (!doneBotPaymentPending(next.status)) await refresh();
    } catch (cause) { if (generation === epoch.current) setError(problem(cause)); }
    finally { polling.current = false; if (action !== "status") { flight.current = false; if (generation === epoch.current) setBusy(false); } }
  }, [accountID, order, loading, updateOrder, refresh]);

  useEffect(() => {
    if (!order || !doneBotPaymentPending(order.status)) return;
    const timer = window.setInterval(() => { setNow(Date.now()); if (!document.hidden) void readOrder(); }, 3000);
    return () => window.clearInterval(timer);
  }, [order, readOrder]);

  const method = snapshot?.methods.find(method => method.id === methodID);
  const value = Number(amount), valid = /^\d+(?:\.\d{1,2})?$/.test(amount) && value > 0 && Number.isFinite(value);
  const quote = snapshot && method && valid ? doneBotPaymentQuote(snapshot, value, method.fee_rate) : null;
  const inRange = method && valid && value >= method.min && (!method.max || value <= method.max) && (method.remaining === null || (quote?.payable ?? value) <= method.remaining);
  const pending = !!order && doneBotPaymentPending(order.status);
  const expired = !!order && Date.parse(order.expires_at) <= now;
  const create = async () => {
    if (!snapshot || !method || !inRange || pending || uncertain || flight.current || loading || !snapshot.enabled) return;
    const generation = epoch.current;
    flight.current = true; setBusy(true); setError("");
    try {
      const next = await api<DoneBotPaymentOrder>("/api/donebot/payments/orders", { method: "POST", body: JSON.stringify({ account_id: accountID, amount: value, payment_type: method.id }) });
      if (generation !== epoch.current) return;
      setOrder(next); setNow(Date.now());
      setSnapshot(current => current ? { ...current, orders: [next, ...current.orders.filter(item => item.id !== next.id)] } : current);
      try { sessionStorage.setItem(storageKey(accountID), JSON.stringify(next)); } catch {}
    } catch (cause) {
      if (generation === epoch.current) { setError(problem(cause)); setUncertain(true); }
    } finally { flight.current = false; if (generation === epoch.current) setBusy(false); }
  };

  return <div data-donebot-payments className="flex flex-col gap-5">
    <Card title={t("donebot.payments.balance")} subtitle={snapshot?.email ?? state.config?.donebot?.user?.email}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[28px] font-semibold tabular-nums text-ink" data-payment-balance>{snapshot?.balance == null ? "—" : money(snapshot.balance)}</p>
        <button type="button" className={button} disabled={busy || loading} onClick={() => void refresh()}><RefreshCw size={14} className={loading ? "animate-spin" : ""} />{t("donebot.payments.refresh")}</button>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{t("donebot.payments.subtitle")}</p>
    </Card>
    {loading && !snapshot && <p role="status" className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={16} className="animate-spin" />{t("donebot.payments.loading")}</p>}
    {order && <Card title={statusLabel(order.status)}>
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        {order.status === "PENDING" && order.qr_code && !expired && <div className="shrink-0 self-start rounded-xl bg-white p-3" aria-label={t("donebot.payments.qr")}><QRCodeSVG value={order.qr_code} size={200} marginSize={1} /></div>}
        <div className="flex min-w-0 flex-1 flex-col items-start gap-3 text-[13px] text-ink-secondary">
          {order.status === "COMPLETED" && <CheckCircle2 size={26} className="text-success" aria-hidden="true" />}
          <p className="text-[22px] font-semibold text-ink">{money(order.pay_amount, order.currency)}</p>
          <p>{snapshot?.methods.find(method => method.id === order.payment_type)?.name ?? order.payment_type}</p>
          <p>{t("donebot.payments.credited")}: {money(order.amount)}</p>
          <p className="break-all">{t("donebot.payments.order")}: {order.out_trade_no || order.id}</p>
          {pending && <p>{order.status !== "PENDING" ? t("donebot.payments.creditingHint") : expired ? t("donebot.payments.expiredHint") : order.qr_code ? t("donebot.payments.scan") : t("donebot.payments.noCode")}</p>}
          {pending && <p>{t("donebot.payments.expires", { time: date(order.expires_at) })}</p>}
          {pending && <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || loading} onClick={() => void readOrder("verify")}>{t("donebot.payments.check")}</button>
            {order.status === "PENDING" && <button type="button" className={button} disabled={busy || loading} onClick={() => void readOrder("cancel")}>{t("donebot.payments.cancel")}</button>}</div>}
        </div>
      </div>
    </Card>}
    {snapshot && !pending && <Card title={t("settings.section.purchase")}>
      {!snapshot.enabled ? <p className="text-[13px] text-ink-secondary">{t("donebot.payments.disabled")}</p> : <>
        {snapshot.notice && <p className="mb-4 whitespace-pre-wrap break-words text-[13px] text-ink-secondary">{snapshot.notice}</p>}
        <div className="flex flex-col gap-4">
          <fieldset disabled={busy || pending || uncertain} className="flex flex-col gap-4 disabled:opacity-60">
            <legend className="mb-2 text-[13px] font-medium text-ink">{t("donebot.payments.amount")}</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{[50, 100, 200, 500].map(preset => <button key={preset} type="button" aria-pressed={amount === String(preset)} onClick={() => setAmount(String(preset))}
              className={`rounded-xl border px-4 py-3 text-[15px] font-medium ${amount === String(preset) ? "border-ink bg-ink/5 text-ink" : "border-hairline text-ink-secondary"}`}>{preset}</button>)}</div>
            <label className="flex flex-col gap-2 text-[13px] text-ink-secondary">{t("donebot.payments.customAmount")}
              <input aria-label={t("donebot.payments.customAmount")} inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} className="max-w-[280px] rounded-lg border border-hairline bg-app px-3 py-2 text-ink outline-none focus:ring-1 focus:ring-ink" />
            </label>
            <div className="flex flex-wrap gap-2" role="group" aria-label={t("donebot.payments.method")}>{snapshot.methods.map(item => <button key={item.id} type="button" disabled={!item.available} aria-pressed={item.id === methodID} onClick={() => setMethodID(item.id)}
              className={`${button} ${item.id === methodID ? "ring-1 ring-ink" : ""}`}>{item.name}</button>)}</div>
          </fieldset>
          {!snapshot.methods.some(method => method.available) && <p className="text-[13px] text-ink-secondary">{t("donebot.payments.noMethods")}</p>}
          {method && <p className="text-[12px] text-ink-secondary">{t("donebot.payments.range", { min: money(method.min, method.currency), max: method.max ? money(method.max, method.currency) : t("donebot.payments.noLimit") })}</p>}
          {quote && method && <dl className="flex flex-wrap gap-x-8 gap-y-2 text-[14px] text-ink"><div><dt className="text-[12px] text-ink-secondary">{t("donebot.payments.payable")}</dt><dd className="mt-1 font-semibold">{money(quote.payable, method.currency)}</dd></div><div><dt className="text-[12px] text-ink-secondary">{t("donebot.payments.credited")}</dt><dd className="mt-1 font-semibold">{money(quote.credited)}</dd></div></dl>}
          {method && method.fee_rate > 0 && <p className="text-[12px] text-ink-secondary">{t("donebot.payments.fee", { percent: method.fee_rate })}</p>}
          {!pending && <button type="button" disabled={busy || loading || uncertain || !inRange || !method?.available} className={`${button} ui-button-primary self-start`} onClick={() => void create()}>{busy && <Loader2 size={14} className="animate-spin" />}{t("donebot.payments.pay")}</button>}
          <p className="text-[12px] text-ink-secondary">{t("donebot.payments.finalAmount")}</p>
        </div>
      </>}
    </Card>}
    {uncertain && <p role="status" className="text-[13px] leading-relaxed text-ink-secondary">{t("donebot.payments.uncertain")}</p>}
    {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    {!!snapshot?.orders.length && <Card title={t("donebot.payments.history")}><ul className="divide-y divide-hairline">{snapshot.orders.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-[13px]">
      <div className="min-w-0"><p className="break-all text-ink">{item.out_trade_no || item.id}</p><p className="mt-1 text-[12px] text-ink-secondary">{item.created_at && date(item.created_at)}</p></div>
      <div className="flex items-center gap-3"><span className="tabular-nums text-ink">{money(item.pay_amount, item.currency)}</span><span className="text-ink-secondary">{statusLabel(item.status)}</span>
        {doneBotPaymentPending(item.status) && <button type="button" className={button} disabled={busy || loading} onClick={() => setOrder(recoverCode(accountID, item))}>{t("donebot.payments.view")}</button>}</div>
    </li>)}</ul></Card>}
  </div>;
}
