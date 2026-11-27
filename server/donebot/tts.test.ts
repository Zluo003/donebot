import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DoneBotCatalog, DoneBotGatewayModel } from "../../shared/donebot.ts";
import { DONEBOT_VOICE_MODELS, isValidDoneBotVoiceId } from "../../shared/donebot-voice.ts";
import type { AppConfig } from "../config.ts";
import { json, readBody } from "../harness/http.ts";
import { createTtsRoutes } from "../routes/tts.ts";
import { bindDoneBotVoice, describeAsr, describeVoice, listVoices, providerConfigured, speak, streamVoice, verifyKey, voiceReady } from "../tts/index.ts";
import {
  doneBotClientAsrModel,
  doneBotClientSpeechModel,
  doneBotVoiceCapabilities,
  enrichDoneBotCatalogForClient,
  resolvePreferredDoneBotSpeechModel,
} from "./media-registry.ts";
import { createDoneBotVoice } from "./tts.ts";

const model: DoneBotGatewayModel = { id: "gpt-4o-mini-tts", display_name: "Fixture voice", media_types: ["audio"], platforms: ["openai"], interfaces: ["openai.audio.speech"] };
const receiptId = "fixture-receipt-1";
const pcm = (body: ConstructorParameters<typeof Response>[0] = new Uint8Array([0, 0, 1, 0])) => new Response(body, { headers: { "content-type": "audio/pcm", "X-DoneBot-Receipt-ID": receiptId } });
const fixture = (response: () => Response = pcm) => {
  let scope: { accountId: string; installationId: string } | null = { accountId: "fixture-user", installationId: "fixture-install" };
  const gateway = {
    authenticated: () => Boolean(scope), scope: () => scope,
    requestForScope: vi.fn(async (_scope: unknown, _path: string, _init?: RequestInit) => response()),
    receipt: vi.fn(async (_id: string, _scope: unknown, _signal?: AbortSignal) => ({ receipt_id: receiptId, status: "completed" })),
  };
  return { gateway, service: createDoneBotVoice({ gateway, resolveModel: () => model }), changeAccount: () => { scope = { accountId: "another-user", installationId: "another-install" }; } };
};
const consume = async (body: ReadableStream<Uint8Array>) => { const chunks: Uint8Array[] = [], reader = body.getReader(); for (;;) { const next = await reader.read(); if (next.done) return Buffer.concat(chunks); chunks.push(next.value); } };
afterEach(() => { bindDoneBotVoice(undefined); vi.unstubAllGlobals(); });

describe("DoneBot streaming speech", () => {
  it("uses local speech parameters when gateway metadata is missing or contradictory", () => {
    expect(doneBotClientSpeechModel(model)?.media_parameters?.voices).toContain("alloy");
    expect(doneBotClientSpeechModel({ ...model, media_parameters: { voices: ["unknown"] } })).toEqual(doneBotClientSpeechModel(model));
    expect(doneBotClientSpeechModel({ ...model, id: "unknown" })).toBeUndefined();
    expect(doneBotClientSpeechModel({ ...model, interfaces: [] })).toBeUndefined();
  });
  it("ignores a retained supplier default while rejecting an explicitly unavailable voice", async () => {
    const f = fixture();
    bindDoneBotVoice(f.service);
    const cfg = { tts: { provider: "elevenlabs", voice: "old-supplier-voice" } } as AppConfig;
    expect(voiceReady(cfg)).toBe(true);
    expect(voiceReady(cfg, "old-supplier-voice")).toBe(false);
    expect((await speak(cfg, "Fixture")).mime).toBe("audio/wav");
  });

  it("delivers the first PCM bytes before EOF and only closes after a completed scoped receipt", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const fx = fixture(() => pcm(new ReadableStream({ start(controller) { source = controller; } })));
    const audio = await fx.service.stream("Fixture speech", "alloy", new AbortController().signal), reader = audio.body.getReader();
    const first = reader.read(); source.enqueue(new Uint8Array([0, 0]));
    expect(await first).toEqual({ done: false, value: new Uint8Array([0, 0]) });
    expect(fx.gateway.receipt).not.toHaveBeenCalled();
    fx.gateway.receipt.mockResolvedValueOnce({ receipt_id: receiptId, status: "dispatching" });
    source.close();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(fx.gateway.receipt).toHaveBeenCalledTimes(2);
    expect(fx.gateway.receipt).toHaveBeenLastCalledWith(receiptId, { accountId: "fixture-user", installationId: "fixture-install" }, expect.any(AbortSignal));
    const [scope, path, init] = fx.gateway.requestForScope.mock.calls[0]!;
    expect(scope).toEqual({ accountId: "fixture-user", installationId: "fixture-install" });
    expect(path).toBe("/v1/audio/speech");
    expect(init!.headers).toMatchObject({ "Idempotency-Key": expect.stringMatching(/^[a-f0-9-]{36}$/) });
    expect(JSON.parse(init!.body as string)).toEqual({ model: model.id, input: "Fixture speech", voice: "alloy", response_format: "pcm", stream_format: "audio" });
  });

  it.each(["uncertain", "failed", "cancelled", "refunded"])("refuses %s receipts without submitting another speech request", async (status) => {
    const fx = fixture(); fx.gateway.receipt.mockResolvedValue({ receipt_id: receiptId, status });
    const audio = await fx.service.stream("Fixture");
    await expect(consume(audio.body)).rejects.toThrow("confirmed completion");
    expect(fx.gateway.requestForScope).toHaveBeenCalledTimes(1);
  });

  it("rejects a receipt from another operation and rejects an account change during streaming", async () => {
    const wrong = fixture(); wrong.gateway.receipt.mockResolvedValue({ receipt_id: "another-receipt", status: "completed" });
    await expect(consume((await wrong.service.stream("Fixture")).body)).rejects.toThrow("verified");
    const changed = fixture(), audio = await changed.service.stream("Fixture"); changed.changeAccount();
    await expect(consume(audio.body)).rejects.toThrow("account changed");
    expect(changed.gateway.receipt).not.toHaveBeenCalled();
  });

  it("Stop cancels a stalled upstream read and never checks a receipt or retries", async () => {
    const cancelled = vi.fn(), controller = new AbortController();
    const fx = fixture(() => pcm(new ReadableStream({ cancel: cancelled })));
    const audio = await fx.service.stream("Fixture", undefined, controller.signal), reader = audio.body.getReader();
    const pending = reader.read(); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toHaveBeenCalled();
    expect(fx.gateway.receipt).not.toHaveBeenCalled();
    expect(fx.gateway.requestForScope).toHaveBeenCalledTimes(1);
  });

  it("rejects absent receipt, wrong format, odd samples and HTTP failure", async () => {
    for (const response of [() => new Response("fixture"), () => new Response("fixture", { headers: { "X-DoneBot-Receipt-ID": receiptId, "content-type": "audio/wav" } }), () => new Response("private-provider-secret", { status: 401 })]) {
      const fx = fixture(response);
      await expect(fx.service.stream("Fixture")).rejects.toThrow();
      expect(fx.gateway.requestForScope).toHaveBeenCalledTimes(1);
    }
    const odd = fixture(() => pcm(new Uint8Array([0])));
    await expect(consume((await odd.service.stream("Fixture")).body)).rejects.toThrow("incomplete");
  });

  it("retains buffered voice notes as WAV through the same verified stream", async () => {
    const fx = fixture(), audio = await fx.service.speak("Fixture", "alloy");
    expect(audio.mime).toBe("audio/wav");
    const bytes = Buffer.from(audio.bytes);
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
    expect(bytes.readUInt32LE(24)).toBe(24_000);
    expect(bytes.readUInt16LE(22)).toBe(1);
    expect(bytes.subarray(44)).toEqual(Buffer.from([0, 0, 1, 0]));
    expect(fx.gateway.receipt).toHaveBeenCalledTimes(1);
  });

  it.each(["elevenlabs", "fish", "gemini", "openai", "xai", "system", "chatterbox"] as const)("makes every existing voice entry point use the bound gateway with retained %s configuration", async provider => {
    const fx = fixture(); bindDoneBotVoice(fx.service);
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Direct provider bypass"); }));
    const cfg = { tts: { provider, voice: "alloy", key: "fixture-key", fishKey: "fixture-key", geminiKey: "fixture-key", baseUrl: "https://direct-provider.invalid" }, openai: { key: "fixture-key" }, xai: { key: "fixture-key" } };
    expect(providerConfigured(cfg)).toBe(true);
    expect(describeVoice(cfg)).toMatchObject({ provider: "donebot", model: model.id, streaming: true, ready: true });
    expect(await listVoices(cfg)).toEqual(["alloy", "echo", "fable", "onyx", "nova", "shimmer"].map(id => ({ id, label: id })));
    expect((await speak(cfg, "Fixture")).mime).toBe("audio/wav");
    expect(await consume((await streamVoice(cfg, "Fixture")).body)).toHaveLength(4);
    expect(await verifyKey("elevenlabs", "fixture-key")).toMatchObject({ ok: false });
    fx.gateway.requestForScope.mockRejectedValueOnce(new Error("DoneBot gateway unavailable"));
    await expect(speak(cfg, "Fixture")).rejects.toThrow("DoneBot gateway unavailable");
    bindDoneBotVoice(createDoneBotVoice({ gateway: { ...fx.gateway, authenticated: () => false, scope: () => null }, resolveModel: () => model }));
    expect(providerConfigured(cfg)).toBe(false);
    await expect(speak(cfg, "Fixture")).rejects.toThrow("Sign in to DoneBot");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("registers Qwen-Audio-3.1 TTS/ASR models, prefers flash over plus over legacy, and enriches catalog metadata", () => {
    const flash: DoneBotGatewayModel = {
      id: DONEBOT_VOICE_MODELS.ttsFlash, display_name: "", media_types: ["audio"], platforms: ["openai"],
      interfaces: ["openai.audio.speech"], pricing: { unit: "million_tokens", input_per_million: 10, output_per_million: 20 },
    };
    const plus: DoneBotGatewayModel = {
      id: DONEBOT_VOICE_MODELS.ttsPlus, display_name: "", media_types: ["audio"], platforms: ["openai"],
      interfaces: ["openai.audio.speech"], pricing: { unit: "million_characters", tiers: { tts: 100 } },
    };
    const asr: DoneBotGatewayModel = {
      id: DONEBOT_VOICE_MODELS.asrRealtime, display_name: "", media_types: ["audio"], platforms: ["openai"],
      interfaces: ["openai.audio.transcriptions.realtime"], pricing: { unit: "million_tokens", input_per_million: 5 },
    };
    const catalog: DoneBotCatalog = {
      gateway_contract_version: 4, catalog_scope_id: "scope", catalog_version: "v2",
      defaults: { text: "gpt-6.1-sol" }, models: [model, plus, flash, asr],
    };

    expect(isValidDoneBotVoiceId("longanhuan_v3.1")).toBe(true);
    expect(isValidDoneBotVoiceId("Emily_v3.1")).toBe(true);
    expect(isValidDoneBotVoiceId("..")).toBe(false);
    expect(isValidDoneBotVoiceId("foo..bar")).toBe(false);

    expect(doneBotClientSpeechModel(flash)?.media_parameters?.voices).toHaveLength(13);
    expect(doneBotClientSpeechModel(plus)?.media_parameters?.voices).toHaveLength(4);
    expect(doneBotClientAsrModel(asr)?.id).toBe(DONEBOT_VOICE_MODELS.asrRealtime);

    expect(resolvePreferredDoneBotSpeechModel(catalog)?.id).toBe(DONEBOT_VOICE_MODELS.ttsFlash);
    expect(resolvePreferredDoneBotSpeechModel(catalog, DONEBOT_VOICE_MODELS.ttsPlus)?.id).toBe(DONEBOT_VOICE_MODELS.ttsPlus);
    expect(resolvePreferredDoneBotSpeechModel({ ...catalog, models: [model, plus] })?.id).toBe(DONEBOT_VOICE_MODELS.ttsPlus);
    expect(resolvePreferredDoneBotSpeechModel({ ...catalog, models: [model] })?.id).toBe(DONEBOT_VOICE_MODELS.ttsLegacy);

    const enriched = enrichDoneBotCatalogForClient({
      ...catalog,
      models: catalog.models.map((item) => item.id === DONEBOT_VOICE_MODELS.ttsFlash ? { ...item, display_name: item.id } : item),
    });
    expect(enriched.defaults.audio).toBe(DONEBOT_VOICE_MODELS.ttsFlash);
    const enrichedFlash = enriched.models.find((item) => item.id === DONEBOT_VOICE_MODELS.ttsFlash)!;
    expect(enrichedFlash.display_name).toBe("Qwen Audio 3.1 TTS Flash");
    expect(enrichedFlash.media_parameters?.voices).toContain("longanhuan_v3.1");
    expect(enrichedFlash.media_parameters?.voices).toContain("yuxiaoyun_v3.1");
    expect(enrichedFlash.media_parameters?.voices).toContain("Emily_v3.1");
    expect(enrichedFlash.pricing).toEqual(flash.pricing);

    const caps = doneBotVoiceCapabilities(catalog, true);
    expect(caps).toMatchObject({
      tts: { available: true, model: DONEBOT_VOICE_MODELS.ttsFlash, defaultVoice: "longanhuan_v3.1" },
      asr: { available: true, model: DONEBOT_VOICE_MODELS.asrRealtime, wsPath: "/api/voice/asr", sampleRate: 16_000, format: "pcm" },
    });
    expect(caps.tts.models.map((item) => item.id)).toEqual([
      DONEBOT_VOICE_MODELS.ttsFlash,
      DONEBOT_VOICE_MODELS.ttsPlus,
      DONEBOT_VOICE_MODELS.ttsLegacy,
    ]);
    expect(doneBotVoiceCapabilities(catalog, false).asr.available).toBe(false);
  });

  it("smoothly falls back legacy or cross-model voices to Qwen-Audio-3.1 default voice and forwards optional controls", async () => {
    const plus: DoneBotGatewayModel = {
      id: DONEBOT_VOICE_MODELS.ttsPlus, display_name: "Qwen Plus", media_types: ["audio"], platforms: ["openai"],
      interfaces: ["openai.audio.speech"],
    };
    const asr: DoneBotGatewayModel = {
      id: DONEBOT_VOICE_MODELS.asrRealtime, display_name: "Qwen ASR", media_types: ["audio"], platforms: ["openai"],
      interfaces: ["openai.audio.transcriptions.realtime"],
    };
    const scope = { accountId: "fixture-user", installationId: "fixture-install" };
    const gateway = {
      authenticated: () => true,
      scope: () => scope,
      requestForScope: vi.fn(async (_scope: unknown, _path: string, _init?: RequestInit) => new Response(new Uint8Array([0, 0, 1, 0]), {
        headers: { "content-type": "audio/pcm", "X-DoneBot-Receipt-ID": receiptId, "X-Audio-Sample-Rate": "16000" },
      })),
      receipt: vi.fn(async () => ({ receipt_id: receiptId, status: "completed" })),
    };
    const service = createDoneBotVoice({ gateway, resolveModel: () => plus, resolveAsrModel: () => asr });
    bindDoneBotVoice(service);

    const cfg = {} as AppConfig;
    expect(describeVoice(cfg)).toMatchObject({
      provider: "donebot",
      model: DONEBOT_VOICE_MODELS.ttsPlus,
      defaultVoice: "longanhuan_v3.1",
      asrAvailable: true,
      asrModel: DONEBOT_VOICE_MODELS.asrRealtime,
      asrWsPath: "/api/voice/asr",
    });
    expect(describeAsr()).toEqual({ ready: true, model: DONEBOT_VOICE_MODELS.asrRealtime, wsPath: "/api/voice/asr" });

    // Legacy gpt-4o-mini-tts voice ("alloy") and flash-only voice ("yuxiaoyun_v3.1") fall back cleanly to Plus default.
    expect(voiceReady(cfg, "alloy")).toBe(true);
    expect(voiceReady(cfg, "yuxiaoyun_v3.1")).toBe(true);
    expect(voiceReady(cfg, "longanlingxin_v3.1")).toBe(true);

    const audio = await speak(cfg, "你好世界", "alloy", undefined, undefined, {
      instruction: "温柔一点",
      speed: 1.1,
      languageHints: ["zh"],
    });
    expect(Buffer.from(audio.bytes).readUInt32LE(24)).toBe(16_000);
    const body = JSON.parse(gateway.requestForScope.mock.calls[0]![2]!.body as string);
    expect(body).toEqual({
      model: DONEBOT_VOICE_MODELS.ttsPlus,
      input: "你好世界",
      voice: "longanhuan_v3.1",
      response_format: "pcm",
      stream_format: "audio",
      instruction: "温柔一点",
      speed: 1.1,
      language_hints: ["zh"],
    });

    const flashVoices = await listVoices(cfg);
    expect(flashVoices).toHaveLength(4);
    expect(flashVoices[0]).toMatchObject({ id: "longanhuan_v3.1", name: "龙安欢", gender: "female", recommended: true });
  });

  it("streams PCM on /api/tts/stream, falls back stale voice IDs on HTTP routes, and aborts upstream on client disconnect", async () => {
    const flash: DoneBotGatewayModel = {
      id: DONEBOT_VOICE_MODELS.ttsFlash, display_name: "Qwen Flash", media_types: ["audio"], platforms: ["openai"],
      interfaces: ["openai.audio.speech"],
    };
    const scope = { accountId: "fixture-user", installationId: "fixture-install" };
    let upstreamCancelled = false;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let mode: "instant" | "stalled" = "instant";
    const gateway = {
      authenticated: () => true,
      scope: () => scope,
      requestForScope: vi.fn(async (_scope: unknown, _path: string, init?: RequestInit) => {
        if (mode === "stalled") {
          init?.signal?.addEventListener("abort", () => { upstreamCancelled = true; }, { once: true });
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) { streamController = controller; },
            cancel() { upstreamCancelled = true; },
          }), { headers: { "content-type": "audio/pcm", "X-DoneBot-Receipt-ID": receiptId } });
        }
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { "content-type": "audio/pcm", "X-DoneBot-Receipt-ID": receiptId },
        });
      }),
      receipt: vi.fn(async () => ({ receipt_id: receiptId, status: "completed" })),
    };
    bindDoneBotVoice(createDoneBotVoice({ gateway, resolveModel: () => flash }));

    const route = createTtsRoutes({ config: () => ({} as AppConfig) });
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      void route({ req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const prep = await fetch(`${origin}/api/tts/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "你好", voiceId: "totally-stale-old-voice" }),
      });
      expect(prep.status).toBe(200);
      expect(await prep.json()).toMatchObject({ ready: true });

      const streamRes = await fetch(`${origin}/api/tts/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "流式测试", voiceId: "totally-stale-old-voice", instruction: "😀".repeat(505) }),
      });
      expect(streamRes.status).toBe(200);
      expect(streamRes.headers.get("content-type")).toBe("audio/pcm");
      expect(streamRes.headers.get("x-audio-sample-rate")).toBe("24000");
      expect(Buffer.from(await streamRes.arrayBuffer())).toEqual(Buffer.from([1, 2, 3, 4]));
      const sentPayload = JSON.parse(gateway.requestForScope.mock.calls[0]![2]!.body as string);
      expect(sentPayload.voice).toBe("longanhuan_v3.1");
      expect(Array.from(sentPayload.instruction as string)).toHaveLength(500);

      // Mid-stream Barge-in disconnect cancels upstream immediately without unhandled errors.
      mode = "stalled";
      const address = server.address() as AddressInfo;
      const clientReq = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        path: "/api/tts/stream",
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      clientReq.on("error", () => {});
      const firstChunk = new Promise<void>((resolve) => {
        clientReq.once("response", (res) => {
          res.once("data", () => resolve());
        });
      });
      clientReq.end(JSON.stringify({ text: "正在播报中", voiceId: "longanhuan_v3.1" }));
      await vi.waitFor(() => expect(streamController).toBeDefined());
      streamController.enqueue(new Uint8Array([9, 8, 7, 6]));
      await firstChunk;
      clientReq.destroy();
      await vi.waitFor(() => expect(upstreamCancelled).toBe(true));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
