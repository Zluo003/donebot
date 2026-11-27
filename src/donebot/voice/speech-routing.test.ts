import { afterEach, describe, expect, it, vi } from "vitest";
import { callCapabilityHelp } from "@/lib/call-capability";
import { cacheDesktopCapabilities, initialDesktopCapabilities } from "@/lib/desktop";
import { fishSpeech } from "@/lib/fish-speech";
import { cloudAsrReady, listensHere, speechBridge, syncCloudAsrAvailability } from "@/lib/speech";
import { cloudSpeechBridge } from "@/donebot/voice/cloud-speech-bridge";
import type { ConfigStatus } from "@/state/store";

const WIN_FISH: DesktopCapabilities = {
  ...initialDesktopCapabilities(),
  host: { platform: "win32", label: "Windows", session: "unknown", packaged: true },
  dictation: { available: true, engine: "fish-audio", onDevice: false },
};

const BROWSER_NONE: DesktopCapabilities = {
  ...initialDesktopCapabilities(),
  dictation: { available: false, engine: "none", onDevice: false, reasonCode: "desktop-app-required" },
};

const CLOUD_ASR_CONFIG = {
  asr: { ready: true, model: "qwen-audio-3.1-asr-flash-streaming", wsPath: "/api/voice/asr" },
  tts: { configured: true, ready: true, voice: "", asrAvailable: true, asrWsPath: "/api/voice/asr" },
} as unknown as ConfigStatus;

afterEach(() => {
  syncCloudAsrAvailability(null);
  cacheDesktopCapabilities(initialDesktopCapabilities());
  vi.unstubAllGlobals();
});

describe("cross-platform cloud streaming ASR routing & fallback", () => {
  it("enables cloudSpeechBridge across Windows/Linux/Browser when cloud ASR is ready", () => {
    vi.stubGlobal("WebSocket", vi.fn());
    cacheDesktopCapabilities(WIN_FISH);

    expect(cloudAsrReady(CLOUD_ASR_CONFIG)).toBe(true);
    expect(listensHere(WIN_FISH, CLOUD_ASR_CONFIG)).toBe(true);
    expect(listensHere(BROWSER_NONE, CLOUD_ASR_CONFIG)).toBe(true);
    expect(speechBridge(CLOUD_ASR_CONFIG)).toBe(cloudSpeechBridge);
    expect(callCapabilityHelp(WIN_FISH, true, false, true)).toBeNull();
    expect(callCapabilityHelp(BROWSER_NONE, true, false, true)).toBeNull();
  });

  it("falls back to existing Fish Audio / native bridge when cloud ASR is not ready", () => {
    vi.stubGlobal("window", { ogb: { speechStart: vi.fn() } });
    cacheDesktopCapabilities(WIN_FISH);

    expect(cloudAsrReady(null)).toBe(false);
    expect(listensHere(WIN_FISH, null)).toBe(false);
    expect(speechBridge(null)).toBe(fishSpeech);
    expect(callCapabilityHelp(WIN_FISH, true, false, false)?.label).toContain("Fish Audio");
  });
});
