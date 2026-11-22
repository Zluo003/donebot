// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn(), config: {} as Record<string, unknown> }));
vi.mock("@/state/api", () => ({ api: fixture.api }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: fixture.config } }) }));
vi.mock("@/components/DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { windowChrome: "native" } }) }));
vi.mock("./MediaSettings", () => ({ DoneBotMediaSettingsPanel: () => "Fixture media preferences" }));
const { DoneBotAccountGate, DoneBotAccountSettings } = await import("./Account");
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.config = { donebot: { enabled: true, authenticated: true, persistent: true, user: { id: "fixture-user", email: "fixture@example.invalid" } } };
  fixture.api.mockReset().mockResolvedValue({ balance_cents: 1234, concurrency: 30 });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("keeps account and media preferences cleanly separated from Cloud and team pages", async () => {
  await act(async () => root.render(createElement(DoneBotAccountSettings)));
  expect(host.textContent).toContain("12.34");
  expect(host.textContent).toContain("账号总并发：30");
  expect(host.textContent).toContain("Fixture media preferences");
  expect(host.textContent).not.toContain("可用模型");
  expect(host.textContent).not.toContain("刷新模型");
  expect(fixture.api.mock.calls.map(([path]) => path)).toEqual(["/api/donebot/account"]);
});
it("retains account error feedback after the model list is removed", async () => {
  fixture.api.mockRejectedValue(new Error("隔离测试：账号同步失败"));
  await act(async () => root.render(createElement(DoneBotAccountSettings)));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("账号同步失败");
  expect(host.textContent).not.toContain("可用模型");
});
it("admits team workspaces through the account gate and avoids personal account APIs in team settings", async () => {
  fixture.config = {
    team: { id: "team-1", name: "Studio Team" },
    donebot: { enabled: true, authenticated: false, persistent: false },
    profile: { email: "owner@example.invalid" },
  };
  await act(async () => root.render(createElement(DoneBotAccountGate, null, createElement("p", null, "Team workspace ready"))));
  expect(host.textContent).toContain("Team workspace ready");
  expect(host.querySelector("[data-donebot-sign-in]")).toBeNull();

  await act(async () => root.render(createElement(DoneBotAccountSettings)));
  expect(host.textContent).toContain("Studio Team");
  expect(host.textContent).toContain("owner@example.invalid");
  expect(fixture.api).not.toHaveBeenCalled();
});
