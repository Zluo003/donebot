// Security: pairing needs the owner's session on a place that is one person's own (never a team's or a shared server).

import { createReadStream, createWriteStream, rmSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

import type { createDialer } from "../bot-link/dial.ts";
import type { BotLink } from "../bot-link/link.ts";
import { BOTS_PATH, FILE_PATH, LEVEL_HEADER, PAIR_PATH, PROTOCOL_LEVEL, SEEN_MS, STATE_PATH, SYNC_PATH, fileWay, levelOf, placeSchema, syncRequest } from "../bot-link/protocol.ts";
import { FILE_MAX_BYTES } from "../../shared/upload-limits.ts";
import { answerAsleep } from "../cloud-power.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

const name = z.string().trim().min(1).max(120);
const origin = z.string().max(300).regex(/^https?:\/\/[^/\s]+$/u);
const switchBody = z.union([
  z.object({ on: z.literal(true), origin, token: z.string().min(16).max(512), name, cloud: placeSchema, account: z.string().max(200).optional() }).strict(),
  z.object({ on: z.literal(false) }).strict(),
  z.object({ cloud: z.enum(["asleep", "awake"]), origin }).strict(),
]);
const pairBody = z.object({ computer: placeSchema, name }).strict();

const loopbackHost = (value: string) => /^(?:localhost|127\.0\.0\.1|\[::1\])$/u.test(new URL(value).hostname);

const LINK_USER = "bot-link:";
export const linkSessionUser = (computerId: string): string => `${LINK_USER}${computerId}`.slice(0, 200);

const LINK_ROUTES: ReadonlyArray<{ method: string; path: string }> = [{ method: "POST", path: SYNC_PATH }, { method: "GET", path: FILE_PATH }, { method: "PUT", path: FILE_PATH }];
/** Security invariant: a link's sign-in reaches the link's own routes and nothing else, whatever scopes it carries. */
export function linkSessionRefusal(session: { userId?: string }, method: string, path: string): string | null {
  if (!session.userId?.startsWith(LINK_USER)) return null;
  return LINK_ROUTES.some((route) => route.method === method && route.path === path) ? null : "This sign-in is only for the link between a computer and its Cloud.";
}

export const isBotLinkHeldPath = (path: string): boolean => path === SYNC_PATH;

export interface BotLinkRouteDeps {
  link: BotLink;
  dialer: ReturnType<typeof createDialer>;
  
  environmentId: string;
  
  local(auth: RequestAuth): boolean;
  
  owner(auth: RequestAuth): boolean;
  account?(): string | null;
  
  issue(auth: RequestAuth, label: string, computerId: string): { token: string; sessionId: string };
  revoke(sessionId: string): void;
  power(): { sleeping(): boolean; sleepSignal(): AbortSignal } | null | undefined;
  
  turnedOn?(): void;
  seenMs?: number;
  
  level?: number;
}

export function createBotLinkRoutes(deps: BotLinkRouteDeps): RouteHandler {
  const { link, dialer } = deps;
  const session = randomUUID();
  const held = new Map<string, () => void>();
  const gone = new Map<string, NodeJS.Timeout>();
  const seen = (peer: string) => {
    link.setOnline(peer, true);
    clearTimeout(gone.get(peer));
    const timer = setTimeout(() => { gone.delete(peer); link.setOnline(peer, false); }, deps.seenMs ?? SEEN_MS);
    timer.unref?.();
    gone.set(peer, timer);
  };
  
  const hold = (res: ServerResponse, peer: string, ack: number, wait: number, sleep: AbortSignal | undefined) => new Promise<void>((resolve) => {
    held.get(peer)?.();
    const done = () => { clearTimeout(timer); stop(); res.off("close", done); sleep?.removeEventListener("abort", done); if (held.get(peer) === done) held.delete(peer); resolve(); };
    const timer = setTimeout(done, wait);
    const stop = link.onOutgoing((changed) => { if (changed === peer && (!link.has(peer) || link.hasOutgoing(peer, ack))) done(); });
    res.on("close", done);
    sleep?.addEventListener("abort", done, { once: true });
    held.set(peer, done);
  });
  const state = () => ({ ...link.status(), ...(link.role() === "dialer" ? dialer.state() : {}) });

  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (path !== STATE_PATH && path !== PAIR_PATH && path !== SYNC_PATH && path !== FILE_PATH && path !== BOTS_PATH) return PASS;
    res.setHeader("cache-control", "no-store");

    if (path === BOTS_PATH) {
      req.resume();
      if (!deps.local(auth) && !deps.owner(auth)) return json(res, 403, { error: "Only the app on this computer or this place's owner lists its other places' bots." });
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      
      return json(res, 200, { bots: link.linked().map(({ id, peer, place, kind, online, bot }) => ({ id, home: { id: place.id, key: peer, kind, name: place.name, online }, botId: bot.id, name: bot.name,
        ...(bot.title ? { title: bot.title } : {}), ...(bot.color ? { color: bot.color } : {}), ...(bot.mascotBody ? { mascotBody: bot.mascotBody } : {}),
        ...(bot.mascotFaceColor ? { mascotFaceColor: bot.mascotFaceColor } : {}), ...(bot.chief ? { chiefOfStaff: true } : {}), ...(bot.threadId ? { threadId: bot.threadId } : {}) })) });
    }

    if (path === STATE_PATH) {
      if (!deps.local(auth)) { req.resume(); return json(res, 403, { error: "Only the app on this computer can turn the link to the Cloud on or off." }); }
      if (method === "GET") return json(res, 200, state());
      if (method !== "PUT") { req.resume(); return json(res, 405, { error: "method not allowed" }); }
      const body = switchBody.safeParse(await readBody(req, 16 * 1024));
      if (!body.success) return json(res, 400, { error: "send { on: true, origin, token, name, cloud: { id, name } }, { on: false } or { cloud: \"asleep\" | \"awake\", origin }" });
      if (!("on" in body.data)) {
        
        if (body.data.cloud === "awake") await dialer.tellEnded(body.data.origin);
        if (link.role() === "dialer" && link.dial()?.origin === body.data.origin) { if (body.data.cloud === "asleep") dialer.sleep(); else dialer.start(); }
        return json(res, 200, state());
      }
      if (!body.data.on) {
        if (link.role() === "dialer") link.turnOff(await dialer.stop({ bye: true }));
        return json(res, 200, link.status());
      }
      if (link.role() === "acceptor") return json(res, 409, { error: "This place already takes a computer's link." });
      if (deps.account && (!body.data.account || body.data.account !== deps.account())) return json(res, 403, { error: "The DoneBot account changed before the link was enabled." });
      if (!body.data.origin.startsWith("https://") && !loopbackHost(body.data.origin)) return json(res, 400, { error: "The Cloud's address must be https." });
      if (link.role() === "dialer" && link.dial()?.origin !== body.data.origin) link.turnOff(await dialer.stop({ bye: true }));
      link.turnOn({ self: { id: deps.environmentId, name: body.data.name }, origin: body.data.origin, token: body.data.token, peer: body.data.cloud, ...(body.data.account ? { account: body.data.account } : {}) });
      deps.turnedOn?.();
      dialer.start();
      return json(res, 200, state());
    }

    if (path === PAIR_PATH) {
      if (!deps.owner(auth)) { req.resume(); return json(res, 403, { error: "Only this place's owner can link their computer to it." }); }
      if (method === "DELETE") {
        req.resume();
        const computer = url.searchParams.get("computer") ?? undefined;
        if (link.role() === "acceptor") link.unpair(computer && computer.length <= 200 ? computer : undefined);
        return json(res, 200, { ok: true });
      }
      if (method !== "POST") { req.resume(); return json(res, 405, { error: "method not allowed" }); }
      const body = pairBody.safeParse(await readBody(req, 16 * 1024));
      if (!body.success) return json(res, 400, { error: "send { computer: { id, name }, name }" });
      if (link.role() === "dialer") return json(res, 409, { error: "This place is linked to a Cloud itself." });
      const issued = deps.issue(auth, `Bot link · ${body.data.computer.name}`, body.data.computer.id);
      const self = { id: deps.environmentId, name: body.data.name };
      const paired = link.pair({ self, sessionId: issued.sessionId, computer: body.data.computer });
      if (!paired) { deps.revoke(issued.sessionId); return json(res, 409, { error: "This Cloud already links as many computers as it can. Turn the link off on one of them first." }); }
      held.get(paired.peer)?.();
      if (paired.replaced) deps.revoke(paired.replaced);
      deps.turnedOn?.();
      return json(res, 200, { token: issued.token, place: self });
    }

    const peer = auth.kind === "session" ? link.peerOfSession(auth.session.id) : null;
    if (!peer) { req.resume(); return json(res, 403, { error: "This link is off. Turn it on again in the app." }); }
    if (path === FILE_PATH) {
      const id = url.searchParams.get("id") ?? "", way = fileWay.safeParse(url.searchParams.get("way")), index = Number(url.searchParams.get("index")), fileName = url.searchParams.get("name") ?? "";
      if (!id || id.length > 200 || !way.success || !Number.isInteger(index) || !fileName || fileName.length > 255) { req.resume(); return json(res, 400, { error: "send id, way, index and name" }); }
      if (deps.power()?.sleeping()) { req.resume(); return answerAsleep(res, json); }
      seen(peer);
      if (method === "GET" && url.searchParams.has("probe")) return json(res, 200, { have: link.holds(peer, id, way.data, index, fileName, Number(url.searchParams.get("bytes"))) });
      if (method === "GET") {
        const file = link.outgoingFile(peer, id, way.data, index);
        let bytes = -1;
        try { if (file) bytes = statSync(file.path).size; } catch {}
        if (!file || bytes < 0) return json(res, 404, { error: "that file is no longer kept" });
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(bytes) });
        await pipeline(createReadStream(file.path), res).catch(() => {});
        return;
      }
      if (method !== "PUT") { req.resume(); return json(res, 405, { error: "method not allowed" }); }
      const to = link.incoming(peer, id, way.data, index, fileName);
      if (!to) { req.resume(); return json(res, 409, { error: "that file is not wanted here any more" }); }
      let taken = 0;
      const capped = new Transform({ transform(chunk: Buffer, _encoding, done) { taken += chunk.length; done(taken > FILE_MAX_BYTES ? new Error("too large") : null, chunk); } });
      try {
        await pipeline(req, capped, createWriteStream(to, { mode: 0o600 }));
      } catch {
        rmSync(to, { force: true });
        if (res.destroyed) return;
        return json(res, taken > FILE_MAX_BYTES ? 413 : 400, { error: taken > FILE_MAX_BYTES ? `a file may be at most ${Math.round(FILE_MAX_BYTES / (1024 * 1024))} MB` : "the file did not arrive whole" });
      }
      return json(res, 200, { ok: true });
    }
    if (method !== "POST") { req.resume(); return json(res, 405, { error: "method not allowed" }); }
    const body = syncRequest.safeParse(await readBody(req, 4 * 1024 * 1024));
    if (!body.success) return json(res, 400, { error: "send { ack, frames, wait }" });
    const power = deps.power();
    if (power?.sleeping()) return answerAsleep(res, json);
    seen(peer);
    
    link.setLevel(peer, levelOf(req.headers[LEVEL_HEADER]));
    if ((deps.level ?? PROTOCOL_LEVEL) > 1) res.setHeader(LEVEL_HEADER, String(deps.level ?? PROTOCOL_LEVEL));
    if (body.data.fresh) link.sessionStarted(peer);
    link.receive(peer, body.data.frames);
    const linked = () => auth.kind === "session" && link.peerOfSession(auth.session.id) === peer;
    if (!linked()) { clearTimeout(gone.get(peer)); gone.delete(peer); return json(res, 200, { session, frames: [] }); }
    if (body.data.wait > 0 && !link.hasOutgoing(peer, body.data.ack)) await hold(res, peer, body.data.ack, body.data.wait, power?.sleepSignal());
    if (power?.sleeping()) return answerAsleep(res, json);
    if (res.writableEnded || res.destroyed) return;
    if (!linked()) return json(res, 403, { error: "This link is off. Turn it on again in the app." });
    seen(peer);
    return json(res, 200, { session, frames: link.outgoing(peer, body.data.ack) });
  };
}
