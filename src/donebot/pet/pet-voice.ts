import {
  createCloudSpeechBridge,
  type CloudSpeechBridge,
} from "@/donebot/voice/cloud-speech-bridge";
import {
  createWakeStandbySession,
  type WakeStandbySession,
} from "@/donebot/voice/wake-standby";
import { buildWakePhrase, matchWakeWord, sanitizeWakeWord, type PetVoicePhase, type PetVoiceState } from "./pet-protocol";

const COMMAND_ENDPOINT_MS = 950;
const COMMAND_IDLE_TIMEOUT_MS = 9_000;
const WAKE_REARM_MS = 45_000;
const WAKE_RESTART_DELAY_MS = 450;
const WAKE_REMAINDER_SETTLE_MS = 950;
const MAX_COMMAND_MS = 45_000;
const FAST_FAIL_WINDOW_MS = 3_000;
const MAX_CONSECUTIVE_FAST_FAILS = 3;
const BACKOFF_MS = [2_000, 5_000, 10_000] as const;

export interface PetCloudAsrConfig {
  available: boolean;
  wsPath?: string;
}

export interface PetVoiceController {
  /** Keeps passive wake-word listening armed whenever the pet is visible and idle. */
  setWakeEnabled(enabled: boolean): void;
  /** Updates the chief bot name used for default wake word `你好 <botName>`. */
  setBotName(name: string): void;
  /** Updates the user's custom wake word (empty string restores default `你好 <botName>`). */
  setWakeWord(wakeWord: string): void;
  /** Enables/disables cloud streaming ASR (with zero-cost local VAD standby & quasi-full-duplex barge-in). */
  setCloudAsr(config: PetCloudAsrConfig): void;
  /** Manually starts command listening (e.g., clicking mic in composer). */
  startCommandListening(options?: { adoptBargeIn?: boolean; initialHeard?: string }): void;
  /** Stops active conversation/listening; returns to wake standby if wakeEnabled is true. */
  stopConversation(): void;
  /** Suspends all microphone capture (when pet hides or shutting down). */
  suspend(): void;
  /** Marks that wake word hit and fast greeting TTS is playing (barge-in armed in cloud mode; mic off in native mode). */
  markWaking(): void;
  markWorking(): void;
  /** Marks that TTS reply is playing (keeps AEC barge-in armed in cloud mode; pauses mic in native mode). */
  markSpeaking(): void;
  /** Called right after TTS finishes speaking a wake greeting or reply. */
  afterSpeaking(options?: { expectCommand?: boolean }): void;
  dispose(): void;
}

export interface SpeechBridgeLike {
  speechStart?: (options?: { endpointMs?: number; adoptBargeIn?: boolean; hotwords?: Record<string, number> }) => Promise<void> | void;
  speechStop?: () => Promise<void> | void;
  speechFinish?: () => Promise<void> | void;
  onSpeechTranscript?: (cb: (line: { text?: string; final?: boolean; partial?: boolean }) => void) => () => void;
  onSpeechEnd?: (cb: (info: { code?: number | null; reason?: string; message?: string }) => void) => () => void;
  callActive?: (active: boolean) => Promise<void> | void;
}

const SPEECH_ERROR_TEXT: Record<string, { text: string; needsMicSettings?: boolean; fatal?: boolean }> = {
  "speech-not-authorized": {
    text: "请先在系统设置 → 隐私与安全性中允许 DoneBot 使用麦克风和语音识别。",
    needsMicSettings: true,
    fatal: true,
  },
  "microphone-blocked": {
    text: "请先在系统设置 → 隐私与安全性中允许 DoneBot 使用麦克风。",
    needsMicSettings: true,
    fatal: true,
  },
  "microphone-missing": {
    text: "未检测到可用的麦克风设备，请检查录音设备后重试。",
    fatal: true,
  },
  "dictation-disabled": {
    text: "请先在系统设置 → 键盘中开启听写功能。",
    needsMicSettings: true,
    fatal: true,
  },
  "unsupported-platform": {
    text: "当前系统暂不支持原生语音识别。",
    fatal: true,
  },
  "mic-failed": {
    text: "麦克风启动失败，请检查录音设备后重试。",
  },
  "microphone-failed": {
    text: "麦克风启动失败，请检查录音设备后重试。",
  },
  "recognizer-unavailable": {
    text: "语音识别暂时不可用，请稍后重试。",
  },
  "asr_unavailable": {
    text: "云端流式语音识别暂不可用，请稍后重试。",
  },
};

export function createPetVoiceController(deps: {
  bridge: () => SpeechBridgeLike | undefined;
  initialBotName?: string;
  initialWakeWord?: string;
  initialCloudAsr?: PetCloudAsrConfig;
  cloudBridge?: CloudSpeechBridge;
  createWakeStandby?: typeof createWakeStandbySession;
  currentSpokenText?: () => string;
  onChange: (state: PetVoiceState) => void;
  /** Fired immediately when `你好 <botName>` is detected. */
  onWakeDetected: (info: { immediateCommand: string }) => void;
  /** Fired when user interrupts ongoing TTS playback via quasi-full-duplex barge-in. */
  onBargeIn?: (info: { initialText: string }) => void;
  /** Fired when a spoken command finishes after endpointing. */
  onUtterance: (text: string) => void;
}): PetVoiceController {
  const cloudBridge = deps.cloudBridge ?? createCloudSpeechBridge();
  const makeWakeStandby = deps.createWakeStandby ?? createWakeStandbySession;

  let cloudAsr: PetCloudAsrConfig = {
    available: deps.initialCloudAsr?.available === true,
    wsPath: deps.initialCloudAsr?.wsPath,
  };
  if (cloudAsr.wsPath) cloudBridge.setWsPath(cloudAsr.wsPath);

  let wakeEnabled = false;
  let botName = deps.initialBotName?.trim() || "多宝";
  let customWakeWord = sanitizeWakeWord(deps.initialWakeWord);
  let suspended = false;
  let disposed = false;
  let consecutiveFastFails = 0;

  let state: PetVoiceState = {
    active: false,
    wakeEnabled: false,
    phase: "idle",
    heard: "",
    error: null,
  };

  let sessionToken = 0;
  let unsubTranscript: (() => void) | null = null;
  let unsubEnd: (() => void) | null = null;
  let wakeStandbySession: WakeStandbySession | null = null;
  let bargeInStop: (() => void) | null = null;
  let endpointTimer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeRearmTimer: ReturnType<typeof setTimeout> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeHitRemainder: string | null = null;

  const useCloudMode = () => cloudAsr.available === true;

  const hotwordsForBot = (): Record<string, number> => ({
    [buildWakePhrase(botName, customWakeWord)]: 5,
    [botName]: 5,
    DoneBot: 5,
  });

  const emit = (patch: Partial<PetVoiceState>) => {
    const next: PetVoiceState = { ...state, ...patch };
    if (
      next.active === state.active
      && next.wakeEnabled === state.wakeEnabled
      && next.phase === state.phase
      && next.heard === state.heard
      && next.error === state.error
      && next.needsMicSettings === state.needsMicSettings
    ) {
      return;
    }
    state = next;
    deps.onChange(state);
  };

  const clearTimers = () => {
    for (const timer of [endpointTimer, maxTimer, idleTimeoutTimer, wakeRearmTimer, restartTimer]) {
      if (timer) clearTimeout(timer);
    }
    endpointTimer = null;
    maxTimer = null;
    idleTimeoutTimer = null;
    wakeRearmTimer = null;
    restartTimer = null;
  };

  const detachListeners = () => {
    unsubTranscript?.();
    unsubTranscript = null;
    unsubEnd?.();
    unsubEnd = null;
  };

  const stopBargeInMonitor = () => {
    bargeInStop?.();
    bargeInStop = null;
  };

  const stopWakeStandby = () => {
    wakeStandbySession?.stop();
    wakeStandbySession = null;
  };

  const stopCaptureNow = (options?: { preserveCloudBargeInHandoff?: boolean }) => {
    sessionToken += 1;
    wakeHitRemainder = null;
    clearTimers();
    detachListeners();
    stopWakeStandby();
    stopBargeInMonitor();
    void deps.bridge()?.speechStop?.();
    if (!options?.preserveCloudBargeInHandoff) {
      void cloudBridge.speechStop();
    }
  };

  const scheduleWakeStandby = (delayMs = WAKE_RESTART_DELAY_MS) => {
    if (disposed || suspended || !wakeEnabled) {
      if (!state.active) emit({ phase: "idle", heard: "" });
      return;
    }
    clearTimers();
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (disposed || suspended || !wakeEnabled || state.active) return;
      beginWakeStandby();
    }, delayMs);
  };

  const fireWakeHit = (token: number, immediateCommand: string) => {
    if (token !== sessionToken || disposed || suspended) return;
    consecutiveFastFails = 0;
    stopCaptureNow();
    emit({ active: true, phase: "waking", heard: immediateCommand, error: null });
    void deps.bridge()?.callActive?.(true);
    deps.onWakeDetected({ immediateCommand });
  };

  const beginCloudWakeStandby = () => {
    stopCaptureNow();
    const token = sessionToken;
    emit({ active: false, wakeEnabled: true, phase: "wake-standby", heard: "", error: null, needsMicSettings: false });

    wakeStandbySession = makeWakeStandby({
      wsPath: cloudAsr.wsPath,
      botName,
      wakeWord: customWakeWord,
      matchWakeWord,
      onWakeHit: ({ remainder, final }) => {
        if (token !== sessionToken || disposed || suspended || state.phase !== "wake-standby") return;
        if (!remainder) {
          fireWakeHit(token, "");
          return;
        }
        wakeHitRemainder = remainder;
        emit({ heard: remainder });
        if (endpointTimer) clearTimeout(endpointTimer);
        if (final) {
          fireWakeHit(token, remainder);
        } else {
          endpointTimer = setTimeout(() => {
            if (token !== sessionToken) return;
            fireWakeHit(token, wakeHitRemainder ?? "");
          }, WAKE_REMAINDER_SETTLE_MS);
        }
      },
      onError: ({ code, message, fatal }) => {
        if (token !== sessionToken || disposed) return;
        const mapped = SPEECH_ERROR_TEXT[code];
        if (code === "asr_unavailable") {
          // Smoothly fall back to native dictation if cloud ASR is unavailable at runtime.
          stopWakeStandby();
          if (deps.bridge()?.speechStart) {
            beginNativeWakeStandby();
            return;
          }
        }
        if (fatal || mapped?.fatal) {
          wakeEnabled = false;
          stopCaptureNow();
          emit({
            active: false,
            wakeEnabled: false,
            phase: "idle",
            heard: "",
            error: mapped?.text ?? message,
            needsMicSettings: mapped?.needsMicSettings,
          });
        }
      },
    });
  };

  const beginNativeWakeStandby = () => {
    const bridge = deps.bridge();
    if (!bridge?.speechStart || !bridge.onSpeechTranscript || !bridge.onSpeechEnd) {
      emit({
        active: false,
        wakeEnabled: false,
        phase: "idle",
        heard: "",
        error: "当前环境暂不支持语音唤醒。",
        needsMicSettings: false,
      });
      return;
    }

    stopCaptureNow();
    const token = sessionToken;
    const startedAt = Date.now();
    emit({ active: false, wakeEnabled: true, phase: "wake-standby", heard: "", error: null, needsMicSettings: false });

    unsubTranscript = bridge.onSpeechTranscript((line) => {
      if (token !== sessionToken || disposed || suspended || state.phase !== "wake-standby") return;
      consecutiveFastFails = 0;
      const text = typeof line?.text === "string" ? line.text : "";
      if (!text) return;
      const matched = matchWakeWord(text, botName, customWakeWord);
      if (!matched.matched) return;

      if (!matched.remainder) {
        fireWakeHit(token, "");
        return;
      }

      wakeHitRemainder = matched.remainder;
      emit({ heard: matched.remainder });
      if (endpointTimer) clearTimeout(endpointTimer);
      if (line?.final || line?.partial === false) {
        fireWakeHit(token, matched.remainder);
      } else {
        endpointTimer = setTimeout(() => {
          if (token !== sessionToken) return;
          fireWakeHit(token, wakeHitRemainder ?? "");
        }, WAKE_REMAINDER_SETTLE_MS);
      }
    });

    unsubEnd = bridge.onSpeechEnd((info) => {
      if (token !== sessionToken || disposed) return;
      clearTimers();
      detachListeners();
      if (wakeHitRemainder !== null) {
        const cmd = wakeHitRemainder;
        wakeHitRemainder = null;
        fireWakeHit(token, cmd);
        return;
      }
      const reason = info?.reason ?? "";
      const elapsed = Date.now() - startedAt;

      if (reason && SPEECH_ERROR_TEXT[reason]?.fatal) {
        const mapped = SPEECH_ERROR_TEXT[reason]!;
        wakeEnabled = false;
        emit({
          active: false,
          wakeEnabled: false,
          phase: "idle",
          heard: "",
          error: mapped.text,
          needsMicSettings: mapped.needsMicSettings,
        });
        return;
      }

      // Circuit breaker: prevent tight process-spawn loops if macOS helper exits rapidly.
      if (elapsed < FAST_FAIL_WINDOW_MS && reason !== "completed") {
        consecutiveFastFails += 1;
        if (consecutiveFastFails >= MAX_CONSECUTIVE_FAST_FAILS) {
          wakeEnabled = false;
          const mapped = SPEECH_ERROR_TEXT[reason];
          emit({
            active: false,
            wakeEnabled: false,
            phase: "idle",
            heard: "",
            error: mapped?.text ?? "语音唤醒未能正常启动，请检查系统麦克风和语音识别权限后重新开启。",
            needsMicSettings: true,
          });
          return;
        }
        const delay = BACKOFF_MS[Math.min(consecutiveFastFails - 1, BACKOFF_MS.length - 1)] ?? 5_000;
        scheduleWakeStandby(delay);
        return;
      }

      consecutiveFastFails = 0;
      scheduleWakeStandby(WAKE_RESTART_DELAY_MS);
    });

    // Apple SFSpeechRecognizer stops around ~60s; proactively rotate cleanly at 45s.
    wakeRearmTimer = setTimeout(() => {
      if (token !== sessionToken || disposed || suspended || state.phase !== "wake-standby") return;
      if (wakeHitRemainder !== null) return;
      consecutiveFastFails = 0;
      stopCaptureNow();
      scheduleWakeStandby(WAKE_RESTART_DELAY_MS);
    }, WAKE_REARM_MS);

    try {
      void bridge.speechStart({});
    } catch {
      consecutiveFastFails += 1;
      if (consecutiveFastFails >= MAX_CONSECUTIVE_FAST_FAILS) {
        wakeEnabled = false;
        emit({ active: false, wakeEnabled: false, phase: "idle", heard: "", error: "语音唤醒启动失败，请稍后重试。" });
        return;
      }
      scheduleWakeStandby(3_000);
    }
  };

  const beginWakeStandby = () => {
    if (disposed || suspended || !wakeEnabled) return;
    if (useCloudMode()) {
      beginCloudWakeStandby();
      return;
    }
    beginNativeWakeStandby();
  };

  const beginCommandListening = (options?: { adoptBargeIn?: boolean; initialHeard?: string; forceNative?: boolean }) => {
    if (disposed || suspended) return;
    const preferCloud = useCloudMode() && !options?.forceNative;
    const bridge: SpeechBridgeLike | undefined = preferCloud ? cloudBridge : deps.bridge();

    if (!bridge?.speechStart || !bridge.onSpeechTranscript || !bridge.onSpeechEnd) {
      emit({
        active: false,
        phase: "idle",
        heard: "",
        error: "当前环境暂不支持语音对话，请使用输入栏。",
        needsMicSettings: false,
      });
      return;
    }

    const adopt = preferCloud && options?.adoptBargeIn === true && cloudBridge.hasActiveBargeInHandoff();
    stopCaptureNow({ preserveCloudBargeInHandoff: adopt });
    const token = sessionToken;
    const initialHeard = options?.initialHeard?.trim() ?? "";
    emit({ active: true, phase: "listening", heard: initialHeard, error: null, needsMicSettings: false });
    void deps.bridge()?.callActive?.(true);

    let heardAnyWord = Boolean(initialHeard);

    unsubTranscript = bridge.onSpeechTranscript((line) => {
      if (token !== sessionToken || disposed || suspended || state.phase !== "listening") return;
      const text = typeof line?.text === "string" ? line.text : "";
      emit({ heard: text });
      if (text.trim()) {
        heardAnyWord = true;
        if (idleTimeoutTimer) {
          clearTimeout(idleTimeoutTimer);
          idleTimeoutTimer = null;
        }
        if (endpointTimer) clearTimeout(endpointTimer);
        const isFinal = line?.final === true || line?.partial === false;
        if (isFinal) {
          if (!preferCloud) void bridge.speechFinish?.();
        } else {
          endpointTimer = setTimeout(() => {
            if (token === sessionToken && state.phase === "listening") {
              void bridge.speechFinish?.();
            }
          }, COMMAND_ENDPOINT_MS);
        }
      }
    });

    unsubEnd = bridge.onSpeechEnd((info) => {
      if (token !== sessionToken || disposed) return;
      clearTimers();
      detachListeners();
      if (!state.active) return;

      const reason = info?.reason ?? "";
      if (preferCloud && reason === "asr_unavailable" && deps.bridge()?.speechStart) {
        // Fallback smoothly to native dictation if cloud ASR became unavailable mid-session.
        beginCommandListening({ forceNative: true });
        return;
      }

      if (reason && (SPEECH_ERROR_TEXT[reason] || info?.code === 1)) {
        const mapped = SPEECH_ERROR_TEXT[reason];
        void deps.bridge()?.callActive?.(false);
        emit({
          active: false,
          phase: "idle",
          heard: "",
          error: mapped?.text ?? info?.message ?? "语音识别中断，请重试。",
          needsMicSettings: mapped?.needsMicSettings,
        });
        return;
      }

      const words = state.heard.trim();
      if (!words) {
        void deps.bridge()?.callActive?.(false);
        emit({ active: false, phase: "idle", heard: "" });
        scheduleWakeStandby(WAKE_RESTART_DELAY_MS);
        return;
      }

      emit({ phase: "sending" });
      deps.onUtterance(words);
    });

    if (!heardAnyWord) {
      idleTimeoutTimer = setTimeout(() => {
        if (token !== sessionToken || heardAnyWord || state.phase !== "listening") return;
        stopCaptureNow();
        void deps.bridge()?.callActive?.(false);
        emit({ active: false, phase: "idle", heard: "" });
        scheduleWakeStandby(WAKE_RESTART_DELAY_MS);
      }, COMMAND_IDLE_TIMEOUT_MS);
    }

    maxTimer = setTimeout(() => {
      if (token === sessionToken && state.phase === "listening") {
        void bridge.speechFinish?.();
      }
    }, MAX_COMMAND_MS);

    try {
      const startOpts = preferCloud
        ? {
            endpointMs: COMMAND_ENDPOINT_MS,
            hotwords: hotwordsForBot(),
            ...(adopt ? { adoptBargeIn: true } : {}),
          }
        : { endpointMs: COMMAND_ENDPOINT_MS };
      void bridge.speechStart(startOpts);
    } catch {
      clearTimers();
      detachListeners();
      void deps.bridge()?.callActive?.(false);
      emit({ active: false, phase: "idle", heard: "", error: "语音识别启动失败，请重试。" });
      scheduleWakeStandby(2_500);
    }
  };

  const armSpeakingBargeIn = () => {
    if (disposed || suspended || !useCloudMode()) return;
    stopBargeInMonitor();
    const token = sessionToken;
    bargeInStop = cloudBridge.startBargeInMonitor({
      wsPath: cloudAsr.wsPath,
      spokenText: () => deps.currentSpokenText?.() ?? "",
      hotwords: hotwordsForBot(),
      onBargeIn: ({ text }) => {
        if (disposed || suspended || token !== sessionToken) return;
        deps.onBargeIn?.({ initialText: text });
        beginCommandListening({ adoptBargeIn: true, initialHeard: text });
      },
    });
  };

  return {
    setWakeEnabled(enabled) {
      const nextEnabled = enabled === true;
      if (nextEnabled) consecutiveFastFails = 0;
      wakeEnabled = nextEnabled;
      suspended = false;
      emit({ wakeEnabled });
      if (disposed) return;
      if (wakeEnabled) {
        if (!state.active && state.phase === "idle") {
          scheduleWakeStandby(350);
        }
      } else if (state.phase === "wake-standby") {
        stopCaptureNow();
        emit({ phase: "idle", heard: "" });
      }
    },

    setBotName(name) {
      const trimmed = name.trim();
      if (trimmed) {
        botName = trimmed;
        wakeStandbySession?.setBotName(trimmed);
      }
    },

    setWakeWord(next) {
      const cleaned = sanitizeWakeWord(next);
      if (cleaned === customWakeWord) return;
      customWakeWord = cleaned;
      wakeStandbySession?.setWakeWord(cleaned);
    },

    setCloudAsr(config) {
      const nextAvailable = config.available === true;
      const nextWsPath = config.wsPath;
      const changed = nextAvailable !== cloudAsr.available || nextWsPath !== cloudAsr.wsPath;
      cloudAsr = { available: nextAvailable, wsPath: nextWsPath };
      if (nextWsPath) cloudBridge.setWsPath(nextWsPath);
      if (!changed || disposed || suspended) return;
      if (state.phase === "wake-standby" && wakeEnabled) {
        beginWakeStandby();
      }
    },

    startCommandListening(options) {
      if (disposed) return;
      suspended = false;
      consecutiveFastFails = 0;
      beginCommandListening(options);
    },

    stopConversation() {
      stopCaptureNow();
      void deps.bridge()?.callActive?.(false);
      emit({ active: false, phase: "idle", heard: "", error: null, needsMicSettings: false });
      scheduleWakeStandby(WAKE_RESTART_DELAY_MS);
    },

    suspend() {
      suspended = true;
      stopCaptureNow();
      void deps.bridge()?.callActive?.(false);
      emit({ active: false, phase: "idle", heard: "" });
    },

    markWaking() {
      stopCaptureNow();
      emit({ active: true, phase: "waking" });
      if (useCloudMode()) {
        armSpeakingBargeIn();
      }
    },

    markWorking() {
      if (!state.active) return;
      stopCaptureNow();
      const nextPhase: PetVoicePhase = "working";
      emit({ phase: nextPhase });
    },

    markSpeaking() {
      stopCaptureNow();
      if (state.active) {
        emit({ phase: "speaking" });
      }
      // In cloud streaming ASR mode, keep AEC barge-in armed during TTS playback instead of muting the mic.
      if (useCloudMode() && (state.active || wakeEnabled)) {
        armSpeakingBargeIn();
      }
    },

    afterSpeaking(options) {
      stopBargeInMonitor();
      if (disposed || suspended) return;
      // If barge-in already transitioned into active listening, never clobber it.
      if (state.phase === "listening") return;
      if (options?.expectCommand) {
        restartTimer = setTimeout(() => {
          restartTimer = null;
          if (!disposed && !suspended && state.phase !== "listening") beginCommandListening();
        }, 200);
        return;
      }
      if (state.active) {
        restartTimer = setTimeout(() => {
          restartTimer = null;
          if (!disposed && !suspended && state.active && state.phase !== "listening") beginCommandListening();
        }, 240);
        return;
      }
      if (wakeEnabled) {
        scheduleWakeStandby(350);
      }
    },

    dispose() {
      disposed = true;
      suspended = true;
      stopCaptureNow();
      void deps.bridge()?.callActive?.(false);
    },
  };
}
