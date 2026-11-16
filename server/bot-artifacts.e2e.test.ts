import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { BotArtifactPage } from "../shared/artifacts.ts";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { handleToolCall, request } from "../scripts/mcp-server.ts";
import { startFakeDoneBotGateway } from "./testing/fake-donebot-gateway.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const assets = [
  { name: "donkey.png", mime: "image/png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2Cj8AAAAASUVORK5CYII=", "base64") },
  { name: "film.mp4", mime: "video/mp4", bytes: Buffer.from("synthetic video") },
  { name: "music.mp3", mime: "audio/mpeg", bytes: Buffer.from("synthetic audio") },
  { name: "brief.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF-1.4 synthetic document") },
];

it.each([false, true])("lists all four delegated artifacts under the reporting bot, with scoped previews and downloads (room=%s)", async room => {
  const gateway = await startFakeDoneBotGateway();
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true }, [], undefined, undefined, gateway.origin);
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, fixture.info.url) as Promise<any>;
  try {
    await api("/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-fixture-password" });
    const { bot: sender } = await cli("new-bot", "--name", "Editor", "--section", "Studio");
    const { bot: worker } = await cli("new-bot", "--name", "Artist", "--section", "Studio");
    for (const [bot, model] of [[sender, "deepseek-flash"], [worker, "gpt-6.1-sol"]] as const) {
      await cli("set-model", "--bot", bot.id, "--instance", "donebot", "--model", model);
      await api(`/api/bots/${bot.id}`, { approvalMode: "full" }, "PATCH");
    }
    const channel = room ? (await handleToolCall("create_channel", { name: "Editorial", member_ids: [sender.id, worker.id] },
      (path, options) => request(path, options, fixture.info.url)) as any).channel : undefined;
    const threadId = channel?.activeTaskId ?? sender.activeTaskId;
    const folder = join(fixture.info.dataDir, "workspaces", worker.id);
    mkdirSync(folder, { recursive: true });
    for (const asset of assets) writeFileSync(join(folder, asset.name), asset.bytes);
    gateway.setModelPlan("gpt-6.1-sol", assets.map(asset => ({ name: "attach_file", arguments: { path: join(folder, asset.name) } })), "All deliverables are attached.", "Unexpected extra execution");
    gateway.setModelPlan("deepseek-flash", [{ name: "coordinate_bots", arguments: { bot_ids: [worker.id], message: "Produce four donkey deliverables." } }], "Assigned", "The donkey deliverables are ready.");
    if (channel) await cli("send-channel", "--channel", channel.id, "--text", "@Editor 画一个皮克斯 3D 卡通风格的驴子");
    else await cli("send", "--bot", sender.id, "--text", "画一个皮克斯 3D 卡通风格的驴子");
    const waited = channel ? await cli("wait", "--channel", channel.id, "--timeout", "30") : await cli("wait", "--bot", sender.id, "--timeout", "30");
    expect(waited.status).toBe("settled");
    const page = await api(`/api/bots/${sender.id}/artifacts?limit=2`) as BotArtifactPage;
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeTruthy();
    const next = await api(`/api/bots/${sender.id}/artifacts?limit=2&before=${page.nextCursor}`) as BotArtifactPage;
    expect(next.items).toHaveLength(2);
    expect(next.nextCursor).toBeNull();
    const items = [...page.items, ...next.items];
    expect(new Set(items.map(item => item.id)).size).toBe(4);
    expect(new Set(items.map(item => item.kind))).toEqual(new Set(["image", "video", "audio", "document"]));
    expect(items.every(item => item.title === "皮克斯 3D 卡通驴子")).toBe(true);
    expect(items.every(item => item.threadId === threadId)).toBe(true);
    const { messages } = await api(`/api/threads/${threadId}/messages?limit=100`);
    const summary = messages.find((message: any) => message.text === "The donkey deliverables are ready.");
    expect(summary.reportedAttachmentMessageIds?.length).toBeGreaterThan(0);
    expect(items.every(item => item.reportMessageId === summary.id)).toBe(true);
    for (const item of items) {
      const asset = assets.find(asset => asset.mime === item.mime)!;
      const preview = await fetch(`${fixture.info.url}${item.previewUrl}`, { headers: { range: "bytes=0-7" } });
      expect(preview.status).toBe(206);
      expect(preview.headers.get("content-type")).toBe(asset.mime);
      expect(preview.headers.get("content-disposition")).toBe("inline");
      expect(Buffer.from(await preview.arrayBuffer())).toEqual(asset.bytes.subarray(0, 8));
      const response = await fetch(`${fixture.info.url}/api/threads/${item.threadId}/messages/${item.messageId}/file`, {
        method: "POST", headers: { origin: fixture.info.url, "content-type": "application/json" }, body: JSON.stringify({ path: item.path }),
      });
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(asset.bytes);
      const forged = new URL(item.previewUrl, fixture.info.url);
      forged.searchParams.set("path", join(folder, "never-shared.pdf"));
      expect((await fetch(forged)).status).toBe(403);
    }
    const absent = await api(`/api/bots/${worker.id}/artifacts`) as BotArtifactPage;
    expect(absent.items).toHaveLength(room ? 4 : 0);
    const invalid = await fetch(`${fixture.info.url}/api/bots/${sender.id}/artifacts?before=not-a-cursor`);
    expect(invalid.status).toBe(400);
    const pairing = await api("/api/auth/pairing", { label: "Artifact reader", scopes: ["client"] });
    const paired = await api("/api/auth/pair", { code: pairing.code, label: "Artifact reader" });
    const headers = { authorization: `Bearer ${paired.token}` };
    expect((await fetch(`${fixture.info.url}/api/bots/${sender.id}/artifacts`, { headers })).status).toBe(200);
    await api(`/api/bots/${sender.id}`, { visibility: "admins" }, "PATCH");
    expect((await fetch(`${fixture.info.url}/api/bots/${sender.id}/artifacts`, { headers })).status).toBe(404);
    expect((await fetch(`${fixture.info.url}${items[0]!.previewUrl}`, { headers })).status).toBe(404);
    const publicWorker = await fetch(`${fixture.info.url}/api/bots/${worker.id}/artifacts`, { headers }).then(response => response.json()) as BotArtifactPage;
    expect(publicWorker.items).toHaveLength(0);
    const evidence = join(process.cwd(), ".omb-scratch", "verify-evidence", "artifacts");
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, `${room ? "room" : "direct"}.json`), JSON.stringify({ fixture: fixture.info, items, summary }, null, 2));
  } finally { await fixture.close(); await gateway.close(); }
}, hostTimeout(90_000));
