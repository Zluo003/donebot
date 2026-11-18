import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { startFakeDoneBotGateway } from "./testing/fake-donebot-gateway.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import type { DoneBotPaymentOrder, DoneBotPaymentSnapshot } from "../shared/donebot-payments.ts";

it("buys credits in an isolated service, verifies completion and refreshes the same account balance", async () => {
  const master = await startFakeDoneBotGateway();
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, master.origin);
  const request = async <T = unknown>(path: string, body?: unknown, status = 200): Promise<T> => {
    const response = await fetch(fixture.info.url + "/api/donebot/" + path, { method: body === undefined ? "GET" : "POST",
      headers: { origin: fixture.info.url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store"); return result as T;
  };
  try {
    await request("payments", undefined, 401);
    await request("login", { email: "fixture@example.invalid", password: "synthetic-password" });
    const snapshot = await request<DoneBotPaymentSnapshot>("payments");
    expect(snapshot).toMatchObject({ account_id: "fixture-user", enabled: true, balance: 0 });
    const input = { account_id: snapshot.account_id, amount: 100, payment_type: "alipay" };
    const first = await request<DoneBotPaymentOrder>("payments/orders", input, 201);
    expect(first).toMatchObject({ status: "PENDING", pay_amount: 100, amount: 110 });
    const account = { account_id: snapshot.account_id };
    await request(`payments/orders/${first.id}/status`, account);
    master.payments.paid.add(first.id);
    const paid = await request<DoneBotPaymentOrder>(`payments/orders/${first.id}/verify`, account);
    expect(paid.status).toBe("COMPLETED");
    expect((await request<DoneBotPaymentSnapshot>("payments")).balance).toBe(110);
    await request(`payments/orders/${first.id}/verify`, account);
    expect(master.cloud.balanceCents).toBe(11000);
    const second = await request<DoneBotPaymentOrder>("payments/orders", { ...input, payment_type: "wxpay", amount: 50 }, 201);
    expect((await request<DoneBotPaymentOrder>(`payments/orders/${second.id}/cancel`, account)).status).toBe("CANCELLED");
    await request("payments/orders", { ...input, account_id: "other-user" }, 409);
    await request("payments/orders", { ...input, payment_type: "stripe" }, 400);
    await request("payments/orders", { ...input, user_id: "other-user" }, 400);
    const count = master.payments.orders.length;
    master.payments.dropNextReply = true;
    await request("payments/orders", input, 502);
    expect(master.payments.orders).toHaveLength(count + 1);
    expect((await request<DoneBotPaymentSnapshot>("payments")).orders[0]?.status).toBe("PENDING");
    expect(master.payments.orders).toHaveLength(count + 1);
    const output = JSON.stringify({ snapshot, first, paid }) + await readFile(fixture.info.logPath, "utf8");
    expect(output).not.toMatch(/fixture-access-token|fixture-refresh-token|fixture-installation-key|synthetic-password|private-fixture-provider-secret/);
    await request("logout", {});
    await request("payments", undefined, 401);
  } finally { await fixture.close(); await master.close(); }
}, hostTimeout(90_000));
