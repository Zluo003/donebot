import { afterEach, describe, expect, it, vi } from "vitest";
import type { DoneBotGatewayModel } from "../../shared/donebot.ts";
import type { AppConfig } from "../config.ts";
import { bindDoneBotVoice, describeVoice, listVoices, providerConfigured, speak, streamVoice, verifyKey, voiceReady } from "../tts/index.ts";
import { doneBotClientSpeechModel } from "./media-registry.ts";
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
});
