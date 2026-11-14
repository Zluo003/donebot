import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import type { DoneBotGateway, DoneBotScope } from "./gateway.ts";
import type { DesktopTarget } from "../routes/desktop-viewer.ts";

export function doneBotDesktopViewer(gateway: DoneBotGateway, binding: () => Promise<{ instance: string; scope: DoneBotScope }>): DesktopTarget & { close(): void } {
  const bridges = new Set<() => void>();
  return { key: "donebot/shared", close() { for (const close of bridges) close(); }, async resolve() {
    const { instance, scope } = await binding(), access = await gateway.cloudViewerAccess(instance, scope);
    if (bridges.size >= 16) throw new Error("Cloud viewer is busy");
    const token = randomBytes(32).toString("hex"), server = createServer((_req, res) => res.writeHead(404).end());
    const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
    const sockets = new Set<import("node:net").Socket>(); let used = false;
    const close = () => { bridges.delete(close); clearTimeout(deadline); server.close(); wss.close(); for (const socket of sockets) socket.destroy(); };
    bridges.add(close);
    const deadline = setTimeout(close, 15000); deadline.unref();
    server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    server.on("upgrade", (req, socket, head) => {
      socket.on("error", () => socket.destroy());
      if (used || !access.live() || req.url !== "/websockify" || req.headers["x-donebot-viewer-token"] !== token) { socket.destroy(); return; }
      used = true;
      let remote: WebSocket;
      try { remote = access.open(); } catch { close(); return; }
      remote.once("error", close); remote.once("unexpected-response", (_req, res) => { res.resume(); remote.terminate(); close(); });
      remote.once("open", () => {
        if (socket.destroyed || !access.live()) { remote.terminate(); close(); return; }
        clearTimeout(deadline);
        wss.handleUpgrade(req, socket, head, local => {
          const forward = (peer: WebSocket, data: WebSocket.RawData, binary: boolean) => { if (peer.readyState === WebSocket.OPEN) peer.send(data, { binary }); if (peer.bufferedAmount > 8 * 1024 * 1024) peer.terminate(); };
          remote.on("message", (data, binary) => forward(local, data, binary)); local.on("message", (data, binary) => forward(remote, data, binary));
          local.on("error", () => remote.terminate()); local.once("close", () => { remote.terminate(); close(); }); remote.once("close", () => { local.terminate(); close(); });
        });
      }); socket.once("close", () => { remote.terminate(); close(); });
    });
    try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
    catch (error) { close(); throw error; }
    const address = server.address(); if (!address || typeof address === "string") { close(); throw new Error("Cloud viewer unavailable"); }
    return { port: address.port, password: access.password, headers: { "x-donebot-viewer-token": token }, live: access.live, retain: () => close };
  } };
}
