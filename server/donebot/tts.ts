import { randomUUID } from "node:crypto";
import type { DoneBotGatewayModel } from "../../shared/donebot.ts";
import type { Audio, Voice } from "../tts/elevenlabs.ts";
import type { DoneBotVoice, VoiceStream } from "../tts/index.ts";
import type { DoneBotGateway, DoneBotScope } from "./gateway.ts";

// https://developers.openai.com/api/docs/guides/text-to-speech: PCM is 24 kHz, mono, signed 16-bit little-endian.
const SAMPLE_RATE = 24_000;
const MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * 10 * 60;

interface Dependencies {
  gateway: Pick<DoneBotGateway, "authenticated" | "scope" | "requestForScope" | "receipt">;
  resolveModel(): DoneBotGatewayModel | undefined;
}
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
});

function wave(bytes: Uint8Array): Audio {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(bytes.length + 36, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(bytes.length, 40);
  return { bytes: Buffer.concat([header, bytes]), mime: "audio/wav" };
}

export function createDoneBotVoice(deps: Dependencies): DoneBotVoice {
  const model = () => {
    const value = deps.resolveModel();
    const formats = value?.media_parameters?.formats;
    const adapter = (value?.media_parameters?.protocol as { adapter?: unknown } | undefined)?.adapter;
    if (!value || !value.media_types.includes("audio") ||
        !value.interfaces.includes("openai.audio.speech") || adapter !== "apimart.speech.v1" || !Array.isArray(formats) || !formats.includes("pcm")) return undefined;
    return value;
  };
  const voices = (): Voice[] => {
    const configured = model()?.media_parameters?.voices;
    return Array.isArray(configured) ? configured.filter((voice): voice is string => typeof voice === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(voice)).map((id) => ({ id, label: id })) : [];
  };
  const selected = (id?: string) => { const available = voices(); return available.find((voice) => voice.id === id)?.id ?? (!id ? available[0]?.id : undefined); };
  const scopeStillMatches = (scope: DoneBotScope) => { const now = deps.gateway.scope(); if (!now || now.accountId !== scope.accountId || now.installationId !== scope.installationId) throw new Error("DoneBot account changed during speech."); };
  const settleReceipt = async (id: string, scope: DoneBotScope, signal: AbortSignal) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      signal.throwIfAborted(); scopeStillMatches(scope);
      const value = await deps.gateway.receipt(id, scope, signal) as { receipt_id?: unknown; status?: unknown };
      signal.throwIfAborted(); scopeStillMatches(scope);
      if (value?.receipt_id !== id) throw new Error("DoneBot speech receipt could not be verified.");
      if (value.status === "completed") return;
      if (!["dispatching", "accepted", "processing"].includes(String(value.status))) throw new Error("DoneBot speech ended without confirmed completion. Check its receipt before trying again.");
      if (attempt < 7) await delay(250 * (attempt + 1), signal);
    }
    throw new Error("DoneBot speech completion is still pending. Check its receipt before trying again.");
  };
  const stream = async (text: string, voiceId?: string, signal?: AbortSignal): Promise<VoiceStream> => {
    const selectedModel = model(), voice = selected(voiceId);
    if (!deps.gateway.authenticated() || !selectedModel) throw new Error("Sign in to DoneBot and select an available speech model.");
    if (!voice) throw new Error("Pick an available DoneBot voice.");
    if (!text.trim() || text.length > 4096) throw new Error("Speech text must contain 1–4096 characters.");
    const scope = deps.gateway.scope();
    if (!scope) throw new Error("Sign in to DoneBot to use speech.");
    const controller = new AbortController();
    const active = AbortSignal.any([...(signal ? [signal] : []), controller.signal, AbortSignal.timeout(180_000)]);
    active.throwIfAborted();
    const response = await deps.gateway.requestForScope(scope, "/v1/audio/speech", {
      method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ model: selectedModel.id, input: text, voice, response_format: "pcm", stream_format: "audio" }), signal: active,
    });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`DoneBot speech request failed (HTTP ${response.status}).`); }
    const receipt = response.headers.get("X-DoneBot-Receipt-ID");
    if (!receipt || !/^[A-Za-z0-9_-]{1,200}$/.test(receipt) || !response.body) { await response.body?.cancel().catch(() => {}); throw new Error("DoneBot speech returned no verifiable stream receipt."); }
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (mime !== "audio/pcm" && mime !== "application/octet-stream") { await response.body.cancel().catch(() => {}); throw new Error("DoneBot speech returned an unexpected audio format."); }
    const reader = response.body.getReader();
    let total = 0, ended = false;
    const abort = () => { void reader.cancel(active.reason).catch(() => {}); };
    active.addEventListener("abort", abort, { once: true });
    const cleanup = () => { active.removeEventListener("abort", abort); };
    const body = new ReadableStream<Uint8Array>({
      async pull(target) {
        try {
          active.throwIfAborted(); scopeStillMatches(scope);
          const next = await reader.read();
          active.throwIfAborted(); scopeStillMatches(scope);
          if (next.done) {
            if (!total || total % 2) throw new Error("DoneBot speech returned incomplete PCM samples.");
            await settleReceipt(receipt, scope, active);
            ended = true; cleanup(); target.close(); return;
          }
          total += next.value.byteLength;
          if (total > MAX_AUDIO_BYTES) throw new Error("DoneBot speech exceeded the audio size limit.");
          target.enqueue(next.value);
        } catch (error) { cleanup(); controller.abort(); await reader.cancel().catch(() => {}); target.error(error); }
      },
      async cancel(reason) { cleanup(); if (!ended) controller.abort(reason); await reader.cancel(reason); },
    }, { highWaterMark: 0 });
    return { body, mime: "audio/pcm", sampleRate: SAMPLE_RATE };
  };
  return {
    configured: () => deps.gateway.authenticated() && Boolean(model()) && voices().length > 0,
    ready: (voiceId) => deps.gateway.authenticated() && Boolean(model()) && Boolean(selected(voiceId)),
    model: () => model()?.id ?? "", voices, stream,
    async speak(text, voiceId, signal) {
      const audio = await stream(text, voiceId, signal), reader = audio.body.getReader(), chunks: Uint8Array[] = [];
      try { for (;;) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); } }
      finally { await reader.cancel().catch(() => {}); }
      return wave(Buffer.concat(chunks));
    },
  };
}
