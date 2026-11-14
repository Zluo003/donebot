import { request } from "node:http";
import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { rm } from "node:fs/promises";
import { cloudDesktopCall, cloudDesktopSocket } from "../cloud-desktop.ts";
import { copyDesktopFile, desktopFileChunk, type DesktopFile } from "./desktop-files.ts";

const rpcId = z.union([z.string().max(200), z.number().finite()]);
export const desktopRpcMessage = z.object({ jsonrpc: z.literal("2.0"), id: rpcId.optional(),
  method: z.enum(["initialize", "notifications/initialized", "ping", "tools/list", "tools/call"]), params: z.record(z.string(), z.unknown()).optional() }).strict();
export const desktopRelayInput = z.object({ version: z.literal(1), accountId: z.string().max(200), controller: z.string().uuid(),
  action: z.enum(["status", "submit", "poll", "renew", "chunk", "release", "close"]), operation: z.string().uuid().optional(), offset: z.number().int().nonnegative().optional(),
  command: z.enum(["ensure", "stop", "frame", "rpc", "exec", "file"]).optional(), message: desktopRpcMessage.optional(), path: z.string().max(8192).optional(),
  exec: z.object({ command: z.string().min(1).max(20000), timeout_seconds: z.number().int().min(1).max(300).optional() }).strict().optional() }).strict();

class DesktopMcpSocket {
  private socket?: Duplex;
  private opening?: Promise<void>;
  private closed = false;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly controller: string;
  constructor(controller: string) { this.controller = controller; }
  private connect() {
    return this.opening ??= new Promise<void>((resolve, reject) => {
      const socketPath = cloudDesktopSocket();
      if (!socketPath || this.closed) { reject(new Error("Cloud 桌面不可用。")); return; }
      const req = request({ socketPath, path: "/mcp", agent: false, headers: { connection: "Upgrade", upgrade: "donebot-mcp", "x-donebot-desktop-controller": this.controller } });
      const timer = setTimeout(() => req.destroy(new Error("桌面连接超时。")), 10000); timer.unref();
      req.once("error", error => { clearTimeout(timer); reject(error); this.close(); });
      req.once("response", res => { res.resume(); clearTimeout(timer); reject(new Error("桌面正在被其他任务操作，或有中断的操作需要核对。")); this.close(); });
      req.once("upgrade", (_res, socket, head) => {
        clearTimeout(timer);
        if (this.closed) { socket.destroy(); reject(new Error("桌面连接已取消。")); return; }
        this.socket = socket; const decoder = new StringDecoder("utf8"); let buffer = "";
        const receive = (chunk: Buffer) => {
          buffer += decoder.write(chunk);
          if (Buffer.byteLength(buffer) > 20 * 1024 * 1024) { this.close(); return; }
          for (;;) {
            const end = buffer.indexOf("\n"); if (end < 0) break;
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
            try {
              const message = JSON.parse(line) as Record<string, unknown>, key = JSON.stringify(message.id), pending = this.pending.get(key);
              if (pending && ("result" in message || "error" in message)) { this.pending.delete(key); clearTimeout(pending.timer); pending.resolve(message); }
            } catch { this.close(); return; }
          }
        };
        socket.on("data", receive); socket.once("error", () => this.close()); socket.once("close", () => this.close());
        if (head.length) receive(head); resolve();
      }); req.end();
    });
  }
  async call(message: z.infer<typeof desktopRpcMessage>): Promise<unknown> {
    await this.connect(); if (this.closed || !this.socket) throw new Error("桌面连接已断开；请核对在途操作，不要重复执行。 ");
    if (message.id === undefined) { this.socket.write(JSON.stringify(message) + "\n"); return null; }
    const key = JSON.stringify(message.id);
    if (this.pending.has(key)) throw new Error("重复的桌面请求编号。");
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error("桌面操作未确认完成，请核对后再继续。")); }, 320000); timer.unref();
      this.pending.set(key, { resolve, reject, timer }); this.socket!.write(JSON.stringify(message) + "\n");
    });
  }
  close() {
    this.closed = true; this.socket?.destroy();
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("桌面连接中断；操作结果需核对。")); } this.pending.clear();
  }
}

interface DesktopJob { fingerprint: string; state: "running" | "completed" | "failed"; value?: unknown; error?: string; file?: DesktopFile }
interface DesktopSession { at: number; mcp: DesktopMcpSocket; jobs: Map<string, DesktopJob>; exports: number }
export function createDesktopRpc() {
  const sessions = new Map<string, DesktopSession>();
  const close = (id: string) => { const session = sessions.get(id); session?.mcp.close(); sessions.delete(id); for (const job of session?.jobs.values() ?? []) if (job.file) void rm(job.file.root, { recursive: true, force: true }); };
  const timer = setInterval(() => { for (const [id, session] of sessions) if (Date.now() - session.at > 45000) close(id); }, 1000); timer.unref();
  return {
    async handle(input: z.infer<typeof desktopRelayInput>): Promise<unknown> {
      const sessionId = `${input.accountId}:${input.controller}`;
      if (input.action === "status") return cloudDesktopCall("/status");
      if (input.action === "close") { close(sessionId); return { ok: true }; }
      let session = sessions.get(sessionId);
      if (!session) {
        if (input.action !== "submit" || sessions.size >= 8) throw new Error("桌面会话已过期，请核对操作状态。 ");
        session = { at: Date.now(), mcp: new DesktopMcpSocket(input.controller), jobs: new Map(), exports: 0 }; sessions.set(sessionId, session);
      }
      session.at = Date.now();
      if (input.action === "renew") return { ok: true };
      if (!input.operation) throw new Error("缺少桌面操作编号。 ");
      const previous = session.jobs.get(input.operation);
      if (input.action === "release") {
        if (previous?.state === "running") throw new Error("文件仍在导出。 ");
        if (previous?.file) { const file = previous.file; previous.file = undefined; session.exports--; await rm(file.root, { recursive: true, force: true }); }
        return { ok: true };
      }
      if (input.action === "chunk") { if (!previous?.file || input.offset === undefined) throw new Error("云桌面文件导出已过期。 "); return desktopFileChunk(previous.file, input.offset); }
      if (input.action === "poll") { if (!previous) throw new Error("桌面操作记录已过期，不能自动重做。 "); return { state: previous.state, value: previous.value, error: previous.error }; }
      const fingerprint = JSON.stringify([input.command, input.message, input.exec, input.path]);
      if (previous) { if (previous.fingerprint !== fingerprint) throw new Error("桌面操作编号已经被使用。 "); return { state: previous.state, value: previous.value, error: previous.error }; }
      if (session.jobs.size >= 256) throw new Error("桌面会话操作数量已达到上限，请结束当前任务。 ");
      const job: DesktopJob = { fingerprint, state: "running" }; session.jobs.set(input.operation, job);
      const perform = async () => {
        if (input.command === "ensure") return cloudDesktopCall("/action", { action: "run" }, input.controller);
        if (input.command === "stop") return cloudDesktopCall("/action", { action: "stop" }, input.controller);
        if (input.command === "frame") return cloudDesktopCall("/frame");
        if (input.command === "exec" && input.exec) return cloudDesktopCall("/exec", input.exec, input.controller);
        if (input.command === "rpc" && input.message) return session.mcp.call(input.message);
        if (input.command === "file" && input.path) {
          if (session.exports >= 2) throw new Error("请结束本次桌面文件传输后重试。 ");
          session.exports++;
          try {
            const file = await copyDesktopFile(input.path);
            if (sessions.get(sessionId) !== session) { await rm(file.root, { recursive: true, force: true }); throw new Error("桌面会话已关闭。 "); }
            job.file = file; return { name: file.name, bytes: file.bytes, sha256: file.sha256 };
          } catch (error) { session.exports--; throw error; }
        }
        throw new Error("无效的桌面操作。 ");
      };
      void perform().then(value => { job.state = "completed"; job.value = value; }, () => { job.state = "failed"; job.error = "云桌面操作未完成。可能已被占用、连接中断或需要核对上次操作；不要自动重做。"; });
      return { state: "running" };
    },
    close() { clearInterval(timer); for (const id of sessions.keys()) close(id); },
  };
}
