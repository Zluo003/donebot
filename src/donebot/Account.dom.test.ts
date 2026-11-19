// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/api", () => ({ api: fixture.api }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: { donebot: { enabled: true, persistent: true, user: { id: "fixture-user", email: "fixture@example.invalid" } } } } }) }));
vi.mock("./CloudAccess", () => ({ DoneBotCloudAccess: () => "Fixture Cloud access" }));
vi.mock("./MediaSettings", () => ({ DoneBotMediaSettingsPanel: () => "Fixture media preferences" }));
const { DoneBotAccountSettings } = await import("./Account");
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.api.mockReset().mockResolvedValue({ balance_cents: 1234, concurrency: 30 });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("keeps account, Cloud and media preferences without the old available-model list", async () => {
  await act(async () => root.render(createElement(DoneBotAccountSettings)));
  expect(host.textContent).toContain("12.34");
  expect(host.textContent).toContain("账号总并发：30");
  expect(host.textContent).toContain("Fixture Cloud access");
  expect(host.textContent).toContain("Fixture media preferences");
  expect(host.textContent).not.toContain("可用模型");
  expect(host.textContent).not.toContain("刷新模型");
  expect(fixture.api.mock.calls).toEqual([["/api/donebot/account"]]);
});
it("retains account error feedback after the model list is removed", async () => {
  fixture.api.mockRejectedValue(new Error("隔离测试：账号同步失败"));
  await act(async () => root.render(createElement(DoneBotAccountSettings)));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("账号同步失败");
  expect(host.textContent).not.toContain("可用模型");
});
