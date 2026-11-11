// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ dictation: true }));
vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: {
        ...actual.initialState,
        config: {
          tts: { configured: true, ready: true, voice: "v" },
          live: { configured: true, voice: "marin", readTypedReplies: true, idleMinutes: 5 },
        } as AppState["config"],
      },
      dispatch: vi.fn(),
    }),
  };
});
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({
    capabilities: {
      host: { platform: "darwin" },
      dictation: { available: fixture.dictation, engine: fixture.dictation ? "apple-speech" : "none", onDevice: fixture.dictation, reasonCode: fixture.dictation ? undefined : "unsupported-platform" },
    },
    ready: true,
  }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const stored = new Map([["donebot.callMode.v1", "live"]]);
vi.stubGlobal("localStorage", {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
});
vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { headers: { "Content-Type": "application/json" } })));
const { CallButton } = await import("./CallView");
const { ComposerPlusMenu } = await import("./ComposerPlusMenu");
const { callMode, setCallMode } = await import("@/lib/call-mode");
const { currentCall, endCall } = await import("@/lib/call");
const { requestCallStart } = await import("@/lib/call-start-request");
const { configureLiveMedia, liveMedia, resetLiveMedia, startLiveCall } = await import("@/lib/live-call-media");
const { setAdvancedMode } = await import("@/lib/interface-mode");

const bot: Bot = {
  id: "atlas", threadId: "thread-atlas", name: "Atlas", title: "", description: "",
  notifications: true, color: "green", unread: false, messages: [], voice: "v",
  modelSelection: { instanceId: "fixture", model: "test" },
};
let root: Root;
let container: HTMLDivElement;
const getUserMedia = vi.fn();
const request = vi.fn();
const render = (advanced: boolean, plus = false) => flushSync(() => {
  setAdvancedMode(advanced);
  root.render(createElement("div", null,
    createElement(CallButton, { bot, placement: "composer", fill: advanced ? undefined : "#8057C8" }),
    plus ? createElement(ComposerPlusMenu, { onAttach: vi.fn(), callBotId: bot.id }) : null,
  ));
});
const pressCall = () => flushSync(() => container.querySelector<HTMLButtonElement>("[data-call-button]")!.click());

beforeEach(() => {
  fixture.dictation = true;
  window.ogb = { speechStart: vi.fn(), speechStop: vi.fn(async () => {}) } as unknown as NonNullable<Window["ogb"]>;
  getUserMedia.mockClear();
  request.mockClear();
  configureLiveMedia({ getUserMedia, request });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  resetLiveMedia();
  endCall();
  delete window.ogb;
});
afterAll(() => vi.unstubAllGlobals());

describe("DoneBot calls with realtime disabled", () => {
  it.each([false, true])("takes turns with a saved Live preference, advanced=%s", (advanced) => {
    expect(callMode()).toBe("turns");
    setCallMode("live");
    render(advanced);
    expect(container.querySelector('[aria-label="Call mode"]')).toBeNull();
    expect(container.querySelector("[data-call-button]")?.getAttribute("aria-label")).toBe("Call Atlas");
    pressCall();
    expect(currentCall()).toBe(bot.id);
    expect(liveMedia().phase).toBe("idle");
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([false, true])("shows availability help without falling back to Live, advanced=%s", (advanced) => {
    fixture.dictation = false;
    render(advanced);
    pressCall();
    expect(container.textContent).toContain("Call unavailable");
    expect(container.textContent).toContain("They listen from this computer");
    expect(container.textContent).not.toMatch(/Live|OpenAI/);
    expect(currentCall()).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("offers only taking turns in the composer's plus menu and starts that call", () => {
    render(false, true);
    flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="Add"]')!.click());
    const items = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const turns = items.find((item) => item.textContent?.includes("Take turns"));
    expect(turns).toBeDefined();
    expect(items.some((item) => item.textContent?.includes("Live"))).toBe(false);
    flushSync(() => turns!.click());
    expect(currentCall()).toBe(bot.id);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a stale Live menu action and a direct Live start before microphone or network access", async () => {
    render(true);
    flushSync(() => requestCallStart(bot.id, "live"));
    await startLiveCall({ botId: bot.id, threadId: bot.threadId });
    expect(currentCall()).toBeNull();
    expect(liveMedia().phase).toBe("idle");
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
