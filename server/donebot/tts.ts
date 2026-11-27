import { randomUUID } from "node:crypto";
import type { DoneBotAsrConfigSummary, DoneBotGatewayModel } from "../../shared/donebot.ts";
import {
  DONEBOT_ASR_WS_PATH,
  DONEBOT_TTS_DEFAULT_SAMPLE_RATE,
  DONEBOT_VOICE_MODELS,
  doneBotSpeechMaxInputChars,
  doneBotSpeechModelSpec,
  doneBotSpeechVoices,
  isQwen31SpeechModel,
  isValidDoneBotVoiceId,
  resolveDoneBotSpeechVoice,
} from "../../shared/donebot-voice.ts";
import type { Audio, Voice } from "../tts/elevenlabs.ts";
import type { DoneBotSpeechOptions, DoneBotVoice, VoiceStream } from "../tts/index.ts";
import type { DoneBotGateway, DoneBotScope } from "./gateway.ts";
import { doneBotClientAsrModel, doneBotClientSpeechModel } from "./media-registry.ts";

// Default gateway streaming PCM is 24 kHz, mono, signed 16-bit little-endian.
const DEFAULT_SAMPLE_RATE = DONEBOT_TTS_DEFAULT_SAMPLE_RATE;
const ALLOWED_SAMPLE_RATES = new Set([8_000, 12_000, 16_000, 22_050, 24_000, 44_100, 48_000]);
const MAX_AUDIO_SECONDS = 10 * 60;

interface Dependencies {
  gateway: Pick<DoneBotGateway, "authenticated" | "scope" | "requestForScope" | "receipt">;
  resolveModel(): DoneBotGatewayModel | undefined;
  resolveAsrModel?(): DoneBotGatewayModel | undefined;
}
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
});

function parseSampleRate(header: string | null): number {
  if (!header) return DEFAULT_SAMPLE_RATE;
  const parsed = Number(header.trim());
  return Number.isInteger(parsed) && ALLOWED_SAMPLE_RATES.has(parsed) ? parsed : DEFAULT_SAMPLE_RATE;
}

function wave(bytes: Uint8Array, sampleRate: number = DEFAULT_SAMPLE_RATE): Audio {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(bytes.length + 36, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(bytes.length, 40);
  return { bytes: Buffer.concat([header, bytes]), mime: "audio/wav" };
}

function qwenControlFields(modelId: string, options?: DoneBotSpeechOptions): Record<string, unknown> {
  if (!options || !isQwen31SpeechModel(modelId)) return {};
  const extra: Record<string, unknown> = {};
  if (typeof options.instruction === "string") {
    const trimmed = options.instruction.trim();
    if (trimmed && Array.from(trimmed).length <= 500) extra.instruction = trimmed;
  }
  if (typeof options.speed === "number" && Number.isFinite(options.speed) && options.speed >= 0.5 && options.speed <= 2.0) {
    extra.speed = options.speed;
  }
  if (typeof options.pitch === "number" && Number.isFinite(options.pitch) && options.pitch >= 0.5 && options.pitch <= 2.0) {
    extra.pitch = options.pitch;
  }
  if (typeof options.volume === "number" && Number.isFinite(options.volume) && options.volume >= 0 && options.volume <= 100) {
    extra.volume = Math.round(options.volume);
  }
  if (Array.isArray(options.languageHints)) {
    const hints = options.languageHints
      .filter((item): item is string => typeof item === "string" && /^[A-Za-z0-9_-]{2,16}$/.test(item.trim()))
      .map((item) => item.trim())
      .slice(0, 4);
    if (hints.length) extra.language_hints = hints;
  }
  return extra;
}

export function createDoneBotVoice(deps: Dependencies): DoneBotVoice {
  const model = () => doneBotClientSpeechModel(deps.resolveModel());
  const asrModel = () => doneBotClientAsrModel(deps.resolveAsrModel?.());
  const voices = (): Voice[] => {
    const selectedModel = model();
    if (!selectedModel) return [];
    if (selectedModel.id === DONEBOT_VOICE_MODELS.ttsLegacy) {
      const configured = selectedModel.media_parameters?.voices;
      return Array.isArray(configured)
        ? configured.filter(isValidDoneBotVoiceId).map((id) => ({ id, label: id }))
        : [];
    }
    return doneBotSpeechVoices(selectedModel.id).filter((voice) => isValidDoneBotVoiceId(voice.id));
  };
  const defaultVoice = (): string => {
    const selectedModel = model();
    if (!selectedModel) return "";
    return doneBotSpeechModelSpec(selectedModel.id)?.defaultVoice ?? voices()[0]?.id ?? "";
  };
  const selected = (id?: string, fallbackUnknown = false): string | undefined => {
    const selectedModel = model();
    if (!selectedModel) return undefined;
    return resolveDoneBotSpeechVoice(selectedModel.id, id, { fallbackUnknown });
  };
  const asr = (): DoneBotAsrConfigSummary => {
    const enabled = deps.gateway.authenticated() ? asrModel() : undefined;
    return {
      ready: Boolean(enabled),
      model: enabled?.id ?? "",
      wsPath: DONEBOT_ASR_WS_PATH,
    };
  };
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
  const stream = async (text: string, voiceId?: string, signal?: AbortSignal, options?: DoneBotSpeechOptions): Promise<VoiceStream> => {
    const selectedModel = model();
    const voice = selected(voiceId, options?.fallbackUnknownVoice === true);
    if (!deps.gateway.authenticated() || !selectedModel) throw new Error("Sign in to DoneBot and select an available speech model.");
    if (!voice) throw new Error("Pick an available DoneBot voice.");
    const maxChars = doneBotSpeechMaxInputChars(selectedModel.id);
    if (!text.trim() || Array.from(text).length > maxChars) throw new Error(`Speech text must contain 1–${maxChars} characters.`);
    const scope = deps.gateway.scope();
    if (!scope) throw new Error("Sign in to DoneBot to use speech.");
    const controller = new AbortController();
    const active = AbortSignal.any([...(signal ? [signal] : []), controller.signal, AbortSignal.timeout(180_000)]);
    active.throwIfAborted();
    const response = await deps.gateway.requestForScope(scope, "/v1/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        model: selectedModel.id,
        input: text,
        voice,
        response_format: "pcm",
        stream_format: "audio",
        ...qwenControlFields(selectedModel.id, options),
      }),
      signal: active,
    });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`DoneBot speech request failed (HTTP ${response.status}).`); }
    const receipt = response.headers.get("X-DoneBot-Receipt-ID");
    if (!receipt || !/^[A-Za-z0-9_-]{1,200}$/.test(receipt) || !response.body) { await response.body?.cancel().catch(() => {}); throw new Error("DoneBot speech returned no verifiable stream receipt."); }
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (mime !== "audio/pcm" && mime !== "application/octet-stream") { await response.body?.cancel().catch(() => {}); throw new Error("DoneBot speech returned an unexpected audio format."); }
    const sampleRate = parseSampleRate(response.headers.get("X-Audio-Sample-Rate"));
    const maxAudioBytes = sampleRate * 2 * MAX_AUDIO_SECONDS;
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
          if (total > maxAudioBytes) throw new Error("DoneBot speech exceeded the audio size limit.");
          target.enqueue(next.value);
        } catch (error) { cleanup(); controller.abort(); await reader.cancel().catch(() => {}); target.error(error); }
      },
      async cancel(reason) { cleanup(); if (!ended) controller.abort(reason); await reader.cancel(reason).catch(() => {}); },
    }, { highWaterMark: 0 });
    return { body, mime: "audio/pcm", sampleRate };
  };
  return {
    configured: () => deps.gateway.authenticated() && Boolean(model()) && voices().length > 0,
    ready: (voiceId) => deps.gateway.authenticated() && Boolean(model()) && Boolean(selected(voiceId)),
    model: () => model()?.id ?? "",
    defaultVoice,
    asr,
    voices,
    stream,
    async speak(text, voiceId, signal, options) {
      const audio = await stream(text, voiceId, signal, options), reader = audio.body.getReader(), chunks: Uint8Array[] = [];
      try { for (;;) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); } }
      finally { await reader.cancel().catch(() => {}); }
      return wave(Buffer.concat(chunks), audio.sampleRate ?? DEFAULT_SAMPLE_RATE);
    },
  };
}
