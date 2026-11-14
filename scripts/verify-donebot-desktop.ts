import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "./control-omb.ts";
import { startFakeDoneBotGateway } from "../server/testing/fake-donebot-gateway.ts";
import { fakeDoneBotDesktop } from "./testing/fake-donebot-desktop.ts";
import { mountPreview, fixtureApi, type MountedPreview } from "./testing/preview-fixture.ts";
import { openHeadlessChrome, type HeadlessPage } from "./testing/headless-chrome.ts";

const evidence = await mkdtemp(join(tmpdir(), "donebot-desktop-evidence-")), profile = await mkdtemp(join(tmpdir(), "donebot-desktop-chrome-"));
const desktop = await fakeDoneBotDesktop(), installation = randomUUID(), key = `sk-donebot-${"b".repeat(64)}`;
const gateway = await startFakeDoneBotGateway(undefined, new Map([[key, installation]]), "1");
gateway.cloud.enabled = true; gateway.cloud.balanceCents = 5000;
let cloud: VerificationServer | undefined, local: VerificationServer | undefined, preview: MountedPreview | undefined, page: HeadlessPage | undefined;
const proxy = createServer((req, res) => { void (async () => {
  const match = /^\/api\/v1\/donebot\/cloud\/instances\/[a-f0-9-]+\/proxy(\/api\/(?:donebot\/relay\/v1\/desktop|desktop-viewer\/local\/shared))$/.exec(req.url ?? "");
  if (match && req.headers.authorization !== "Bearer fixture-access-token") { res.writeHead(401).end(); return; }
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const response = await fetch(match ? cloud!.info.url + match[1] : gateway.origin + req.url, { method: req.method,
    headers: { "content-type": "application/json", ...(match ? {} : { authorization: String(req.headers.authorization ?? ""), "x-donebot-installation": String(req.headers["x-donebot-installation"] ?? ""), "idempotency-key": String(req.headers["idempotency-key"] ?? "") }) },
    ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: Buffer.concat(chunks) }) });
  res.writeHead(response.status, { "content-type": "application/json" }).end(Buffer.from(await response.arrayBuffer()));
})().catch(() => { if (!res.headersSent) res.writeHead(502); res.end(); }); });
const sockets = new Set<import("node:net").Socket>(); proxy.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
proxy.on("upgrade", (req, socket, head) => {
  socket.on("error", () => socket.destroy());
  if (req.headers.authorization !== "Bearer fixture-access-token" || !req.url?.endsWith("/proxy/api/desktop-viewer/local/shared/websockify")) { socket.destroy(); return; }
  const upstream = request(cloud!.info.url + "/api/desktop-viewer/local/shared/websockify", { headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": String(req.headers["sec-websocket-key"]) } });
  upstream.on("error", () => socket.destroy()); upstream.once("response", res => { res.resume(); socket.destroy(); });
  upstream.once("upgrade", (res, remote, remoteHead) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${res.headers["sec-websocket-accept"]}\r\n\r\n`);
    if (head.length) remote.write(head); if (remoteHead.length) socket.write(remoteHead);
    remote.on("error", () => socket.destroy()); remote.once("close", () => socket.destroy()); socket.once("close", () => remote.destroy()); socket.pipe(remote).pipe(socket);
  }); socket.once("close", () => upstream.destroy()); upstream.end();
});
await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
try {
  cloud = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin,
    { installationId: installation, credential: key, user: { id: "1", email: "fixture@example.invalid" } }, desktop.socketPath);
  local = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, origin);
  const api = fixtureApi(local.info.url), control = (...args: string[]) => runControlOmb([...args, "--url", local!.info.url]);
  await api("POST", "/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-only" });
  await api("POST", "/api/donebot/cloud", { action: "start", key: randomUUID(), account_id: "1", monthly_price: "12.500000" });
  const { bot } = await control("new-bot", "--name", "Cloud desktop fixture");
  await control("set-model", "--bot", bot.id, "--instance", "donebot", "--model", "deepseek-flash");
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud", cloudBackend: "donebot", approvalMode: "full" });
  desktop.files.set("/home/cua/workspace/result.txt", Buffer.from("Synthetic Cloud desktop artifact.\n"));
  gateway.setPlan([{ name: "fixture_desktop_action", arguments: { text: "中文桌面操作" } }, { name: "vm_exec", arguments: { command: "synthetic command" } }, { name: "attach_file", arguments: { path: "/home/cua/workspace/result.txt" } }]);
  await control("send", "--bot", bot.id, "--text", "在自有 Cloud 桌面执行合成操作，并把 result.txt 发回当前会话。");
  const wait = await control("wait", "--bot", bot.id, "--timeout", "45");
  const messages = await control("messages", "--bot", bot.id);
  await writeFile(join(evidence, "conversation.json"), JSON.stringify({ wait, messages }, null, 2));
  assert.equal(wait.status, "settled", JSON.stringify(messages));
  assert.deepEqual(desktop.calls, ["中文桌面操作"]); assert.deepEqual(desktop.commands, ["synthetic command"]);
  const threadId = (await api("GET", "/api/bots")).bots.find((row: { id: string }) => row.id === bot.id).threadId;
  assert.equal(typeof threadId, "string");
  const rows = (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages;
  const delivered = rows.find((row: { attachments?: unknown[] }) => row.attachments?.length);
  assert.ok(delivered, "artifact must be delivered to original thread");
  const attachment = delivered.attachments[0];
  const download = await fetch(`${local.info.url}/api/threads/${threadId}/messages/${delivered.id}/file`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: attachment.path }),
  });
  assert.equal(download.ok, true); assert.match(await download.text(), /Synthetic Cloud desktop artifact/);
  preview = await mountPreview(local, { entry: "/scripts/testing/donebot-desktop-preview.tsx", route: "/__donebot-desktop.html", title: "Isolated DoneBot Cloud desktop", logLevel: "warn" });
  page = await openHeadlessChrome(profile);
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.send("Page.navigate", { url: preview.previewUrl });
  await page.until("document.body.textContent.includes('接管云桌面')");
  assert.equal(await page.evaluate("document.body.textContent.includes('Boat') || document.body.textContent.includes('私有桌面')"), false);
  await page.evaluate("[...document.querySelectorAll('button')].find(button => button.textContent.includes('接管云桌面')).click()");
  await page.until("document.querySelector('canvas')?.width === 1280");
  await page.until("[...document.querySelectorAll('canvas')].some(canvas => canvas.height === 800)");
  await writeFile(join(evidence, "desktop.png"), await page.capture());
  await api("POST", "/api/donebot/logout", {});
  await page.until("!document.querySelector('canvas')", 10000);
  const receipt = { passed: true, checks: ["real-two-runtime-relay", "same-bot-thread", "mcp-call-once", "desktop-exec-once", "workspace-artifact-delivery", "real-panel-no-boat", "real-novnc-rfb", "logout-revokes-remote-viewer"], scriptedLlm: true, syntheticDesktop: true, liveDataTouched: false,
    logs: { local: local.info.logPath, cloud: cloud.info.logPath } };
  await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify({ ...receipt, evidence }));
} finally {
  console.log(JSON.stringify({ evidence, localLog: local?.info.logPath, cloudLog: cloud?.info.logPath }));
  page?.close(); await preview?.close(); await local?.close(); await cloud?.close();
  for (const socket of sockets) socket.destroy(); proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
  await gateway.close(); await desktop.close(); await rm(profile, { recursive: true, force: true });
}
