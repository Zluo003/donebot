import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudSpeechBridge } from "@/donebot/voice/cloud-speech-bridge";
import type { MicCaptureHandle, MicChunk } from "@/donebot/voice/mic-capture";
import { ASR_SAMPLE_RATE } from "@/donebot/voice/pcm";
import type { WebSocketLike } from "@/donebot/voice/realtime-asr";
import { createWakeStandbySession } from "@/donebot/voice/wake-standby";
import { createPetTtsPlayer } from "./pet-tts";
import { createPetVoiceController } from "./pet-voice";

class MockWs implements WebSocketLike {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;
  sentText: Record<string, unknown>[] = [];
  sentBinary: Uint8Array[] = [];
  closed = false;

  constructor(readonly url: string) {}
  open() { this.readyState = 1; this.onopen?.({}); }
  receive(payload: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(payload) }); }
  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (typeof data === "string") this.sentText.push(JSON.parse(data) as Record<string, unknown>);
    else if (data instanceof ArrayBuffer) this.sentBinary.push(new Uint8Array(data));
    else this.sentBinary.push(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
  }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }
}

function fakeMic() {
  let activeListener: ((chunk: MicChunk) => void) | null = null;
  let activeToken = 0;
  const startMic = vi.fn(async (cb: (chunk: MicChunk) => void): Promise<MicCaptureHandle> => {
    const myToken = ++activeToken;
    let myActive = true;
    activeListener = cb;
    return {
      stop: () => {
        if (!myActive) return;
        myActive = false;
        if (activeToken === myToken) activeListener = null;
      },
      isActive: () => myActive,
      setListener: (next) => {
        if (myActive && activeToken === myToken) activeListener = next;
      },
    };
  });
  const emit = (rms: number, durationMs = 80) => {
    const pcm = new Uint8Array(new ArrayBuffer(Math.round((ASR_SAMPLE_RATE * durationMs) / 1000) * 2));
    activeListener?.({ pcm, rms, durationMs });
  };
  return { startMic, emit, isActive: () => activeListener !== null };
}

describe("Pet quasi-full-duplex barge-in & native fallback", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels ongoing TTS playback and queued chunks on barge-in, hands off ASR to listening, and sends new utterance", async () => {
    vi.useFakeTimers();
    let now = 20_000;
    const mic = fakeMic();
    const sockets: MockWs[] = [];

    const cloudBridge = createCloudSpeechBridge({
      startMic: mic.startMic,
      createWebSocket: (url) => {
        const ws = new MockWs(url);
        sockets.push(ws);
        return ws;
      },
      now: () => now,
    });

    // Multi-chunk TTS playback that stays active until aborted by barge-in.
    let playAborted = false;
    const playPcmStreamImpl = vi.fn((_res: Response, signal: AbortSignal) => new Promise<boolean>((resolve) => {
      signal.addEventListener("abort", () => {
        playAborted = true;
        resolve(false);
      }, { once: true });
    }));
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ start() {} }), {
      status: 200,
      headers: { "content-type": "audio/pcm", "x-audio-sample-rate": "24000" },
    }));
    const ttsPlayer = createPetTtsPlayer({ fetchImpl, playPcmStreamImpl, preferStream: true });

    const nativeBridge = {
      speechStart: vi.fn(),
      speechStop: vi.fn(),
      speechFinish: vi.fn(),
      onSpeechTranscript: vi.fn(() => () => {}),
      onSpeechEnd: vi.fn(() => () => {}),
      callActive: vi.fn(),
    };

    const utterances: string[] = [];
    const phases: string[] = [];
    let bargeInCount = 0;

    const ctrl = createPetVoiceController({
      bridge: () => nativeBridge,
      initialBotName: "多宝",
      initialCloudAsr: { available: true, wsPath: "/api/voice/asr" },
      cloudBridge,
      createWakeStandby: (opts) => createWakeStandbySession(opts, {
        startMic: mic.startMic,
        createWebSocket: (url) => {
          const ws = new MockWs(url);
          sockets.push(ws);
          return ws;
        },
        now: () => now,
      }),
      currentSpokenText: () => ttsPlayer.currentText(),
      onChange: (s) => phases.push(s.phase),
      onWakeDetected: vi.fn(),
      onBargeIn: () => {
        bargeInCount += 1;
        ttsPlayer.stop();
      },
      onUtterance: (text) => utterances.push(text),
    });

    // Start long multi-sentence TTS playback (triggers streaming PCM path).
    const longReply = "老板，今天的工作汇报内容比较长，首先是研发进度同步，其次是客户反馈汇总与下周安排。";
    ctrl.markWaking();
    ctrl.markSpeaking();
    const speakPromise = ttsPlayer.speak(longReply, { voiceId: "longanhuan_v3.1" });
    await Promise.resolve();
    await Promise.resolve();

    // Native speech helper is never invoked while cloud ASR is enabled.
    expect(nativeBridge.speechStart).not.toHaveBeenCalled();

    // During silent playback: 0 ASR WebSockets opened.
    for (let i = 0; i < 6; i += 1) {
      now += 80;
      mic.emit(0.003, 80);
    }
    expect(sockets).toHaveLength(0);

    // User interrupts mid-playback -> opens WS, cloud returns non-echo transcript -> barge-in stops TTS immediately!
    for (let i = 0; i < 3; i += 1) {
      now += 80;
      mic.emit(0.11, 80);
    }
    expect(sockets).toHaveLength(1);
    const ws = sockets[0]!;
    ws.open();
    ws.receive({ type: "transcript", sentenceId: 1, text: "先别念了，帮我发邮件", final: false });

    expect(bargeInCount).toBe(1);
    expect(playAborted).toBe(true);
    expect(ttsPlayer.isSpeaking()).toBe(false);
    expect(phases.at(-1)).toBe("listening");

    // Speak promise resolves cleanly as interrupted.
    const speakRes = await speakPromise;
    expect(speakRes).toEqual({ ok: false, interrupted: true });

    // Calling afterSpeaking now must NOT clobber the active barge-in listening phase.
    ctrl.afterSpeaking({ expectCommand: false });
    vi.advanceTimersByTime(400);
    expect(phases.at(-1)).toBe("listening");

    // Cloud finalizes user's interrupting command -> dispatched to chief coordinator!
    ws.receive({ type: "transcript", sentenceId: 1, text: "先别念了，帮我发邮件给产品经理", final: true });
    expect(utterances).toEqual(["先别念了，帮我发邮件给产品经理"]);

    ctrl.dispose();
  });

  it("falls back smoothly to native dictation when cloud ASR is disabled", () => {
    vi.useFakeTimers();
    const nativeBridge = {
      speechStart: vi.fn(),
      speechStop: vi.fn(),
      speechFinish: vi.fn(),
      onSpeechTranscript: vi.fn(() => () => {}),
      onSpeechEnd: vi.fn(() => () => {}),
      callActive: vi.fn(),
    };

    const ctrl = createPetVoiceController({
      bridge: () => nativeBridge,
      initialBotName: "多宝",
      initialCloudAsr: { available: false },
      onChange: () => {},
      onWakeDetected: () => {},
      onUtterance: () => {},
    });

    ctrl.setWakeEnabled(true);
    vi.advanceTimersByTime(400);
    expect(nativeBridge.speechStart).toHaveBeenCalledWith({});

    // In native half-duplex mode, markSpeaking mutes mic via speechStop.
    nativeBridge.speechStop.mockClear();
    ctrl.markSpeaking();
    expect(nativeBridge.speechStop).toHaveBeenCalled();

    ctrl.dispose();
  });
});
