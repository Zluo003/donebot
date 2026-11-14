import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import type { SessionRegistry } from "../sessions.ts";
import { bearerToken, ownerOrAdmin, PROXY_HEADERS } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import { phoneRelayKey } from "../phone-relay.ts";
import { relayBaseUrlOverride } from "../../companion/src/e2e/config.ts";
import { createE2EOrigin, e2eContextOf } from "../../companion/src/e2e/origin.ts";
import { E2ERegistry } from "../../companion/src/e2e/registry.ts";
import { TRANSPORT_RELAY } from "../../companion/src/e2e/noise.ts";
import { RelayClient } from "../../companion/src/e2e/relay-client.ts";
import type { DoneBotGateway, DoneBotScope } from "./gateway.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const grantSchema = z.object({ authorizationId: z.string().regex(/^[a-f0-9]{64}$/), id: z.string().uuid(), tokenHash: z.string().regex(/^[a-f0-9]{64}$/) });
const replySchema = z.object({ hostId: z.string(), nodes: z.array(z.string().regex(/^(donebot\.cn\/mobile-relay|relay[1-9][0-9]?\.donebot\.cn)$/)).min(1).max(4), token: z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/).max(2048), devices: z.array(grantSchema).max(20), leaseSeconds: z.number().int().min(1).max(70) });
export interface MobileMessageEvent { botId: string; threadId: string; messageId: string }
interface HostOptions {
  dataDir: string; gateway: DoneBotGateway; sessions: SessionRegistry;
  handle(req: IncomingMessage, res: ServerResponse): unknown;
  name(): string;
  fixtureRelay?: string;
}
function reply(res: ServerResponse, status: number) { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ error: "mobile request refused" })); }
export function mobileChatRoute(method: string, raw: string): boolean {
  const url = new URL(raw, "https://phone-relay.invalid");
  if (!raw.startsWith("/") || raw.startsWith("//") || /%|\\/.test(url.pathname)) return false;
  const path = url.pathname;
  if (raw.split("?")[0] !== path) return false;
  if (method === "GET" && path === "/api/bots") return [...url.searchParams].every(([key,value]) => key === "messages" && value === "1");
  if (method === "GET" && /^\/api\/threads\/[\w-]+\/messages$/.test(path)) return [...url.searchParams].every(([key,value]) => key === "limit" ? /^\d{1,2}$/.test(value) && Number(value) <= 50 : key === "before" && /^[\w-]+$/.test(value));
  return method === "POST" && !url.search && /^\/api\/bots\/[\w-]+\/(messages|read)$/.test(path);
}
export function createDoneBotMobileHost(options: HostOptions) {
  let dir = "", stateFile = "";
  let state: { hostId: string; revoked: string[]; events: Array<MobileMessageEvent & { scope: string; at: number }> } | undefined;
  let scope: DoneBotScope | null = null;
  let live = new Map<string, { id: string; tokenHash: string; authorization: string; until: number }>();
  let relay: RelayClient | undefined;
  let key: ReturnType<typeof phoneRelayKey> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let started = false, changing = false, running = false, epoch = 0, leaseUntil = 0;
  let abort = new AbortController();
  let lastHeartbeat = 0;
  let problem = "";
  const snapshot = () => ({ authenticated: Boolean(options.gateway.scope()),
    registered: Boolean(lastHeartbeat && Date.now() - lastHeartbeat < 45_000),
    relay: relay?.status ?? "off", node: relay?.node ?? null, problem,
    lastHeartbeat: lastHeartbeat || null });
  const route: RouteHandler = async ({ path, method, auth, res, json }) => {
    if (path !== "/api/donebot/mobile/status" || method !== "GET") return PASS;
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only the owner can view mobile access." });
    res.setHeader("Cache-Control", "no-store");
    return json(res, 200, snapshot());
  };
  const save = () => { if (state) writeFileAtomic(stateFile, JSON.stringify(state), { mode: 0o600 }); };
  const devices = { records: () => options.sessions.bearerDigests(new Set([...live.values()].filter(device => device.until > Date.now()).map(device => device.id))), pairingWindows: () => [], confirm() {}, markE2E() {} };
  const e2e = new E2ERegistry(devices);
  const origin = createE2EOrigin((req,res) => {
    const context = e2eContextOf(req.socket);
    const token = bearerToken(req.headers.authorization);
    const record = token && options.sessions.authenticate(token);
    if (!scope || Date.now() >= leaseUntil || context?.peer.kind !== "device" || !record || record.id !== context.peer.id || !devices.records().some(device => device.id === record.id)) return reply(res,401);
    if (!mobileChatRoute(req.method ?? "GET", req.url ?? "/")) return reply(res,403);
    for (const name of Object.keys(req.headers)) if (name === "cookie" || name.startsWith("x-donebot-") || (PROXY_HEADERS as readonly string[]).includes(name)) delete req.headers[name];
    req.headers.host = "phone-relay.invalid";
    req.headers["x-forwarded-for"] = `mobile-${record.id}`;
    void Promise.resolve(options.handle(req,res)).catch(() => { if (!res.headersSent) reply(res,500); else res.destroy(); });
  }, (_req,socket) => socket.destroy());
  function clear() {
    ++epoch; abort.abort(); abort = new AbortController();
    relay?.stop(); relay = undefined; e2e.closeAll(); e2e.setRelay(null); e2e.setKey(null); leaseUntil = 0; key = undefined; state = undefined;
    changing = true;
    lastHeartbeat = 0;
    try { for (const device of live.values()) options.sessions.revoke(device.id); } finally { live.clear(); changing = false; }
  }
  const stopRevoked = options.sessions.onSessionRevoked(id => {
    const device = [...live.values()].find(device => device.id === id);
    e2e.closeDevice(id); relay?.refreshAdmission();
    if (!changing && device && device.until > Date.now() && state) { state.revoked = [...new Set([...state.revoked,device.authorization])]; save(); }
  });
  async function post(path: "heartbeat" | "events", body: unknown, current: DoneBotScope, signal: AbortSignal): Promise<unknown> {
    const res = await options.gateway.requestForScope(current, `/v1/donebot/runtime/mobile/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
    if (!res.ok) { await res.body?.cancel(); throw Object.assign(new Error("Mobile hub unavailable"), { status: res.status }); }
    if (res.status === 204) return null;
    const text = await res.text(); if (text.length > 64 * 1024) throw new Error("Invalid mobile hub response");
    const data = JSON.parse(text) as { code?: number; data?: unknown };
    return data.code === 0 ? data.data : data;
  }
  async function tick() {
    if (!started || running) return;
    const next = options.gateway.scope();
    if (JSON.stringify(next) !== JSON.stringify(scope)) { clear(); scope = next; }
    if (!scope) return;
    running = true;
    const current = scope, generation = epoch, signal = abort.signal;
    try {
      if (!state) {
        dir = join(options.dataDir, "donebot", "mobile", hash(JSON.stringify(current)));
        stateFile = join(dir, "state.json");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        try { state = z.object({ hostId: z.string().regex(/^[A-Za-z0-9_-]{22}$/), revoked: z.array(z.string().regex(/^[a-f0-9]{64}$/)), events: z.array(z.object({ botId: z.string(), threadId: z.string(), messageId: z.string(), scope: z.string(), at: z.number() })) }).parse(JSON.parse(readFileSync(stateFile,"utf8"))); }
        catch(error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; state = { hostId: randomBytes(16).toString("base64url"), revoked: [], events: [] }; save(); }
      }
      key ??= phoneRelayKey(dir); e2e.setKey(key);
      const acknowledged = Object.fromEntries([...live].filter(([,device]) => options.sessions.isLive(device.id)).map(([id,device]) => [id,device.tokenHash]));
      const result = replySchema.parse(await post("heartbeat", { hostId: state.hostId, publicKey: key.publicKey.toString("base64url"), name: options.name().slice(0,120), acknowledged, relayState: relay?.status ?? "connecting", relayNode: relay?.node ?? "" }, current, signal));
      if (generation !== epoch || !started) return;
      if (result.hostId !== state.hostId) throw new Error("Mobile host identity changed");
      lastHeartbeat = Date.now(); problem = "";
      leaseUntil = Date.now() + result.leaseSeconds * 1000;
      const accepted = new Map<string, { id: string; tokenHash: string; authorization: string; until: number }>();
      changing = true;
      try {
        for (const grant of result.devices) {
          if (state.revoked.includes(grant.authorizationId)) continue;
          const id = "mobile-" + hash(JSON.stringify([current.accountId,current.installationId,grant.id,grant.tokenHash]));
          options.sessions.acceptMobileLease(id, grant.tokenHash, leaseUntil);
          accepted.set(grant.id, { id, tokenHash: grant.tokenHash, authorization: grant.authorizationId, until: leaseUntil });
        }
        for (const device of live.values()) if (![...accepted.values()].some(next => next.id === device.id)) { e2e.closeDevice(device.id); options.sessions.revoke(device.id); }
        live = accepted;
      } finally { changing = false; }
      e2e.setRelay({ hostId: Buffer.from(result.hostId,"base64url"), nodes: result.nodes });
      if (relay) relay.setToken(result.token,result.nodes);
      else {
        relay = new RelayClient({ nodes: result.nodes, token: result.token, admissionSet: () => e2e.admissionSet(), tokenRejected: () => void tick(), baseUrl: relayBaseUrlOverride(options.fixtureRelay), accept: transport => {
          if (Date.now() >= leaseUntil) return null;
          const session = e2e.accept(transport, TRANSPORT_RELAY,"relay",context => origin.connect(context));
          return session && { receive: (data,binary) => session.receive(data,binary), transportClosed: code => session.transportClosed(code) };
        } });
        relay.start();
      }
      relay.refreshAdmission();
      const scopeKey = JSON.stringify(current);
      state.events = state.events.filter(event => event.at > Date.now() - 5 * 60_000 && event.scope === scopeKey);
      const pending = state.events.slice(0,50);
      if (pending.length) {
        await post("events",{ events: pending.map(({ botId,threadId,messageId }) => ({ botId,threadId,messageId })) },current,signal);
        if (generation !== epoch) return;
        const sent = new Set(pending.map(event => event.messageId));
        state.events = state.events.filter(event => !sent.has(event.messageId)); save();
      }
    } catch (error) {
      if (generation !== epoch || !started) return;
      if (Date.now() >= leaseUntil) clear();
      const status = (error as { status?: number }).status;
      problem = status === 404 || status === 501 || status === 503 ? "unavailable" : status === 401 || status === 403 ? "login" : "network";
    }
    finally { running = false; }
  }
  const stopAccount = options.gateway.onChange(() => { const next = options.gateway.scope(); if (JSON.stringify(next) !== JSON.stringify(scope)) { clear(); scope=next; } void tick(); });
  return {
    route, state: snapshot,
    start() { if (started) return; started = true; timer = setInterval(() => { if (leaseUntil && Date.now() >= leaseUntil) clear(); void tick(); },5_000); timer.unref(); void tick(); },
    message(event: MobileMessageEvent) {
      if (!started || !state || !scope) return;
      if (state.events.some(old => old.messageId === event.messageId)) return;
      state.events.push({ ...event, scope: JSON.stringify(scope), at: Date.now() }); state.events=state.events.slice(-500); try { save(); } catch { } void tick();
    },
    stop() { started=false;if (timer) clearInterval(timer); clear(); origin.close(); stopRevoked(); stopAccount(); },
  };
}
