// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({
  api: vi.fn(async () => ({
    models: [
      {
        id: "gpt-4o-mini-tts",
        interfaces: ["openai.audio.speech"],
        media_parameters: { voices: ["alloy", "nova", "onyx"] },
      },
    ],
  })),
  persistBotUpdate: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
  useStore: () => ({
    dispatch: vi.fn(),
    state: {
      bots: [
        {
          id: "chief-1",
          name: "多宝",
          voice: "nova",
          chiefOfStaff: true,
          section: "",
          soul: '<!-- donebot-chief-preferences -->\nAddress the user as "老板".\n<!-- /donebot-chief-preferences -->',
        },
      ],
      config: { profile: { name: "路人" }, tts: { model: "gpt-4o-mini-tts" } },
    },
  }),
}));

import { DesktopPetSettings } from "./DesktopPetSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | null = null;
let state: DesktopPetState;
const listeners = new Set<(s: DesktopPetState) => void>();

const bridge = {
  state: vi.fn(async () => state),
  set: vi.fn(async (patch: Partial<DesktopPetConfig>) => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn(state);
    return state;
  }),
  onState: vi.fn((cb: (s: DesktopPetState) => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }),
};

beforeEach(() => {
  state = {
    available: true,
    visible: false,
    temporarilyHidden: false,
    popoverMode: null,
    enabled: false,
    replyMode: "tts",
    voiceMode: false,
    wakeWord: "",
    autoAnnounceReports: true,
    hideInFullscreen: true,
    muted: false,
    position: null,
  };
  listeners.clear();
  bridge.state.mockClear();
  bridge.set.mockClear();
  bridge.onState.mockClear();
  (window as { ogb?: unknown }).ogb = { desktopPet: bridge };
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  delete (window as { ogb?: unknown }).ogb;
});

async function mount(simple = false) {
  root = createRoot(host);
  await act(async () => root!.render(createElement(DesktopPetSettings, { simple })));
  await act(async () => { await Promise.resolve(); });
}

describe("DesktopPetSettings", () => {
  it("renders dynamic wake word and user title when enabled, without pet avatar/color pickers", async () => {
    await mount();
    expect(host.textContent).toContain("桌面宠物（macOS）");
    expect(host.textContent).toContain("外观自动同步主协调助手");
    expect(host.textContent).not.toContain("桌宠默认回复方式");

    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="启用桌面宠物"]');
    expect(toggle).not.toBeNull();
    await act(async () => toggle!.click());
    await act(async () => { await Promise.resolve(); });

    expect(bridge.set).toHaveBeenCalledWith({ enabled: true });
    expect(host.textContent).toContain("桌宠默认回复方式");
    expect(host.textContent).toContain("语音唤醒（喊「你好多宝」）");
    expect(host.textContent).toContain("老板，我在。");
    expect(host.textContent).toContain("老板，我在忙呢，你有什么事啊？");
    expect(host.textContent).toContain("待审批汇报语音提醒");
    expect(host.textContent).toContain("全屏应用时自动隐藏");

    const select = host.querySelector<HTMLSelectElement>('select[aria-label="桌宠默认回复方式"]');
    expect(select?.value).toBe("tts");
    await act(async () => {
      select!.value = "text";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(bridge.set).toHaveBeenCalledWith({ replyMode: "text" });
  });

  it("hides completely when desktop pet is unavailable (non-macOS)", async () => {
    state = { ...state, available: false };
    await mount();
    expect(host.innerHTML).toBe("");
  });

  it("displays Qwen-Audio-3.1 Chinese voice labels and handles legacy voice fallback gracefully", async () => {
    const storeMod = await import("@/state/store");
    vi.mocked(storeMod.api).mockResolvedValueOnce({
      tts: {
        available: true,
        model: "qwen-audio-3.1-tts-flash",
        defaultVoice: "longanhuan_v3.1",
        models: [
          {
            id: "qwen-audio-3.1-tts-flash",
            displayName: "Qwen Audio 3.1 TTS Flash",
            defaultVoice: "longanhuan_v3.1",
            voices: [
              { id: "longanhuan_v3.1", name: "龙安欢", label: "龙安欢", gender: "female", description: "欢脱元气、开朗活泼", recommended: true },
              { id: "xunanchuan_v3.1", name: "许南川", label: "许南川", gender: "male", description: "磁性真诚、沉稳叙事感" },
            ],
          },
        ],
      },
      asr: { available: true, model: "qwen-audio-3.1-asr-flash-streaming", wsPath: "/api/voice/asr", sampleRate: 16000, format: "pcm" },
    });
    state = { ...state, enabled: true };
    await mount();
    expect(host.textContent).toContain("龙安欢");
    expect(host.textContent).toContain("许南川");
    expect(host.textContent).toContain("已启用云端实时语音，支持播报中随时插话打断");
    // Chief currently holds legacy "nova", so fallback hint is shown smoothly without breaking select.
    expect(host.textContent).toContain("nova（清亮女声）");
  });

  it("lets the user save a custom wake word, validates minimum length, and restores default", async () => {
    state = { ...state, enabled: true, voiceMode: true };
    await mount();

    const input = host.querySelector<HTMLInputElement>('input[aria-label="自定义唤醒词"]');
    expect(input).not.toBeNull();
    expect(input!.value).toBe("");

    const setInputValue = async (val: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        setter.call(input!, val);
        input!.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    const findButton = (label: string) =>
      Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((btn) => btn.textContent?.trim() === label);

    // 1-char wake word is rejected with a friendly hint and not persisted.
    await setInputValue("宝");
    await act(async () => findButton("保存")!.click());
    expect(bridge.set).not.toHaveBeenCalled();
    expect(host.textContent).toContain("唤醒词至少需要 2 个字");

    // Valid custom wake word saves and immediately updates the wake-word label.
    await setInputValue("小宝同学");
    await act(async () => findButton("保存")!.click());
    await act(async () => { await Promise.resolve(); });
    expect(bridge.set).toHaveBeenCalledWith({ wakeWord: "小宝同学" });
    expect(host.textContent).toContain("语音唤醒（喊「小宝同学」）");
    expect(host.textContent).toContain("已保存，现在直接喊「小宝同学」即可唤醒。");

    // Resetting restores the default wake phrase.
    const resetBtn = findButton("恢复默认");
    expect(resetBtn).toBeDefined();
    await act(async () => resetBtn!.click());
    await act(async () => { await Promise.resolve(); });
    expect(bridge.set).toHaveBeenCalledWith({ wakeWord: "" });
    expect(host.textContent).toContain("语音唤醒（喊「你好多宝」）");
  });
});
