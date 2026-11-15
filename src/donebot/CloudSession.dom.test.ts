// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DoneBotCloudSessionEnded } from "./CloudSession";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); delete window.ogb; vi.unstubAllGlobals(); });

it("returns to local immediately while automatic Cloud reconnect is still pending", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const returnLocal = vi.fn(async () => {}), reconnectCloud = vi.fn(() => new Promise<never>(() => {}));
  Object.assign(window, { ogb: { workspaces: { returnLocal, reconnectCloud } } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  cleanup = async () => { await act(async () => root.unmount()); host.remove(); };
  await act(async () => root.render(createElement(DoneBotCloudSessionEnded)));
  const button = [...host.querySelectorAll("button")].find(entry => entry.textContent === "返回本地对话");
  expect(button?.disabled).toBe(false);
  await act(async () => button!.click());
  expect(returnLocal).toHaveBeenCalledOnce(); expect(reconnectCloud).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain("返回 Cloud 控制台");
});
