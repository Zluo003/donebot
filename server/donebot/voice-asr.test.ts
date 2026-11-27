import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { DONEBOT_VOICE_MODELS, type DoneBotAsrServerMessage, type DoneBotCatalog } from "../../shared/donebot.ts";
import { json, readBody } from "../harness/http.ts";
import { resolveRequestAuth } from "../request-auth.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { createUpgrades } from "../routes/upgrades.ts";
import { createVoiceRoutes } from "../routes/voice.ts";
import { SessionRegistry } from "../sessions.ts";
import { DoneBotGateway, type DoneBotCredential, type DoneBotCredentialStore } from "./gateway.ts";
import { doneBotVoiceCapabilities, resolveDoneBotAsrModel } from "./media-registry.ts";
import { buildAsrVocabulary, VOICE_ASR_CLOSE, VoiceAsrProxy } from "./voice-asr.ts";

interface MockUpstreamCapture {
  headers: IncomingMessage["headers"];
  url: string;
  runTask?: Record<string, unknown>;
  audioChunks: Buffer[];
  finishReceived: boolean;
  closed: boolean;
  ws: WebSocket;
}

const servers: Server[] = [];
const wsServers: WebSocketServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const wss of wsServers.splice(0)) wss.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function startMockGateway(options: {
  catalog?: DoneBotCatalog;
  autoStart?: boolean;
  rejectUpgradeStatus?: number;
  onUpstream?: (capture: MockUpstreamCapture) => void;
} = {}) {
  const catalog: DoneBotCatalog = options.catalog ?? {
    gateway_contract_version: 4,
    catalog_scope_id: "scope-asr",
    catalog_version: "v4",
    defaults: { text: "gpt-6.1-sol" },
    models: [
      { id: DONEBOT_VOICE_MODELS.ttsFlash, display_name: "", media_types: ["audio"], platforms: ["openai"], interfaces: ["openai.audio.speech"] },
      { id: DONEBOT_VOICE_MODELS.asrRealtime, display_name: "", media_types: ["audio"], platforms: ["openai"], interfaces: ["openai.audio.transcriptions.realtime"] },
    ],
  };

  const captures: MockUpstreamCapture[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path.endsWith("/auth/login")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 0, data: { access_token: "access-tok", refresh_token: "refresh-tok", expires_in: 3600, user: { id: "u-1", email: "asr@example.test" } } }));
      return;
    }
    if (path.endsWith("/installations/claim")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ credential: "super-secret-gateway-key" }));
      return;
    }
    if (path.endsWith("/donebot/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(catalog));
      return;
    }
    if (path.endsWith("/auth/logout")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 0 }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true });
  wsServers.push(wss);
  server.on("upgrade", (req, socket, head) => {
    if (options.rejectUpgradeStatus) {
      socket.write(`HTTP/1.1 ${options.rejectUpgradeStatus} Error\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const capture: MockUpstreamCapture = {
        headers: req.headers,
        url: req.url ?? "",
        audioChunks: [],
        finishReceived: false,
        closed: false,
        ws,
      };
      captures.push(capture);
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          capture.audioChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
          return;
        }
        const msg = JSON.parse(String(data)) as { header?: { action?: string; task_id?: string } };
        if (msg.header?.action === "run-task") {
          capture.runTask = msg as unknown as Record<string, unknown>;
          if (options.autoStart !== false) {
            ws.send(JSON.stringify({ header: { task_id: msg.header.task_id, event: "task-started" }, payload: {} }));
          }
        } else if (msg.header?.action === "finish-task") {
          capture.finishReceived = true;
          ws.send(JSON.stringify({
            header: { task_id: msg.header.task_id, event: "task-finished" },
            payload: { usage: { input_tokens: 120, output_tokens: 18, total_tokens: 138 } },
          }));
        }
      });
      ws.once("close", () => { capture.closed = true; });
      options.onUpstream?.(capture);
    });
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let saved: DoneBotCredential | null = null;
  const store: DoneBotCredentialStore = {
    persistent: false,
    async load() { return saved; },
    async save(next) { saved = structuredClone(next); },
  };
  const gateway = new DoneBotGateway(store, { testOrigin: origin });
  await gateway.login("asr@example.test", "fixture-pass");
  return { origin, gateway, captures };
}

async function startLocalVoiceServer(options: {
  gateway: DoneBotGateway;
  botNames?: string[];
  loopbackMutationToken?: string;
  proxyOptions?: Partial<ConstructorParameters<typeof VoiceAsrProxy>[0]>;
}) {
  const dir = mkdtempSync(join(tmpdir(), "donebot-voice-asr-"));
  tempDirs.push(dir);
  const sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  const upgrades = createUpgrades();
  const proxy = new VoiceAsrProxy({
    openUpstream: ({ scope, model, idempotencyKey, onAccountChanged }) => options.gateway.openVoiceAsrSocket({
      scope,
      model,
      idempotencyKey,
      onAccountChanged,
    }),
    ...options.proxyOptions,
  });
  const route = createVoiceRoutes({
    upgrades,
    asrProxy: proxy,
    capabilities: () => doneBotVoiceCapabilities(options.gateway.models(), options.gateway.authenticated()),
    asrTarget: () => {
      const scope = options.gateway.scope();
      const asr = resolveDoneBotAsrModel(options.gateway.models());
      return scope && asr ? { scope, model: asr.id } : null;
    },
    authenticated: () => options.gateway.authenticated(),
    hotwordsFor: () => options.botNames ?? ["多宝", "研发助手"],
    isCurrent: () => options.gateway.authenticated(),
  });
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const gate = resolveRequestAuth(req, {
      sessions,
      cookieName: "donebot_sess_test",
      streamPath: "/api/events",
      url,
      ...(options.loopbackMutationToken ? { loopbackMutationToken: options.loopbackMutationToken } : {}),
    });
    if (!gate.auth) return json(res, gate.status, { error: gate.error });
    const handled = await dispatchRoutes([route], {
      req, res, url, path: url.pathname, method: req.method ?? "GET", auth: gate.auth, json, readBody,
    });
    if (!handled) json(res, 404, { error: "not found" });
  };
  const server = createServer((req, res) => void handle(req, res));
  upgrades.attach(server, handle);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    httpOrigin: `http://127.0.0.1:${port}`,
    wsOrigin: `ws://127.0.0.1:${port}`,
    proxy,
    sessions,
    upgrades,
  };
}

function collectMessages(ws: WebSocket): DoneBotAsrServerMessage[] {
  const out: DoneBotAsrServerMessage[] = [];
  ws.on("message", (data) => {
    out.push(JSON.parse(String(data)) as DoneBotAsrServerMessage);
  });
  return out;
}

describe("buildAsrVocabulary", () => {
  it("injects DoneBot and active bot names with wake phrases and validates client hotword weights", () => {
    const vocab = buildAsrVocabulary(["多宝", "  代码助手 \n"], {
      "自定义热词": 50,
      "多宝": 4,
      "无效权重": 99,
      "负数": -1,
      "": 5,
    });
    expect(vocab).toEqual({
      DoneBot: 5,
      "多宝": 4,
      "你好多宝": 5,
      "代码助手": 5,
      "你好代码助手": 5,
      "自定义热词": 50,
    });
  });

  it("caps super hotwords at 50 and total hotwords at 200", () => {
    const clientHotwords: Record<string, number> = {};
    for (let i = 0; i < 60; i++) clientHotwords[`super-${i}`] = 50;
    for (let i = 0; i < 220; i++) clientHotwords[`word-${i}`] = 3;
    const vocab = buildAsrVocabulary([], clientHotwords);
    const values = Object.values(vocab);
    expect(values.filter((w) => w === 50)).toHaveLength(50);
    expect(Object.keys(vocab).length).toBeLessThanOrEqual(200);
  });
});

describe("DoneBot local streaming ASR proxy & voice routes", () => {
  it("exposes voice capabilities, proxies full duplex ASR with pre-buffering, hotwords, VAD translation, heartbeat filtering, and never leaks gateway keys", async () => {
    let releaseTaskStarted!: () => void;
    const taskStartedGate = new Promise<void>((resolve) => { releaseTaskStarted = resolve; });
    const mock = await startMockGateway({
      autoStart: false,
      onUpstream(capture) {
        capture.ws.on("message", (data, isBinary) => {
          if (isBinary) return;
          const msg = JSON.parse(String(data)) as { header?: { action?: string; task_id?: string } };
          if (msg.header?.action === "run-task") {
            void taskStartedGate.then(() => {
              capture.ws.send(JSON.stringify({ header: { task_id: msg.header!.task_id, event: "task-started" }, payload: {} }));
            });
          }
        });
      },
    });
    const local = await startLocalVoiceServer({ gateway: mock.gateway, botNames: ["多宝", "小研"] });

    const capRes = await fetch(`${local.httpOrigin}/api/voice/capabilities`);
    expect(capRes.status).toBe(200);
    expect(capRes.headers.get("cache-control")).toBe("no-store");
    const caps = await capRes.json();
    expect(caps).toMatchObject({
      tts: { available: true, model: DONEBOT_VOICE_MODELS.ttsFlash, defaultVoice: "longanhuan_v3.1" },
      asr: { available: true, model: DONEBOT_VOICE_MODELS.asrRealtime, wsPath: "/api/voice/asr", sampleRate: 16_000, format: "pcm" },
    });
    expect(JSON.stringify(caps)).not.toContain("super-secret-gateway-key");

    const client = new WebSocket(`${local.wsOrigin}/api/voice/asr`);
    const messages = collectMessages(client);
    const closed = new Promise<number>((resolve) => client.once("close", (code) => resolve(code)));
    await new Promise<void>((resolve) => client.once("open", () => resolve()));

    client.send(JSON.stringify({
      type: "start",
      sampleRate: 16_000,
      endpointMs: 700,
      vadModel: "near_meeting_16k",
      hotwords: { "百炼": 50 },
      context: "用户正在询问今天天气",
    }));
    // Send pre-buffered audio frames BEFORE task-started arrives.
    const preChunk = Buffer.from([1, 2, 3, 4]);
    client.send(preChunk, { binary: true });

    await vi.waitFor(() => expect(mock.captures[0]?.runTask).toBeDefined());
    const capture = mock.captures[0]!;
    expect(capture.headers.authorization).toBe("Bearer super-secret-gateway-key");
    expect(capture.headers["x-donebot-installation"]).toBe(mock.gateway.scope()!.installationId);
    expect(capture.headers["idempotency-key"]).toMatch(/^[a-f0-9-]{36}$/);
    expect(capture.runTask).toMatchObject({
      header: { action: "run-task", streaming: "duplex" },
      payload: {
        task_group: "audio",
        task: "asr",
        function: "recognition",
        model: DONEBOT_VOICE_MODELS.asrRealtime,
        parameters: {
          format: "pcm",
          sample_rate: 16_000,
          max_sentence_silence: 700,
          vad_model: "near_meeting_16k",
          vocabulary: {
            DoneBot: 5,
            "多宝": 5,
            "你好多宝": 5,
            "小研": 5,
            "你好小研": 5,
            "百炼": 50,
          },
        },
        input: {
          context: [{ role: "user", content: [{ type: "input_text", text: "用户正在询问今天天气" }] }],
        },
      },
    });
    expect((capture.runTask!.payload as { parameters: Record<string, unknown> }).parameters).not.toHaveProperty("context");

    // Pre-buffered chunk must wait until task-started, then flush in order.
    expect(capture.audioChunks).toHaveLength(0);
    releaseTaskStarted();
    await vi.waitFor(() => expect(messages.some((m) => m.type === "ready")).toBe(true));
    await vi.waitFor(() => expect(capture.audioChunks).toEqual([preChunk]));

    // Live audio after ready flows directly.
    const liveChunk = Buffer.from([5, 6, 7, 8]);
    client.send(liveChunk, { binary: true });
    await vi.waitFor(() => expect(capture.audioChunks).toEqual([preChunk, liveChunk]));

    const taskId = (messages.find((m) => m.type === "ready") as Extract<DoneBotAsrServerMessage, { type: "ready" }>).taskId;
    // Heartbeat must be ignored.
    capture.ws.send(JSON.stringify({
      header: { task_id: taskId, event: "result-generated" },
      payload: { output: { sentence: { sentence_id: 1, text: "ignored", heartbeat: true } } },
    }));
    // Interim + final sentence events.
    capture.ws.send(JSON.stringify({
      header: { task_id: taskId, event: "result-generated" },
      payload: { output: { sentence: { sentence_id: 1, begin_time: 100, end_time: 400, text: "你好多宝", sentence_begin: true, sentence_end: false, heartbeat: false } } },
    }));
    capture.ws.send(JSON.stringify({
      header: { task_id: taskId, event: "result-generated" },
      payload: { output: { sentence: { sentence_id: 1, begin_time: 100, end_time: 950, text: "你好多宝，查一下天气", sentence_begin: false, sentence_end: true, heartbeat: false } } },
    }));

    client.send(JSON.stringify({ type: "finish" }));
    await vi.waitFor(() => expect(capture.finishReceived).toBe(true));
    expect(await closed).toBe(VOICE_ASR_CLOSE.normal);
    expect(messages).toEqual([
      { type: "ready", model: DONEBOT_VOICE_MODELS.asrRealtime, taskId },
      { type: "speech_started", sentenceId: 1, beginTime: 100 },
      { type: "transcript", sentenceId: 1, text: "你好多宝", final: false, beginTime: 100, endTime: 400 },
      { type: "transcript", sentenceId: 1, text: "你好多宝，查一下天气", final: true, beginTime: 100, endTime: 950 },
      { type: "speech_stopped", sentenceId: 1, endTime: 950 },
      { type: "finished", usage: { inputTokens: 120, outputTokens: 18, totalTokens: 138 } },
    ]);
    expect(JSON.stringify(messages)).not.toContain("super-secret-gateway-key");
    expect(local.proxy.size).toBe(0);
  });

  it("closes upstream immediately when client disconnects or sends stop (anti-billing leak)", async () => {
    const mock = await startMockGateway();
    const local = await startLocalVoiceServer({ gateway: mock.gateway });

    const ws1 = new WebSocket(`${local.wsOrigin}/api/voice/asr`);
    const msgs1 = collectMessages(ws1);
    await new Promise<void>((resolve) => ws1.once("open", () => resolve()));
    ws1.send(Buffer.from([1, 2, 3, 4]), { binary: true });
    await vi.waitFor(() => expect(msgs1.some((m) => m.type === "ready")).toBe(true));
    ws1.close();
    await vi.waitFor(() => expect(mock.captures[0]!.closed).toBe(true));
    await vi.waitFor(() => expect(local.proxy.size).toBe(0));

    const ws2 = new WebSocket(`${local.wsOrigin}/api/voice/asr`);
    const msgs2 = collectMessages(ws2);
    await new Promise<void>((resolve) => ws2.once("open", () => resolve()));
    ws2.send(JSON.stringify({ type: "start" }));
    await vi.waitFor(() => expect(msgs2.some((m) => m.type === "ready")).toBe(true));
    ws2.send(JSON.stringify({ type: "stop" }));
    await vi.waitFor(() => expect(mock.captures[1]!.closed).toBe(true));
    await vi.waitFor(() => expect(local.proxy.size).toBe(0));
  });

  it("disconnects idle sessions even if client keeps sending ping frames", async () => {
    const mock = await startMockGateway();
    const local = await startLocalVoiceServer({
      gateway: mock.gateway,
      proxyOptions: { defaultIdleTimeoutMs: 120, initialIdleTimeoutMs: 120 },
    });

    const ws = new WebSocket(`${local.wsOrigin}/api/voice/asr`);
    const msgs = collectMessages(ws);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(JSON.stringify({ type: "start" }));
    await vi.waitFor(() => expect(msgs.some((m) => m.type === "ready")).toBe(true));
    // Sending ping must NOT reset the audio idle timeout.
    ws.send(JSON.stringify({ type: "ping" }));
    expect(await closed).toBe(VOICE_ASR_CLOSE.timeout);
    expect(msgs).toContainEqual({ type: "pong" });
    expect(msgs).toContainEqual(expect.objectContaining({ type: "error", code: "idle_timeout" }));
    await vi.waitFor(() => expect(mock.captures[0]!.closed).toBe(true));
  });

  it("enforces max session duration, max concurrent sessions, and tears down on account logout", async () => {
    const mock = await startMockGateway();
    const local = await startLocalVoiceServer({
      gateway: mock.gateway,
      proxyOptions: { maxSessions: 1, maxDurationMs: 250, defaultIdleTimeoutMs: 5_000 },
    });

    const first = new WebSocket(`${local.wsOrigin}/api/voice/asr`);
    const firstMsgs = collectMessages(first);
    const firstClosed = new Promise<number>((resolve) => first.once("close", (code) => resolve(code)));
    await new Promise<void>((resolve) => first.once("open", () => resolve()));
    first.send(JSON.stringify({ type: "start" }));
    await vi.waitFor(() => expect(firstMsgs.some((m) => m.type === "ready")).toBe(true));

    // Second concurrent session exceeds maxSessions=1.
    const second = new WebSocket(`${local.wsOrigin}/api/voice/asr`);
    const secondClosed = new Promise<number>((resolve) => second.once("close", (code) => resolve(code)));
    expect(await secondClosed).toBe(VOICE_ASR_CLOSE.busy);

    // First hits maxDurationMs.
    expect(await firstClosed).toBe(VOICE_ASR_CLOSE.timeout);
    expect(firstMsgs).toContainEqual(expect.objectContaining({ type: "error", code: "max_duration" }));

    // New session gets terminated when gateway logs out.
    const third = new WebSocket(`${local.wsOrigin}/api/voice/asr`);
    const thirdMsgs = collectMessages(third);
    const thirdClosed = new Promise<number>((resolve) => third.once("close", (code) => resolve(code)));
    await new Promise<void>((resolve) => third.once("open", () => resolve()));
    third.send(JSON.stringify({ type: "start" }));
    await vi.waitFor(() => expect(thirdMsgs.some((m) => m.type === "ready")).toBe(true));
    await mock.gateway.logout();
    expect(await thirdClosed).toBe(VOICE_ASR_CLOSE.accountChanged);
    expect(thirdMsgs).toContainEqual(expect.objectContaining({ type: "error", code: "account_changed" }));
  });

  it("enforces request-auth, same-origin, HTTP 426, desktop owner token, and 503 when ASR model is disabled", async () => {
    const mock = await startMockGateway({
      catalog: {
        gateway_contract_version: 4,
        catalog_scope_id: "scope-no-asr",
        catalog_version: "v4",
        defaults: { text: "gpt-6.1-sol" },
        models: [
          { id: DONEBOT_VOICE_MODELS.ttsFlash, display_name: "", media_types: ["audio"], platforms: ["openai"], interfaces: ["openai.audio.speech"] },
        ],
      },
    });
    const local = await startLocalVoiceServer({ gateway: mock.gateway, loopbackMutationToken: "desktop-secret-token" });

    // Plain HTTP GET without desktop owner token is rejected by request-auth (mutating route).
    expect((await fetch(`${local.httpOrigin}/api/voice/asr`)).status).toBe(403);
    // Plain HTTP GET with desktop owner token returns 426 Upgrade Required.
    expect((await fetch(`${local.httpOrigin}/api/voice/asr`, {
      headers: { "x-donebot-desktop-owner": "desktop-secret-token" },
    })).status).toBe(426);

    // Cross-origin WebSocket upgrade is rejected before opening upstream.
    const crossOriginStatus = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${local.wsOrigin}/api/voice/asr`, {
        headers: { origin: "https://attacker.invalid", "x-donebot-desktop-owner": "desktop-secret-token" },
      });
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.once("open", () => { ws.close(); resolve(200); });
    });
    expect(crossOriginStatus).toBe(403);

    // Same-origin authorized WebSocket gets 503 when gateway catalog has no ASR model enabled.
    const unavailableStatus = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${local.wsOrigin}/api/voice/asr`, {
        headers: { origin: local.httpOrigin, "x-donebot-desktop-owner": "desktop-secret-token" },
      });
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.once("open", () => { ws.close(); resolve(200); });
    });
    expect(unavailableStatus).toBe(503);
    expect(mock.captures).toHaveLength(0);
  });

  it("re-emits speech_started when upstream reuses sentence_id and never leaks timers when openUpstream throws on binary first frame", async () => {
    const mock = await startMockGateway();
    const local = await startLocalVoiceServer({ gateway: mock.gateway });

    // Multi-turn sentence_id=0 reuse emits speech_started for every sentence.
    const ws = new WebSocket(`${local.wsOrigin}/api/voice/asr`);
    const msgs = collectMessages(ws);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(JSON.stringify({ type: "start" }));
    await vi.waitFor(() => expect(msgs.some((m) => m.type === "ready")).toBe(true));
    const capture = mock.captures[0]!;
    const taskId = (msgs[0] as Extract<DoneBotAsrServerMessage, { type: "ready" }>).taskId;
    capture.ws.send(JSON.stringify({
      header: { task_id: taskId, event: "result-generated" },
      payload: { output: { sentence: { sentence_id: 0, text: "第一句", sentence_begin: true, sentence_end: true } } },
    }));
    capture.ws.send(JSON.stringify({
      header: { task_id: taskId, event: "result-generated" },
      payload: { output: { sentence: { sentence_id: 0, text: "第二句", sentence_begin: true, sentence_end: true } } },
    }));
    await vi.waitFor(() => expect(msgs.filter((m) => m.type === "speech_started")).toHaveLength(2));
    ws.close();
    await vi.waitFor(() => expect(local.proxy.size).toBe(0));

    // Binary first frame when openUpstream throws closes cleanly without re-arming idle timer.
    const failingLocal = await startLocalVoiceServer({
      gateway: mock.gateway,
      proxyOptions: {
        defaultIdleTimeoutMs: 50,
        openUpstream: () => { throw new Error("boom"); },
      },
    });
    const ws2 = new WebSocket(`${failingLocal.wsOrigin}/api/voice/asr`);
    const msgs2 = collectMessages(ws2);
    const closed2 = new Promise<number>((resolve) => ws2.once("close", (code) => resolve(code)));
    await new Promise<void>((resolve) => ws2.once("open", () => resolve()));
    ws2.send(Buffer.from([1, 2, 3, 4]), { binary: true });
    expect(await closed2).toBe(VOICE_ASR_CLOSE.unavailable);
    expect(msgs2).toEqual([expect.objectContaining({ type: "error", code: "asr_unavailable" })]);
    expect(failingLocal.proxy.size).toBe(0);
    // Wait past defaultIdleTimeoutMs to ensure no late idle_timeout fires on closed session.
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(msgs2).toHaveLength(1);
  });
});
