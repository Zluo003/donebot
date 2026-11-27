/**
 * Pure audio utilities for client-side real-time ASR:
 * - Resampling arbitrary AudioContext sample rates down to 16kHz mono
 * - 16-bit signed little-endian PCM encoding
 * - Fixed-size frame chunking (default 80ms) and pre-roll ring buffer (~400ms)
 * - Lightweight adaptive-noise-floor local VAD gate for zero-cost standby and barge-in gating
 */

export const ASR_SAMPLE_RATE = 16_000;
export const ASR_BYTES_PER_SAMPLE = 2;
export const ASR_CHUNK_MS = 80;
export const DEFAULT_PRE_ROLL_MS = 400;

export function computeRms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i]!;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Resamples mono Float32 PCM from `fromRate` to `toRate`.
 * Uses box averaging when downsampling to attenuate aliasing above the target Nyquist frequency.
 */
export function downsampleFloat32(
  input: Float32Array,
  fromRate: number,
  toRate = ASR_SAMPLE_RATE,
): Float32Array {
  if (!input.length || fromRate <= 0 || toRate <= 0 || fromRate === toRate) {
    return input;
  }
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLength);

  if (ratio > 1) {
    for (let i = 0; i < outLength; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let acc = 0;
      for (let j = start; j < end; j += 1) acc += input[j]!;
      out[i] = acc / (end - start);
    }
    return out;
  }

  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[Math.min(input.length - 1, idx + 1)] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Encodes mono Float32 [-1, 1] samples into 16-bit signed little-endian PCM bytes. */
export function float32ToPcm16(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(samples.length * ASR_BYTES_PER_SAMPLE);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    const int16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(i * 2, Math.max(-32768, Math.min(32767, int16)), true);
  }
  return new Uint8Array(buffer);
}

/** Splits arbitrary PCM byte slices into uniform chunks (default 80ms = 2560 bytes at 16kHz). */
export class PcmChunker {
  private readonly chunkBytes: number;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;

  constructor(chunkMs = ASR_CHUNK_MS, sampleRate = ASR_SAMPLE_RATE) {
    const samples = Math.max(160, Math.round((sampleRate * chunkMs) / 1000));
    this.chunkBytes = samples * ASR_BYTES_PER_SAMPLE;
  }

  push(bytes: Uint8Array): Uint8Array<ArrayBuffer>[] {
    if (!bytes.byteLength) return [];
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    this.pending.push(copy);
    this.pendingBytes += copy.byteLength;

    const ready: Uint8Array<ArrayBuffer>[] = [];
    while (this.pendingBytes >= this.chunkBytes) {
      ready.push(this.take(this.chunkBytes));
    }
    return ready;
  }

  flush(): Uint8Array<ArrayBuffer> | null {
    if (this.pendingBytes === 0) return null;
    // Keep even byte length so every Int16 sample stays aligned.
    const evenBytes = this.pendingBytes - (this.pendingBytes % ASR_BYTES_PER_SAMPLE);
    if (evenBytes === 0) return null;
    return this.take(evenBytes);
  }

  clear(): void {
    this.pending = [];
    this.pendingBytes = 0;
  }

  private take(size: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(new ArrayBuffer(size));
    let offset = 0;
    while (offset < size && this.pending.length > 0) {
      const head = this.pending[0]!;
      const needed = size - offset;
      if (head.byteLength <= needed) {
        out.set(head, offset);
        offset += head.byteLength;
        this.pending.shift();
      } else {
        out.set(head.subarray(0, needed), offset);
        this.pending[0] = head.subarray(needed);
        offset += needed;
      }
    }
    this.pendingBytes -= offset;
    return out;
  }
}

/**
 * Bounded FIFO ring buffer storing the most recent `maxDurationMs` of 16-bit mono PCM audio.
 * Used during zero-cost local standby / barge-in gating so the opening syllables (~400ms)
 * are flushed immediately when cloud ASR WS connects.
 */
export class PcmRingBuffer {
  readonly maxBytes: number;
  readonly sampleRate: number;
  private chunks: Uint8Array<ArrayBuffer>[] = [];
  private totalBytes = 0;

  constructor(maxDurationMs = DEFAULT_PRE_ROLL_MS, sampleRate = ASR_SAMPLE_RATE) {
    this.sampleRate = sampleRate;
    const maxSamples = Math.max(1, Math.ceil((sampleRate * maxDurationMs) / 1000));
    this.maxBytes = maxSamples * ASR_BYTES_PER_SAMPLE;
  }

  push(chunk: Uint8Array): void {
    if (!chunk.byteLength) return;
    const copy = new Uint8Array(new ArrayBuffer(chunk.byteLength));
    copy.set(chunk);
    this.chunks.push(copy);
    this.totalBytes += copy.byteLength;
    while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.totalBytes -= dropped.byteLength;
    }
    if (this.totalBytes > this.maxBytes && this.chunks.length === 1) {
      const single = this.chunks[0]!;
      const excess = single.byteLength - this.maxBytes;
      const evenExcess = excess + (excess % ASR_BYTES_PER_SAMPLE);
      const trimmed = new Uint8Array(new ArrayBuffer(Math.max(0, single.byteLength - evenExcess)));
      trimmed.set(single.subarray(evenExcess));
      this.chunks[0] = trimmed;
      this.totalBytes = trimmed.byteLength;
    }
  }

  snapshot(): Uint8Array<ArrayBuffer>[] {
    return this.chunks.map((c) => c.slice());
  }

  drain(): Uint8Array<ArrayBuffer>[] {
    const out = this.chunks;
    this.chunks = [];
    this.totalBytes = 0;
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }

  get byteLength(): number {
    return this.totalBytes;
  }

  get durationMs(): number {
    return (this.totalBytes / (this.sampleRate * ASR_BYTES_PER_SAMPLE)) * 1000;
  }
}

export type LocalVadMode = "standby" | "barge-in";

export interface LocalVadOptions {
  mode?: LocalVadMode;
  standbyRmsThreshold?: number;
  bargeInRmsThreshold?: number;
  standbyOnsetMs?: number;
  bargeInOnsetMs?: number;
  noiseMultiplier?: number;
  bargeInNoiseMultiplier?: number;
  maxNoiseFloor?: number;
  initialNoiseFloor?: number;
  silenceHoldMs?: number;
}

export interface LocalVadResult {
  rms: number;
  threshold: number;
  noiseFloor: number;
  isSpeech: boolean;
  onsetTriggered: boolean;
  consecutiveSpeechMs: number;
  silenceElapsedMs: number;
}

/**
 * Adaptive local voice activity detector.
 * Tracks ambient noise floor slowly during silence so steady background fans/AC do not
 * falsely trigger cloud ASR connections during standby.
 */
export class LocalVadGate {
  private mode: LocalVadMode;
  private readonly standbyRmsThreshold: number;
  private readonly bargeInRmsThreshold: number;
  private readonly standbyOnsetMs: number;
  private readonly bargeInOnsetMs: number;
  private readonly noiseMultiplier: number;
  private readonly bargeInNoiseMultiplier: number;
  private readonly maxNoiseFloor: number;
  private readonly silenceHoldMs: number;

  private noiseFloor: number;
  private inSpeech = false;
  private consecutiveSpeechMs = 0;
  private silenceElapsedMs = 0;

  constructor(opts: LocalVadOptions = {}) {
    this.mode = opts.mode ?? "standby";
    this.standbyRmsThreshold = opts.standbyRmsThreshold ?? 0.018;
    this.bargeInRmsThreshold = opts.bargeInRmsThreshold ?? 0.032;
    this.standbyOnsetMs = opts.standbyOnsetMs ?? 160;
    this.bargeInOnsetMs = opts.bargeInOnsetMs ?? 240;
    this.noiseMultiplier = opts.noiseMultiplier ?? 2.6;
    this.bargeInNoiseMultiplier = opts.bargeInNoiseMultiplier ?? 3.0;
    this.maxNoiseFloor = opts.maxNoiseFloor ?? 0.035;
    this.noiseFloor = opts.initialNoiseFloor ?? 0.004;
    this.silenceHoldMs = opts.silenceHoldMs ?? 1_500;
  }

  setMode(mode: LocalVadMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.inSpeech = false;
    this.consecutiveSpeechMs = 0;
    this.silenceElapsedMs = 0;
  }

  getMode(): LocalVadMode {
    return this.mode;
  }

  reset(): void {
    this.inSpeech = false;
    this.consecutiveSpeechMs = 0;
    this.silenceElapsedMs = 0;
  }

  currentThreshold(): number {
    const base = this.mode === "barge-in" ? this.bargeInRmsThreshold : this.standbyRmsThreshold;
    const mult = this.mode === "barge-in" ? this.bargeInNoiseMultiplier : this.noiseMultiplier;
    return Math.max(base, Math.min(this.maxNoiseFloor, this.noiseFloor) * mult);
  }

  feed(rmsValue: number, frameMs: number): LocalVadResult {
    const safeRms = Number.isFinite(rmsValue) && rmsValue > 0 ? rmsValue : 0;
    const safeMs = Number.isFinite(frameMs) && frameMs > 0 ? frameMs : ASR_CHUNK_MS;
    const threshold = this.currentThreshold();
    const onsetTarget = this.mode === "barge-in" ? this.bargeInOnsetMs : this.standbyOnsetMs;
    let onsetTriggered = false;

    if (safeRms >= threshold) {
      this.consecutiveSpeechMs += safeMs;
      this.silenceElapsedMs = 0;
      if (!this.inSpeech && this.consecutiveSpeechMs >= onsetTarget) {
        this.inSpeech = true;
        onsetTriggered = true;
      }
    } else {
      if (this.inSpeech) {
        this.silenceElapsedMs += safeMs;
        if (this.silenceElapsedMs >= this.silenceHoldMs) {
          this.inSpeech = false;
          this.consecutiveSpeechMs = 0;
        }
      } else {
        this.consecutiveSpeechMs = Math.max(0, this.consecutiveSpeechMs - safeMs);
        // Slowly track ambient noise floor only when idle in silence.
        this.noiseFloor = this.noiseFloor * 0.96 + Math.min(safeRms, this.maxNoiseFloor) * 0.04;
      }
    }

    return {
      rms: safeRms,
      threshold,
      noiseFloor: this.noiseFloor,
      isSpeech: this.inSpeech,
      onsetTriggered,
      consecutiveSpeechMs: this.consecutiveSpeechMs,
      silenceElapsedMs: this.silenceElapsedMs,
    };
  }
}
