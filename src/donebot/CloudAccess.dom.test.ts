// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DoneBotCloudSnapshot } from "../../shared/donebot-cloud";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/api", () => ({ api: fixture.api }));
const { DoneBotCloudAccess } = await import("./CloudAccess");
let host: HTMLDivElement, root: Root, snapshot: DoneBotCloudSnapshot;
let add: ReturnType<typeof vi.fn>, external: ReturnType<typeof vi.fn>;
const click = async (text: string) => {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text);
  expect(button, text).toBeTruthy(); expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
};
const posts = () => fixture.api.mock.calls.filter(([, init]) => init?.method === "POST");
const mount = async () => { await act(async () => root.render(createElement(DoneBotCloudAccess))); };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  snapshot = { account_id: "fixture-user", email: "fixture@example.invalid", balance_cents: 5000,
    plan: { enabled: true, monthly_price: "12.500000", retention_days: 7 }, instance: null, operations: [], connection_available: true };
  fixture.api.mockReset().mockImplementation(async () => structuredClone(snapshot));
  add = vi.fn(async () => ({ outcome: "connected" })); external = vi.fn();
  Object.assign(window, { ogb: { workspaces: { add }, openExternal: external } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete window.ogb; vi.unstubAllGlobals(); });

it("shows the same account's plan and balance and never charges before explicit confirmation", async () => {
  await mount();
  expect(host.textContent).toContain("fixture@example.invalid");
  expect(host.querySelector("[data-cloud-balance]")?.textContent).toBe("50");
  await click("购买 Cloud 云主机"); expect(posts()).toHaveLength(0);
  await click("返回"); expect(posts()).toHaveLength(0); expect(external).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="Cloud 操作确认"]')).toBeNull();
});
it("retries an uncertain submission with the same key and blocks a double click", async () => {
  let resolve!: (value: unknown) => void;
  const delayed = new Promise(resolvePromise => { resolve = resolvePromise; });
  fixture.api.mockImplementation(async (_path, init) => {
    if (init?.method === "POST") {
      if (posts().length === 1) throw new Error("Synthetic connection lost");
      return delayed;
    }
    return structuredClone(snapshot);
  });
  await mount(); await click("购买 Cloud 云主机"); await click("确认"); await click("重试确认");
  const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons.find(button => button.textContent === "正在处理…")?.disabled).toBe(true);
  await act(async () => buttons.find(button => button.textContent === "正在处理…")!.click());
  expect(posts()).toHaveLength(2);
  expect(JSON.parse(posts()[0]![1].body)).toEqual(JSON.parse(posts()[1]![1].body));
  await act(async () => resolve({ operation: { state: "succeeded" } }));
  expect(host.querySelector('[aria-label="Cloud 操作确认"]')).toBeNull();
});
it.each(["billing_insufficient_balance", "capacity_unavailable"])("shows a definitive %s failure and allows a newly confirmed retry", async failure => {
  fixture.api.mockImplementation(async (_path, init) => {
    if (init?.method === "POST") {
      snapshot.instance = { id: "fixture-id", desired: "stopped", actual: "error", error: failure, subscription_state: "unpaid", paid_until: null, purge_locked: false };
      snapshot.operations = [{ id: "fixture-operation", action: "start", state: "failed", error: failure }];
      return { instance: snapshot.instance, operation: snapshot.operations[0] };
    }
    return structuredClone(snapshot);
  });
  await mount(); await click("购买 Cloud 云主机"); await click("确认");
  expect(host.textContent).toContain("Cloud 未开通且未扣款");
  await click("重试开通"); await click("确认");
  expect(JSON.parse(posts()[0]![1].body).key).not.toBe(JSON.parse(posts()[1]![1].body).key);
  expect(external).not.toHaveBeenCalled();
});
it("does not allow a disabled plan to be purchased", async () => {
  snapshot.plan.enabled = false; await mount();
  expect([...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "购买 Cloud 云主机")?.disabled).toBe(true);
  expect(posts()).toHaveLength(0);
});
it.each(["account", "price"])("discards a confirmation after the %s changes", async changed => {
  await mount(); await click("购买 Cloud 云主机");
  if (changed === "account") snapshot.account_id = "other-fixture-user";
  else snapshot.plan.monthly_price = "25.000000";
  await click("刷新 Cloud");
  expect(host.querySelector('[aria-label="Cloud 操作确认"]')).toBeNull(); expect(posts()).toHaveLength(0);
});
function running() {
  snapshot.instance = { id: "fixture-id", desired: "running", actual: "running", error: "", auto_renew: true, subscription_state: "active", paid_until: new Date(Date.now() + 86400000).toISOString(), purge_locked: false };
}
it("connects through the existing desktop pairing bridge without opening a website", async () => {
  running();
  fixture.api.mockImplementation(async (path) => path.endsWith("/connect") ? { url: "donebot://pair?synthetic-fixture" } : structuredClone(snapshot));
  await mount(); await click("连接 Cloud");
  expect(add).toHaveBeenCalledExactlyOnceWith("link", "donebot://pair?synthetic-fixture");
  expect(external).not.toHaveBeenCalled(); expect(host.textContent).toContain("已连接 Cloud");
});
it("uses the owned Cloud bridge without generating a second launch or snapshot", async () => {
  running();
  const openCloud = vi.fn(async () => ({ outcome: "connected" as const }));
  window.ogb!.workspaces!.openCloud = openCloud;
  await mount(); await click("连接 Cloud");
  expect(openCloud).toHaveBeenCalledExactlyOnceWith("fixture-id", "fixture-user");
  expect(add).not.toHaveBeenCalled(); expect(posts()).toHaveLength(0);
  expect(host.textContent).toContain("已连接 Cloud");
});
it("refuses to pair when the account switches during the connection request", async () => {
  running();
  fixture.api.mockImplementation(async path => {
    if (path.endsWith("/connect")) { snapshot.account_id = "other-fixture-user"; return { url: "donebot://pair?synthetic-fixture" }; }
    return structuredClone(snapshot);
  });
  await mount(); await click("连接 Cloud");
  expect(add).not.toHaveBeenCalled(); expect(host.textContent).toContain("连接 Cloud 未完成");
});
it("cancels renewal via switch without offering an immediate stop and keeps the Cloud connected", async () => {
  running(); await mount();
  expect(host.textContent).not.toContain("停机并保留数据");
  const renewSwitch = host.querySelector<HTMLButtonElement>('[data-cloud-auto-renew-switch]')!;
  expect(renewSwitch?.getAttribute("role")).toBe("switch");
  expect(renewSwitch.getAttribute("aria-checked")).toBe("true");
  await act(async () => renewSwitch.click());
  expect(host.querySelector('[aria-label="Cloud 操作确认"]')?.textContent).toContain("Cloud 继续运行至");
  expect(posts()).toHaveLength(0);
  fixture.api.mockImplementation(async (_path, init) => {
    if (init?.method === "POST") { snapshot.instance!.auto_renew = false; return { operation: { state: "succeeded" } }; }
    return structuredClone(snapshot);
  });
  await click("确认");
  expect(JSON.parse(posts()[0]![1].body)).toMatchObject({ id: "fixture-id", action: "cancel" });
  expect(host.textContent).toContain("连接 Cloud");
  expect(host.querySelector('[data-cloud-auto-renew-switch]')?.getAttribute("aria-checked")).toBe("false");
});
it("enables renewal via switch during a paid period without buying a new period", async () => {
  running(); snapshot.instance!.auto_renew = false; await mount();
  const renewSwitch = host.querySelector<HTMLButtonElement>('[data-cloud-auto-renew-switch]')!;
  expect(renewSwitch.getAttribute("aria-checked")).toBe("false");
  await act(async () => renewSwitch.click());
  expect(host.querySelector('[aria-label="Cloud 操作确认"]')?.textContent).toContain("本次不扣款，不改变当前到期时间");
  fixture.api.mockImplementation(async (_path, init) => init?.method === "POST" ? { operation: { state: "succeeded" } } : structuredClone(snapshot));
  await click("确认"); expect(JSON.parse(posts()[0]![1].body)).toMatchObject({ id: "fixture-id", action: "keep" });
});
it("clears historical insufficient-balance operation errors once the instance is running", async () => {
  running();
  snapshot.operations = [
    { id: "op-old-fail", action: "start", state: "failed", error: "billing_insufficient_balance" },
    { id: "op-latest-ok", action: "start", state: "succeeded", error: "" },
  ];
  await mount();
  expect(host.textContent).toContain("运行中");
  expect(host.textContent).not.toContain("账户余额不足");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it("offers a purchase after expiry even when the runtime has not stopped yet", async () => {
  running(); snapshot.instance!.auto_renew = false; snapshot.instance!.paid_until = new Date(Date.now() - 1000).toISOString(); await mount();
  const labels = [...host.querySelectorAll("button")].map(button => button.textContent);
  expect(labels).toContain("购买 Cloud 云主机"); expect(labels).not.toContain("连接 Cloud");
  expect(host.querySelector('[data-cloud-auto-renew-switch]')).toBeNull();
  await click("购买 Cloud 云主机"); expect(host.querySelector('[aria-label="Cloud 操作确认"]')?.textContent).toContain("确认后从当前 DoneBot 账号余额扣款");
});
it("does not apply an old read after the account view was replaced", async () => {
  let release!: (value: unknown) => void;
  fixture.api.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await mount(); await act(async () => root.render(createElement(DoneBotCloudAccess, { key: "new-account" })));
  await act(async () => release({ ...snapshot, account_id: "old-user", email: "old@example.invalid" }));
  expect(host.textContent).toContain("fixture@example.invalid"); expect(host.textContent).not.toContain("old@example.invalid");
});
