// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  dispatch: vi.fn(),
  speak: vi.fn(async () => {}),
  stop: vi.fn(),
  config: {
    donebot: { enabled: true, authenticated: true, user: { id: "u1", email: "a@b.c" }, modelCount: 4, persistent: true },
    tts: { configured: true, ready: true, voice: "", model: "qwen-audio-3.1-tts-flash", asrAvailable: true },
    asr: { ready: true, model: "qwen-audio-3.1-asr-flash-streaming", wsPath: "/api/voice/asr" },
  },
}));

vi.mock("@/state/store", () => ({
  api: mocks.api,
  useStore: () => ({ state: { config: mocks.config }, dispatch: mocks.dispatch }),
}));

vi.mock("@/lib/tts", () => ({
  speaker: {
    speak: mocks.speak,
    stop: mocks.stop,
    subscribe: (fn: (s: { status: string }) => void) => {
      fn({ status: "idle" });
      return () => {};
    },
    state: { status: "idle" },
  },
}));

vi.mock("@/lib/tts/useSpeech", () => ({
  useSpeech: () => ({ status: "idle" }),
}));

import { DoneBotVoiceSettings, formatDoneBotVoiceLabel } from "./Voice";
import type { Bot } from "@/state/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CAPABILITIES = {
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
          { id: "longanlingxin_v3.1", name: "龙安灵心", label: "龙安灵心", gender: "female", description: "温柔细腻、温暖治愈陪伴" },
          { id: "xunanchuan_v3.1", name: "许南川", label: "许南川", gender: "male", description: "磁性真诚、沉稳叙事感" },
          { id: "yuxiaoyun_v3.1", name: "于小云", label: "于小云", gender: "female", description: "元气亲切自然" },
          { id: "Emily_v3.1", name: "Emily", label: "Emily", gender: "female", description: "自然英式英语" },
        ],
      },
      {
        id: "qwen-audio-3.1-tts-plus",
        displayName: "Qwen Audio 3.1 TTS Plus",
        defaultVoice: "longanhuan_v3.1",
        voices: [
          { id: "longanhuan_v3.1", name: "龙安欢", label: "龙安欢", gender: "female", description: "欢脱元气、开朗活泼", recommended: true },
          { id: "xunanchuan_v3.1", name: "许南川", label: "许南川", gender: "male", description: "磁性真诚、沉稳叙事感" },
        ],
      },
      {
        id: "gpt-4o-mini-tts",
        displayName: "GPT-4o mini TTS",
        defaultVoice: "alloy",
        voices: [
          { id: "alloy", name: "alloy", label: "alloy（自然中性）", gender: "neutral", description: "自然中性", recommended: true },
          { id: "nova", name: "nova", label: "nova（清亮女声）", gender: "female", description: "清亮女声" },
        ],
      },
    ],
  },
  asr: {
    available: true,
    model: "qwen-audio-3.1-asr-flash-streaming",
    wsPath: "/api/voice/asr",
    sampleRate: 16000,
    format: "pcm",
  },
};

let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  mocks.api.mockReset();
  mocks.api.mockResolvedValue(CAPABILITIES);
  mocks.dispatch.mockReset();
  mocks.speak.mockReset();
  mocks.speak.mockResolvedValue(undefined);
  mocks.config.tts.model = "qwen-audio-3.1-tts-flash";
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
});

async function renderVoice(bot: Partial<Bot>, onPatch = vi.fn()) {
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(DoneBotVoiceSettings, {
      bot: { id: "bot-1", name: "多宝", voice: "", speakReplies: false, voiceNotes: true, ...bot } as Bot,
      onPatch,
    }));
  });
  await act(async () => { await Promise.resolve(); });
  return { onPatch };
}

describe("DoneBotVoiceSettings & Chinese voice labels", () => {
  it("formats verified Qwen-Audio-3.1 Chinese voice labels and preserves legacy gpt-4o-mini-tts labels", () => {
    expect(formatDoneBotVoiceLabel("longanhuan_v3.1")).toBe("龙安欢 · 欢脱元气女声");
    expect(formatDoneBotVoiceLabel("xunanchuan_v3.1")).toBe("许南川 · 磁性沉稳男声");
    expect(formatDoneBotVoiceLabel("yuxiaoyun_v3.1")).toBe("于小云 · 元气亲切女声");
    expect(formatDoneBotVoiceLabel("Emily_v3.1")).toBe("Emily · 自然英式女声");
    expect(formatDoneBotVoiceLabel("alloy")).toBe("alloy（自然中性）");
    expect(formatDoneBotVoiceLabel("nova")).toBe("nova（清亮女声）");
  });

  it("renders dot-containing _v3.1 voices with Chinese names, descriptions, and one-click preview", async () => {
    const onPatch = vi.fn();
    await renderVoice({ voice: "longanhuan_v3.1" }, onPatch);

    expect(host.textContent).toContain("实时语音 · 支持随时打断");
    expect(host.textContent).toContain("龙安欢");
    expect(host.textContent).toContain("许南川");
    expect(host.textContent).toContain("于小云");
    expect(host.textContent).toContain("欢脱元气、开朗活泼");

    const voiceSelect = host.querySelector<HTMLSelectElement>('select[aria-label="声音"]');
    expect(voiceSelect?.value).toBe("longanhuan_v3.1");
    expect(Array.from(voiceSelect?.options ?? []).map((o) => o.value)).toContain("Emily_v3.1");

    // Click card preview button for 许南川 without losing selection.
    const previewBtn = host.querySelector<HTMLButtonElement>('button[aria-label="试听 许南川"]');
    expect(previewBtn).not.toBeNull();
    await act(async () => previewBtn!.click());
    expect(mocks.speak).toHaveBeenCalledWith("你好，我是多宝，很高兴为你服务。", {
      botId: "bot-1",
      voiceId: "xunanchuan_v3.1",
    });

    // Click card to select 许南川.
    const card = previewBtn!.closest('[role="radio"]') as HTMLElement;
    await act(async () => card.click());
    expect(onPatch).toHaveBeenCalledWith({ voice: "xunanchuan_v3.1" });
  });

  it("shows gentle fallback hint when bot still holds a legacy alloy voice after upgrading to Qwen-Audio-3.1", async () => {
    await renderVoice({ voice: "alloy" });

    expect(host.textContent).toContain("alloy（自然中性）");
    expect(host.textContent).toContain("自动使用默认人声");
    expect(host.textContent).toContain("龙安欢");

    // Clicking main preview button falls back cleanly to longanhuan_v3.1 instead of sending invalid alloy.
    const mainPreview = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("试听声音"));
    expect(mainPreview).toBeDefined();
    await act(async () => mainPreview!.click());
    expect(mocks.speak).toHaveBeenCalledWith("你好，我是多宝，很高兴为你服务。", {
      botId: "bot-1",
      voiceId: "longanhuan_v3.1",
    });
  });
});
