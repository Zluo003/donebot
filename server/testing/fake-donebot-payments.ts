import type { ServerResponse } from "node:http";
import type { FakeDoneBotCloud } from "./fake-donebot-cloud.ts";

export class FakeDoneBotPayments {
  readonly orders: Array<Record<string, unknown>> = [];
  enabled = true;
  dropNextReply = false;
  paid = new Set<number>();
  private readonly cloud: FakeDoneBotCloud;
  constructor(cloud: FakeDoneBotCloud) { this.cloud = cloud; }

  handle(path: string, method: string, body: Record<string, unknown>, response: ServerResponse, loggedIn: boolean): boolean {
    if (!path.startsWith("/api/v1/payment/")) return false;
    const send = (data: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify({ code: status === 200 ? 0 : status, data })); return true; };
    if (!loggedIn) return send({}, 401);
    if (path.endsWith("/config")) return send({ enabled: this.enabled, min_amount: 1, max_amount: 1000, balance_disabled: false });
    if (path.endsWith("/checkout-info")) return send({ balance_recharge_multiplier: 1, recharge_fee_rate: 0, recharge_bonus_mode: "bonus",
      recharge_bonus_tiers: [{ min_amount: 100, bonus_percent: 10 }], methods: Object.fromEntries(["alipay", "wxpay"].map(id => [id,
        { currency: "CNY", single_min: 1, single_max: 1000, daily_limit: 5000, fee_rate: 0 }])) });
    if (path.endsWith("/orders/my")) return send({ items: this.orders.toReversed(), total: this.orders.length });
    if (path.endsWith("/orders") && method === "POST") {
      const id = this.orders.length + 1, amount = Number(body.amount);
      const order = { id, amount: amount >= 100 ? Math.round(amount * 110) / 100 : amount, pay_amount: amount, currency: "CNY", fee_rate: 0, payment_type: body.payment_type,
        out_trade_no: `synthetic-order-${id}`, status: "PENDING", order_type: "balance", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 900000).toISOString() };
      this.orders.push(order);
      if (this.dropNextReply) { this.dropNextReply = false; response.destroy(); return true; }
      return send({ ...order, order_id: id, qr_code: `https://payment.example.invalid/synthetic-${id}`, client_secret: "private-fixture-provider-secret" });
    }
    const match = path.match(/\/orders\/(\d+)(?:\/(cancel))?$/);
    const order = match ? this.orders.find(order => order.id === Number(match[1])) : path.endsWith("/orders/verify") ? this.orders.find(order => order.out_trade_no === body.out_trade_no) : null;
    if (!order) return send({}, 404);
    if (this.paid.has(Number(order.id)) && order.status !== "COMPLETED") { order.status = "COMPLETED"; this.cloud.balanceCents += Number(order.amount) * 100; }
    if (match?.[2] && order.status === "PENDING") order.status = "CANCELLED";
    return send(order);
  }
}
