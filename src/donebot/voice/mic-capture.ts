/**
 * Browser AEC microphone capture yielding uniform 16kHz 16-bit mono PCM chunks + frame RMS.
 * Keeps output routed through a zero-gain sink so microphone audio never plays back into speakers,
 * while Chromium's getUserMedia AEC cancels HTMLAudioElement / Web Audio TTS playback cleanly.
 */

import { ASR_CHUNK_MS, ASR_SAMPLE_RATE, PcmChunker, computeRms, downsampleFloat32, float32ToPcm16 } from "./pcm";

export interface MicChunk {
  pcm: Uint8Array<ArrayBuffer>;
  rms: number;
  durationMs: number;
}

export interface MicCaptureError {
  reason: "microphone-blocked" | "microphone-missing" | "microphone-failed";
  message: string;
}

export interface MicCaptureHandle {
  stop(): void;
  isActive(): boolean;
  setListener(onChunk: ((chunk: MicChunk) => void) | null): void;
}

export function classifyMicCaptureError(error: unknown): MicCaptureError {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return {
      reason: "microphone-blocked",
      message: "麦克风权限被拒绝，请在系统设置中允许 DoneBot 访问麦克风。",
    };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return {
      reason: "microphone-missing",
      message: "未检测到可用的麦克风设备，请检查录音输入设置。",
    };
  }
  return {
    reason: "microphone-failed",
    message: "麦克风启动失败，请检查录音设备后重试。",
  };
}

export interface MicCaptureDeps {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createAudioContext?: (sampleRate: number) => AudioContext;
  chunkMs?: number;
}

const SCRIPT_PROCESSOR_BUFFER_SIZE = 1024;

export async function startMicCapture(
  initialListener: (chunk: MicChunk) => void,
  deps?: MicCaptureDeps,
): Promise<MicCaptureHandle> {
  const chunkMs = deps?.chunkMs ?? ASR_CHUNK_MS;
  const getUserMedia = deps?.getUserMedia
    ?? ((constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints));

  const stream = await getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });

  let context: AudioContext;
  let source: MediaStreamAudioSourceNode;
  let processor: ScriptProcessorNode;
  let silentGain: GainNode | null = null;

  try {
    context = deps?.createAudioContext
      ? deps.createAudioContext(ASR_SAMPLE_RATE)
      : new AudioContext({ sampleRate: ASR_SAMPLE_RATE });
    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SIZE, 1, 1);
    if (typeof context.createGain === "function") {
      silentGain = context.createGain();
      silentGain.gain.value = 0;
    }
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    throw error;
  }

  let active = true;
  let listener: ((chunk: MicChunk) => void) | null = initialListener;
  const chunker = new PcmChunker(chunkMs, ASR_SAMPLE_RATE);
  const inputRate = typeof context.sampleRate === "number" && context.sampleRate > 0
    ? context.sampleRate
    : ASR_SAMPLE_RATE;

  processor.onaudioprocess = (event) => {
    if (!active || !listener) return;
    const raw = event.inputBuffer.getChannelData(0);
    if (!raw || raw.length === 0) return;
    const copied = new Float32Array(raw.length);
    copied.set(raw);
    const mono16k = inputRate === ASR_SAMPLE_RATE
      ? copied
      : downsampleFloat32(copied, inputRate, ASR_SAMPLE_RATE);
    const pcmBytes = float32ToPcm16(mono16k);
    const chunks = chunker.push(pcmBytes);
    if (!chunks.length) return;
    const level = computeRms(mono16k);
    for (const chunk of chunks) {
      if (!active || !listener) return;
      const durationMs = (chunk.byteLength / (ASR_SAMPLE_RATE * 2)) * 1000;
      listener({ pcm: chunk, rms: level, durationMs });
    }
  };

  source.connect(processor);
  if (silentGain) {
    processor.connect(silentGain);
    silentGain.connect(context.destination);
  } else {
    processor.connect(context.destination);
  }
  void context.resume?.().catch(() => {});

  const stop = () => {
    if (!active) return;
    active = false;
    listener = null;
    chunker.clear();
    processor.onaudioprocess = null;
    try { source.disconnect(); } catch {}
    try { processor.disconnect(); } catch {}
    try { silentGain?.disconnect(); } catch {}
    for (const track of stream.getTracks()) {
      try { track.stop(); } catch {}
    }
    void context.close?.().catch(() => {});
  };

  return {
    stop,
    isActive: () => active,
    setListener(next) {
      if (active) listener = next;
    },
  };
}
