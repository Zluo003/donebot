/**
 * Client-side WebSocket transport for local server streaming ASR (`/api/voice/asr`).
 * Strictly talks to the same-origin DoneBot server; gateway/DashScope credentials never reach the renderer.
 */

export const DEFAULT_ASR_WS_PATH = "/api/voice/asr";
export const MAX_PRE_OPEN_FRAMES = 64;
export const MAX_PRE_OPEN_BYTES = 512 * 1024;
export const MAX_WS_BUFFERED_BYTES = 256 * 1024;
const FINISH_CLOSE_TIMEOUT_MS = 3_500;

export interface AsrStartOptions {
  wsPath?: string;
  sampleRate?: 16000 | 8000;
  endpointMs?: number;
  vadModel?: "near_meeting_16k" | "far_field_meeting_16k";
  languageHints?: string[];
  keepDialect?: boolean;
  hotwords?: Record<string, number>;
  idleTimeoutMs?: number;
}

export type AsrServerEvent =
  | { type: "ready"; model: string; taskId?: string }
  | { type: "speech_started"; sentenceId?: number; beginTime?: number }
  | { type: "transcript"; sentenceId?: number; text: string; final: boolean; beginTime?: number; endTime?: number }
  | { type: "speech_stopped"; sentenceId?: number; endTime?: number }
  | { type: "finished"; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }
  | { type: "pong" }
  | { type: "error"; code: string; message: string };

export interface AsrCloseInfo {
  code: number;
  reason: string;
  wasClean: boolean;
}

export interface WebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string; wasClean?: boolean }) => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const WS_CONNECTING = 0;
const WS_OPEN = 1;

export function buildAsrWsUrl(
  wsPath = DEFAULT_ASR_WS_PATH,
  query?: { endpointMs?: number; vadModel?: string; language?: string },
): string {
  const path = wsPath.startsWith("/") ? wsPath : `/${wsPath}`;
  const loc = typeof window !== "undefined" ? window.location : undefined;
  const proto = loc?.protocol === "https:" ? "wss:" : "ws:";
  const host = loc?.host || "127.0.0.1";
  const url = new URL(`${proto}//${host}${path}`);
  if (query?.endpointMs !== undefined && Number.isFinite(query.endpointMs)) {
    url.searchParams.set("endpointMs", String(Math.round(query.endpointMs)));
  }
  if (query?.vadModel) url.searchParams.set("vadModel", query.vadModel);
  if (query?.language) url.searchParams.set("language", query.language);
  return url.toString();
}

export function parseAsrServerEvent(raw: unknown): AsrServerEvent | null {
  if (typeof raw !== "string" || !raw) return null;
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }

  switch (parsed.type) {
    case "ready":
      return {
        type: "ready",
        model: typeof parsed.model === "string" ? parsed.model : "",
        taskId: typeof parsed.taskId === "string" ? parsed.taskId : undefined,
      };
    case "speech_started":
      return {
        type: "speech_started",
        sentenceId: typeof parsed.sentenceId === "number" ? parsed.sentenceId : undefined,
        beginTime: typeof parsed.beginTime === "number" ? parsed.beginTime : undefined,
      };
    case "transcript":
      if (typeof parsed.text !== "string") return null;
      return {
        type: "transcript",
        sentenceId: typeof parsed.sentenceId === "number" ? parsed.sentenceId : undefined,
        text: parsed.text,
        final: parsed.final === true,
        beginTime: typeof parsed.beginTime === "number" ? parsed.beginTime : undefined,
        endTime: typeof parsed.endTime === "number" ? parsed.endTime : undefined,
      };
    case "speech_stopped":
      return {
        type: "speech_stopped",
        sentenceId: typeof parsed.sentenceId === "number" ? parsed.sentenceId : undefined,
        endTime: typeof parsed.endTime === "number" ? parsed.endTime : undefined,
      };
    case "finished": {
      const u = parsed.usage && typeof parsed.usage === "object"
        ? parsed.usage as Record<string, unknown>
        : undefined;
      return {
        type: "finished",
        usage: u
          ? {
              inputTokens: typeof u.inputTokens === "number" ? u.inputTokens : undefined,
              outputTokens: typeof u.outputTokens === "number" ? u.outputTokens : undefined,
              totalTokens: typeof u.totalTokens === "number" ? u.totalTokens : undefined,
            }
          : undefined,
      };
    }
    case "pong":
      return { type: "pong" };
    case "error":
      return {
        type: "error",
        code: typeof parsed.code === "string" ? parsed.code : "unknown",
        message: typeof parsed.message === "string" ? parsed.message : "语音识别服务异常。",
      };
    default:
      return null;
  }
}

export interface RealtimeAsrClient {
  isOpen(): boolean;
  isActive(): boolean;
  sendAudio(pcmBytes: Uint8Array): boolean;
  finish(): void;
  stop(): void;
}

export function connectRealtimeAsr(
  options: AsrStartOptions,
  callbacks: {
    onOpen?: () => void;
    onEvent: (event: AsrServerEvent) => void;
    onClose?: (info: AsrCloseInfo) => void;
  },
  deps?: {
    createWebSocket?: WebSocketFactory;
    preRollChunks?: readonly Uint8Array[];
  },
): RealtimeAsrClient {
  const createWs: WebSocketFactory = deps?.createWebSocket
    ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);

  const url = buildAsrWsUrl(options.wsPath ?? DEFAULT_ASR_WS_PATH, {
    endpointMs: options.endpointMs,
    vadModel: options.vadModel,
    language: options.languageHints?.[0],
  });

  let closed = false;
  let finishing = false;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  const preOpenQueue: Uint8Array[] = [];
  let preOpenBytes = 0;

  const enqueuePreOpen = (chunk: Uint8Array) => {
    if (!chunk.byteLength) return;
    const copy = new Uint8Array(chunk.byteLength);
    copy.set(chunk);
    preOpenQueue.push(copy);
    preOpenBytes += copy.byteLength;
    while (preOpenQueue.length > MAX_PRE_OPEN_FRAMES || preOpenBytes > MAX_PRE_OPEN_BYTES) {
      const dropped = preOpenQueue.shift();
      if (!dropped) break;
      preOpenBytes -= dropped.byteLength;
    }
  };

  if (deps?.preRollChunks) {
    for (const chunk of deps.preRollChunks) enqueuePreOpen(chunk);
  }

  let ws: WebSocketLike | null = null;
  const clearFinishTimer = () => {
    if (finishTimer) {
      clearTimeout(finishTimer);
      finishTimer = null;
    }
  };

  const cleanupWs = () => {
    clearFinishTimer();
    preOpenQueue.length = 0;
    preOpenBytes = 0;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
    }
  };

  const sendStartFrame = (socket: WebSocketLike) => {
    const startPayload: Record<string, unknown> = {
      type: "start",
      sampleRate: options.sampleRate ?? 16000,
    };
    if (options.endpointMs !== undefined) {
      startPayload.endpointMs = Math.max(200, Math.min(6000, Math.round(options.endpointMs)));
    }
    if (options.vadModel) startPayload.vadModel = options.vadModel;
    if (options.languageHints?.length) startPayload.languageHints = options.languageHints;
    if (options.keepDialect !== undefined) startPayload.keepDialect = options.keepDialect;
    if (options.hotwords && Object.keys(options.hotwords).length > 0) {
      startPayload.hotwords = options.hotwords;
    }
    if (options.idleTimeoutMs !== undefined) {
      startPayload.idleTimeoutMs = Math.max(5_000, Math.min(60_000, Math.round(options.idleTimeoutMs)));
    }
    socket.send(JSON.stringify(startPayload));
  };

  const emitCloseOnce = (info: AsrCloseInfo) => {
    if (closed) return;
    closed = true;
    cleanupWs();
    ws = null;
    callbacks.onClose?.(info);
  };

  try {
    ws = createWs(url);
    ws.binaryType = "arraybuffer";
  } catch {
    closed = true;
    queueMicrotask(() => {
      callbacks.onEvent({ type: "error", code: "ws_connect_failed", message: "无法连接本地语音识别通道。" });
      callbacks.onClose?.({ code: 1006, reason: "connect-failed", wasClean: false });
    });
    return {
      isOpen: () => false,
      isActive: () => false,
      sendAudio: () => false,
      finish: () => {},
      stop: () => {},
    };
  }

  ws.onopen = () => {
    if (closed || !ws) return;
    try {
      sendStartFrame(ws);
      while (preOpenQueue.length > 0 && ws.readyState === WS_OPEN) {
        const chunk = preOpenQueue.shift()!;
        preOpenBytes -= chunk.byteLength;
        ws.send(chunk);
      }
      if (finishing && ws.readyState === WS_OPEN) {
        ws.send(JSON.stringify({ type: "finish" }));
      }
      callbacks.onOpen?.();
    } catch {
      emitCloseOnce({ code: 1006, reason: "send-failed", wasClean: false });
    }
  };

  ws.onmessage = (event) => {
    if (closed) return;
    const parsed = parseAsrServerEvent(event.data);
    if (!parsed) return;
    callbacks.onEvent(parsed);
    if (parsed.type === "finished") {
      const current = ws;
      emitCloseOnce({ code: 1000, reason: "finished", wasClean: true });
      try { current?.close(1000, "finished"); } catch {}
    }
  };

  ws.onerror = () => {
    // WebSocket spec always follows `error` with `close`; defer final teardown to `onclose`.
  };

  ws.onclose = (event) => {
    emitCloseOnce({
      code: typeof event?.code === "number" ? event.code : 1006,
      reason: typeof event?.reason === "string" ? event.reason : "",
      wasClean: event?.wasClean === true,
    });
  };

  return {
    isOpen: () => !closed && ws?.readyState === WS_OPEN,
    isActive: () => !closed && ws !== null && (ws.readyState === WS_CONNECTING || ws.readyState === WS_OPEN),
    sendAudio(pcmBytes: Uint8Array) {
      if (closed || finishing || !ws || !pcmBytes.byteLength) return false;
      if (ws.readyState === WS_CONNECTING) {
        enqueuePreOpen(pcmBytes);
        return true;
      }
      if (ws.readyState !== WS_OPEN) return false;
      if (typeof ws.bufferedAmount === "number" && ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
        return false;
      }
      try {
        ws.send(pcmBytes);
        return true;
      } catch {
        return false;
      }
    },
    finish() {
      if (closed || finishing || !ws) return;
      finishing = true;
      if (ws.readyState === WS_OPEN) {
        try {
          ws.send(JSON.stringify({ type: "finish" }));
        } catch {
          this.stop();
          return;
        }
      }
      clearFinishTimer();
      finishTimer = setTimeout(() => {
        if (closed) return;
        const current = ws;
        emitCloseOnce({ code: 1000, reason: "finish-timeout", wasClean: true });
        try { current?.close(1000, "finish-timeout"); } catch {}
      }, FINISH_CLOSE_TIMEOUT_MS);
    },
    stop() {
      if (closed) return;
      const current = ws;
      closed = true;
      cleanupWs();
      ws = null;
      if (current) {
        if (current.readyState === WS_OPEN) {
          try { current.send(JSON.stringify({ type: "stop" })); } catch {}
        }
        try { current.close(1000, "client-stop"); } catch {}
      }
    },
  };
}
