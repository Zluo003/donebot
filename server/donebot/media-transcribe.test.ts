import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FAKE_DONEBOT_CATALOG } from "../testing/fake-donebot-gateway.ts";
import type { HelperToolContext } from "../routes/helper-tools.ts";
import { callTool } from "../drivers/agents-call.ts";
import type { DoneBotMediaService, MediaContext } from "./media.ts";
import { createDoneBotMediaRoutes } from "./media-routes.ts";
import { createDoneBotMediaTranscriber, parseCompatibleWav } from "./media-transcribe.ts";

function buildWav16kMono(durationSec: number): Uint8Array {
  const sampleRate = 16_000;
  const numSamples = Math.round(durationSec * sampleRate);
  const dataBytes = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}

function catalogWithAsr() {
  const catalog = structuredClone(FAKE_DONEBOT_CATALOG);
  catalog.models.push({
    id: "qwen-audio-3.1-asr-flash-streaming",
    display_name: "Qwen Audio 3.1 ASR",
    media_types: ["audio"],
    interfaces: ["openai.audio.transcriptions.realtime"],
    platforms: [],
  });
  return catalog;
}

describe("DoneBot gateway audio transcription tool", () => {
  const trusted: MediaContext = { botId: "bot-1", threadId: "thread-1", turnId: "turn-1", active: () => true };
  const scope = { accountId: "acct-1", installationId: "inst-1" };

  it("parses compatible 16kHz mono WAV and chunks long audio with cumulative timestamp offsets without ffmpeg", async () => {
    const wavBytes = buildWav16kMono(110);
    const parsed = parseCompatibleWav(wavBytes);
    expect(parsed?.sampleRate).toBe(16_000);
    expect(parsed?.pcm.byteLength).toBe(110 * 16_000 * 2);

    const calls: Array<{ path: string; body: Record<string, unknown>; idem: string | null }> = [];
    const fetchGateway = vi.fn(async (_scope, path: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ path, body, idem: headers.get("idempotency-key") });
      const idx = calls.length;
      return Response.json({
        model: body.model,
        text: idx === 1 ? "第一段话术开场。" : "第二段波谷实测。",
        segments: idx === 1
          ? [{ begin_ms: 500, end_ms: 4200, text: "第一段话术开场。" }]
          : [{ begin_ms: 1000, end_ms: 5500, text: "第二段波谷实测。" }],
      });
    });

    const extractPcm = vi.fn();
    const transcriber = createDoneBotMediaTranscriber({
      scope: () => scope,
      catalog: () => catalogWithAsr(),
      fetchGateway,
      extractPcm,
      openLocalMedia: async () => ({
        path: "/workspace/clip.wav",
        name: "clip.wav",
        mime: "audio/wav",
        bytes: wavBytes.byteLength,
        readBytes: async () => wavBytes,
        close: async () => {},
      }),
    });

    const result = await transcriber.transcribe(trusted, {
      local_path: "/workspace/clip.wav",
      start_sec: 10,
      duration_sec: 100,
      language_hints: ["zh"],
      hotwords: { DoneBot: 5 },
    });

    expect(extractPcm).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.path).toBe("/v1/audio/transcriptions");
    expect(calls[0]!.idem).not.toBe(calls[1]!.idem);
    expect(calls[0]!.body).toMatchObject({ model: "qwen-audio-3.1-asr-flash-streaming", format: "pcm", sample_rate: 16_000, language_hints: ["zh"], vocabulary: { DoneBot: 5 } });
    expect(result.chunks).toBe(2);
    expect(result.text).toBe("第一段话术开场。第二段波谷实测。");
    expect(result.segments).toEqual([
      { begin_sec: 10.5, end_sec: 14.2, text: "第一段话术开场。" },
      { begin_sec: 101, end_sec: 105.5, text: "第二段波谷实测。" },
    ]);
    expect(result.timeline_text).toContain("[00:00:10 - 00:00:14] 第一段话术开场。");
    expect(result.timeline_text).toContain("[00:01:41 - 00:01:45] 第二段波谷实测。");
  });

  it("extracts sliced PCM from a real MP4 video via ffmpeg and transcribes through gateway", async () => {
    const dir = mkdtempSync(join(tmpdir(), "donebot-transcribe-"));
    try {
      const mp4 = join(dir, "live.mp4");
      execFileSync("ffmpeg", [
        "-y",
        "-f", "lavfi", "-i", "color=c=black:s=160x160:r=24:d=4",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", mp4,
      ], { stdio: "ignore" });
      const size = statSync(mp4).size;
      const seenBytes: number[] = [];
      const transcriber = createDoneBotMediaTranscriber({
        scope: () => scope,
        catalog: () => catalogWithAsr(),
        fetchGateway: async (_scope, _path, init) => {
          const body = JSON.parse(String(init.body)) as { audio_base64: string; model: string };
          seenBytes.push(Buffer.from(body.audio_base64, "base64").byteLength);
          return Response.json({
            model: body.model,
            text: "欢迎来到抖音直播间。",
            segments: [{ begin_ms: 200, end_ms: 1900, text: "欢迎来到抖音直播间。" }],
          });
        },
        openLocalMedia: async () => ({
          path: mp4,
          name: "live.mp4",
          mime: "video/mp4",
          bytes: size,
          readBytes: async () => { throw new Error("MP4 should stream via ffmpeg instead of reading whole file into memory"); },
          close: async () => {},
        }),
      });

      const res = await transcriber.transcribe(trusted, { local_path: mp4, start_sec: 1, duration_sec: 2 });
      expect(seenBytes).toHaveLength(1);
      expect(seenBytes[0]!).toBeGreaterThan(32_000);
      expect(res.text).toBe("欢迎来到抖音直播间。");
      expect(res.segments[0]).toEqual({ begin_sec: 1.2, end_sec: 2.9, text: "欢迎来到抖音直播间。" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes agents transcribe_audio calls through /api/internal/donebot/media/transcribe with strict validation", async () => {
    const transcriber = {
      transcribe: vi.fn(async () => ({
        model: "qwen-audio-3.1-asr-flash-streaming",
        file: "demo.mp4",
        start_sec: 0,
        duration_sec: 12,
        chunks: 1,
        text: "测试逐字稿",
        segments: [{ begin_sec: 0, end_sec: 12, text: "测试逐字稿" }],
        timeline_text: "[00:00:00 - 00:00:12] 测试逐字稿",
      })),
    };
    const service = { submit: vi.fn(), status: vi.fn(), stopWaiting: vi.fn(), capabilities: vi.fn(async () => []) };
    const route = createDoneBotMediaRoutes(service as unknown as DoneBotMediaService, () => trusted, undefined, transcriber);

    const ctx = {
      method: "POST",
      path: "/api/internal/donebot/media/transcribe",
      res: {} as ServerResponse,
      json: vi.fn(),
      botId: trusted.botId,
      threadId: trusted.threadId,
      readBody: async () => ({ local_path: "/workspace/demo.mp4", start_sec: 0, duration_sec: 12 }),
      folders: async () => ({ roots: [], vmWorkspace: null }),
    } as unknown as HelperToolContext & { threadId: string };

    await route(ctx);
    expect(transcriber.transcribe).toHaveBeenCalledOnce();
    expect(ctx.json).toHaveBeenCalledWith(ctx.res, 200, expect.objectContaining({ text: "测试逐字稿" }));

    // Rejects duration > 600s before invoking transcriber.
    const badCtx = { ...ctx, json: vi.fn(), readBody: async () => ({ local_path: "/workspace/demo.mp4", duration_sec: 3600 }) } as unknown as HelperToolContext & { threadId: string };
    await route(badCtx);
    expect(badCtx.json).toHaveBeenCalledWith(badCtx.res, 400, expect.anything());

    // Verifies callTool dispatches transcribe_audio to /api/internal/donebot/media/transcribe.
    const apiResponse = vi.fn(async () => ({ ok: true, status: 200, body: { text: "ok" } }));
    const toolRes = await callTool("transcribe_audio", { local_path: "/workspace/demo.mp4" }, {
      botId: trusted.botId,
      threadId: trusted.threadId,
      depth: 0,
      externalRuntime: false,
      sharedComputers: false,
      donebotMedia: true,
      client: { api: async () => ({}), apiResponse },
    });
    expect(toolRes).toEqual({ text: "{\"text\":\"ok\"}" });
    expect(apiResponse).toHaveBeenCalledWith("/api/internal/donebot/media/transcribe", expect.objectContaining({ method: "POST" }));
  });
});
