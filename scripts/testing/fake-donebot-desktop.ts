import { createServer, request } from "node:http";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fakeVncDesktop } from "./fake-vnc-desktop.ts";

export async function fakeDoneBotDesktop() {
  const root = await mkdtemp("/tmp/dbc-desktop-"), socketPath = join(root, "desktop.sock"), vnc = await fakeVncDesktop();
  const files = new Map<string, Buffer>(), commands: string[] = [], calls: string[] = [];
  const sockets = new Set<import("node:net").Socket>();
  let ready = false, controller: string | undefined, references = 0;
  const enter = (owner: string) => {
    if (controller && controller !== owner) throw new Error("desktop_control_occupied");
    controller = owner; references++; let released = false;
    return () => { if (released) return; released = true; if (--references === 0) controller = undefined; };
  };
  const server = createServer((req, res) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    let value: unknown;
    if (req.url === "/status") value = { ready, running: ready, status: ready ? "running" : "stopped", engine: "docker", available: true, image_ready: true,
      managed: true, imageMatches: true, network: "loopback", container: ready ? "running" : "stopped", viewer_url: "http://cloud-desktop.invalid/#password=fixture-only",
      viewer_port: vnc.port, control: { occupied: Boolean(controller), review_required: false } };
    else if (req.url === "/action") { ready = ["run", "start"].includes(input.action); value = { ok: true }; }
    else if (req.url === "/frame") value = { png: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", format: "png" };
    else if (req.url === "/exec") {
      const release = enter(String(req.headers["x-donebot-desktop-controller"] ?? "cloud-runtime"));
      try { commands.push(input.command); value = { stdout: "synthetic desktop output", stderr: "", exitCode: 0, timedOut: false }; } finally { release(); }
    } else if (req.url === "/file") {
      const content = files.get(input.path); if (!content) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": content.length }).end(content); return;
    } else { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
  })().catch(() => { if (!res.headersSent) res.writeHead(409); res.end(JSON.stringify({ error: "desktop_control_occupied" })); }); });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    socket.once("end", () => socket.destroy());
    try {
      const release = enter(req.url === "/mcp" ? String(req.headers["x-donebot-desktop-controller"] ?? "cloud-runtime") : randomUUID());
      socket.once("close", release);
      if (req.url === "/websockify") {
        const upstream = request({ hostname: "127.0.0.1", port: vnc.port, path: "/websockify", headers: req.headers });
        upstream.once("error", () => socket.destroy()); upstream.once("response", res => { res.resume(); socket.destroy(); });
        upstream.once("upgrade", (response, remote, remoteHead) => {
          socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${response.headers["sec-websocket-accept"]}\r\n\r\n`);
          if (head.length) remote.write(head); if (remoteHead.length) socket.write(remoteHead);
          socket.once("close", () => remote.destroy()); remote.once("close", () => socket.destroy()); remote.on("error", () => socket.destroy());
          socket.pipe(remote).pipe(socket);
        }); socket.once("close", () => upstream.destroy()); upstream.end(); return;
      }
      if (req.url !== "/mcp") { socket.destroy(); return; }
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: donebot-mcp\r\n\r\n");
      const decoder = new StringDecoder("utf8"); let buffer = "";
      const receive = (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        for (;;) {
          const end = buffer.indexOf("\n"); if (end < 0) break;
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
          const message = JSON.parse(line); if (message.id === undefined) continue;
          let result: unknown = {};
          if (message.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture-desktop", version: "1" } };
          if (message.method === "tools/list") result = { tools: [{ name: "fixture_desktop_action", description: "Synthetic desktop action", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
          if (message.method === "tools/call") { calls.push(message.params?.arguments?.text ?? ""); result = { content: [{ type: "text", text: "Synthetic desktop action completed." }] }; }
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
        }
      };
      socket.on("data", chunk => { try { receive(chunk); } catch { socket.destroy(); } }); if (head.length) receive(head);
    } catch { socket.end("HTTP/1.1 409 Rejected\r\nConnection: close\r\n\r\n"); }
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  return { socketPath, files, commands, calls, vnc,
    async close() { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await vnc.close(); await rm(root, { recursive: true, force: true }); },
  };
}
