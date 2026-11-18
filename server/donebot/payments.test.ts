import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { DoneBotGateway, type DoneBotCredentialStore } from "./gateway.ts";
import { createPaymentOrder, paymentSnapshot } from "./payments.ts";
import { startFakeDoneBotGateway, type FakeDoneBotGateway } from "../testing/fake-donebot-gateway.ts";
import { doneBotPaymentQuote } from "../../shared/donebot-payments.ts";

let master: FakeDoneBotGateway | undefined;
afterEach(async () => { await master?.close(); master = undefined; });
async function fixture(installation = false) {
  master = await startFakeDoneBotGateway();
  const store: DoneBotCredentialStore = { persistent: false, load: async () => installation ? {
    mode: "installation", accessToken: "", credential: "synthetic-installation", expiresAt: Number.MAX_SAFE_INTEGER,
    installationId: randomUUID(), user: { id: "fixture-user", email: "fixture@example.invalid" },
  } : null, save: async () => {} };
  const gateway = new DoneBotGateway(store, { testOrigin: master.origin });
  if (installation) await gateway.restore(); else await gateway.login("fixture@example.invalid", "synthetic-password");
  master.requests.length = 0;
  return { gateway, master };
}
const input = { account_id: "fixture-user", amount: 100, payment_type: "alipay" as const };

it("reuses authenticated gateway recharge endpoints and returns only the checkout fields", async () => {
  const { gateway, master } = await fixture();
  expect(await paymentSnapshot(gateway)).toMatchObject({ account_id: "fixture-user", enabled: true, balance: 0,
    methods: [{ id: "alipay", available: true, remaining: null }, { id: "wxpay", available: true, remaining: null }] });
  const order = await createPaymentOrder(gateway, input);
  expect(order).toMatchObject({ id: 1, amount: 110, pay_amount: 100, status: "PENDING", qr_code: "https://payment.example.invalid/synthetic-1" });
  expect(JSON.stringify(order)).not.toContain("private-fixture-provider-secret");
  expect(master.requests.find(request => request.path === "/api/v1/payment/orders")?.body).toEqual({ amount: 100, payment_type: "alipay", order_type: "balance",
    is_mobile: false, payment_source: "donebot_desktop", return_url: "https://donebot.cn/payment/result" });
});
it("serializes creation before reading history and blocks an unresolved payment", async () => {
  const { gateway, master } = await fixture();
  const results = await Promise.allSettled([createPaymentOrder(gateway, input), createPaymentOrder(gateway, input)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(master.payments.orders).toHaveLength(1);
  await expect(createPaymentOrder(gateway, input)).rejects.toMatchObject({ code: "payment_pending" });
  master.payments.orders[0]!.status = "CANCELLED";
  await expect(createPaymentOrder(gateway, { ...input, payment_type: "wxpay" })).resolves.toMatchObject({ id: 2 });
});
it("rejects installation credentials, stale accounts, unsupported operations and invalid amounts before creating an order", async () => {
  const { gateway, master } = await fixture();
  for (const patch of [{ account_id: "other" }, { amount: 0 }, { amount: 0.01 }, { amount: 1001 }, { amount: NaN }, { amount: 1.001 }, { payment_type: "stripe" }]) {
    await expect(createPaymentOrder(gateway, { ...input, ...patch } as typeof input)).rejects.toBeTruthy();
  }
  await expect(gateway.paymentRequest("https://other.invalid", {}, input.account_id)).rejects.toMatchObject({ code: "payment_path" });
  expect(master.payments.orders).toHaveLength(0);
  await master.close();
  const installed = await fixture(true);
  await expect(paymentSnapshot(installed.gateway)).rejects.toMatchObject({ code: "payment_login_required" });
  expect(installed.master.payments.orders).toHaveLength(0);
});
it("never retries an uncertain create and recovers the order from the account history", async () => {
  const { gateway, master } = await fixture();
  master.payments.dropNextReply = true;
  await expect(createPaymentOrder(gateway, input)).rejects.toBeTruthy();
  expect(master.payments.orders).toHaveLength(1);
  expect((await paymentSnapshot(gateway)).orders).toMatchObject([{ id: 1, status: "PENDING" }]);
  expect(master.requests.filter(request => request.path === "/api/v1/payment/orders")).toHaveLength(1);
});
it("keeps disabled purchases closed and computes configured bonus, discount and fee previews", async () => {
  const { gateway, master } = await fixture();
  master.payments.enabled = false;
  await expect(createPaymentOrder(gateway, input)).rejects.toMatchObject({ code: "payment_disabled" });
  const snapshot = await paymentSnapshot(gateway);
  expect(doneBotPaymentQuote(snapshot, 100, 2)).toEqual({ credited: 110, payable: 102 });
  expect(doneBotPaymentQuote({ ...snapshot, bonus_mode: "discount" }, 100, 2)).toEqual({ credited: 100, payable: 91.8 });
  expect(master.payments.orders).toHaveLength(0);
});
