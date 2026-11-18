import { DoneBotGatewayError, type DoneBotGateway } from "./gateway.ts";
import { doneBotPaymentPending, doneBotPaymentQuote, type DoneBotPaymentInput, type DoneBotPaymentMethod, type DoneBotPaymentOrder, type DoneBotPaymentSnapshot } from "../../shared/donebot-payments.ts";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown, max = 200): string => typeof value === "string" ? value.slice(0, max) : "";
const amount = (value: unknown, fallback = 0): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
const currency = (value: unknown): string => typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : "CNY";
const invalid = (): never => { throw new DoneBotGatewayError(502, "payment_invalid", "充值订单无法验证，请刷新订单状态。"); };
const creating = new WeakSet<DoneBotGateway>();

export function paymentOrder(value: unknown): DoneBotPaymentOrder {
  const x = row(value);
  if (!Number.isSafeInteger(x.id) || Number(x.id) <= 0 || typeof x.amount !== "number" || !Number.isFinite(x.amount) || x.amount < 0 ||
    typeof x.pay_amount !== "number" || !Number.isFinite(x.pay_amount) || x.pay_amount < 0 ||
    typeof x.status !== "string" || !/^[A-Z_]{1,32}$/.test(x.status) || typeof x.expires_at !== "string" || !Number.isFinite(Date.parse(x.expires_at))) return invalid();
  return { id: Number(x.id), amount: x.amount, pay_amount: x.pay_amount, currency: currency(x.currency),
    payment_type: text(x.payment_type), out_trade_no: text(x.out_trade_no, 64), status: x.status, expires_at: x.expires_at, created_at: text(x.created_at) };
}

export async function paymentSnapshot(gateway: DoneBotGateway): Promise<DoneBotPaymentSnapshot> {
  const account = gateway.state().user;
  const accountID = account?.id ?? "";
  const [config, checkout, history, balance] = await Promise.all([
    gateway.paymentRequest("config", undefined, accountID), gateway.paymentRequest("checkout-info", undefined, accountID),
    gateway.paymentRequest("orders/my?page=1&page_size=20&order_type=balance", undefined, accountID), gateway.account(),
  ]);
  if (gateway.state().user?.id !== accountID) throw new DoneBotGatewayError(409, "account_changed", "DoneBot 账号已切换，请刷新。");
  const cfg = row(config), info = row(checkout), methods = row(info.methods);
  const cents = row(balance).balance_cents;
  const balanceValue = typeof cents === "number" || typeof cents === "string" && cents.trim() ? Number(cents) / 100 : NaN;
  const result: DoneBotPaymentSnapshot = { account_id: accountID, email: account?.email ?? "", balance: Number.isFinite(balanceValue) ? balanceValue : null,
    enabled: (cfg.enabled === true || cfg.payment_enabled === true) && cfg.balance_disabled !== true && info.balance_disabled !== true,
    multiplier: amount(info.balance_recharge_multiplier, 1) || 1, bonus_mode: info.recharge_bonus_mode === "discount" ? "discount" : "bonus",
    bonus_tiers: [], notice: text(info.recharge_bonus_notice, 8000), methods: [], orders: [] };
  for (const id of ["alipay", "wxpay"] as const) {
    if (!Object.hasOwn(methods, id)) continue;
    const method = row(methods[id]);
    const minima = [cfg.min_amount, method.single_min].map(value => amount(value));
    const maxima = [cfg.max_amount, method.single_max].map(value => amount(value)).filter(value => value > 0);
    const item: DoneBotPaymentMethod = { id, name: text(method.display_name) || (id === "alipay" ? "支付宝" : "微信支付"), currency: currency(method.currency),
      available: method.available !== false, min: Math.max(...minima), max: maxima.length ? Math.min(...maxima) : 0,
      remaining: amount(method.daily_limit) > 0 && typeof method.daily_remaining === "number" && Number.isFinite(method.daily_remaining) ? amount(method.daily_remaining) : null,
      fee_rate: amount(method.fee_rate, amount(info.recharge_fee_rate)) };
    result.methods.push(item);
  }
  if (Array.isArray(info.recharge_bonus_tiers)) result.bonus_tiers = info.recharge_bonus_tiers.slice(0, 20).map(row)
    .filter(tier => typeof tier.min_amount === "number" && Number.isFinite(tier.min_amount) && typeof tier.bonus_percent === "number" && Number.isFinite(tier.bonus_percent) && tier.min_amount >= 0 && tier.bonus_percent >= 0 && tier.bonus_percent <= 1000)
    .map(tier => ({ min_amount: Number(tier.min_amount), bonus_percent: Number(tier.bonus_percent) }));
  const items = row(history).items;
  if (!Array.isArray(items)) return invalid();
  result.orders = items.filter(item => row(item).order_type === "balance").map(paymentOrder);
  return result;
}

export async function createPaymentOrder(gateway: DoneBotGateway, input: DoneBotPaymentInput): Promise<DoneBotPaymentOrder> {
  if (creating.has(gateway)) throw new DoneBotGatewayError(409, "payment_pending", "充值订单正在创建，请稍后刷新订单。");
  creating.add(gateway);
  try { return await createOrder(gateway, input); }
  finally { creating.delete(gateway); }
}

async function createOrder(gateway: DoneBotGateway, input: DoneBotPaymentInput): Promise<DoneBotPaymentOrder> {
  if (!input.account_id || !["alipay", "wxpay"].includes(input.payment_type) || !Number.isFinite(input.amount) || input.amount <= 0 ||
    Math.abs(Math.round(input.amount * 100) / 100 - input.amount) > 1e-9) throw new DoneBotGatewayError(400, "payment_input", "请输入有效的充值金额和支付方式。");
  const snapshot = await paymentSnapshot(gateway);
  if (snapshot.account_id !== input.account_id) throw new DoneBotGatewayError(409, "account_changed", "DoneBot 账号已切换，请重新确认充值账号。");
  if (snapshot.orders.some(order => doneBotPaymentPending(order.status))) throw new DoneBotGatewayError(409, "payment_pending", "请先查询或取消已有的待支付订单。");
  const method = snapshot.methods.find(method => method.id === input.payment_type);
  if (!snapshot.enabled || !method?.available) throw new DoneBotGatewayError(409, "payment_disabled", "该支付方式暂不可用，请刷新。");
  if (input.amount < method.min || method.max > 0 && input.amount > method.max) throw new DoneBotGatewayError(400, "payment_amount", "充值金额不在当前支付方式允许的范围内。");
  if (method.remaining !== null && doneBotPaymentQuote(snapshot, input.amount, method.fee_rate).payable > method.remaining) throw new DoneBotGatewayError(400, "payment_limit", "充值金额超过该支付方式的今日剩余额度。");
  const result = row(await gateway.paymentRequest("orders", { amount: input.amount, payment_type: input.payment_type, order_type: "balance", is_mobile: false,
    payment_source: "donebot_desktop", return_url: "https://donebot.cn/payment/result" }, input.account_id));
  const order = paymentOrder({ ...result, id: result.order_id, status: result.status ?? "PENDING", created_at: new Date().toISOString() });
  const candidate = result.qr_code || result.pay_url;
  const qr = typeof candidate === "string" && Buffer.byteLength(candidate, "utf8") <= 2900 ? candidate : "";
  return { ...order, ...(qr ? { qr_code: qr } : {}) };
}
