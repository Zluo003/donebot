/**
 * Unified real-time cloud SpeechBridge backed by DoneBot local server `/api/voice/asr`.
 *
 * Implements the exact five-method `SpeechBridge` contract consumed by CallView, GroupCallView,
 * Composer dictation and push-to-talk, PLUS quasi-full-duplex barge-in monitoring during TTS playback:
 * - Zero-cost idle during TTS playback: keeps AEC mic + 400ms ring buffer locally, only opens
 *   the cloud ASR WebSocket if sustained local speech crosses the barge-in threshold.
 * - Seamless handoff: once barge-in triggers, the already-open mic & ASR session are adopted
 *   directly into active listening so the user's opening words are never lost.
 */

import type { SpeechBridge } from "@/lib/fish-speech";
import { BargeInGuard, type BargeInGuardOptions } from "./barge-in";
import { classifyMicCaptureError, startMicCapture, type MicCaptureDeps, type MicCaptureHandle, type MicChunk } from "./mic-capture";
import { DEFAULT_PRE_ROLL_MS, LocalVadGate, PcmRingBuffer } from "./pcm";
import {
  connectRealtimeAsr,
  DEFAULT_ASR_WS_PATH,
  type AsrServerEvent,
  type RealtimeAsrClient,
  type WebSocketFactory,
} from "./realtime-asr";

type TranscriptLine = Parameters<Parameters<SpeechBridge["onSpeechTranscript"]>[0]>[0];
type EndInfo = Parameters<Parameters<SpeechBridge["onSpeechEnd"]>[0]>[0];

const DEFAULT_CALL_IDLE_DISCONNECT_MS = 20_000;
const DEFAULT_MANUAL_IDLE_DISCONNECT_MS = 45_000;
const DEFAULT_HANDOFF_CLAIM_TIMEOUT_MS = 3_000;

function joinTranscriptSegments(segments: readonly string[], currentPartial: string): string {
  const parts = [...segments];
  if (currentPartial.trim()) parts.push(currentPartial.trim());
  let out = "";
  for (const part of parts) {
    if (!part) continue;
    if (!out) {
      out = part;
      continue;
    }
    const prevLast = out[out.length - 1] ?? "";
    const nextFirst = part[0] ?? "";
    const needsSpace = /[A-Za-z0-9]$/.test(prevLast) && /^[A-Za-z0-9]/.test(nextFirst);
    out += needsSpace ? ` ${part}` : part;
  }
  return out;
}

export interface BargeInMonitorOptions {
  spokenText: () => string;
  onBargeIn: (info: { text: string }) => void;
  hotwords?: Record<string, number>;
  wsPath?: string;
  guardOptions?: BargeInGuardOptions;
}

export interface CloudSpeechStartOptions {
  endpointMs?: number;
  hotwords?: Record<string, number>;
  wsPath?: string;
  /** Adopts an active barge-in mic + ASR session without tearing down the WebSocket. */
  adoptBargeIn?: boolean;
}

export interface CloudSpeechBridge extends SpeechBridge {
  readonly isRealtimeCloud: true;
  speechStart(options?: CloudSpeechStartOptions): Promise<void>;
  setWsPath(wsPath: string): void;
  startBargeInMonitor(options: BargeInMonitorOptions): () => void;
  hasActiveBargeInHandoff(): boolean;
  isAsrConnected(): boolean;
}

export interface CloudSpeechBridgeDeps {
  startMic?: typeof startMicCapture;
  micDeps?: MicCaptureDeps;
  createWebSocket?: WebSocketFactory;
  now?: () => number;
  callIdleDisconnectMs?: number;
  manualIdleDisconnectMs?: number;
  handoffClaimTimeoutMs?: number;
}

interface ActiveHandoff {
  mic: MicCaptureHandle;
  asr: RealtimeAsrClient;
  ring: PcmRingBuffer;
  committedSegments: string[];
  currentPartial: string;
  lastSentenceId: number | undefined;
  expiryTimer: ReturnType<typeof setTimeout>;
}

export function createCloudSpeechBridge(deps?: CloudSpeechBridgeDeps): CloudSpeechBridge {
  const startMic = deps?.startMic ?? startMicCapture;
  const nowFn = deps?.now ?? (() => Date.now());
  const callIdleDisconnectMs = deps?.callIdleDisconnectMs ?? DEFAULT_CALL_IDLE_DISCONNECT_MS;
  const manualIdleDisconnectMs = deps?.manualIdleDisconnectMs ?? DEFAULT_MANUAL_IDLE_DISCONNECT_MS;
  const handoffClaimTimeoutMs = deps?.handoffClaimTimeoutMs ?? DEFAULT_HANDOFF_CLAIM_TIMEOUT_MS;

  const transcriptListeners = new Set<(line: TranscriptLine) => void>();
  const endListeners = new Set<(info: EndInfo) => void>();

  let configuredWsPath = DEFAULT_ASR_WS_PATH;
  let generation = 0;

  let activeMic: MicCaptureHandle | null = null;
  let activeAsr: RealtimeAsrClient | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let finishing = false;

  let bargeInStopFn: (() => void) | null = null;
  let pendingHandoff: ActiveHandoff | null = null;

  const emitTranscript = (line: TranscriptLine) => {
    for (const fn of Array.from(transcriptListeners)) fn(line);
  };
  const emitEnd = (info: EndInfo) => {
    for (const fn of Array.from(endListeners)) fn(info);
  };

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const disposePendingHandoff = () => {
    if (!pendingHandoff) return;
    const h = pendingHandoff;
    pendingHandoff = null;
    clearTimeout(h.expiryTimer);
    h.asr.stop();
    h.mic.stop();
    h.ring.clear();
  };

  const teardownAll = (keepHandoff = false) => {
    generation += 1;
    finishing = false;
    clearIdleTimer();
    if (bargeInStopFn) {
      const stopBarge = bargeInStopFn;
      bargeInStopFn = null;
      stopBarge();
    }
    if (!keepHandoff) {
      disposePendingHandoff();
    }
    if (activeAsr) {
      const asr = activeAsr;
      activeAsr = null;
      asr.stop();
    }
    if (activeMic) {
      const mic = activeMic;
      activeMic = null;
      mic.stop();
    }
  };

  const mapAsrErrorMessage = (code: string, fallback: string): string => {
    switch (code) {
      case "auth_expired":
      case "account_changed":
        return "DoneBot 登录态已变更，请重新登录后再使用语音识别。";
      case "asr_unavailable":
        return "云端流式语音识别暂不可用，请检查语音模型设置。";
      case "backpressure":
        return "网络发送拥塞，语音识别已断开，请重试。";
      default:
        return fallback || "语音识别连接中断，请重试。";
    }
  };

  const bindListeningSession = (
    gen: number,
    mic: MicCaptureHandle,
    asr: RealtimeAsrClient,
    options: CloudSpeechStartOptions | undefined,
    initialState?: { committedSegments: string[]; currentPartial: string; lastSentenceId?: number },
  ) => {
    const endpointed = options?.endpointMs !== undefined;
    const idleLimitMs = endpointed ? callIdleDisconnectMs : manualIdleDisconnectMs;
    const committedSegments = [...(initialState?.committedSegments ?? [])];
    let currentPartial = initialState?.currentPartial ?? "";
    let lastSentenceId = initialState?.lastSentenceId;
    let settled = false;

    const finishSession = (emitFinalText: boolean, endInfo: EndInfo) => {
      if (settled || gen !== generation) return;
      settled = true;
      clearIdleTimer();
      const combined = joinTranscriptSegments(committedSegments, currentPartial).trim();
      const curAsr = activeAsr;
      const curMic = activeMic;
      activeAsr = null;
      activeMic = null;
      curAsr?.stop();
      curMic?.stop();
      if (emitFinalText && combined) {
        emitTranscript({ partial: false, text: combined });
      }
      emitEnd(endInfo);
    };

    const bumpIdleTimer = () => {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        if (settled || gen !== generation) return;
        finishSession(true, { code: 0, reason: "completed" });
      }, idleLimitMs);
    };

    bumpIdleTimer();

    // Forward mic chunks directly to open ASR WS.
    mic.setListener((chunk) => {
      if (settled || gen !== generation) return;
      asr.sendAudio(chunk.pcm);
      if (chunk.rms >= 0.015) {
        bumpIdleTimer();
      }
    });

    // If barge-in already collected initial text, surface it immediately to UI.
    const initialCombined = joinTranscriptSegments(committedSegments, currentPartial).trim();
    if (initialCombined) {
      emitTranscript({ partial: true, text: initialCombined });
    }

    const handleEvent = (event: AsrServerEvent) => {
      if (settled || gen !== generation) return;
      if (event.type === "speech_started") {
        bumpIdleTimer();
        return;
      }
      if (event.type === "transcript") {
        bumpIdleTimer();
        const text = event.text.trim();
        if (!text) return;
        if (event.sentenceId !== undefined && lastSentenceId !== undefined && event.sentenceId !== lastSentenceId && currentPartial) {
          committedSegments.push(currentPartial);
          currentPartial = "";
        }
        lastSentenceId = event.sentenceId;

        if (event.final) {
          committedSegments.push(text);
          currentPartial = "";
          const combined = joinTranscriptSegments(committedSegments, "");
          if (endpointed) {
            finishSession(true, { code: 0, reason: "completed" });
            return;
          }
          emitTranscript({ partial: false, text: combined });
          return;
        }

        currentPartial = text;
        const combined = joinTranscriptSegments(committedSegments, currentPartial);
        emitTranscript({ partial: true, text: combined });
        return;
      }
      if (event.type === "speech_stopped") {
        if (endpointed) {
          const combined = joinTranscriptSegments(committedSegments, currentPartial).trim();
          if (combined) {
            finishSession(true, { code: 0, reason: "completed" });
          }
        }
        return;
      }
      if (event.type === "finished") {
        finishSession(true, { code: 0, reason: "completed" });
        return;
      }
      if (event.type === "error") {
        if (event.code === "idle_timeout" || event.code === "max_duration") {
          finishSession(true, { code: 0, reason: "completed" });
          return;
        }
        finishSession(false, {
          code: 1,
          reason: event.code || "asr-error",
          message: mapAsrErrorMessage(event.code, event.message),
        });
      }
    };

    const handleClose = (info: { code: number; reason: string; wasClean: boolean }) => {
      if (settled || gen !== generation) return;
      if (finishing || info.wasClean || info.code === 1000) {
        finishSession(true, { code: 0, reason: "completed" });
      } else {
        finishSession(false, {
          code: 1,
          reason: info.code === 4429 ? "asr-busy" : "asr-disconnected",
          message: info.code === 4429 ? "当前语音通道繁忙，请稍后再试。" : "语音识别连接已断开。",
        });
      }
    };

    return { handleEvent, handleClose };
  };

  // Dynamic event dispatcher so an already-open barge-in ASR WebSocket can be seamlessly handed off
  // into listening without reconnecting.
  let onAsrEventProxy: (event: AsrServerEvent) => void = () => {};
  let onAsrCloseProxy: (info: { code: number; reason: string; wasClean: boolean }) => void = () => {};

  const bridge: CloudSpeechBridge = {
    isRealtimeCloud: true,

    setWsPath(wsPath: string) {
      if (wsPath && wsPath.startsWith("/")) configuredWsPath = wsPath;
    },

    hasActiveBargeInHandoff() {
      return Boolean(pendingHandoff && pendingHandoff.asr.isActive() && pendingHandoff.mic.isActive());
    },

    isAsrConnected() {
      return Boolean((activeAsr && activeAsr.isActive()) || (pendingHandoff && pendingHandoff.asr.isActive()));
    },

    async speechStart(options) {
      const adopting = options?.adoptBargeIn === true && pendingHandoff !== null;
      const handoff = adopting ? pendingHandoff : null;
      if (handoff) clearTimeout(handoff.expiryTimer);
      pendingHandoff = null;
      teardownAll(false);
      const gen = generation;

      if (handoff && handoff.asr.isActive() && handoff.mic.isActive()) {
        activeMic = handoff.mic;
        activeAsr = handoff.asr;
        const handlers = bindListeningSession(gen, handoff.mic, handoff.asr, options, {
          committedSegments: handoff.committedSegments,
          currentPartial: handoff.currentPartial,
          lastSentenceId: handoff.lastSentenceId,
        });
        onAsrEventProxy = handlers.handleEvent;
        onAsrCloseProxy = handlers.handleClose;
        return;
      }

      if (handoff) {
        handoff.asr.stop();
        handoff.mic.stop();
        handoff.ring.clear();
      }

      let mic: MicCaptureHandle;
      try {
        mic = await startMic(() => {}, deps?.micDeps);
      } catch (error) {
        if (gen !== generation) return;
        const mapped = classifyMicCaptureError(error);
        emitEnd({ code: 1, reason: mapped.reason, message: mapped.message });
        return;
      }

      if (gen !== generation) {
        mic.stop();
        return;
      }

      const asr = connectRealtimeAsr(
        {
          wsPath: options?.wsPath ?? configuredWsPath,
          sampleRate: 16000,
          endpointMs: options?.endpointMs ?? 850,
          vadModel: "near_meeting_16k",
          hotwords: options?.hotwords,
          idleTimeoutMs: options?.endpointMs !== undefined ? callIdleDisconnectMs : manualIdleDisconnectMs,
        },
        {
          onEvent: (event) => onAsrEventProxy(event),
          onClose: (info) => onAsrCloseProxy(info),
        },
        { createWebSocket: deps?.createWebSocket },
      );

      activeMic = mic;
      activeAsr = asr;
      const handlers = bindListeningSession(gen, mic, asr, options);
      onAsrEventProxy = handlers.handleEvent;
      onAsrCloseProxy = handlers.handleClose;
    },

    async speechStop() {
      teardownAll(false);
    },

    async speechFinish() {
      if (!activeAsr) {
        teardownAll(false);
        return;
      }
      finishing = true;
      clearIdleTimer();
      // Stop microphone immediately so no trailing noise is billed while awaiting final transcript.
      if (activeMic) {
        const mic = activeMic;
        activeMic = null;
        mic.stop();
      }
      activeAsr.finish();
    },

    onSpeechTranscript(cb) {
      transcriptListeners.add(cb);
      return () => transcriptListeners.delete(cb);
    },

    onSpeechEnd(cb) {
      endListeners.add(cb);
      return () => endListeners.delete(cb);
    },

    startBargeInMonitor(options) {
      // Tear down any previous monitor or active session cleanly before monitoring TTS playback.
      teardownAll(false);
      const monitorGen = generation;
      let stopped = false;
      let triggered = false;
      let mic: MicCaptureHandle | null = null;
      let asr: RealtimeAsrClient | null = null;

      const ring = new PcmRingBuffer(DEFAULT_PRE_ROLL_MS);
      const vad = new LocalVadGate({ mode: "barge-in" });
      const guard = new BargeInGuard(options.guardOptions);
      guard.start(options.spokenText(), nowFn());

      const committedSegments: string[] = [];
      let currentPartial = "";
      let lastSentenceId: number | undefined;

      const closeMonitorAsr = () => {
        if (!asr) return;
        const cur = asr;
        asr = null;
        cur.stop();
      };

      const fireBargeIn = (initialText: string) => {
        if (stopped || triggered || monitorGen !== generation) return;
        triggered = true;
        bargeInStopFn = null;
        if (mic && asr && asr.isActive() && mic.isActive()) {
          // Keep mic & ASR open for instant handoff into listening, with a short safety timeout
          // so an unclaimed handoff (e.g. caller hung up concurrently) never leaks a live ASR WS.
          const handoffObj: ActiveHandoff = {
            mic,
            asr,
            ring,
            committedSegments: [...committedSegments],
            currentPartial,
            lastSentenceId,
            expiryTimer: setTimeout(() => {
              if (pendingHandoff === handoffObj) {
                disposePendingHandoff();
              }
            }, handoffClaimTimeoutMs),
          };
          pendingHandoff = handoffObj;
          // Continue buffering/sending chunks during the microtask handoff so zero audio is dropped.
          const handoffAsr = asr;
          mic.setListener((chunk) => {
            handoffAsr.sendAudio(chunk.pcm);
          });
          mic = null;
          asr = null;
        }
        options.onBargeIn({ text: initialText });
      };

      const openOnDemandAsr = () => {
        if (stopped || triggered || asr || monitorGen !== generation) return;
        const preRoll = ring.drain();
        onAsrEventProxy = (event: AsrServerEvent) => {
          if (stopped || triggered || monitorGen !== generation) return;
          guard.updateSpokenText(options.spokenText());
          if (event.type === "speech_started") {
            if (guard.onCloudSpeechStarted(nowFn())) {
              fireBargeIn(joinTranscriptSegments(committedSegments, currentPartial));
            }
            return;
          }
          if (event.type === "transcript") {
            const text = event.text.trim();
            if (!text) return;
            if (event.sentenceId !== undefined && lastSentenceId !== undefined && event.sentenceId !== lastSentenceId && currentPartial) {
              committedSegments.push(currentPartial);
              currentPartial = "";
            }
            lastSentenceId = event.sentenceId;
            if (event.final) {
              committedSegments.push(text);
              currentPartial = "";
            } else {
              currentPartial = text;
            }
            const combined = joinTranscriptSegments(committedSegments, currentPartial);
            const verdict = guard.onCloudTranscript(combined, nowFn());
            if (verdict.triggered) {
              fireBargeIn(verdict.text);
            }
            return;
          }
          if (event.type === "error") {
            closeMonitorAsr();
          }
        };
        onAsrCloseProxy = () => {
          if (!triggered) {
            asr = null;
          }
        };

        asr = connectRealtimeAsr(
          {
            wsPath: options.wsPath ?? configuredWsPath,
            sampleRate: 16000,
            endpointMs: 850,
            vadModel: "near_meeting_16k",
            hotwords: options.hotwords,
            idleTimeoutMs: callIdleDisconnectMs,
          },
          {
            onEvent: (event) => onAsrEventProxy(event),
            onClose: (info) => onAsrCloseProxy(info),
          },
          {
            createWebSocket: deps?.createWebSocket,
            preRollChunks: preRoll,
          },
        );
      };

      const handleChunk = (chunk: MicChunk) => {
        if (stopped || triggered || monitorGen !== generation) return;
        const now = nowFn();
        guard.updateSpokenText(options.spokenText());
        const vadRes = vad.feed(chunk.rms, chunk.durationMs);
        const decision = guard.onLocalVad(
          { isSpeech: vadRes.isSpeech, consecutiveSpeechMs: vadRes.consecutiveSpeechMs },
          now,
        );

        if (decision.shouldOpenAsr) {
          ring.push(chunk.pcm);
          openOnDemandAsr();
          return;
        }
        if (decision.shouldCloseAsr) {
          closeMonitorAsr();
          committedSegments.length = 0;
          currentPartial = "";
          lastSentenceId = undefined;
          ring.clear();
          return;
        }

        if (asr && asr.isActive()) {
          asr.sendAudio(chunk.pcm);
        } else {
          // Zero-cost local standby during TTS playback until sustained human speech appears.
          ring.push(chunk.pcm);
        }
      };

      const stopMonitor = () => {
        if (stopped) return;
        stopped = true;
        if (bargeInStopFn === stopMonitor) bargeInStopFn = null;
        if (!triggered) {
          closeMonitorAsr();
          mic?.stop();
          mic = null;
          ring.clear();
        }
        guard.reset();
      };
      bargeInStopFn = stopMonitor;

      void startMic(handleChunk, deps?.micDeps)
        .then((handle) => {
          if (stopped || triggered || monitorGen !== generation) {
            handle.stop();
            return;
          }
          mic = handle;
        })
        .catch(() => {
          // If mic cannot open during TTS playback, gracefully degrade to non-barge-in playback.
          stopMonitor();
        });

      return stopMonitor;
    },
  };

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("beforeunload", () => teardownAll(false));
  }

  return bridge;
}

export const cloudSpeechBridge = createCloudSpeechBridge();

export function isCloudSpeechBridge(bridge: unknown): bridge is CloudSpeechBridge {
  return Boolean(bridge && typeof bridge === "object" && (bridge as { isRealtimeCloud?: unknown }).isRealtimeCloud === true);
}
