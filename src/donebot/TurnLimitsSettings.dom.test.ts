// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DoneBotTurnLimits } from "../../shared/donebot";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/api", () => ({ api: fixture.api }));

const { TurnLimitsSettings } = await import("./TurnLimitsSettings");

let host: HTMLDivElement;
let root: Root;
let limits: DoneBotTurnLimits;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  limits = { maxSteps: 256, maxToolCalls: 800 };
  fixture.api.mockReset().mockImplementation(async (_path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "PUT" && init.body) {
      limits = JSON.parse(init.body) as DoneBotTurnLimits;
    }
    return { ...limits };
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

const mount = async (simple = true) => {
  await act(async () => root.render(createElement(TurnLimitsSettings, { simple })));
  await act(async () => { await Promise.resolve(); });
};

const setField = async (label: string, value: string) => {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const clickButton = async (label: string) => {
  const btn = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === label)!;
  await act(async () => btn.click());
  await act(async () => { await Promise.resolve(); });
};

it("loads defaults (256 / 800), validates bounds, saves custom limits, and resets to defaults", async () => {
  await mount(true);
  expect(host.querySelector<HTMLInputElement>('input[aria-label="单轮最大步数"]')?.value).toBe("256");
  expect(host.querySelector<HTMLInputElement>('input[aria-label="单轮最大工具调用次数"]')?.value).toBe("800");
  expect(host.textContent).toContain("正常完成的任务不会多消耗 Token");

  // Rejects tool calls < steps without calling PUT.
  await setField("单轮最大步数", "400");
  await setField("单轮最大工具调用次数", "300");
  await clickButton("保存");
  expect(fixture.api).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("最大工具调用次数不能小于最大步数");

  // Saves valid custom limits.
  await setField("单轮最大步数", "320");
  await setField("单轮最大工具调用次数", "1200");
  await clickButton("保存");
  expect(fixture.api).toHaveBeenLastCalledWith("/api/donebot/turn-limits", {
    method: "PUT",
    body: JSON.stringify({ maxSteps: 320, maxToolCalls: 1200 }),
  });
  expect(host.textContent).toContain("已保存（320 步 / 1200 次工具调用）");

  // Resets back to defaults.
  await clickButton("恢复默认");
  expect(fixture.api).toHaveBeenLastCalledWith("/api/donebot/turn-limits", {
    method: "PUT",
    body: JSON.stringify({ maxSteps: 256, maxToolCalls: 800 }),
  });
  expect(host.textContent).toContain("已恢复默认（256 步 / 800 次工具调用）");
});

it("hides cleanly when the server denies access (non-admin member)", async () => {
  fixture.api.mockRejectedValueOnce(new Error("Forbidden"));
  await mount(true);
  expect(host.innerHTML).toBe("");
});
