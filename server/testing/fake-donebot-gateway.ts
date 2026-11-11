import { createHash, randomUUID } from "node:crypto";
import { parsePackageDocument } from "../../shared/package-format.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DoneBotCatalog, DoneBotGatewayModel } from "../../shared/donebot.ts";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const list = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const textModels = ["gpt-6.1-sol", "claude-sonnet-5-5", "gemini-4-argon", "deepseek-flash"];
const mediaModel = (id: string, kind: "image" | "video" | "music" | "audio", adapter: string, extra: Row = {}): DoneBotGatewayModel => ({ id, display_name: id, media_types: [kind], platforms: ["openai"], interfaces: [kind === "audio" ? "openai.audio.speech" : kind === "music" ? "openai.music" : kind === "video" ? "openai.videos" : "openai.images"], media_parameters: { protocol: { adapter }, ...extra } });
export const FAKE_DONEBOT_CATALOG: DoneBotCatalog = {
  gateway_contract_version: 4, catalog_scope_id: "fixture-scope", catalog_version: "fixture-v1", defaults: { text: textModels[0]!, audio: "gpt-4o-mini-tts" },
  models: [
    ...textModels.map((id): DoneBotGatewayModel => ({ id, display_name: id, media_types: ["text"], platforms: [id.startsWith("claude") ? "anthropic" : id.startsWith("gemini") ? "gemini" : "openai"], interfaces: [id.startsWith("claude") ? "anthropic.messages" : id.startsWith("gemini") ? "gemini.generate_content" : id.startsWith("gpt") ? "openai.responses" : "openai.chat_completions"], capabilities: { tool_calling: true } })),
    mediaModel("gpt-image-2.5-flare", "image", "donebot.images.async.v1", { sizes: ["1024x1024"], qualities: ["auto", "low", "medium", "high"], formats: ["png", "jpeg", "webp"] }),
    ...["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"].map(id => mediaModel(id, "image", "donebot.images.async.v1", { qualities: ["auto", "low", "medium", "high", "xhigh", "max"], formats: ["png", "jpeg", "webp", "gif"] })),
    mediaModel("gpt-4o-mini-tts", "audio", "apimart.speech.v1", { voices: ["alloy", "shimmer"], formats: ["pcm", "wav"] }),
    mediaModel("suno", "music", "apimart.music.v1", { versions: ["v6", "v6-wild", "v6-mini"] }),
    ...["seedance-2-0", "seedance-2-5"].map(id => mediaModel(id, "video", "seedance.videos.v1", { resolutions: ["480p", "720p", "1080p"], formats: id === "seedance-2-5" ? ["mp4", "mov"] : ["mp4"] })),
  ],
};

export const FAKE_DONEBOT_GIF_BASE64 = "R0lGODlhAgABAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAFAAAACwAAAAAAgABAAAIBQABAAgIACH5BAEUAAEALAAAAAACAAEAgQAA/wAAAAAAAAAAAAgFAAEACAgAOw==";

export interface FakeDoneBotToolStep { name: string; arguments: Row }
export interface FakeDoneBotRequest { path: string; method: string; body: Row; authenticated: boolean; installation?: string; receiptId?: string }
export interface FakeDoneBotGateway {
  setAuthSettings(settings: Row): void;
  setAuthRequires2fa(required: boolean): void;
  setTemplateDocuments(documents: unknown[] | null): void;
  origin: string;
  requests: FakeDoneBotRequest[];
  setPlan(steps: FakeDoneBotToolStep[], answer?: string): void;
  setReceiptPlan(status: "completed" | "failed" | "uncertain", steps: FakeDoneBotToolStep[]): void;
  setMediaStatus(status: "processing" | "completed" | "failed" | "uncertain"): void;
  setMediaSubmissionOutcome(outcome: "accepted" | "uncertain"): void;
  setMediaReceiptOutcome(receiptId: string, outcome: "completed" | "failed"): void;
  close(): Promise<void>;
}
const read = async (request: IncomingMessage): Promise<Row> => {
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of request) { const bytes = Buffer.from(part); size += bytes.length; if (size > 2_000_000) throw new Error("Fixture request exceeded limit"); chunks.push(bytes); }
  if (request.headers["content-type"]?.startsWith("multipart/form-data")) {
    const form = await new Request("http://127.0.0.1/fixture-upload", { method: "POST", headers: { "content-type": request.headers["content-type"] }, body: Uint8Array.from(Buffer.concat(chunks)) }).formData();
    const file = form.get("file");
    return file instanceof File ? { name: file.name, mime: file.type, bytes: file.size } : {};
  }
  return size ? row(JSON.parse(Buffer.concat(chunks).toString("utf8"))) : {};
};
const send = (response: ServerResponse, value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
const stream = (response: ServerResponse, events: Row[]) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")); };

export async function startFakeDoneBotGateway(): Promise<FakeDoneBotGateway> {
  let authSettings: Row = { registration_enabled: true }, requires2fa = false;
  let templateDocuments: unknown[] | null = [];
  const requests: FakeDoneBotRequest[] = [];
  let plan: FakeDoneBotToolStep[] = [], answer = "Synthetic DoneBot fixture complete.";
  const receiptPlans = new Map<string, FakeDoneBotToolStep[]>();
  let mediaStatus: "processing" | "completed" | "failed" | "uncertain" = "completed", mediaTaskCount = 0;
  let mediaSubmissionOutcome: "accepted" | "uncertain" = "accepted";
  type FixtureMediaTask = { status: "processing" | "uncertain" | "completed" | "failed"; taskId: string; kind: "image" | "video" | "music"; mime: string; name: string };
  const mediaReceipts = new Map<string, FixtureMediaTask>();
  const mediaTasks = new Map<string, FixtureMediaTask>();
  const mediaFormats = new Map<string, unknown>();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2Cj8AAAAASUVORK5CYII=";
  let origin = "";
  const server = createServer((request, response) => { void (async () => {
    const path = new URL(request.url!, "http://127.0.0.1").pathname, body = await read(request);
    const authenticated = request.headers.authorization === "Bearer fixture-installation-key";
    const login = request.headers.authorization === "Bearer fixture-access-token";
    const logged = { ...body, ...(body.password ? { password: "[fixture password omitted]" } : {}), ...(body.new_password ? { new_password: "[fixture password omitted]" } : {}) };
    const recorded: FakeDoneBotRequest = { path, method: request.method!, body: logged, authenticated, ...(typeof request.headers["x-donebot-installation"] === "string" ? { installation: request.headers["x-donebot-installation"] } : {}) };
    requests.push(recorded);
    if (path === "/fixture-audio.mp3" && request.method === "GET") {
      const bytes = Buffer.from("Synthetic audio artifact.");
      response.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(bytes.byteLength) });
      response.end(bytes);
      return;
    }
    if (path === "/api/v1/auth/login" && requires2fa) return send(response, { code: 0, data: { requires_2fa: true, temp_token: "fixture-temp-token" } });
    if (path === "/api/v1/auth/login/2fa" && (body.temp_token !== "fixture-temp-token" || body.totp_code !== "123456")) return send(response, {}, 401);
    if (path === "/api/v1/auth/login" || path === "/api/v1/auth/register" || path === "/api/v1/auth/login/2fa") return send(response, { code: 0, data: { access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", expires_in: 3600, user: { id: "fixture-user", email: "fixture@example.invalid" } } });
    if (path === "/api/v1/auth/logout") return send(response, {});
    if (path === "/api/v1/settings/public") return send(response, authSettings);
    if (path === "/api/v1/auth/send-verify-code" || path === "/api/v1/auth/forgot-password") return send(response, { code: 0, data: { countdown: 60, expires_in: 900 } });
    if (path === "/api/v1/auth/reset-password") return body.email_code === "123456" ? send(response, { code: 0, data: { message: "Synthetic password updated." } }) : send(response, { reason: "INVALID_RESET_CODE" }, 400);
    if (path === "/api/v1/donebot/installations/claim") return login ? send(response, { credential: "fixture-installation-key" }) : send(response, {}, 401);
    if (path === "/api/v1/donebot/models") return login ? send(response, FAKE_DONEBOT_CATALOG) : send(response, {}, 401);
    if (path === "/api/v1/donebot/templates" || path.startsWith("/api/v1/donebot/templates/")) {
      if (!login) return send(response, {}, 401);
      if (!templateDocuments) return send(response, {}, 503);
      const releases = templateDocuments.map(document => {
        const pkg = parsePackageDocument(document).package, content = JSON.stringify(document);
        return { template: { id: pkg.id, release: pkg.release, name: pkg.name, summary: pkg.summary, category: pkg.category,
          kind: pkg.agents.length ? "department" : "bot", members: (pkg.agents.length ? pkg.agents : pkg.presets ?? []).map(bot => bot.name),
          skills: (pkg.skills?.entries ?? []).map(skill => skill.name), bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") }, content };
      });
      if (path === "/api/v1/donebot/templates") return send(response, { templates: releases.map(release => release.template) });
      const entry = releases.find(release => path === `/api/v1/donebot/templates/${release.template.id}/${release.template.release}`);
      return entry ? send(response, entry) : send(response, {}, 404);
    }
    if (path.startsWith("/api/v1/donebot/receipts/")) {
      if (!login || !request.headers["x-donebot-installation"]) return send(response, {}, 403);
      const receiptId = path.split("/").at(-1)!;
      const mediaReceipt = mediaReceipts.get(receiptId);
      return send(response, { receipt_id: receiptId, status: mediaReceipt?.status ?? "completed", currency: "CNY", actual_cents: 0,
        ...(mediaReceipt && ["processing", "completed"].includes(mediaReceipt.status) ? { task_id: mediaReceipt.taskId } : {}),
        ...(mediaReceipt?.status === "failed" ? { diagnostic: { http_status: 422, code: "provider_rejected", request_id: "fixture-receipt-request", message: "Synthetic provider rejected the requested image format." } } : {}) });
    }
    if (path === "/api/v1/donebot/account") return login ? send(response, { balance_cents: 0, frozen_cents: 0, concurrency: 20, currency: "CNY" }) : send(response, {}, 401);
    if (!authenticated) return send(response, { error: "Fixture installation required" }, 401);
    const receipt = randomUUID(); recorded.receiptId = receipt; response.setHeader("X-DoneBot-Receipt-ID", receipt);
    if (path === "/v1/systemone" && request.method === "POST") {
      const answers = Object.fromEntries(Object.entries(row(body.questions)).map(([id, raw]) => {
        const question = row(raw), options = Object.keys(row(question.criteria));
        const choice = options[0]!;
        const probabilities = Object.fromEntries(options.map((option, index) => [option, index === 0 ? 0.9 : 0.1 / (options.length - 1)]));
        return [id, { type: "choice", choice, probabilities }];
      }));
      return send(response, { model: "jev-latest", answers });
    }
    if (path === "/v1/audio/speech") { response.writeHead(200, { "content-type": "audio/pcm" }); response.write(Buffer.alloc(480)); response.end(Buffer.alloc(480)); return; }
    if (path === "/v1/assets" && request.method === "POST") return send(response, { id: "ast_0123456789abcdef0123456789abcdef", url: "https://assets.example.test/fixture-reference.png" });
    if (/^\/v1\/assets\/[A-Za-z0-9_-]+$/.test(path) && request.method === "GET") return send(response, { id: path.split("/").at(-1), url: "https://assets.example.test/fixture-reference.png" });
    const createMediaTask = (taskId: string, kind: FixtureMediaTask["kind"], mime: string): FixtureMediaTask => {
      const task = { status: mediaSubmissionOutcome === "uncertain" ? "uncertain" as const : mediaStatus,
        taskId, kind, mime, name: `fixture-${kind}.${mime === "audio/mpeg" ? "mp3" : mime.split("/")[1]}` };
      mediaReceipts.set(receipt, task);
      mediaTasks.set(taskId, task);
      return task;
    };
    const uncertainSubmission = () => send(response, { error: { type: "upstream_error", code: "dispatch_unknown", request_id: "fixture-native-media-request",
      message: "Synthetic provider connection closed after dispatch; completion is unconfirmed. https://private-provider.invalid/generate?token=fixture-secret api_key=fixture-private-key" } }, 503);
    if (["/v1/images/generations/async", "/v1/images/edits/async"].includes(path) && request.method === "POST") {
      const taskId = `fixture-image-task-${++mediaTaskCount}`, format = body.output_format;
      mediaFormats.set(taskId, format);
      createMediaTask(taskId, "image", format === "gif" ? "image/gif" : "image/png");
      if (mediaSubmissionOutcome === "uncertain") return uncertainSubmission();
      return send(response, { id: taskId, status: "accepted" }, 202);
    }
    const imageTaskMatch = /^\/v1\/images\/tasks\/(fixture-image-task-\d+)$/.exec(path);
    if (imageTaskMatch && request.method === "GET") {
      const task = mediaTasks.get(imageTaskMatch[1]!);
      if (!task) return send(response, {}, 404);
      return send(response, { id: task.taskId, status: task.status,
        ...(task.status === "completed" ? { result: { data: [{ b64_json: task.mime === "image/gif" ? FAKE_DONEBOT_GIF_BASE64 : png }] } }
          : task.status === "failed" ? { http_status: 422, error: { code: "provider_rejected", request_id: "fixture-task-request", message: "Synthetic provider rejected the requested image format." } }
            : task.status === "uncertain" ? { http_status: 502, error: { type: "upstream_error", code: "dispatch_unknown", request_id: "fixture-native-image-request",
              message: "Synthetic provider connection closed after dispatch; completion is unconfirmed. https://private-provider.invalid/generate?token=fixture-secret api_key=fixture-private-key" } } : {}) });
    }
    if (["/v1/videos", "/v1/videos/edits", "/v1/videos/extensions"].includes(path) && request.method === "POST") {
      const taskId = `fixture-video-task-${++mediaTaskCount}`;
      createMediaTask(taskId, "video", "video/mp4");
      if (mediaSubmissionOutcome === "uncertain") return uncertainSubmission();
      return send(response, { id: taskId, status: "queued" }, 202);
    }
    const videoContent = /^\/v1\/videos\/(fixture-video-task-\d+)\/content$/.exec(path);
    if (videoContent && request.method === "GET") {
      const task = mediaTasks.get(videoContent[1]!);
      if (!task || task.status !== "completed") return send(response, { error: "Fixture video is not complete" }, 404);
      const bytes = Buffer.from("Synthetic video artifact.");
      response.writeHead(200, { "content-type": task.mime, "content-length": String(bytes.byteLength) }); response.end(bytes); return;
    }
    const videoTask = /^\/v1\/videos\/(fixture-video-task-\d+)$/.exec(path);
    if (videoTask && request.method === "GET") {
      const task = mediaTasks.get(videoTask[1]!);
      if (!task) return send(response, {}, 404);
      return send(response, { id: task.taskId, status: task.status,
        ...(task.status === "failed" ? { error: { code: "provider_rejected", request_id: "fixture-video-request", message: "Synthetic provider rejected the video request." } } : {}) });
    }
    if (path === "/v1/music/generations" && request.method === "POST") {
      const taskId = `fixture-music-task-${++mediaTaskCount}`;
      createMediaTask(taskId, "music", "audio/mpeg");
      if (mediaSubmissionOutcome === "uncertain") return uncertainSubmission();
      return send(response, { data: [{ task_id: taskId }] }, 202);
    }
    const musicTask = /^\/v1\/music\/tasks\/(fixture-music-task-\d+)$/.exec(path);
    if (musicTask && request.method === "GET") {
      const task = mediaTasks.get(musicTask[1]!);
      if (!task) return send(response, {}, 404);
      return send(response, { data: { status: task.status,
        ...(task.status === "completed" ? { result: { music: [{ audio_url: `${origin}/fixture-audio.mp3` }] } }
          : task.status === "failed" ? { error: { code: "provider_rejected", request_id: "fixture-music-request", message: "Synthetic provider rejected the audio request." } } : {}) } });
    }
    const native = path === "/v1/messages" ? "messages" : path.startsWith("/v1beta/") ? "gemini" : path === "/v1/responses" ? "responses" : path === "/v1/chat/completions" ? "chat" : undefined;
    if (!native) return send(response, { error: "Fixture operation is not implemented" }, 404);
    const tools = native === "gemini" ? list(list(body.tools)[0]?.functionDeclarations) : list(body.tools).map((one) => native === "responses" || native === "messages" ? one : row(one.function));
    const results = native === "responses" ? list(body.input).filter((one) => one.type === "function_call_output")
      : native === "chat" ? list(body.messages).filter((one) => one.role === "tool")
      : native === "messages" ? list(body.messages).flatMap((one) => list(one.content).filter((part) => part.type === "tool_result"))
      : list(body.contents).flatMap((one) => list(one.parts).filter((part) => part.functionResponse));
    const currentPrompt = JSON.stringify(list(body.input ?? body.messages ?? body.contents).findLast(one => one.role === "user") ?? {});
    const receiptPhase = /\[DoneBot media receipt: (completed|failed|terminal|uncertain)\]/.exec(currentPrompt)?.[1];
    const mediaReceipt = receiptPhase === "terminal"
      ? /"status":"(completed|failed)"/.exec(currentPrompt.replaceAll('\\"', '"'))?.[1]
      : receiptPhase;
    const reply = mediaReceipt ? `Synthetic media ${mediaReceipt} receipt acknowledged.` : answer;
    const step = tools.length ? (mediaReceipt ? receiptPlans.get(mediaReceipt) ?? [] : plan)[results.length] : undefined;
    const name = step ? tools.find((tool) => tool.name === step.name || String(tool.name).endsWith(`_${step.name}`))?.name : undefined;
    if (step && typeof name !== "string") return send(response, { error: "Fixture tool not offered", tool: step.name }, 422);
    const callId = `fixture-call-${results.length}`;
    if (native === "responses") return stream(response, [{ type: "response.completed", response: { output: step ? [{ type: "reasoning", id: "fixture-reasoning", encrypted_content: "fixture-opaque-reasoning", summary: [] }, { type: "function_call", id: callId, call_id: callId, name, arguments: JSON.stringify(step.arguments) }] : [{ type: "message", id: "fixture-reply", role: "assistant", content: [{ type: "output_text", text: reply }] }], usage: { input_tokens: 10, output_tokens: 5 } } }]);
    if (native === "messages") return send(response, { content: step ? [{ type: "thinking", thinking: "Fixture thought", signature: "fixture-opaque-signature" }, { type: "tool_use", id: callId, name, input: step.arguments }] : [{ type: "text", text: reply }], stop_reason: step ? "tool_use" : "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
    if (native === "gemini") return send(response, { candidates: [{ index: 0, content: { role: "model", parts: step ? [{ functionCall: { id: callId, name, args: step.arguments }, thoughtSignature: "fixture-opaque-signature" }] : [{ text: reply }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
    return send(response, { choices: [{ message: step ? { content: null, tool_calls: [{ id: callId, type: "function", function: { name, arguments: JSON.stringify(step.arguments) } }] } : { content: reply }, finish_reason: step ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  })().catch(() => { if (!response.headersSent) send(response, { error: "Fixture gateway failed" }, 500); else response.destroy(); }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, requests,
    setAuthSettings(settings) { authSettings = settings; },
    setAuthRequires2fa(required) { requires2fa = required; },
    setTemplateDocuments(documents) { templateDocuments = documents; },
    setPlan(steps, final = "Synthetic DoneBot fixture complete.") { plan = steps; answer = final; },
    setReceiptPlan(status, steps) { receiptPlans.set(status, steps); },
    setMediaStatus(status) {
      mediaStatus = status;
      for (const task of mediaTasks.values()) task.status = status;
    },
    setMediaSubmissionOutcome(outcome) { mediaSubmissionOutcome = outcome; },
    setMediaReceiptOutcome(receiptId, outcome) {
      const receipt = mediaReceipts.get(receiptId);
      if (!receipt) throw new Error("No uncertain fixture media receipt exists.");
      receipt.status = outcome;
    },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
