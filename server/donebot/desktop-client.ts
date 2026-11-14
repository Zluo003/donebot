import { createServer } from "node:http";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DoneBotGateway, DoneBotScope } from "./gateway.ts";
import { desktopRpcMessage } from "./desktop-rpc.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { desktopFileMeta, receiveDesktopFile } from "./desktop-files.ts";

const jobSchema = z.object({ state: z.enum(["running", "completed", "failed"]), value: z.unknown().optional(), error: z.string().optional() });
export class DoneBotDesktopClient {
  readonly controller = randomUUID();
  private closed = false;
  private closing?: Promise<void>;
  private started = false;
  private readonly abort = new AbortController();
  private readonly gateway: DoneBotGateway;
  readonly instance: string;
  private readonly scope: DoneBotScope;
  constructor(gateway: DoneBotGateway, instance: string, scope: DoneBotScope) { this.gateway = gateway; this.instance = instance; this.scope = scope; }
  current() {
    const scope = this.gateway.scope();
    return !this.closed && scope?.accountId === this.scope.accountId && scope.installationId === this.scope.installationId;
  }
  async request(action: "status" | "submit" | "poll" | "renew" | "chunk" | "release", fields: Record<string, unknown> = {}) {
    if (!this.current()) throw new Error("Cloud 桌面账号已退出或切换。 ");
    return this.gateway.cloudRelay(this.instance, this.scope, { version: 1, accountId: this.scope.accountId, controller: this.controller, action, ...fields }, this.abort.signal, "desktop");
  }
  async run(command: "ensure" | "stop" | "frame" | "rpc" | "exec" | "file", fields: Record<string, unknown> = {}, operation = randomUUID()) {
    let job = jobSchema.parse(await this.request("submit", { operation, command, ...fields })); this.started = true;
    const deadline = Date.now() + 330000;
    while (job.state === "running") {
      if (Date.now() >= deadline || !this.current()) throw new Error("Cloud 桌面操作尚未确认，不能自动重做。 ");
      await new Promise<void>((resolve, reject) => {
        const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener("abort", cancel); resolve(); };
        const cancel = () => { clearTimeout(timer); reject(new Error("Cloud 桌面连接已关闭。")); };
        const timer = setTimeout(done, 250); this.abort.signal.addEventListener("abort", cancel, { once: true });
      });
      job = jobSchema.parse(await this.request("poll", { operation }));
    }
    if (!this.current()) throw new Error("Cloud 桌面账号已变化。 ");
    if (job.state === "failed") throw new Error(job.error ?? "Cloud 桌面操作失败，请核对后继续。 ");
    return job.value;
  }
  async withFile<T>(path: string, save: (local: { root: string; path: string }) => Promise<T>) {
    const operation = randomUUID(), meta = desktopFileMeta.parse(await this.run("file", { path }, operation));
    try { return await receiveDesktopFile(meta, offset => this.request("chunk", { operation, offset }), save); }
    finally { await this.request("release", { operation }).catch(() => {}); }
  }
  async mount(control: { url: string; token: string }, active: () => boolean) {
    const token = randomBytes(32).toString("hex"), sockets = new Set<import("node:net").Socket>();
    const server = createServer(async (req, res) => {
      const bearer = req.headers.authorization?.slice(7) ?? "";
      if (!req.headers.authorization?.startsWith("Bearer ") || bearer.length !== token.length || !timingSafeEqual(Buffer.from(bearer), Buffer.from(token)) || !active() || !this.current() || req.method !== "POST" || req.url !== "/rpc") { res.writeHead(403).end(); return; }
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error("桌面请求过大。 "); chunks.push(chunk); }
        const message = desktopRpcMessage.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (!active()) throw new Error("任务已结束。 ");
        const value = await this.run("rpc", { message });
        if (!active() || !this.current()) { res.destroy(); return; }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
      } catch { if (!res.headersSent) res.writeHead(502).end(JSON.stringify({ error: "Cloud 桌面操作未确认，请核对后继续。" })); else res.destroy(); }
    });
    server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Cloud 桌面桥未启动。 ");
    const stop = () => { clearInterval(timer); for (const socket of sockets) socket.destroy(); server.close(); void this.close(); };
    const timer = setInterval(() => { if (!active() || !this.current()) stop(); }, 500); timer.unref();
    let refreshing = false;
    const heartbeat = setInterval(() => {
      if (!this.started || refreshing || !this.current()) return;
      refreshing = true; void this.request("renew").catch(stop).finally(() => { refreshing = false; });
    }, 10000); heartbeat.unref(); server.once("close", () => clearInterval(heartbeat));
    return { integration: { command: process.execPath, args: [SPAWNED_PROXIES.donebotDesktopMcp], env: {
      ELECTRON_RUN_AS_NODE: "1", DONEBOT_DESKTOP_RPC_URL: `http://127.0.0.1:${address.port}/rpc`, DONEBOT_DESKTOP_RPC_TOKEN: token,
      DONEBOT_CONTROL_URL: control.url, DONEBOT_CONTROL_TOKEN: control.token,
    } }, close: stop };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const current = this.current(); this.closed = true; this.abort.abort();
    this.closing = current ? this.gateway.cloudRelay(this.instance, this.scope, { version: 1, accountId: this.scope.accountId,
      controller: this.controller, action: "close" }, AbortSignal.timeout(5000), "desktop").then(() => {}, () => {}) : Promise.resolve();
    return this.closing;
  }
}
