// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { DoneBotPaymentOrder, DoneBotPaymentSnapshot } from "../../shared/donebot-payments";

const fixture = vi.hoisted(() => ({ api: vi.fn(), account: "fixture-user" }));
vi.mock("@/state/api", () => ({ api: fixture.api }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: { donebot: { enabled: true, user: { id: fixture.account, email: "fixture@example.invalid" } } } } }) }));
const { DoneBotPayments } = await import("./Payments");
let host: HTMLDivElement, root: Root, snapshot: DoneBotPaymentSnapshot, order: DoneBotPaymentOrder;
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!;
const click = async (text: string) => { expect(button(text), text).toBeTruthy(); expect(button(text).disabled).toBe(false); await act(async () => button(text).click()); };
const mount = async () => { await act(async () => root.render(createElement(DoneBotPayments))); };
const creates = () => fixture.api.mock.calls.filter(([path]) => path === "/api/donebot/payments/orders");
beforeEach(() => {
  fixture.account = "fixture-user"; setLocale("zh");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear();
  snapshot = { account_id: "fixture-user", email: "fixture@example.invalid", balance: 20, enabled: true, multiplier: 1, bonus_mode: "bonus", bonus_tiers: [{ min_amount: 100, bonus_percent: 10 }], notice: "",
    methods: [{ id: "alipay", name: "支付宝", currency: "CNY", available: true, min: 1, max: 1000, remaining: null, fee_rate: 0 },
      { id: "wxpay", name: "微信支付", currency: "CNY", available: true, min: 1, max: 1000, remaining: null, fee_rate: 0 }], orders: [] };
  order = { id: 1, amount: 110, pay_amount: 100, currency: "CNY", payment_type: "alipay", status: "PENDING", out_trade_no: "synthetic-order", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 900000).toISOString(), qr_code: "https://payment.example.invalid/synthetic" };
  fixture.api.mockReset().mockImplementation(async path => path === "/api/donebot/payments" ? structuredClone(snapshot) : structuredClone(order));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); setLocale("en"); });

it("creates one code with the chosen method and keeps balance unchanged until the gateway credits it", async () => {
  await mount(); expect(creates()).toHaveLength(0);
  expect(host.textContent).toContain("支付宝"); expect(host.textContent).toContain("微信支付");
  await click("微信支付"); await click("生成付款码");
  expect(JSON.parse(creates()[0]![1].body)).toEqual({ account_id: "fixture-user", amount: 100, payment_type: "wxpay" });
  expect(host.querySelector('[aria-label="支付二维码"] svg')).toBeTruthy();
  expect(host.querySelector("[data-payment-balance]")?.textContent).toContain("20.00");
  expect(button("生成付款码")).toBeUndefined();
  order.status = "PAID"; snapshot.orders = [order]; await click("查询支付结果");
  expect(host.textContent).toContain("已支付，正在入账");
  expect(host.querySelector("[data-payment-balance]")?.textContent).toContain("20.00");
  order.status = "COMPLETED"; snapshot.balance = 130; await click("查询支付结果");
  expect(host.textContent).toContain("充值已到账"); expect(host.querySelector("[data-payment-balance]")?.textContent).toContain("130.00");
  expect(host.querySelector("iframe, a[href]" )).toBeNull(); expect(creates()).toHaveLength(1);
});
it("blocks double submission while the create call is in flight", async () => {
  let resolve!: (order: DoneBotPaymentOrder) => void;
  fixture.api.mockImplementation(async path => path === "/api/donebot/payments/orders" ? new Promise<DoneBotPaymentOrder>(done => { resolve = done; }) : structuredClone(snapshot));
  await mount(); const pay = button("生成付款码");
  await act(async () => { pay.click(); pay.click(); });
  expect(creates()).toHaveLength(1); expect(pay.disabled).toBe(true);
  await act(async () => resolve(order)); expect(creates()).toHaveLength(1);
});
it("recovers a possibly created order after a lost response and requires resolution before another purchase", async () => {
  fixture.api.mockImplementation(async path => {
    if (path === "/api/donebot/payments/orders") { snapshot.orders = [{ ...order, qr_code: undefined }]; throw new Error("Synthetic lost reply"); }
    return structuredClone(snapshot);
  });
  await mount(); await click("生成付款码");
  expect(button("生成付款码").disabled).toBe(true); expect(host.textContent).toContain("先刷新并核对订单");
  await click("刷新余额与订单"); expect(button("生成付款码")).toBeUndefined(); expect(host.textContent).toContain("没有可用的付款码");
  expect(creates()).toHaveLength(1);
});
it("restores a verified pending code on reopening, and removes it after cancellation", async () => {
  await mount(); await click("生成付款码"); snapshot.orders = [{ ...order, qr_code: undefined }];
  await act(async () => root.unmount()); root = createRoot(host); await mount();
  expect(host.querySelector('[aria-label="支付二维码"] svg')).toBeTruthy(); expect(creates()).toHaveLength(1);
  fixture.api.mockImplementation(async path => {
    if (path.endsWith("/cancel")) { order.status = "CANCELLED"; snapshot.orders = [order]; return structuredClone(order); }
    return structuredClone(snapshot);
  });
  await click("取消未支付订单"); expect(host.textContent).toContain("已取消"); expect(button("生成付款码").disabled).toBe(false);
  expect(sessionStorage.getItem("donebot.payment.fixture-user")).toBeNull();
});
it("shows the outstanding payment when refreshed history also contains the previously selected completed order", async () => {
  order.status = "COMPLETED"; snapshot.orders = [order];
  await mount();
  snapshot.orders = [{ ...order, id: 2, status: "PENDING", out_trade_no: "another-order" }, order];
  await click("刷新余额与订单");
  expect(button("生成付款码")).toBeUndefined();
  expect(host.textContent).toContain("another-order");
  expect(button("查询支付结果")).toBeTruthy();
});
it("automatically polls payment status and never treats local code expiry as successful payment", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  await mount(); await click("生成付款码");
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(fixture.api.mock.calls.some(([path]) => path.endsWith("/status"))).toBe(true);
  order.expires_at = new Date(Date.now() - 1).toISOString();
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(host.querySelector('[aria-label="支付二维码"]')).toBeNull(); expect(host.textContent).toContain("付款码已到期");
  expect(host.querySelector("[data-payment-balance]")?.textContent).toContain("20.00"); expect(creates()).toHaveLength(1);
});
it.each(["limits", "disabled", "unavailable"])("blocks purchase when %s do not permit it", async mode => {
  if (mode === "limits") snapshot.methods.forEach(method => { method.max = 50; });
  if (mode === "disabled") snapshot.enabled = false;
  if (mode === "unavailable") snapshot.methods.forEach(method => { method.available = false; });
  await mount(); expect(!button("生成付款码") || button("生成付款码").disabled).toBe(true); expect(creates()).toHaveLength(0);
});
it("discards a late response from an account that has been switched", async () => {
  let resolve!: (value: DoneBotPaymentSnapshot) => void;
  fixture.api.mockImplementationOnce(() => new Promise<DoneBotPaymentSnapshot>(done => { resolve = done; }));
  await mount();
  fixture.account = "other-user"; const other = { ...snapshot, account_id: "other-user", email: "other@example.invalid", balance: 7 };
  fixture.api.mockResolvedValue(other); await mount();
  await act(async () => resolve(snapshot));
  expect(host.textContent).toContain("other@example.invalid"); expect(host.textContent).not.toContain("fixture@example.invalid");
  expect(host.querySelector("[data-payment-balance]")?.textContent).toContain("7.00");
});
