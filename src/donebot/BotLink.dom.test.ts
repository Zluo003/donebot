// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DoneBotBotLink } from "./BotLink";

let host: HTMLDivElement, root: Root;
let state: ReturnType<typeof vi.fn>, set: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state = vi.fn(async () => ({ enabled: false, connected: false, available: true, error: "" }));
  set = vi.fn(async (enabled: boolean) => ({ enabled, connected: enabled, available: true, error: "" }));
  Object.assign(window, { ogb: { workspaces: { botLink: { state, set } } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete window.ogb; vi.unstubAllGlobals(); });
const mount = async (ready = true, accountId = "account-1") => { await act(async () => root.render(createElement(DoneBotBotLink, { accountId, instanceId: "cloud-1", ready }))); };
const toggle = () => host.querySelector<HTMLButtonElement>('[role="switch"]')!;

it("requires a click and sends only the current account and instance, with a usable offline status", async () => {
  await mount();
  expect(set).not.toHaveBeenCalled();
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(host.textContent).toContain("个人历史、记忆和目录不会自动同步");
  await act(async () => toggle().click());
  expect(set).toHaveBeenCalledExactlyOnceWith(true, "account-1", "cloud-1");
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  expect(host.textContent).toContain("协作已连接");
  set.mockResolvedValueOnce({ enabled: true, connected: false, available: true, error: "Cloud 版本尚不支持协作，请升级云端。" });
  await act(async () => toggle().click());
  expect(host.textContent).toContain("等待连接");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("请升级云端");
});

it("can close a saved collaboration while Cloud is stopped, but cannot enable it", async () => {
  await mount(false);
  expect(toggle().disabled).toBe(true);
  state.mockResolvedValue({ enabled: true, connected: false, available: true, error: "" });
  await mount(false, "account-2");
  expect(toggle().disabled).toBe(false);
  await act(async () => toggle().click());
  expect(set).toHaveBeenCalledWith(false, "account-2", "cloud-1");
});

it("blocks repeated clicks and ignores an old account's late result", async () => {
  await mount();
  let release!: (value: unknown) => void;
  set.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await act(async () => { toggle().click(); toggle().click(); });
  expect(set).toHaveBeenCalledTimes(1);
  await mount(true, "account-2");
  await act(async () => release({ enabled: true, connected: true, available: true, error: "" }));
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(host.textContent).not.toContain("协作已连接");
});

it("does not offer a native setting to browser-only clients", async () => {
  delete window.ogb;
  await mount();
  expect(host.textContent).toBe("");
});

it("refreshes collaboration state when Cloud becomes ready and reflects default-on status", async () => {
  await mount(false);
  expect(host.textContent).toContain("开通个人 Cloud 后默认开启");
  expect(host.textContent).toContain("个人 Cloud 启动运行后将自动开启协作");
  state.mockResolvedValueOnce({ enabled: true, connected: true, available: true, error: "" });
  await mount(true);
  expect(state).toHaveBeenCalledTimes(2);
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  expect(host.textContent).toContain("协作已连接");
});
