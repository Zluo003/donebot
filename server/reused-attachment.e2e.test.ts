import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { handleToolCall, request } from "../scripts/mcp-server.ts";
import { startFakeDoneBotGateway } from "./testing/fake-donebot-gateway.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const assets = [
  { name: "illustration.png", mime: "image/png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2Cj8AAAAASUVORK5CYII=", "base64") },
  { name: "film.mp4", mime: "video/mp4", bytes: Buffer.from("synthetic video") },
  { name: "music.mp3", mime: "audio/mpeg", bytes: Buffer.from("synthetic audio") },
  { name: "brief.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF-1.4 synthetic document") },
];

it.each([
  { room: false, model: "deepseek-flash" }, { room: true, model: "deepseek-flash" },
  { room: false, model: "gpt-6.1-sol" }, { room: true, model: "gpt-6.1-sol" },
])("reuses all four delivered file types without a partial warning (room=$room, model=$model)", async ({ room, model }) => {
  const gateway = await startFakeDoneBotGateway();
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true }, [], undefined, undefined, gateway.origin);
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, fixture.info.url) as Promise<any>;
  try {
    await api("/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-fixture-password" });
    const { bot: sender } = await cli("new-bot", "--name", "Editor", "--section", "Studio");
    const { bot: worker } = await cli("new-bot", "--name", "Artist", "--section", "Studio");
    const workerModel = model === "deepseek-flash" ? "gpt-6.1-sol" : "deepseek-flash";
    await cli("set-model", "--bot", worker.id, "--instance", "donebot", "--model", workerModel);
    await api(`/api/bots/${worker.id}`, { approvalMode: "full" }, "PATCH");
    await api(`/api/bots/${sender.id}`, { approvalMode: "full" }, "PATCH");
    await cli("set-model", "--bot", sender.id, "--instance", "donebot", "--model", model);
    const channel = room ? (await handleToolCall("create_channel", { name: "Editorial", member_ids: [sender.id, worker.id] },
      (path, options) => request(path, options, fixture.info.url)) as any).channel : undefined;
    const threadId = channel?.activeTaskId ?? sender.activeTaskId;
    const folder = join(fixture.info.dataDir, "workspaces", worker.id);
    mkdirSync(folder, { recursive: true });
    for (const asset of assets) writeFileSync(join(folder, asset.name), asset.bytes);
    gateway.setModelPlan(workerModel, assets.map(asset => ({ name: "attach_file", arguments: { path: join(folder, asset.name) } })),
      "All deliverables are attached.", "Unexpected extra execution");
    gateway.setModelPlan(model, [{ name: "coordinate_bots", arguments: { bot_ids: [worker.id], message: "Produce the four deliverables and return the files." } }],
      "Assigned", "Delivered the received files.", prompt => {
        expect(prompt).toContain("Delivery is complete; reply directly");
        const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
        try {
          const files = db.prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY at").all(threadId)
            .flatMap(row => JSON.parse(String(row.json)).attachments ?? []);
          expect(files).toHaveLength(4);
          return Array.from({ length: 3 }, () => files.map(file => ({ name: "attach_file", arguments: { path: file.path, name: `renamed-${file.name}` } }))).flat();
        } finally { db.close(); }
      });
    if (channel) await cli("send-channel", "--channel", channel.id, "--text", "@Editor Ask Artist for the four files.");
    else await cli("send", "--bot", sender.id, "--text", "Ask Artist for the four files.");
    const waited = channel ? await cli("wait", "--channel", channel.id, "--timeout", "30") : await cli("wait", "--bot", sender.id, "--timeout", "30");
    const { messages } = await api(`/api/threads/${threadId}/messages`);
    expect(waited.status, JSON.stringify({ waited, failed: messages.filter((message: any) => message.tool?.ok === false) })).toBe("settled");
    expect(messages.some((message: any) => message.tool?.ok === false)).toBe(false);
    expect(messages.some((message: any) => message.text === "Delivered the received files.")).toBe(true);
    const reused = messages.filter((message: any) => message.tool?.name === "agents_attach_file" && (!room || message.from?.botId === sender.id));
    expect(reused).toHaveLength(12);
    expect(reused.every((message: any) => message.tool.ok && message.tool.output.includes("Already attached"))).toBe(true);
    const files = messages.flatMap((message: any) => (message.attachments ?? []).map((file: any) => ({ message, file })));
    expect(files).toHaveLength(4);
    for (const asset of assets) {
      const { message, file } = files.find(({ file }: any) => file.mime === asset.mime);
      expect(file.name).toBe(asset.name);
      const response = await fetch(`${fixture.info.url}/api/threads/${threadId}/messages/${message.id}/file`, {
        method: "POST", headers: { origin: fixture.info.url, "content-type": "application/json" }, body: JSON.stringify({ path: file.path }),
      });
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(asset.bytes);
    }
    const children = readHandoffs(fixture.info.dataDir).filter(node => node.parentId);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ status: "completed", executions: 1 });
    expect(gateway.requests.filter(one => one.body.model === workerModel)).toHaveLength(5);
    const evidence = fileURLToPath(new URL("../.omb-scratch/verify-evidence/attachment-reuse/", import.meta.url));
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, `${model}-${room ? "room" : "direct"}.json`), JSON.stringify({ fixture: fixture.info, waited, messages, children }, null, 2));
  } finally { await fixture.close(); await gateway.close(); }
}, hostTimeout(90_000));
