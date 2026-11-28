/**
 * Zero-cost-idle wake-word standby gate for cloud streaming ASR.
 * Keeps 0 WebSocket connections open while silent: only opens `/api/voice/asr` when the local
 * adaptive VAD detects sustained speech, flushing the ~400ms pre-roll PCM ring buffer so the
 * opening syllables of `你好<BotName>` are never clipped, and closes the WS immediately if
 * silence or probe window elapses without a wake match.
 */

import { DEFAULT_PRE_ROLL_MS, LocalVadGate, PcmRingBuffer } from "./pcm";
import { classifyMicCaptureError, startMicCapture, type MicCaptureDeps, type MicCaptureHandle, type MicChunk } from "./mic-capture";
import {
  connectRealtimeAsr,
  DEFAULT_ASR_WS_PATH,
  type AsrServerEvent,
  type RealtimeAsrClient,
  type WebSocketFactory,
} from "./realtime-asr";

export const WAKE_PROBE_SILENCE_TIMEOUT_MS = 1_800;
export const WAKE_PROBE_MAX_DURATION_MS = 6_500;
export const WAKE_PROBE_COOLDOWN_MS = 2_200;

export interface WakeStandbyMatch {
  matched: boolean;
  remainder: string;
}

export interface WakeStandbyOptions {
  wsPath?: string;
  botName: string;
  wakeWord?: string;
  matchWakeWord: (transcript: string, botName: string, customWakeWord?: string) => WakeStandbyMatch;
  preRollMs?: number;
  probeSilenceTimeoutMs?: number;
  probeMaxDurationMs?: number;
  probeCooldownMs?: number;
  onTranscript?: (info: { text: string; final: boolean; remainder: string }) => void;
  onWakeHit: (info: { remainder: string; final: boolean; text: string }) => void;
  onError?: (info: { code: string; message: string; fatal?: boolean }) => void;
}

export interface WakeStandbySession {
  setBotName(name: string): void;
  setWakeWord(wakeWord: string): void;
  isAsrConnected(): boolean;
  isMicActive(): boolean;
  stop(): void;
}

export function createWakeStandbySession(
  options: WakeStandbyOptions,
  deps?: {
    startMic?: typeof startMicCapture;
    micDeps?: MicCaptureDeps;
    createWebSocket?: WebSocketFactory;
    now?: () => number;
  },
): WakeStandbySession {
  const startMic = deps?.startMic ?? startMicCapture;
  const nowFn = deps?.now ?? (() => Date.now());
  const silenceTimeoutMs = options.probeSilenceTimeoutMs ?? WAKE_PROBE_SILENCE_TIMEOUT_MS;
  const maxDurationMs = options.probeMaxDurationMs ?? WAKE_PROBE_MAX_DURATION_MS;
  const cooldownMs = options.probeCooldownMs ?? WAKE_PROBE_COOLDOWN_MS;

  let botName = options.botName.trim() || "多宝";
  let wakeWord = (options.wakeWord ?? "").trim();
  let stopped = false;
  let mic: MicCaptureHandle | null = null;
  let asr: RealtimeAsrClient | null = null;
  let probeStartedAt = 0;
  let lastSpeechAt = 0;
  let cooldownUntil = 0;
  let wakeMatched = false;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;

  const ring = new PcmRingBuffer(options.preRollMs ?? DEFAULT_PRE_ROLL_MS);
  const vad = new LocalVadGate({ mode: "standby" });

  const clearProbeTimers = () => {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    if (maxTimer) {
      clearTimeout(maxTimer);
      maxTimer = null;
    }
  };

  const closeProbe = (applyCooldown: boolean) => {
    clearProbeTimers();
    if (asr) {
      const current = asr;
      asr = null;
      current.stop();
    }
    vad.reset();
    if (applyCooldown) {
      cooldownUntil = nowFn() + cooldownMs;
    }
  };

  const resetSilenceTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (stopped || wakeMatched || !asr) return;
      closeProbe(false);
    }, silenceTimeoutMs);
  };

  const openProbe = () => {
    if (stopped || wakeMatched || asr) return;
    const now = nowFn();
    if (now < cooldownUntil) return;

    const preRoll = ring.drain();
    probeStartedAt = now;
    lastSpeechAt = now;

    const wakePhrase = wakeWord || `你好${botName}`;
    const hotwords: Record<string, number> = {
      [wakePhrase]: 5,
      [botName]: 5,
      DoneBot: 5,
    };

    const client = connectRealtimeAsr(
      {
        wsPath: options.wsPath ?? DEFAULT_ASR_WS_PATH,
        sampleRate: 16000,
        endpointMs: 900,
        vadModel: "near_meeting_16k",
        hotwords,
        idleTimeoutMs: Math.max(5_000, silenceTimeoutMs + 3_000),
      },
      {
        onEvent(event: AsrServerEvent) {
          if (stopped || client !== asr) return;
          if (event.type === "transcript") {
            const text = event.text.trim();
            if (!text) return;
            resetSilenceTimer();
            const match = options.matchWakeWord(text, botName, wakeWord);
            options.onTranscript?.({ text, final: event.final, remainder: match.remainder });
            if (match.matched) {
              wakeMatched = true;
              clearProbeTimers();
              options.onWakeHit({ remainder: match.remainder, final: event.final, text });
            }
          } else if (event.type === "speech_started") {
            resetSilenceTimer();
          } else if (event.type === "error") {
            const fatal = event.code === "auth_expired" || event.code === "asr_unavailable";
            closeProbe(true);
            options.onError?.({ code: event.code, message: event.message, fatal });
          }
        },
        onClose() {
          if (client === asr) {
            clearProbeTimers();
            asr = null;
          }
        },
      },
      {
        createWebSocket: deps?.createWebSocket,
        preRollChunks: preRoll,
      },
    );

    asr = client;
    resetSilenceTimer();
    maxTimer = setTimeout(() => {
      if (stopped || wakeMatched || client !== asr) return;
      closeProbe(true);
    }, maxDurationMs);
  };

  const handleChunk = (chunk: MicChunk) => {
    if (stopped) return;
    const now = nowFn();
    const vadRes = vad.feed(chunk.rms, chunk.durationMs);

    if (asr && asr.isActive()) {
      asr.sendAudio(chunk.pcm);
      if (vadRes.isSpeech) {
        lastSpeechAt = now;
        if (!wakeMatched) resetSilenceTimer();
      } else if (!wakeMatched && now - lastSpeechAt >= silenceTimeoutMs) {
        closeProbe(false);
      }
      if (!wakeMatched && now - probeStartedAt >= maxDurationMs) {
        closeProbe(true);
      }
      return;
    }

    // Idle standby: buffer only the last ~400ms locally with zero network traffic.
    ring.push(chunk.pcm);
    if (vadRes.onsetTriggered && now >= cooldownUntil) {
      openProbe();
    }
  };

  void startMic(handleChunk, deps?.micDeps)
    .then((handle) => {
      if (stopped) {
        handle.stop();
        return;
      }
      mic = handle;
    })
    .catch((err) => {
      if (stopped) return;
      const mapped = classifyMicCaptureError(err);
      options.onError?.({
        code: mapped.reason,
        message: mapped.message,
        fatal: mapped.reason === "microphone-blocked" || mapped.reason === "microphone-missing",
      });
    });

  return {
    setBotName(name: string) {
      const trimmed = name.trim();
      if (trimmed) botName = trimmed;
    },
    setWakeWord(next: string) {
      const trimmed = next.trim();
      if (trimmed === wakeWord) return;
      wakeWord = trimmed;
      if (asr && !wakeMatched) {
        closeProbe(false);
      }
    },
    isAsrConnected: () => Boolean(asr && asr.isActive()),
    isMicActive: () => Boolean(mic && mic.isActive()),
    stop() {
      if (stopped) return;
      stopped = true;
      closeProbe(false);
      ring.clear();
      mic?.stop();
      mic = null;
    },
  };
}
