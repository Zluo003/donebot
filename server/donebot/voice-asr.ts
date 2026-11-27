import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type {
  DoneBotAsrClientMessage,
  DoneBotAsrErrorCode,
  DoneBotAsrServerMessage,
  DoneBotAsrVadModel,
} from "../../shared/donebot.ts";
import type { DoneBotScope } from "./gateway.ts";

const MAX_CONCURRENT_SESSIONS = 4;
const MAX_CLIENT_FRAME_BYTES = 128 * 1024;
const MAX_AUDIO_FRAME_BYTES = 64 * 1024;
const MAX_PREBUFFER_FRAMES = 64;
const MAX_PREBUFFER_BYTES = 512 * 1024;
const UPSTREAM_BACKPRESSURE_SOFT_BYTES = 256 * 1024;
const UPSTREAM_BACKPRESSURE_HARD_BYTES = 1024 * 1024;
const INITIAL_IDLE_TIMEOUT_MS = 10_000;
const DEFAULT_AUDIO_IDLE_TIMEOUT_MS = 20_000;
const MIN_AUDIO_IDLE_TIMEOUT_MS = 5_000;
const MAX_AUDIO_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_DURATION_MS = 180_000;
const FINISH_WAIT_TIMEOUT_MS = 5_000;
const CLIENT_PING_INTERVAL_MS = 15_000;
const MAX_HOTWORDS = 200;
const MAX_SUPER_HOTWORDS = 50;
const MAX_HOTWORD_CHARS = 32;
const MAX_CONTEXT_CHARS = 400;

export const VOICE_ASR_CLOSE = {
  normal: 1000,
  busy: 4429,
  unavailable: 4503,
  accountChanged: 4401,
  timeout: 4408,
  backpressure: 4413,
  upstreamError: 4502,
} as const;

export interface VoiceAsrUpstreamHandle {
  ws: WebSocket;
  close(): void;
}

export interface VoiceAsrProxyOptions {
  openUpstream(input: {
    scope: DoneBotScope;
    model: string;
    idempotencyKey: string;
    onAccountChanged: () => void;
  }): VoiceAsrUpstreamHandle;
  maxSessions?: number;
  initialIdleTimeoutMs?: number;
  defaultIdleTimeoutMs?: number;
  maxDurationMs?: number;
  finishWaitTimeoutMs?: number;
  pingIntervalMs?: number;
}

export interface VoiceAsrOpenRequest {
  req: IncomingMessage;
  socket: Socket;
  head: Buffer;
  scope: DoneBotScope;
  model: string;
  /** Visible workspace bot names (filtered by request auth) injected as instant hotwords. */
  botNames: string[];
  params: URLSearchParams;
  isCurrent?: () => boolean;
}

interface StartConfig {
  sampleRate: 16_000 | 8_000;
  endpointMs: number;
  vadModel: DoneBotAsrVadModel;
  languageHints?: string[];
  keepDialect?: boolean;
  hotwords: Record<string, number>;
  context?: string;
  idleTimeoutMs: number;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function cleanHotword(word: string): string {
  return word.replace(/[\r\n\t\0]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_HOTWORD_CHARS);
}

function validHotwordWeight(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value === 50 || (value >= 1 && value <= 5)) return value;
  return null;
}

export function buildAsrVocabulary(
  botNames: readonly string[],
  clientHotwords?: Record<string, unknown>,
): Record<string, number> {
  const result: Record<string, number> = {};
  let total = 0;
  let superCount = 0;

  const put = (rawWord: string, weight: number, override = false) => {
    const word = cleanHotword(rawWord);
    if (!word) return;
    const existed = Object.hasOwn(result, word);
    if (existed && !override) return;
    if (!existed && total >= MAX_HOTWORDS) return;
    const prevWasSuper = existed && result[word] === 50;
    const nextIsSuper = weight === 50;
    if (nextIsSuper && !prevWasSuper && superCount >= MAX_SUPER_HOTWORDS) return;
    if (prevWasSuper && !nextIsSuper) superCount -= 1;
    if (!prevWasSuper && nextIsSuper) superCount += 1;
    if (!existed) total += 1;
    result[word] = weight;
  };

  put("DoneBot", 5);
  for (const name of botNames) {
    const cleaned = cleanHotword(name);
    if (!cleaned) continue;
    put(cleaned, 5);
    const wake = cleanHotword(`你好${cleaned}`);
    if (wake && wake !== cleaned) put(wake, 5);
  }

  if (clientHotwords && typeof clientHotwords === "object" && !Array.isArray(clientHotwords)) {
    for (const [word, rawWeight] of Object.entries(clientHotwords)) {
      const weight = validHotwordWeight(rawWeight);
      if (weight === null) continue;
      put(word, weight, true);
    }
  }

  return result;
}

function parseInitialParams(params: URLSearchParams, botNames: readonly string[], defaultIdleTimeoutMs: number): StartConfig {
  const rawEndpoint = Number(params.get("endpointMs"));
  const rawVad = params.get("vadModel");
  const rawLang = params.get("language")?.trim();
  return {
    sampleRate: params.get("sampleRate") === "8000" ? 8_000 : 16_000,
    endpointMs: Number.isFinite(rawEndpoint) && rawEndpoint > 0 ? clampInt(rawEndpoint, 200, 6_000, 800) : 800,
    vadModel: rawVad === "far_field_meeting_16k" ? "far_field_meeting_16k" : "near_meeting_16k",
    ...(rawLang && /^[A-Za-z0-9_-]{2,16}$/.test(rawLang) ? { languageHints: [rawLang] } : {}),
    hotwords: buildAsrVocabulary(botNames),
    idleTimeoutMs: defaultIdleTimeoutMs,
  };
}

function applyStartMessage(
  base: StartConfig,
  botNames: readonly string[],
  msg: Extract<DoneBotAsrClientMessage, { type: "start" }>,
): StartConfig {
  const sampleRate = msg.sampleRate === 8_000 ? 8_000 : 16_000;
  const endpointMs = clampInt(msg.endpointMs, 200, 6_000, base.endpointMs);
  const vadModel: DoneBotAsrVadModel = msg.vadModel === "far_field_meeting_16k"
    ? "far_field_meeting_16k"
    : msg.vadModel === "near_meeting_16k"
      ? "near_meeting_16k"
      : base.vadModel;
  const languageHints = Array.isArray(msg.languageHints)
    ? msg.languageHints
      .filter((item): item is string => typeof item === "string" && /^[A-Za-z0-9_-]{2,16}$/.test(item.trim()))
      .map((item) => item.trim())
      .slice(0, 6)
    : base.languageHints;
  const keepDialect = typeof msg.keepDialect === "boolean" ? msg.keepDialect : base.keepDialect;
  const rawContext = typeof msg.context === "string" ? msg.context.trim() : undefined;
  const context = rawContext ? Array.from(rawContext).slice(0, MAX_CONTEXT_CHARS).join("") : base.context;
  const idleTimeoutMs = clampInt(msg.idleTimeoutMs, MIN_AUDIO_IDLE_TIMEOUT_MS, MAX_AUDIO_IDLE_TIMEOUT_MS, base.idleTimeoutMs);
  return {
    sampleRate,
    endpointMs,
    vadModel,
    ...(languageHints?.length ? { languageHints } : {}),
    ...(keepDialect !== undefined ? { keepDialect } : {}),
    hotwords: buildAsrVocabulary(botNames, msg.hotwords),
    ...(context ? { context } : {}),
    idleTimeoutMs,
  };
}

type SessionPhase = "pending" | "starting" | "streaming" | "finishing" | "closed";

interface AsrSession {
  close(code?: number, reason?: string): void;
}

export class VoiceAsrProxy {
  readonly #options: VoiceAsrProxyOptions;
  readonly #sessions = new Set<AsrSession>();
  readonly #server = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_CLIENT_FRAME_BYTES,
  });

  constructor(options: VoiceAsrProxyOptions) {
    this.#options = options;
  }

  get size(): number {
    return this.#sessions.size;
  }

  open(request: VoiceAsrOpenRequest): void {
    const maxSessions = this.#options.maxSessions ?? MAX_CONCURRENT_SESSIONS;
    this.#server.handleUpgrade(request.req, request.socket, request.head, (clientWs) => {
      if (this.#sessions.size >= maxSessions) {
        try { clientWs.close(VOICE_ASR_CLOSE.busy, "同时进行的语音识别会话过多，请稍后重试。"); } catch {}
        return;
      }
      this.#attach(request, clientWs);
    });
  }

  closeAll(): void {
    for (const session of Array.from(this.#sessions)) {
      session.close(VOICE_ASR_CLOSE.unavailable, "服务端正在关闭。");
    }
  }

  #attach(request: VoiceAsrOpenRequest, clientWs: WebSocket): void {
    const initialIdleTimeoutMs = this.#options.initialIdleTimeoutMs ?? INITIAL_IDLE_TIMEOUT_MS;
    const defaultIdleTimeoutMs = this.#options.defaultIdleTimeoutMs ?? DEFAULT_AUDIO_IDLE_TIMEOUT_MS;
    const maxDurationMs = this.#options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    const finishWaitTimeoutMs = this.#options.finishWaitTimeoutMs ?? FINISH_WAIT_TIMEOUT_MS;
    const pingIntervalMs = this.#options.pingIntervalMs ?? CLIENT_PING_INTERVAL_MS;

    const taskId = randomUUID();
    const idempotencyKey = randomUUID();
    let config = parseInitialParams(request.params, request.botNames, defaultIdleTimeoutMs);
    let phase: SessionPhase = "pending";
    let upstream: VoiceAsrUpstreamHandle | null = null;
    let finishRequested = false;
    let finishSent = false;
    let alive = true;
    const prebuffer: Buffer[] = [];
    let prebufferBytes = 0;
    const startedSentences = new Set<number>();

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let maxTimer: ReturnType<typeof setTimeout> | null = null;
    let finishTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    const clearAllTimers = () => {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
      if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    };

    const sendClient = (message: DoneBotAsrServerMessage) => {
      if (phase === "closed" || clientWs.readyState !== WebSocket.OPEN) return;
      try { clientWs.send(JSON.stringify(message)); } catch {}
    };

    const killUpstream = () => {
      const current = upstream;
      upstream = null;
      if (!current) return;
      current.ws.removeAllListeners();
      // Keep an error listener so late socket errors during close never become uncaught exceptions.
      current.ws.on("error", () => {});
      current.close();
      const wsRef = current.ws;
      if (wsRef.readyState !== WebSocket.CLOSED) {
        setTimeout(() => {
          try { if (wsRef.readyState !== WebSocket.CLOSED) wsRef.terminate(); } catch {}
        }, 500).unref();
      }
    };

    const cleanup = (clientCloseCode?: number, clientCloseReason?: string) => {
      if (phase === "closed") return;
      phase = "closed";
      clearAllTimers();
      prebuffer.length = 0;
      prebufferBytes = 0;
      this.#sessions.delete(session);
      killUpstream();
      if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
        try {
          if (clientCloseCode !== undefined) {
            clientWs.close(clientCloseCode, (clientCloseReason ?? "").slice(0, 120));
          } else {
            clientWs.close(VOICE_ASR_CLOSE.normal);
          }
        } catch {
          try { clientWs.terminate(); } catch {}
        }
      }
    };

    const failAndClose = (code: DoneBotAsrErrorCode, message: string, closeCode: number) => {
      if (phase === "closed") return;
      sendClient({ type: "error", code, message });
      cleanup(closeCode, message);
    };

    const resetIdleTimer = (ms: number) => {
      if (phase === "closed") return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        failAndClose("idle_timeout", "语音识别空闲超时，已自动断开以节省费用。", VOICE_ASR_CLOSE.timeout);
      }, ms);
      idleTimer.unref?.();
    };

    const sendFinishToUpstream = () => {
      if (finishSent || !upstream || upstream.ws.readyState !== WebSocket.OPEN) return;
      finishSent = true;
      phase = "finishing";
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      try {
        upstream.ws.send(JSON.stringify({
          header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
          payload: { input: {} },
        }));
      } catch {
        failAndClose("upstream_closed", "上游语音连接已断开。", VOICE_ASR_CLOSE.upstreamError);
        return;
      }
      finishTimer = setTimeout(() => {
        cleanup(VOICE_ASR_CLOSE.normal, "识别结束");
      }, finishWaitTimeoutMs);
      finishTimer.unref?.();
    };

    const forwardAudioChunk = (chunk: Buffer): boolean => {
      if (!upstream || upstream.ws.readyState !== WebSocket.OPEN) return false;
      const buffered = upstream.ws.bufferedAmount;
      if (buffered + chunk.byteLength > UPSTREAM_BACKPRESSURE_HARD_BYTES) {
        failAndClose("backpressure", "音频上传拥塞，已断开连接，请检查网络后重试。", VOICE_ASR_CLOSE.backpressure);
        return false;
      }
      if (buffered > UPSTREAM_BACKPRESSURE_SOFT_BYTES) {
        // Drop under soft backpressure so real-time latency never snowballs.
        return true;
      }
      try {
        upstream.ws.send(chunk, { binary: true });
        return true;
      } catch {
        failAndClose("upstream_closed", "上游语音连接已断开。", VOICE_ASR_CLOSE.upstreamError);
        return false;
      }
    };

    const handleUpstreamEvent = (raw: RawData, isBinary: boolean) => {
      if (phase === "closed" || isBinary) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawDataToBuffer(raw).toString("utf8")) as Record<string, unknown>;
      } catch {
        return;
      }
      const header = (parsed.header && typeof parsed.header === "object" ? parsed.header : {}) as Record<string, unknown>;
      const payload = (parsed.payload && typeof parsed.payload === "object" ? parsed.payload : {}) as Record<string, unknown>;
      const event = typeof header.event === "string" ? header.event : "";

      if (event === "task-started") {
        if (phase !== "starting") return;
        phase = "streaming";
        sendClient({ type: "ready", model: request.model, taskId });
        const queued = prebuffer.splice(0);
        prebufferBytes = 0;
        for (const chunk of queued) {
          if (phase !== "streaming") return;
          if (!forwardAudioChunk(chunk)) return;
        }
        if (finishRequested) sendFinishToUpstream();
        return;
      }

      if (event === "result-generated") {
        const output = (payload.output && typeof payload.output === "object" ? payload.output : {}) as Record<string, unknown>;
        const sentence = (output.sentence && typeof output.sentence === "object" ? output.sentence : null) as Record<string, unknown> | null;
        if (!sentence || sentence.heartbeat === true) return;
        const sentenceId = typeof sentence.sentence_id === "number" && Number.isFinite(sentence.sentence_id)
          ? sentence.sentence_id
          : 0;
        const text = typeof sentence.text === "string" ? sentence.text : "";
        const beginTime = typeof sentence.begin_time === "number" && Number.isFinite(sentence.begin_time)
          ? sentence.begin_time
          : undefined;
        const endTime = typeof sentence.end_time === "number" && Number.isFinite(sentence.end_time)
          ? sentence.end_time
          : undefined;
        const sentenceBegin = sentence.sentence_begin === true;
        const sentenceEnd = sentence.sentence_end === true;

        if ((sentenceBegin || text.trim().length > 0) && !startedSentences.has(sentenceId)) {
          startedSentences.add(sentenceId);
          sendClient({
            type: "speech_started",
            sentenceId,
            ...(beginTime !== undefined ? { beginTime } : {}),
          });
        }
        if (text.length > 0 || sentenceEnd) {
          sendClient({
            type: "transcript",
            sentenceId,
            text,
            final: sentenceEnd,
            ...(beginTime !== undefined ? { beginTime } : {}),
            ...(endTime !== undefined ? { endTime } : {}),
          });
        }
        if (sentenceEnd) {
          startedSentences.delete(sentenceId);
          sendClient({
            type: "speech_stopped",
            sentenceId,
            ...(endTime !== undefined ? { endTime } : {}),
          });
        }
        return;
      }

      if (event === "task-finished") {
        const rawUsage = (payload.usage && typeof payload.usage === "object" ? payload.usage : null) as Record<string, unknown> | null;
        const usage = rawUsage
          ? {
            ...(typeof rawUsage.input_tokens === "number" ? { inputTokens: rawUsage.input_tokens } : {}),
            ...(typeof rawUsage.output_tokens === "number" ? { outputTokens: rawUsage.output_tokens } : {}),
            ...(typeof rawUsage.total_tokens === "number" ? { totalTokens: rawUsage.total_tokens } : {}),
          }
          : undefined;
        sendClient({
          type: "finished",
          ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
        });
        cleanup(VOICE_ASR_CLOSE.normal, "识别完成");
        return;
      }

      if (event === "task-failed") {
        failAndClose("upstream_failed", "云端语音识别异常中断，请重试。", VOICE_ASR_CLOSE.upstreamError);
      }
    };

    const startUpstream = (): boolean => {
      if (phase !== "pending") return false;
      phase = "starting";
      resetIdleTimer(config.idleTimeoutMs);
      maxTimer = setTimeout(() => {
        failAndClose("max_duration", "单次语音识别已达时长上限，请重新开始。", VOICE_ASR_CLOSE.timeout);
      }, maxDurationMs);
      maxTimer.unref?.();

      try {
        upstream = this.#options.openUpstream({
          scope: request.scope,
          model: request.model,
          idempotencyKey,
          onAccountChanged: () => {
            failAndClose("account_changed", "DoneBot 账号状态已变化，请重新连接。", VOICE_ASR_CLOSE.accountChanged);
          },
        });
      } catch {
        failAndClose("asr_unavailable", "无法建立云端语音识别连接，请确认账号已登录。", VOICE_ASR_CLOSE.unavailable);
        return false;
      }

      const upstreamWs = upstream.ws;
      upstreamWs.once("open", () => {
        if (phase !== "starting" || !upstream || upstream.ws !== upstreamWs) return;
        const parameters: Record<string, unknown> = {
          format: "pcm",
          sample_rate: config.sampleRate,
          max_sentence_silence: config.endpointMs,
          vad_model: config.vadModel,
          ...(config.languageHints?.length ? { language_hints: config.languageHints } : {}),
          ...(config.keepDialect !== undefined ? { keep_dialect: config.keepDialect } : {}),
          ...(Object.keys(config.hotwords).length > 0 ? { vocabulary: config.hotwords } : {}),
        };
        const input: Record<string, unknown> = config.context
          ? { context: [{ role: "user", content: [{ type: "input_text", text: config.context }] }] }
          : {};
        try {
          upstreamWs.send(JSON.stringify({
            header: { action: "run-task", task_id: taskId, streaming: "duplex" },
            payload: {
              task_group: "audio",
              task: "asr",
              function: "recognition",
              model: request.model,
              parameters,
              input,
            },
          }));
        } catch {
          failAndClose("upstream_closed", "上游语音连接发送任务失败。", VOICE_ASR_CLOSE.upstreamError);
        }
      });

      upstreamWs.on("message", handleUpstreamEvent);
      upstreamWs.once("unexpected-response", (_req, res) => {
        const status = res.statusCode ?? 502;
        if (status === 401 || status === 403) {
          failAndClose("auth_expired", "DoneBot 网关认证已失效，请重新登录。", VOICE_ASR_CLOSE.accountChanged);
        } else if (status === 402 || status === 429) {
          failAndClose("asr_unavailable", "当前账号额度或并发受限，暂无法启动云端语音识别。", VOICE_ASR_CLOSE.busy);
        } else {
          failAndClose("upstream_failed", "云端语音识别握手失败，请稍后重试。", VOICE_ASR_CLOSE.upstreamError);
        }
      });
      upstreamWs.once("error", () => {
        failAndClose("upstream_closed", "云端语音识别连接异常断开。", VOICE_ASR_CLOSE.upstreamError);
      });
      upstreamWs.once("close", () => {
        if (phase === "closed") return;
        if (phase === "finishing") {
          cleanup(VOICE_ASR_CLOSE.normal, "识别结束");
        } else {
          failAndClose("upstream_closed", "云端语音识别连接已关闭。", VOICE_ASR_CLOSE.upstreamError);
        }
      });
      return true;
    };

    const session: AsrSession = {
      close: (code, reason) => cleanup(code, reason),
    };
    this.#sessions.add(session);

    resetIdleTimer(initialIdleTimeoutMs);
    pingTimer = setInterval(() => {
      if (phase === "closed") return;
      if (request.isCurrent && !request.isCurrent()) {
        failAndClose("account_changed", "当前会话已失效，已断开语音识别。", VOICE_ASR_CLOSE.accountChanged);
        return;
      }
      if (!alive) {
        cleanup(VOICE_ASR_CLOSE.timeout, "客户端心跳超时");
        return;
      }
      alive = false;
      try { clientWs.ping(); } catch { cleanup(VOICE_ASR_CLOSE.timeout, "客户端连接中断"); }
    }, pingIntervalMs);
    pingTimer.unref?.();

    clientWs.on("pong", () => { alive = true; });

    clientWs.on("message", (data, isBinary) => {
      if (phase === "closed") return;
      if (request.isCurrent && !request.isCurrent()) {
        failAndClose("account_changed", "当前会话已失效，已断开语音识别。", VOICE_ASR_CLOSE.accountChanged);
        return;
      }

      if (isBinary) {
        const chunk = rawDataToBuffer(data);
        if (chunk.byteLength === 0) return;
        if (chunk.byteLength > MAX_AUDIO_FRAME_BYTES) {
          sendClient({ type: "error", code: "invalid_frame", message: "单帧音频超出大小上限（64 KiB）。" });
          return;
        }
        if (phase === "finishing") return;
        if (phase === "pending" && !startUpstream()) return;
        resetIdleTimer(config.idleTimeoutMs);
        if (phase === "starting") {
          while (
            prebuffer.length >= MAX_PREBUFFER_FRAMES
            || (prebuffer.length > 0 && prebufferBytes + chunk.byteLength > MAX_PREBUFFER_BYTES)
          ) {
            const dropped = prebuffer.shift();
            if (dropped) prebufferBytes -= dropped.byteLength;
          }
          prebuffer.push(chunk);
          prebufferBytes += chunk.byteLength;
          return;
        }
        if (phase === "streaming") forwardAudioChunk(chunk);
        return;
      }

      let message: DoneBotAsrClientMessage;
      try {
        message = JSON.parse(rawDataToBuffer(data).toString("utf8")) as DoneBotAsrClientMessage;
      } catch {
        sendClient({ type: "error", code: "invalid_frame", message: "控制消息不是有效的 JSON。" });
        return;
      }
      if (!message || typeof message !== "object" || typeof message.type !== "string") {
        sendClient({ type: "error", code: "invalid_frame", message: "控制消息缺少有效的 type 字段。" });
        return;
      }

      if (message.type === "ping") {
        // Deliberately does NOT reset the audio idle timer so silent zombies cannot burn upstream minutes.
        sendClient({ type: "pong" });
        return;
      }

      if (message.type === "stop") {
        cleanup(VOICE_ASR_CLOSE.normal, "客户端停止");
        return;
      }

      if (message.type === "finish") {
        if (phase === "pending") {
          sendClient({ type: "finished" });
          cleanup(VOICE_ASR_CLOSE.normal, "识别结束");
          return;
        }
        finishRequested = true;
        if (phase === "streaming") sendFinishToUpstream();
        return;
      }

      if (message.type === "start") {
        if (phase !== "pending") return;
        config = applyStartMessage(config, request.botNames, message);
        startUpstream();
        return;
      }

      sendClient({ type: "error", code: "invalid_frame", message: "不支持的控制指令类型。" });
    });

    clientWs.once("close", () => cleanup());
    clientWs.once("error", () => cleanup());
  }
}
