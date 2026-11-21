import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { WireMessage as Message } from "../../shared/wire.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { personKey } from "../person-key.ts";
import { DoneBotTeamModelGateway, TeamModelRequestHeld } from "./team-model-gateway.ts";
import { teamRuntimeActor, teamRuntimeConfiguration, teamRuntimeSession } from "./team-runtime.ts";
import { TeamRequestStore } from "./team-requests.ts";
import { createDoneBotLlmDriver } from "./llm-driver.ts";
import { doneBotProtocol, doneBotTextModels } from "./catalog.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const coordinatorToken = `dbtc_${Buffer.alloc(32, 1).toString("base64url")}`;

async function fixture(enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), "donebot-team-model-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519"), teamId = randomUUID(), instanceId = randomUUID();
  const runtime = teamRuntimeConfiguration({ DONEBOT_TEAM_RUNTIME: "1", DONEBOT_TEAM_ID: teamId, DONEBOT_TEAM_INSTANCE_ID: instanceId, DONEBOT_TEAM_NAME: "Fixture",
    DONEBOT_TEAM_PUBLIC_KEY: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64") })!;
  const coordinatorFile = join(directory, "coordinator.json");
  const coordinator = { protocol: "donebot.teams.v1", instance_id: instanceId, team_id: teamId, generation: 1, credential: coordinatorToken };
  await writeFile(coordinatorFile, JSON.stringify(coordinator), { mode: 0o600 });
  const records = new Map<string, { id: string; state: string; token: string; body: Record<string, unknown> }>();
  const seen: Array<{ url: string; authorization: string; key?: string; body: string; headers: IncomingMessage["headers"] }> = [];
  let modelCalls = 0, prepareDrop = false, modelDrop = false, revoked = false, streaming = false, modelError = false;
  const respond = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  const server = createServer(async (req, res) => {
    const bytes: Buffer[] = [];
    for await (const value of req) bytes.push(Buffer.from(value));
    const body = Buffer.concat(bytes).toString("utf8"), url = req.url!, authorization = req.headers.authorization ?? "";
    seen.push({ url, authorization, key: req.headers["idempotency-key"] as string | undefined, body, headers: req.headers });
    if (url.startsWith("/api/v1/donebot/cloud/coordinators/")) {
      if (authorization !== `Bearer ${coordinatorToken}` || revoked) return respond(res, 403, { error: "revoked" });
      if (url.endsWith("/models")) return respond(res, 200, { gateway_contract_version: 4, catalog_scope_id: "team-fixture", catalog_version: "1", defaults: { text: "deepseek-flash" },
        models: [{ id: "deepseek-flash", display_name: "Fixture model", media_types: ["text"], interfaces: ["openai.chat_completions"], platforms: ["openai"], capabilities: { tool_calling: true } }] });
      if (req.method === "GET") {
        const record = [...records.values()].find(value => url.endsWith(`/${value.id}`));
        return record ? respond(res, 200, { code: 0, data: { id: record.id, state: record.state, receipt_id: record.id, currency: "CNY", billing_state: "pending", actual_amount: null } }) : respond(res, 404, {});
      }
      const key = req.headers["idempotency-key"] as string, value = JSON.parse(body) as Record<string, unknown>;
      if (value.actor_id !== "3" || value.member_version !== 2 || value.node_version !== 1 || value.node_id !== instanceId) return respond(res, 403, {});
      let record = records.get(key);
      if (!record) { record = { id: randomUUID(), state: "prepared", token: `dbte_${createHash("sha256").update(key).digest("base64url")}`, body: value }; records.set(key, record); }
      if (JSON.stringify(record.body) !== JSON.stringify(value)) return respond(res, 409, {});
      if (prepareDrop) { prepareDrop = false; res.destroy(); return; }
      return respond(res, 200, { code: 0, data: { id: record.id, state: record.state, token: record.token, expires_at: new Date(Date.now() + 300_000).toISOString() } });
    }
    const record = [...records.values()].find(value => authorization === `Bearer ${value.token}`);
    if (!record || revoked) return respond(res, 403, {});
    if (record.body.request_hash !== digest(`POST\n${url}\n${body}`) || record.state !== "prepared") return respond(res, 409, {});
    record.state = "uncertain"; modelCalls++;
    if (modelDrop) { modelDrop = false; res.destroy(); return; }
    if (modelError) return respond(res, 503, {});
    if (streaming) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "<thinking>fixture reasoning</thinking>fixture answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`);
      return;
    }
    respond(res, 200, { choices: [{ message: { content: "fixture answer" }, finish_reason: "stop" }] });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const create = () => new DoneBotTeamModelGateway(directory, runtime, { coordinatorFile, fixtureOrigin: origin, executionEnabled: enabled });
  const gateway = create(), person = personKey({ id: "", email: "member@example.invalid" });
  const payload = Buffer.from(JSON.stringify({ protocol: "donebot.teams.v1", instance_id: instanceId, team_id: teamId, user_id: "3", email: "member@example.invalid", role: "member",
    member_version: 2, expires: Math.floor(Date.now() / 1000) + 9, runtime_hash: digest("POST\n/api/bots/fixture/send") }));
  const session = teamRuntimeSession(runtime, { method: "POST", url: "/api/bots/fixture/send", headers: {
    "x-donebot-team-grant": `${payload.toString("base64url")}.${sign(null, payload, privateKey).toString("base64url")}` } })!;
  const actor = teamRuntimeActor(runtime, session)!;
  const sender = gateway.requests.sender({ id: person, name: "Fixture member" }, actor);
  const message: Message = { id: "fixture-message", at: Date.now(), role: "user", kind: "text", text: "fixture", sender };
  gateway.requests.captureMessage("fixture-thread", message);
  const binding = gateway.requests.bind({ sourceId: message.id, botId: "fixture-bot", threadId: "fixture-thread", audience: "team", generation: 1 });
  const init = { method: "POST", headers: { authorization: "Bearer ignored-personal-secret", "X-DoneBot-Installation": "ignored", "X-API-Key": "ignored" }, body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "fixture" }] }) };
  const context = { bindingId: binding.id, botId: "fixture-bot", threadId: "fixture-thread", ordinal: 0 };
  return { directory, runtime, coordinatorFile, coordinator, gateway, create, actor, sender, person, message, binding, context, init, session, seen, records,
    count: () => modelCalls, modes: (value: { prepareDrop?: boolean; modelDrop?: boolean; revoked?: boolean; streaming?: boolean; modelError?: boolean }) => {
      if (value.prepareDrop !== undefined) prepareDrop = value.prepareDrop;
      if (value.modelDrop !== undefined) modelDrop = value.modelDrop;
      if (value.revoked !== undefined) revoked = value.revoked;
      if (value.streaming !== undefined) streaming = value.streaming;
      if (value.modelError !== undefined) modelError = value.modelError;
    } };
}

it("derives exact native requests from saved member provenance and never forwards personal or coordinator credentials", async () => {
  const fx = await fixture();
  expect((await fx.gateway.refreshCatalog()).catalog_scope_id).toBe("team-fixture");
  expect(await (await fx.gateway.request("/v1/chat/completions", fx.init, fx.context)).json()).toHaveProperty("choices");
  expect(fx.count()).toBe(1);
  const prepared = [...fx.records.values()][0]!;
  expect(prepared.body).toEqual({ actor_id: "3", member_version: 2, node_kind: "cloud", node_id: fx.runtime.instanceId, node_version: 1,
    purpose: "llm", bot_id: "fixture-bot", thread_id: "fixture-thread", private: false, request_hash: digest(`POST\n/v1/chat/completions\n${fx.init.body}`) });
  const model = fx.seen.at(-1)!;
  expect(model.authorization).toBe(`Bearer ${prepared.token}`);
  expect(model.headers["x-api-key"]).toBeUndefined();
  expect(model.headers["x-donebot-installation"]).toBeUndefined();
  for (const folder of ["requests", "dispatches"]) for (const name of await readdir(join(fx.directory, "donebot-team-execution", folder))) {
    const saved = await readFile(join(fx.directory, "donebot-team-execution", folder, name), "utf8");
    expect(saved).not.toContain("dbtc_"); expect(saved).not.toContain("dbte_"); expect(saved).not.toContain("ignored-personal-secret");
  }
});

it("queries the original execution after response loss and restart, and refuses changed bodies or generations", async () => {
  const fx = await fixture(); fx.modes({ modelDrop: true });
  await expect(fx.gateway.request("/v1/chat/completions", fx.init, fx.context)).rejects.toThrow();
  expect(fx.count()).toBe(1);
  await expect(fx.create().request("/v1/chat/completions", fx.init, fx.context)).rejects.toBeInstanceOf(TeamModelRequestHeld);
  expect(fx.count()).toBe(1);
  await expect(fx.create().request("/v1/chat/completions", { ...fx.init, body: "{}" }, fx.context)).rejects.toThrow("could not be verified");
  await writeFile(fx.coordinatorFile, JSON.stringify({ ...fx.coordinator, generation: 2 }));
  await expect(fx.create().request("/v1/chat/completions", fx.init, fx.context)).rejects.toThrow("could not be verified");
  expect(fx.count()).toBe(1);
});

it("keeps the same idempotency key when a grant response is lost, and admits only one concurrent caller", async () => {
  const fx = await fixture(); fx.modes({ prepareDrop: true });
  await expect(fx.gateway.request("/v1/chat/completions", fx.init, fx.context)).rejects.toThrow();
  expect(fx.count()).toBe(0);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => fx.gateway.request("/v1/chat/completions", fx.init, fx.context)));
  expect(results.filter(value => value.status === "fulfilled")).toHaveLength(1);
  for (const value of results) if (value.status === "fulfilled") await value.value.body?.cancel();
  expect(fx.count()).toBe(1);
  expect(fx.records.size).toBe(1);
  expect(new Set(fx.seen.filter(row => row.key).map(row => row.key)).size).toBe(1);
});

it("recovers the same authoritative operation after the local journal is lost or rolled back", async () => {
  const fx = await fixture(); fx.modes({ prepareDrop: true });
  await expect(fx.gateway.request("/v1/chat/completions", fx.init, fx.context)).rejects.toThrow();
  const folder = join(fx.directory, "donebot-team-execution", "dispatches");
  const file = join(folder, (await readdir(folder))[0]!);
  const prepared = await readFile(file, "utf8");
  await rm(file);
  await (await fx.create().request("/v1/chat/completions", fx.init, fx.context)).body?.cancel();
  expect(fx.count()).toBe(1);
  expect(fx.records.size).toBe(1);
  await writeFile(file, prepared, { mode: 0o600 });
  await expect(fx.create().request("/v1/chat/completions", fx.init, fx.context)).rejects.toBeInstanceOf(TeamModelRequestHeld);
  await rm(file);
  await expect(fx.create().request("/v1/chat/completions", fx.init, fx.context)).rejects.toBeInstanceOf(TeamModelRequestHeld);
  expect(fx.count()).toBe(1);
  expect(fx.records.size).toBe(1);
  expect(new Set(fx.seen.filter(row => row.key).map(row => row.key)).size).toBe(1);
});

it("fails closed for disabled execution, unbound background work, unsafe paths and revoked membership", async () => {
  const off = await fixture(false);
  await expect(off.gateway.request("/v1/chat/completions", off.init, off.context)).rejects.toThrow("not enabled");
  expect(off.seen).toHaveLength(0);
  const fx = await fixture();
  await expect(fx.gateway.request("/v1/chat/completions", fx.init)).rejects.toThrow();
  for (const path of ["https://elsewhere.invalid/v1/messages", "//elsewhere.invalid", "/v1/audio/speech", "/v1/messages?payer=1", "/v1/messages/count_tokens"]) {
    await expect(fx.gateway.request(path, fx.init, fx.context)).rejects.toThrow();
  }
  fx.modes({ revoked: true });
  await expect(fx.gateway.request("/v1/chat/completions", fx.init, fx.context)).rejects.toThrow("403");
  expect(fx.count()).toBe(0);
  expect(fx.records.size).toBe(0);
});

it("holds a delegated model request after restart and gives a genuine continuation its own immutable member request", async () => {
  const fx = await fixture();
  fx.gateway.requests.attachRun("root", fx.binding.id);
  const work = { id: "delegated-run", botId: "builder", threadId: "builder-thread" };
  fx.gateway.requests.handOn("root", work, "team");
  const child = fx.gateway.requests.coordinated({ ...work, audience: "team", generation: 1, executions: 1, restarts: 0 });
  const context = { bindingId: child.id, botId: work.botId, threadId: work.threadId, ordinal: 0 };
  fx.modes({ modelDrop: true });
  await expect(fx.gateway.request("/v1/chat/completions", fx.init, context)).rejects.toThrow();
  expect(fx.count()).toBe(1);
  const restarted = fx.create();
  const rerun = restarted.requests.coordinated({ ...work, audience: "team", generation: 1, executions: 2, restarts: 1 });
  expect(rerun).toEqual(child);
  await expect(restarted.request("/v1/chat/completions", fx.init, { ...context, bindingId: rerun.id })).rejects.toBeInstanceOf(TeamModelRequestHeld);
  expect(fx.count()).toBe(1);
  const continuation = restarted.requests.coordinated({ ...work, audience: "team", generation: 1, executions: 3, restarts: 1 });
  expect(continuation.id).not.toBe(child.id);
  await (await restarted.request("/v1/chat/completions", fx.init, { ...context, bindingId: continuation.id })).body?.cancel();
  expect(fx.count()).toBe(2);
  expect(fx.records.size).toBe(2);
  for (const record of fx.records.values()) expect(record.body).toMatchObject({ actor_id: fx.actor.userId, member_version: fx.actor.memberVersion, bot_id: work.botId, thread_id: work.threadId });
});

it("persists queued actors without refreshing versions and refuses forged sessions, senders or private audiences", async () => {
  const fx = await fixture();
  expect(teamRuntimeActor(fx.runtime, { ...fx.session })).toBeNull();
  expect(teamRuntimeActor({ ...fx.runtime }, fx.session)).toBeNull();
  expect(() => fx.gateway.requests.sender({ id: "other", name: "Other" }, fx.actor)).toThrow();
  expect(() => fx.gateway.requests.bind({ sourceId: fx.message.id, botId: "fixture-bot", threadId: "fixture-thread", audience: "member:someone-else", generation: 1 })).toThrow();
  fx.gateway.requests.captureQueue("fixture-thread", "fixture-queue", fx.sender);
  const restarted = new TeamRequestStore(fx.directory, fx.runtime);
  restarted.captureMessage("fixture-thread", { ...fx.message, id: "queued-message", queueId: "fixture-queue", sender: { ...fx.sender } });
  expect(restarted.bind({ sourceId: "queued-message", botId: "fixture-bot", threadId: "fixture-thread", audience: `member:${fx.person}`, generation: 1 }).actor).toEqual(fx.actor);
  const renewed = restarted.sender({ ...fx.sender }, { ...fx.actor, memberVersion: 3 });
  restarted.captureMessage("fixture-thread", { ...fx.message, id: "renewed-message", sender: renewed });
  expect(() => restarted.bind({ sourceId: "renewed-message", sourceIds: [fx.message.id], botId: "fixture-bot", threadId: "fixture-thread", audience: "team", generation: 1 })).toThrow();
  restarted.captureMessage("fixture-thread", { ...fx.message, id: "forged-message", sender: { ...fx.sender } });
  expect(() => restarted.bind({ sourceId: "forged-message", botId: "fixture-bot", threadId: "fixture-thread", audience: "team", generation: 1 })).toThrow();
  await chmod(fx.coordinatorFile, 0o644);
  expect(() => fx.gateway.coordinator()).toThrow("Private team state");
});

it("carries provenance through the real native driver, separates reasoning, and never retries an uncertain team response", async () => {
  const fx = await fixture(); fx.modes({ streaming: true });
  await fx.gateway.refreshCatalog();
  const driver = createDoneBotLlmDriver({ imageCacheDir: join(fx.directory, "images"), request: (path, init, context) => fx.gateway.request(path, init, context),
    authenticated: () => fx.gateway.authenticated(), requiresExecutionContext: true, models: () => doneBotTextModels(fx.gateway.models()), protocol: model => doneBotProtocol(model, fx.gateway.models()) });
  const instance = await driver.create({ instanceId: "donebot", displayName: "Fixture", environment: {}, enabled: true, config: {} });
  cleanups.push(async () => { await instance.dispose(); });
  let settle = (_event: RuntimeEvent) => {};
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent(event => { events.push(event); if (event.type === "turn.completed") settle(event); });
  const run = async (threadId: string, bindingId: string) => {
    const completed = new Promise<RuntimeEvent>(resolve => { settle = resolve; });
    await instance.adapter.sendTurn({ threadId, botId: "fixture-bot", text: "fixture", teamExecution: { bindingId }, toolScope: { allow: [] } });
    return await completed;
  };
  const completed = await run("fixture-thread", fx.binding.id);
  expect(completed, JSON.stringify(events)).toMatchObject({ type: "turn.completed", ok: true });
  expect(events.filter(event => event.type === "item.completed" && event.itemType === "assistant_text")).toMatchObject([{ text: "fixture answer" }]);
  expect(events.some(event => event.type === "content.delta" && event.streamKind === "reasoning_text" && event.delta.includes("fixture reasoning"))).toBe(true);
  fx.modes({ modelError: true });
  fx.gateway.requests.captureMessage("failure-thread", { ...fx.message, id: "failure-message" });
  const failure = fx.gateway.requests.bind({ sourceId: "failure-message", botId: "fixture-bot", threadId: "failure-thread", audience: "team", generation: 1 });
  expect(await run("failure-thread", failure.id)).toMatchObject({ type: "turn.completed", ok: false });
  expect(fx.count(), JSON.stringify(events)).toBe(2);
  expect(events.filter(event => event.type === "turn.retrying")).toHaveLength(0);
});
