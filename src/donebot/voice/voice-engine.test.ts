import { afterEach, describe, expect, it, vi } from "vitest";
import { BargeInGuard, isLikelyTtsEcho, isMeaningfulBargeInText } from "./barge-in";
import { createCloudSpeechBridge } from "./cloud-speech-bridge";
import type { MicCaptureHandle, MicChunk } from "./mic-capture";
import {
  ASR_SAMPLE_RATE,
  LocalVadGate,
  PcmChunker,
  PcmRingBuffer,
  computeRms,
  downsampleFloat32,
  float32ToPcm16,
} from "./pcm";
import { createStreamingPcmPlayer, decodePcm16LeToFloat32 } from "./pcm-player";
import type { WebSocketLike } from "./realtime-asr";
import { createWakeStandbySession } from "./wake-standby";
import { matchWakeWord } from "@/donebot/pet/pet-protocol";

class FakeWebSocket implements WebSocketLike {
  readyState = 0; // CONNECTING
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;
  readonly sentText: Record<string, unknown>[] = [];
  readonly sentBinary: Uint8Array[] = [];
  closed = false;

  constructor(readonly url: string) {}

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (typeof data === "string") {
      this.sentText.push(JSON.parse(data) as Record<string, unknown>);
    } else if (data instanceof ArrayBuffer) {
      this.sentBinary.push(new Uint8Array(data.slice(0)));
    } else {
      this.sentBinary.push(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
    }
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }
}

function makeFakeMicController() {
  let listener: ((chunk: MicChunk) => void) | null = null;
  let active = false;
  let stopCount = 0;

  const startMic = vi.fn(async (initial: (chunk: MicChunk) => void): Promise<MicCaptureHandle> => {
    listener = initial;
    active = true;
    return {
      stop: () => {
        if (!active) return;
        active = false;
        listener = null;
        stopCount += 1;
      },
      isActive: () => active,
      setListener: (next) => {
        if (active) listener = next;
      },
    };
  });

  const emitChunk = (rms: number, durationMs = 80, markerByte = 1) => {
    const byteLen = Math.round((ASR_SAMPLE_RATE * durationMs) / 1000) * 2;
    const pcm = new Uint8Array(new ArrayBuffer(byteLen));
    pcm.fill(markerByte);
    listener?.({ pcm, rms, durationMs });
  };

  return {
    startMic,
    emitChunk,
    isActive: () => active,
    getStopCount: () => stopCount,
  };
}

describe("PCM encoding, downsampling, chunking and ring buffer", () => {
  it("downsamples 48kHz mono audio to 16kHz and encodes clamped Int16 LE PCM", () => {
    const input48k = new Float32Array([0, 0, 0, 1, 1, 1, -1, -1, -1, 2, 2, 2]);
    const down16k = downsampleFloat32(input48k, 48_000, 16_000);
    expect(down16k.length).toBe(4);
    const pcm = float32ToPcm16(down16k);
    const view = new DataView(pcm.buffer);
    expect([0, 1, 2, 3].map((i) => view.getInt16(i * 2, true))).toEqual([0, 32767, -32768, 32767]);
  });

  it("splits arbitrary PCM writes into uniform 80ms chunks", () => {
    const chunker = new PcmChunker(80, 16_000); // 2560 bytes per chunk
    expect(chunker.push(new Uint8Array(1000))).toHaveLength(0);
    const out = chunker.push(new Uint8Array(4200)); // total 5200 -> 2 chunks (5120), 80 left
    expect(out).toHaveLength(2);
    expect(out[0]!.byteLength).toBe(2560);
    expect(out[1]!.byteLength).toBe(2560);
    expect(chunker.flush()?.byteLength).toBe(80);
  });

  it("maintains a bounded ~400ms pre-roll FIFO ring buffer and drains cleanly", () => {
    const ring = new PcmRingBuffer(400, 16_000); // max 12800 bytes = 5 x 80ms
    for (let i = 1; i <= 8; i += 1) {
      const chunk = new Uint8Array(2560).fill(i);
      ring.push(chunk);
    }
    expect(ring.durationMs).toBeLessThanOrEqual(400);
    const drained = ring.drain();
    expect(drained.map((c) => c[0])).toEqual([4, 5, 6, 7, 8]);
    expect(ring.byteLength).toBe(0);
  });

  it("adapts local VAD threshold to steady background noise and enforces higher barge-in gate", () => {
    const vad = new LocalVadGate({ mode: "standby" });
    // Feed steady ambient fan noise (rms = 0.012) for 40 frames; must never trigger speech.
    for (let i = 0; i < 40; i += 1) {
      const r = vad.feed(0.012, 80);
      expect(r.isSpeech).toBe(false);
    }
    const standbyThreshold = vad.currentThreshold();
    expect(standbyThreshold).toBeGreaterThan(0.018);

    // Sustained human speech above threshold triggers after onset.
    expect(vad.feed(0.09, 80).onsetTriggered).toBe(false);
    expect(vad.feed(0.09, 80).onsetTriggered).toBe(true);

    // Barge-in mode requires higher RMS & longer onset.
    vad.setMode("barge-in");
    expect(vad.currentThreshold()).toBeGreaterThanOrEqual(0.032);
    expect(vad.feed(0.09, 80).isSpeech).toBe(false);
    expect(vad.feed(0.09, 80).isSpeech).toBe(false);
    expect(vad.feed(0.09, 80).isSpeech).toBe(true);
    expect(computeRms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
  });
});

describe("BargeInGuard anti-echo & anti-false-trigger protection", () => {
  it("filters TTS residual echo and single-character fillers while passing real user interruptions", () => {
    const ttsLine = "老板，今天的工作台汇报已经整理好了，一共三项待审批。";
    expect(isLikelyTtsEcho("工作台汇报", ttsLine)).toBe(true);
    expect(isLikelyTtsEcho("今天的工作台汇报已经整理好了", ttsLine)).toBe(true);
    expect(isMeaningfulBargeInText("嗯", ttsLine)).toBe(false);
    expect(isMeaningfulBargeInText("。。。", ttsLine)).toBe(false);
    expect(isMeaningfulBargeInText("工作台汇报", ttsLine)).toBe(false);
    expect(isMeaningfulBargeInText("等一下先别说这个", ttsLine)).toBe(true);
    expect(isMeaningfulBargeInText("停", ttsLine)).toBe(true);
  });

  it("honors startup AEC grace window, opens ASR only on sustained voice, and closes ASR if unconfirmed", () => {
    const guard = new BargeInGuard({ graceMs: 350, localMinMs: 240, speechStartedLocalMinMs: 320, confirmWindowMs: 1_500 });
    guard.start("老板，这是今天的详细工作简报。", 1_000);

    // Inside 350ms AEC convergence window: never opens ASR or triggers.
    expect(guard.onLocalVad({ isSpeech: true, consecutiveSpeechMs: 320 }, 1_200)).toEqual({
      shouldOpenAsr: false,
      shouldCloseAsr: false,
    });
    expect(guard.onCloudSpeechStarted(1_250)).toBe(false);

    // After grace window with sustained voice: requests on-demand ASR WS.
    expect(guard.onLocalVad({ isSpeech: true, consecutiveSpeechMs: 240 }, 1_500)).toEqual({
      shouldOpenAsr: true,
      shouldCloseAsr: false,
    });
    // Cloud echo transcript is rejected.
    expect(guard.onCloudTranscript("今天的详细", 1_700).triggered).toBe(false);

    // If user stops talking without confirmation, closes ASR to avoid wasting tokens.
    expect(guard.onLocalVad({ isSpeech: false, consecutiveSpeechMs: 0 }, 3_200)).toEqual({
      shouldOpenAsr: false,
      shouldCloseAsr: true,
    });

    // Real sustained interruption confirmed by cloud speech_started or non-echo transcript triggers immediately.
    expect(guard.onLocalVad({ isSpeech: true, consecutiveSpeechMs: 320 }, 3_500).shouldOpenAsr).toBe(true);
    expect(guard.onCloudTranscript("先帮我查一下邮件", 3_700)).toEqual({ triggered: true, text: "先帮我查一下邮件" });
  });
});

describe("WakeStandbySession zero-cost idle gating", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens 0 WebSockets during silence, flushes 400ms pre-roll on sustained speech, and closes on silence timeout", async () => {
    vi.useFakeTimers();
    let now = 10_000;
    const mic = makeFakeMicController();
    const sockets: FakeWebSocket[] = [];
    const wakeHits: Array<{ remainder: string; final: boolean; text: string }> = [];

    const session = createWakeStandbySession(
      {
        botName: "多宝",
        matchWakeWord,
        probeSilenceTimeoutMs: 1_500,
        probeMaxDurationMs: 6_000,
        onWakeHit: (hit) => wakeHits.push(hit),
      },
      {
        startMic: mic.startMic,
        createWebSocket: (url) => {
          const ws = new FakeWebSocket(url);
          sockets.push(ws);
          return ws;
        },
        now: () => now,
      },
    );
    await Promise.resolve();

    // 1. Extended silence -> 0 WebSockets opened (zero idle billing).
    for (let i = 0; i < 30; i += 1) {
      now += 80;
      mic.emitChunk(0.002, 80, 10 + (i % 5));
    }
    expect(sockets).toHaveLength(0);
    expect(session.isAsrConnected()).toBe(false);

    // 2. Sustained human voice -> opens 1 WS and flushes pre-roll buffer + hotwords.
    now += 80;
    mic.emitChunk(0.08, 80, 77);
    now += 80;
    mic.emitChunk(0.09, 80, 88);
    expect(sockets).toHaveLength(1);
    const ws1 = sockets[0]!;
    ws1.open();
    expect(ws1.sentText[0]).toMatchObject({
      type: "start",
      sampleRate: 16000,
      hotwords: { 你好多宝: 5, 多宝: 5, DoneBot: 5 },
    });
    // Pre-roll frames were flushed immediately after start.
    expect(ws1.sentBinary.length).toBeGreaterThanOrEqual(4);

    // 3. Random background speech (no wake word) followed by silence -> WS closes to stop billing.
    ws1.receive({ type: "transcript", sentenceId: 1, text: "今天天气不错", final: true });
    now += 1_600;
    vi.advanceTimersByTime(1_600);
    expect(ws1.closed).toBe(true);
    expect(ws1.sentText.some((m) => m.type === "stop")).toBe(true);
    expect(session.isAsrConnected()).toBe(false);

    // 4. User later says wake word + inline command -> opens WS #2 and fires wake hit.
    now += 3_000;
    mic.emitChunk(0.09, 80, 91);
    now += 80;
    mic.emitChunk(0.09, 80, 92);
    expect(sockets).toHaveLength(2);
    const ws2 = sockets[1]!;
    ws2.open();
    ws2.receive({ type: "transcript", sentenceId: 2, text: "你好，多宝，帮我总结周报", final: true });
    expect(wakeHits).toEqual([{ remainder: "帮我总结周报", final: true, text: "你好，多宝，帮我总结周报" }]);

    session.stop();
    expect(mic.isActive()).toBe(false);
  });

  it("injects saved custom wake word into ASR hotwords and updates live via setWakeWord", async () => {
    let now = 20_000;
    const mic = makeFakeMicController();
    const sockets: FakeWebSocket[] = [];
    const wakeHits: Array<{ remainder: string; final: boolean; text: string }> = [];

    const session = createWakeStandbySession(
      {
        botName: "多宝",
        wakeWord: "小宝同学",
        matchWakeWord,
        onWakeHit: (info) => wakeHits.push(info),
      },
      {
        startMic: mic.startMic,
        createWebSocket: (url) => {
          const ws = new FakeWebSocket(url);
          sockets.push(ws);
          return ws;
        },
        now: () => now,
      },
    );
    await Promise.resolve();

    // Trigger speech onset -> opens WS with custom wake word hotword.
    now += 80;
    mic.emitChunk(0.09, 80, 11);
    now += 80;
    mic.emitChunk(0.09, 80, 12);
    expect(sockets).toHaveLength(1);
    const ws1 = sockets[0]!;
    ws1.open();
    expect(ws1.sentText[0]).toMatchObject({
      type: "start",
      hotwords: { 小宝同学: 5, 多宝: 5, DoneBot: 5 },
    });

    // Old default phrase does not wake when custom wake word is configured.
    ws1.receive({ type: "transcript", sentenceId: 1, text: "你好多宝", final: true });
    expect(wakeHits).toHaveLength(0);

    // Updating wake word closes the active unmatched probe so the next speech uses new hotwords.
    session.setWakeWord("嘿管家");
    expect(ws1.closed).toBe(true);

    now += 3_000;
    mic.emitChunk(0.09, 80, 21);
    now += 80;
    mic.emitChunk(0.09, 80, 22);
    expect(sockets).toHaveLength(2);
    const ws2 = sockets[1]!;
    ws2.open();
    expect(ws2.sentText[0]).toMatchObject({
      type: "start",
      hotwords: { 嘿管家: 5, 多宝: 5, DoneBot: 5 },
    });
    ws2.receive({ type: "transcript", sentenceId: 2, text: "嘿管家，打开日报", final: true });
    expect(wakeHits).toEqual([{ remainder: "打开日报", final: true, text: "嘿管家，打开日报" }]);

    session.stop();
  });
});

describe("CloudSpeechBridge streaming & seamless barge-in handoff", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps 0 ASR WS during quiet TTS playback, then opens WS on sustained speech, fires barge-in, and hands off seamlessly", async () => {
    let now = 50_000;
    const mic = makeFakeMicController();
    const sockets: FakeWebSocket[] = [];
    const bridge = createCloudSpeechBridge({
      startMic: mic.startMic,
      createWebSocket: (url) => {
        const ws = new FakeWebSocket(url);
        sockets.push(ws);
        return ws;
      },
      now: () => now,
    });

    const bargeIns: string[] = [];
    const lines: Array<{ partial?: boolean; text?: string }> = [];
    const ends: Array<{ code: number | null; reason?: string }> = [];
    const offT = bridge.onSpeechTranscript((l) => lines.push(l));
    const offE = bridge.onSpeechEnd((e) => ends.push(e));

    const stopMonitor = bridge.startBargeInMonitor({
      spokenText: () => "老板，这是第一季度的项目总结报告。",
      onBargeIn: ({ text }) => bargeIns.push(text),
      hotwords: { 多宝: 5 },
    });
    await Promise.resolve();

    // Quiet playback -> 0 WS connections (no wasted billing during TTS playback).
    for (let i = 0; i < 10; i += 1) {
      now += 80;
      mic.emitChunk(0.004, 80, 1);
    }
    expect(sockets).toHaveLength(0);

    // User speaks loudly after 350ms grace window (3 x 80ms = 240ms barge-in onset).
    for (let i = 0; i < 3; i += 1) {
      now += 80;
      mic.emitChunk(0.12, 80, 55);
    }
    expect(sockets).toHaveLength(1);
    const ws = sockets[0]!;
    ws.open();
    expect(ws.sentBinary.length).toBeGreaterThanOrEqual(4);

    // Residual TTS echo must not trigger barge-in.
    ws.receive({ type: "transcript", sentenceId: 1, text: "第一季度", final: false });
    expect(bargeIns).toEqual([]);

    // Real interruption triggers barge-in immediately and preserves the live WS for handoff!
    ws.receive({ type: "transcript", sentenceId: 1, text: "停一下，帮我查明天的日程", final: false });
    expect(bargeIns).toEqual(["停一下，帮我查明天的日程"]);
    expect(ws.closed).toBe(false);
    expect(bridge.hasActiveBargeInHandoff()).toBe(true);

    // Seamless handoff into listening reuses the EXACT same WebSocket (still 1 socket total).
    await bridge.speechStart({ endpointMs: 850, adoptBargeIn: true });
    expect(sockets).toHaveLength(1);
    expect(lines).toEqual([{ partial: true, text: "停一下，帮我查明天的日程" }]);

    // Final transcript finishes the turn and closes WS cleanly.
    ws.receive({ type: "transcript", sentenceId: 1, text: "停一下，帮我查明天的日程", final: true });
    expect(lines.at(-1)).toEqual({ partial: false, text: "停一下，帮我查明天的日程" });
    expect(ends).toEqual([{ code: 0, reason: "completed" }]);
    expect(ws.closed).toBe(true);

    stopMonitor();
    offT();
    offE();
  });

  it("accumulates multi-sentence manual dictation and finishes cleanly on speechFinish", async () => {
    const mic = makeFakeMicController();
    const sockets: FakeWebSocket[] = [];
    const bridge = createCloudSpeechBridge({
      startMic: mic.startMic,
      createWebSocket: (url) => {
        const ws = new FakeWebSocket(url);
        sockets.push(ws);
        return ws;
      },
    });

    const lines: Array<{ partial?: boolean; text?: string }> = [];
    const ends: Array<{ code: number | null; reason?: string }> = [];
    const offT = bridge.onSpeechTranscript((l) => lines.push(l));
    const offE = bridge.onSpeechEnd((e) => ends.push(e));

    await bridge.speechStart();
    const ws = sockets[0]!;
    ws.open();

    ws.receive({ type: "transcript", sentenceId: 1, text: "第一句。", final: true });
    ws.receive({ type: "transcript", sentenceId: 2, text: "第二句", final: false });
    expect(lines).toEqual([
      { partial: false, text: "第一句。" },
      { partial: true, text: "第一句。第二句" },
    ]);

    await bridge.speechFinish();
    expect(mic.isActive()).toBe(false);
    expect(ws.sentText.some((m) => m.type === "finish")).toBe(true);
    ws.receive({ type: "finished" });
    expect(ends).toEqual([{ code: 0, reason: "completed" }]);

    offT();
    offE();
  });

  it("auto-closes unclaimed barge-in handoff WS and mic after timeout to prevent orphan billing", async () => {
    vi.useFakeTimers();
    let now = 80_000;
    const mic = makeFakeMicController();
    const sockets: FakeWebSocket[] = [];
    const bridge = createCloudSpeechBridge({
      startMic: mic.startMic,
      createWebSocket: (url) => {
        const ws = new FakeWebSocket(url);
        sockets.push(ws);
        return ws;
      },
      now: () => now,
      handoffClaimTimeoutMs: 3_000,
    });

    let bargeInFired = false;
    bridge.startBargeInMonitor({
      spokenText: () => "这是一段播报内容。",
      onBargeIn: () => {
        // Deliberately do NOT call speechStart({ adoptBargeIn: true }) to simulate race/hang-up.
        bargeInFired = true;
      },
    });
    await Promise.resolve();

    // Advance past 350ms grace window and trigger sustained speech.
    now += 400;
    for (let i = 0; i < 3; i += 1) {
      now += 80;
      mic.emitChunk(0.12, 80, 1);
    }
    expect(sockets).toHaveLength(1);
    const ws = sockets[0]!;
    ws.open();
    ws.receive({ type: "transcript", sentenceId: 1, text: "先停一下", final: false });

    expect(bargeInFired).toBe(true);
    expect(bridge.hasActiveBargeInHandoff()).toBe(true);
    expect(ws.closed).toBe(false);

    // After 3s unclaimed timeout, orphan handoff must tear down WS and stop mic automatically.
    vi.advanceTimersByTime(3_100);
    expect(bridge.hasActiveBargeInHandoff()).toBe(false);
    expect(ws.closed).toBe(true);
    expect(ws.sentText.some((m) => m.type === "stop")).toBe(true);
    expect(mic.isActive()).toBe(false);
  });
});

describe("StreamingPcmPlayer", () => {
  it("decodes unaligned PCM chunks cleanly and stops all scheduled sources on abort", async () => {
    const sample = new Uint8Array(new ArrayBuffer(4));
    const view = new DataView(sample.buffer);
    view.setInt16(0, 16384, true);
    view.setInt16(2, -16384, true);
    const floats = decodePcm16LeToFloat32(sample);
    expect(floats[0]).toBeCloseTo(16384 / 0x7fff, 4);
    expect(floats[1]).toBeCloseTo(-0.5, 4);

    let stoppedSources = 0;
    const sources: Array<{ onended: (() => void) | null; stop: () => void }> = [];
    const fakeCtx = {
      currentTime: 0,
      state: "running",
      destination: {},
      resume: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      createBuffer: (_ch: number, len: number, sr: number) => ({
        duration: len / sr,
        copyToChannel: vi.fn(),
      }),
      createBufferSource: () => {
        const src = {
          buffer: null,
          onended: null as (() => void) | null,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(() => { stoppedSources += 1; }),
        };
        sources.push(src);
        return src;
      },
    } as unknown as AudioContext;

    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        // Send an odd-length chunk (3 bytes) followed by remaining 5 bytes -> 4 samples total.
        ctrl.enqueue(new Uint8Array([0x00, 0x20, 0x00]));
        ctrl.enqueue(new Uint8Array([0x20, 0x00, 0x40, 0x00, 0x40]));
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: { "content-type": "audio/pcm", "x-audio-sample-rate": "24000" },
    });

    const player = createStreamingPcmPlayer({ createAudioContext: () => fakeCtx });
    const promise = player.playResponse(response, controller.signal);
    await vi.waitFor(() => expect(sources.length).toBeGreaterThanOrEqual(2));

    // Barge-in abort stops all active audio sources immediately.
    controller.abort();
    const result = await promise;
    expect(result).toBe(false);
    expect(stoppedSources).toBe(sources.length);
  });

  it("resolves immediately when aborted after HTTP stream EOF while the last AudioBufferSourceNode is still playing", async () => {
    let stoppedSources = 0;
    const sources: Array<{ onended: (() => void) | null; stop: () => void }> = [];
    const fakeCtx = {
      currentTime: 0,
      state: "running",
      destination: {},
      resume: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      createBuffer: (_ch: number, len: number, sr: number) => ({
        duration: len / sr,
        copyToChannel: vi.fn(),
      }),
      createBufferSource: () => {
        const src = {
          buffer: null,
          onended: null as (() => void) | null,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(() => { stoppedSources += 1; }),
        };
        sources.push(src);
        return src;
      },
    } as unknown as AudioContext;

    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new Uint8Array([0x00, 0x20, 0x00, 0x20]));
        // Close stream right away so playResponse reaches `await lastEndPromise` before source.onended fires.
        ctrl.close();
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: { "content-type": "audio/pcm", "x-audio-sample-rate": "24000" },
    });

    const player = createStreamingPcmPlayer({ createAudioContext: () => fakeCtx });
    const promise = player.playResponse(response, controller.signal);
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    // Flush microtasks so reader.read() hits EOF and playResponse awaits lastEndPromise.
    await new Promise((r) => setTimeout(r, 0));

    // Abort mid-playback without firing source.onended: must NOT hang!
    controller.abort();
    const result = await promise;
    expect(result).toBe(false);
    expect(stoppedSources).toBe(1);
  });
});
