// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  config: {
    asr: { ready: true, model: "qwen-audio-3.1-asr-flash-streaming", wsPath: "/api/voice/asr" },
    tts: { configured: true, ready: true, voice: "", asrAvailable: true, asrWsPath: "/api/voice/asr" },
    profile: { name: "老板" },
  } as Record<string, unknown>,
  bridge: {
    isRealtimeCloud: true as const,
    setWsPath: vi.fn(),
    speechStart: vi.fn(async () => {}),
    speechStop: vi.fn(async () => {}),
    speechFinish: vi.fn(async () => {}),
    onSpeechTranscript: vi.fn(() => () => {}),
    onSpeechEnd: vi.fn(() => () => {}),
    startBargeInMonitor: vi.fn(() => () => {}),
    hasActiveBargeInHandoff: vi.fn(() => false),
    isAsrConnected: vi.fn(() => false),
  },
}));

vi.mock("@/donebot/voice/cloud-speech-bridge", () => ({
  cloudSpeechBridge: fixture.bridge,
  isCloudSpeechBridge: (b: unknown) => b === fixture.bridge,
}));

vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { config: fixture.config } }),
}));

vi.mock("@/state/store-select", () => ({
  useStoreSelector: <T,>(selector: (state: { config: Record<string, unknown> }) => T) =>
    selector({ config: fixture.config }),
}));

vi.mock("@/components/DesktopCapabilities", async () => {
  const { initialDesktopCapabilities } = await import("@/lib/desktop");
  return { useDesktopCapabilities: () => ({ capabilities: initialDesktopCapabilities(), ready: true }) };
});

import { useComposerDictation } from "@/lib/use-composer-dictation";

describe("useComposerDictation stability across SSE config updates", () => {
  let root: Root;
  let host: HTMLDivElement;
  let dictation: ReturnType<typeof useComposerDictation>;

  beforeEach(() => {
    vi.clearAllMocks();
    fixture.config = {
      asr: { ready: true, model: "qwen-audio-3.1-asr-flash-streaming", wsPath: "/api/voice/asr" },
      tts: { configured: true, ready: true, voice: "", asrAvailable: true, asrWsPath: "/api/voice/asr" },
      profile: { name: "老板" },
    };
    host = document.createElement("div");
    root = createRoot(host);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
  });

  it("does not interrupt active dictation when unrelated SSE config frames replace the config object reference", () => {
    const onText = vi.fn();
    const Probe = () => {
      dictation = useComposerDictation({ draftId: "d1", text: "", onText });
      return null;
    };

    flushSync(() => root.render(createElement(Probe)));
    expect(dictation.ready).toBe(true);

    // Start recording.
    flushSync(() => dictation.toggle());
    expect(dictation.recording).toBe(true);
    expect(fixture.bridge.speechStart).toHaveBeenCalledTimes(1);
    expect(fixture.bridge.speechStop).not.toHaveBeenCalled();

    // Simulate an unrelated SSE `config` push producing a fresh config object identity.
    fixture.config = {
      ...fixture.config,
      profile: { name: "老板2" },
    };
    flushSync(() => root.render(createElement(Probe)));

    expect(dictation.recording).toBe(true);
    expect(fixture.bridge.speechStop).not.toHaveBeenCalled();
    expect(fixture.bridge.speechStart).toHaveBeenCalledTimes(1);
  });
});
