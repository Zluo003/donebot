// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DoneBotBrowserProxyConfig, DoneBotBrowserProxyState } from "../../shared/donebot";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/api", () => ({ api: fixture.api }));

const { BrowserProxySettings } = await import("./BrowserProxySettings");

let host: HTMLDivElement;
let root: Root;
let currentState: DoneBotBrowserProxyState;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  currentState = {
    mode: "system",
    url: "",
    bypass: "",
    detectedSystemProxy: "socks5://127.0.0.1:10808",
  };
  fixture.api.mockReset().mockImplementation(async (_path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "PUT" && init.body) {
      const next = JSON.parse(init.body) as DoneBotBrowserProxyConfig;
      currentState = { ...currentState, ...next };
    }
    return { ...currentState };
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const mount = async () => {
  await act(async () => root.render(createElement(BrowserProxySettings, { simple: true })));
  await act(async () => { await Promise.resolve(); });
};

const setInput = async (label: string, value: string) => {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const setMode = async (mode: string) => {
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Bot 浏览器代理模式"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(select, mode);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => { await Promise.resolve(); });
};

it("shows detected system proxy, validates and saves manual proxy, and toggles direct mode", async () => {
  await mount();
  expect(host.textContent).toContain("已检测到系统代理：socks5://127.0.0.1:10808");

  // Switch to manual mode (does not PUT until user clicks 保存)
  await setMode("manual");
  expect(fixture.api).toHaveBeenCalledTimes(1);

  await setInput("代理地址", "invalid-url");
  const saveBtn = () => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent?.trim() === "保存")!;
  await act(async () => saveBtn().click());
  expect(fixture.api).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("代理地址格式无效");

  await setInput("代理地址", "socks5://127.0.0.1:10808");
  await setInput("免代理域名", "localhost, *.cn");
  await act(async () => saveBtn().click());
  await act(async () => { await Promise.resolve(); });
  expect(fixture.api).toHaveBeenLastCalledWith("/api/donebot/browser-proxy", {
    method: "PUT",
    body: JSON.stringify({ mode: "manual", url: "socks5://127.0.0.1:10808", bypass: "localhost, *.cn" }),
  });
  expect(host.textContent).toContain("已保存手动代理（socks5://127.0.0.1:10808）");

  // Switch to direct mode saves immediately
  await setMode("direct");
  expect(fixture.api).toHaveBeenLastCalledWith("/api/donebot/browser-proxy", {
    method: "PUT",
    body: JSON.stringify({ mode: "direct", url: "socks5://127.0.0.1:10808", bypass: "localhost, *.cn" }),
  });
  expect(host.textContent).toContain("已切换为直连模式");
});

it("hides cleanly on cloud or non-admin runtimes when route is unavailable", async () => {
  fixture.api.mockRejectedValueOnce(new Error("Not Found"));
  await mount();
  expect(host.innerHTML).toBe("");
});
