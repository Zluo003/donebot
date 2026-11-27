import { keyEntry, savedState } from "@/components/keys/key-catalog";
import { cloudSpeechBridge } from "@/donebot/voice/cloud-speech-bridge";
import type { ConfigStatus } from "@/state/store";
import { desktopCapabilitiesNow } from "./desktop";
import { fishSpeech, type SpeechBridge } from "./fish-speech";

let syncedCloudAsrReady = false;

export function cloudAsrReady(config: ConfigStatus | null | undefined): boolean {
  const available = config?.asr?.ready === true || config?.tts?.asrAvailable === true;
  if (!available) return false;
  const wsPath = config?.asr?.wsPath || config?.tts?.asrWsPath;
  if (wsPath) cloudSpeechBridge.setWsPath(wsPath);
  return true;
}

export function syncCloudAsrAvailability(config: ConfigStatus | null | undefined): boolean {
  const ready = cloudAsrReady(config);
  syncedCloudAsrReady = ready;
  return ready;
}

function browserAudioCaptureSupported(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

/**
 * The speech bridge this computer listens through:
 * 1) DoneBot cloud streaming ASR (cross-platform, AEC + quasi-full-duplex barge-in) when enabled;
 * 2) Fish Audio listener on platforms configured for fish-audio;
 * 3) Desktop app's native speech helper (Apple SFSpeechRecognizer on macOS).
 */
export function speechBridge(config?: ConfigStatus | null): SpeechBridge | Window["ogb"] {
  const useCloud = config !== undefined ? syncCloudAsrAvailability(config) : syncedCloudAsrReady;
  if (useCloud && (browserAudioCaptureSupported() || typeof WebSocket !== "undefined")) {
    return cloudSpeechBridge;
  }
  return desktopCapabilitiesNow().dictation.engine === "fish-audio" ? fishSpeech : globalThis.window?.ogb;
}

export function fishListeningReady(config: ConfigStatus | null | undefined): boolean {
  return savedState(keyEntry("fishAudio"), config).configured;
}

/** Whether speech can be heard here: cloud streaming ASR, native engine, or Fish Audio with a saved key. */
export function listensHere(capabilities: DesktopCapabilities, config: ConfigStatus | null | undefined): boolean {
  if (syncCloudAsrAvailability(config)) return true;
  return capabilities.dictation.available && (capabilities.dictation.engine !== "fish-audio" || fishListeningReady(config));
}
