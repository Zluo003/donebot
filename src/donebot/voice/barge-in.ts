/**
 * Dual-gate barge-in guard for quasi-full-duplex voice conversation.
 * Prevents speaker residual echo or brief desk noises from falsely interrupting TTS:
 * 1. Startup AEC convergence grace window after TTS starts.
 * 2. Sustained local voice activity above elevated barge-in threshold (opens cloud ASR on demand only).
 * 3. Cloud confirmation (`speech_started` during active sustained voice, or non-echo transcript text).
 */

export const DEFAULT_BARGE_IN_GRACE_MS = 350;
export const DEFAULT_BARGE_IN_LOCAL_MIN_MS = 240;
export const DEFAULT_BARGE_IN_SPEECH_STARTED_LOCAL_MIN_MS = 320;
export const DEFAULT_BARGE_IN_CONFIRM_WINDOW_MS = 1_800;
export const DEFAULT_BARGE_IN_RECENT_SPEECH_WINDOW_MS = 650;

const FILLER_SINGLE_CHARS = new Set(["嗯", "啊", "呃", "哦", "噢", "喂", "哎", "呀", "哈", "唉", "唔"]);

export function normalizeComparableText(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\s`~!@#$%^&*()\-_=+[\]{}\\|;:'",.<>/?，。！？、；：（）【】《》“”‘’…—·～]+/g, "")
    .trim();
}

/**
 * Estimates whether a short ASR transcript during TTS playback is likely residual acoustic echo
 * of the assistant's own spoken text.
 */
export function isLikelyTtsEcho(transcript: string, currentSpokenText: string): boolean {
  const normHeard = normalizeComparableText(transcript);
  if (!normHeard) return true;
  if (normHeard.length === 1 && FILLER_SINGLE_CHARS.has(normHeard)) return true;

  const normSpoken = normalizeComparableText(currentSpokenText);
  if (!normSpoken) return false;

  if (normHeard.length <= 6 && normSpoken.includes(normHeard)) {
    return true;
  }

  if (normHeard.length > 6) {
    if (normSpoken.includes(normHeard)) return true;
    const bigrams = new Set<string>();
    for (let i = 0; i < normSpoken.length - 1; i += 1) {
      bigrams.add(normSpoken.slice(i, i + 2));
    }
    if (bigrams.size > 0) {
      let overlap = 0;
      const total = normHeard.length - 1;
      for (let i = 0; i < total; i += 1) {
        if (bigrams.has(normHeard.slice(i, i + 2))) overlap += 1;
      }
      if (overlap / total >= 0.78) return true;
    }
  }

  return false;
}

export function isMeaningfulBargeInText(transcript: string, currentSpokenText: string): boolean {
  const norm = normalizeComparableText(transcript);
  if (!norm) return false;
  // Require at least 1 CJK character or >= 2 Latin/digit characters.
  const hasCjk = /[\u4e00-\u9fff]/.test(norm);
  if (!hasCjk && norm.length < 2) return false;
  if (norm.length === 1 && FILLER_SINGLE_CHARS.has(norm)) return false;
  return !isLikelyTtsEcho(transcript, currentSpokenText);
}

export interface BargeInGuardOptions {
  graceMs?: number;
  localMinMs?: number;
  speechStartedLocalMinMs?: number;
  confirmWindowMs?: number;
  recentSpeechWindowMs?: number;
  /** When true, cloud `speech_started` alone cannot trigger barge-in; non-echo text is required. */
  requireTranscript?: boolean;
}

export class BargeInGuard {
  private readonly graceMs: number;
  private readonly localMinMs: number;
  private readonly speechStartedLocalMinMs: number;
  private readonly confirmWindowMs: number;
  private readonly recentSpeechWindowMs: number;
  private readonly requireTranscript: boolean;

  private active = false;
  private startedAt = 0;
  private spokenText = "";
  private asrRequested = false;
  private asrRequestedAt = 0;
  private lastLocalSpeechAt = 0;
  private maxLocalSpeechMs = 0;
  private triggered = false;

  constructor(opts: BargeInGuardOptions = {}) {
    this.graceMs = opts.graceMs ?? DEFAULT_BARGE_IN_GRACE_MS;
    this.localMinMs = opts.localMinMs ?? DEFAULT_BARGE_IN_LOCAL_MIN_MS;
    this.speechStartedLocalMinMs = opts.speechStartedLocalMinMs ?? DEFAULT_BARGE_IN_SPEECH_STARTED_LOCAL_MIN_MS;
    this.confirmWindowMs = opts.confirmWindowMs ?? DEFAULT_BARGE_IN_CONFIRM_WINDOW_MS;
    this.recentSpeechWindowMs = opts.recentSpeechWindowMs ?? DEFAULT_BARGE_IN_RECENT_SPEECH_WINDOW_MS;
    this.requireTranscript = opts.requireTranscript ?? false;
  }

  start(spokenText: string, now = Date.now()): void {
    this.active = true;
    this.startedAt = now;
    this.spokenText = spokenText;
    this.asrRequested = false;
    this.asrRequestedAt = 0;
    this.lastLocalSpeechAt = 0;
    this.maxLocalSpeechMs = 0;
    this.triggered = false;
  }

  updateSpokenText(spokenText: string): void {
    this.spokenText = spokenText;
  }

  reset(): void {
    this.active = false;
    this.startedAt = 0;
    this.spokenText = "";
    this.asrRequested = false;
    this.asrRequestedAt = 0;
    this.lastLocalSpeechAt = 0;
    this.maxLocalSpeechMs = 0;
    this.triggered = false;
  }

  isActive(): boolean {
    return this.active && !this.triggered;
  }

  isAsrRequested(): boolean {
    return this.asrRequested;
  }

  onLocalVad(
    info: { isSpeech: boolean; consecutiveSpeechMs: number },
    now = Date.now(),
  ): { shouldOpenAsr: boolean; shouldCloseAsr: boolean } {
    if (!this.active || this.triggered) {
      return { shouldOpenAsr: false, shouldCloseAsr: false };
    }
    if (now - this.startedAt < this.graceMs) {
      return { shouldOpenAsr: false, shouldCloseAsr: false };
    }

    if (info.isSpeech && info.consecutiveSpeechMs >= this.localMinMs) {
      this.lastLocalSpeechAt = now;
      this.maxLocalSpeechMs = Math.max(this.maxLocalSpeechMs, info.consecutiveSpeechMs);
      if (!this.asrRequested) {
        this.asrRequested = true;
        this.asrRequestedAt = now;
        return { shouldOpenAsr: true, shouldCloseAsr: false };
      }
      return { shouldOpenAsr: false, shouldCloseAsr: false };
    }

    if (
      this.asrRequested
      && !info.isSpeech
      && now - Math.max(this.asrRequestedAt, this.lastLocalSpeechAt) >= this.confirmWindowMs
    ) {
      this.asrRequested = false;
      this.asrRequestedAt = 0;
      this.maxLocalSpeechMs = 0;
      return { shouldOpenAsr: false, shouldCloseAsr: true };
    }

    return { shouldOpenAsr: false, shouldCloseAsr: false };
  }

  onCloudSpeechStarted(now = Date.now()): boolean {
    if (!this.active || this.triggered || this.requireTranscript) return false;
    if (now - this.startedAt < this.graceMs) return false;
    const recentStrongLocalVoice = this.lastLocalSpeechAt > 0
      && now - this.lastLocalSpeechAt <= this.recentSpeechWindowMs
      && this.maxLocalSpeechMs >= this.speechStartedLocalMinMs;
    if (!recentStrongLocalVoice) return false;
    this.triggered = true;
    return true;
  }

  onCloudTranscript(text: string, now = Date.now()): { triggered: boolean; text: string } {
    if (!this.active || this.triggered) return { triggered: false, text: "" };
    if (now - this.startedAt < this.graceMs) return { triggered: false, text: "" };
    const clean = String(text ?? "").trim();
    if (!isMeaningfulBargeInText(clean, this.spokenText)) {
      return { triggered: false, text: "" };
    }
    this.triggered = true;
    return { triggered: true, text: clean };
  }
}
