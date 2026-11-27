/**
 * Low-latency streaming PCM audio player (24kHz 16-bit signed LE mono) backed by Web Audio API.
 * Output stays inside Chromium's audio graph so WebRTC/getUserMedia AEC cancels playback cleanly.
 * Calling `stop()` or aborting the signal halts all scheduled AudioBufferSourceNodes immediately
 * for responsive quasi-full-duplex barge-in.
 */

export const DEFAULT_TTS_PCM_SAMPLE_RATE = 24_000;

export function decodePcm16LeToFloat32(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(new ArrayBuffer(sampleCount * 4));
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = view.getInt16(i * 2, true);
    out[i] = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
  }
  return out;
}

export interface StreamingPcmPlayer {
  playResponse(response: Response, signal: AbortSignal, defaultSampleRate?: number): Promise<boolean>;
  stop(): void;
}

export function createStreamingPcmPlayer(deps?: {
  createAudioContext?: (sampleRate: number) => AudioContext;
}): StreamingPcmPlayer {
  let activeContext: AudioContext | null = null;
  let activeSources = new Set<AudioBufferSourceNode>();
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const pendingResolvers = new Set<() => void>();

  const flushResolvers = () => {
    for (const resolve of Array.from(pendingResolvers)) {
      pendingResolvers.delete(resolve);
      resolve();
    }
  };

  const stop = () => {
    const reader = activeReader;
    activeReader = null;
    if (reader) {
      void reader.cancel().catch(() => {});
    }
    for (const source of Array.from(activeSources)) {
      try {
        source.onended = null;
        source.stop();
        source.disconnect();
      } catch {}
    }
    activeSources.clear();
    flushResolvers();
    if (activeContext) {
      const ctx = activeContext;
      activeContext = null;
      void ctx.close().catch(() => {});
    }
  };

  return {
    async playResponse(response, signal, defaultSampleRate = DEFAULT_TTS_PCM_SAMPLE_RATE) {
      if (signal.aborted || !response.body) return false;
      const AudioCtx = typeof AudioContext !== "undefined" ? AudioContext : undefined;
      if (!deps?.createAudioContext && !AudioCtx) return false;

      const headerRate = Number(response.headers?.get?.("x-audio-sample-rate"));
      const sampleRate = Number.isFinite(headerRate) && headerRate >= 8_000 && headerRate <= 48_000
        ? Math.round(headerRate)
        : defaultSampleRate;

      stop();
      let ctx: AudioContext;
      try {
        ctx = deps?.createAudioContext ? deps.createAudioContext(sampleRate) : new AudioCtx!({ sampleRate });
      } catch {
        return false;
      }
      activeContext = ctx;
      if (typeof ctx.resume === "function" && ctx.state === "suspended") {
        await ctx.resume().catch(() => {});
      }

      const reader = response.body.getReader();
      activeReader = reader;
      let trailingByte: number | null = null;
      let nextTime = ctx.currentTime + 0.025;
      let receivedAnyAudio = false;
      let lastEndPromise: Promise<void> = Promise.resolve();

      const onAbort = () => stop();
      signal.addEventListener("abort", onAbort, { once: true });

      const scheduleBytes = (raw: Uint8Array) => {
        if (!raw.byteLength || signal.aborted || activeContext !== ctx) return;
        let combined: Uint8Array;
        if (trailingByte !== null) {
          combined = new Uint8Array(raw.byteLength + 1);
          combined[0] = trailingByte;
          combined.set(raw, 1);
          trailingByte = null;
        } else {
          combined = raw;
        }
        if (combined.byteLength % 2 === 1) {
          trailingByte = combined[combined.byteLength - 1]!;
          combined = combined.subarray(0, combined.byteLength - 1);
        }
        if (combined.byteLength < 2) return;

        const floats = decodePcm16LeToFloat32(combined);
        if (!floats.length) return;
        receivedAnyAudio = true;

        const buffer = ctx.createBuffer(1, floats.length, sampleRate);
        buffer.copyToChannel(floats, 0);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);

        const now = ctx.currentTime;
        const startAt = Math.max(now + 0.01, nextTime);
        nextTime = startAt + buffer.duration;
        activeSources.add(source);

        lastEndPromise = new Promise<void>((resolve) => {
          const finishSource = () => {
            pendingResolvers.delete(finishSource);
            activeSources.delete(source);
            try { source.disconnect(); } catch {}
            resolve();
          };
          pendingResolvers.add(finishSource);
          source.onended = finishSource;
        });
        source.start(startAt);
      };

      try {
        while (!signal.aborted && activeContext === ctx) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            scheduleBytes(value);
          }
        }
        if (signal.aborted || activeContext !== ctx) return false;
        if (!receivedAnyAudio) return false;
        await lastEndPromise;
        return !signal.aborted && activeContext === ctx;
      } catch {
        return false;
      } finally {
        signal.removeEventListener("abort", onAbort);
        if (activeReader === reader) activeReader = null;
        if (activeContext === ctx) stop();
      }
    },
    stop,
  };
}
