import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { handleToolCall, request } from "../scripts/mcp-server.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const assets = [
  { name: "illustration.png", mime: "image/png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2Cj8AAAAASUVORK5CYII=", "base64") },
  { name: "film.mp4", mime: "video/mp4", bytes: Buffer.from("synthetic video bytes") },
  { name: "music.mp3", mime: "audio/mpeg", bytes: Buffer.from("synthetic music bytes") },
  { name: "brief.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF-1.4 synthetic document") },
];

it.each(["direct", "room-to-direct", "direct-to-room", "room-to-room", "same-room", "chain", "same-room-chain"])("returns every attachment type through %s coordination without a copy request", async kind => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, fixture.info.url) as Promise<any>;
  const tool = (name: string, args: Record<string, unknown>) => handleToolCall(name, args, (path, options) => request(path, options, fixture.info.url)) as Promise<any>;
  try {
    const { bot: sender } = await cli("new-bot", "--name", "Editor", "--section", "Studio");
    const { bot: worker } = await cli("new-bot", "--name", "Artist", "--section", "Studio");
    const { bot: helper } = await cli("new-bot", "--name", "Producer", "--section", "Studio");
    const sourceRoom = kind.startsWith("room") || kind.startsWith("same-room")
      ? (await tool("create_channel", { name: "Editorial", member_ids: kind.startsWith("same-room") ? [sender.id, worker.id] : [sender.id] })).channel : undefined;
    const targetRoom = kind.endsWith("to-room")
      ? (await tool("create_channel", { name: "Production", member_ids: [worker.id] })).channel : undefined;
    const maker = kind.endsWith("chain") ? helper : worker;
    const folder = join(fixture.info.dataDir, "workspaces", maker.id);
    mkdirSync(folder, { recursive: true });
    for (const asset of assets) writeFileSync(join(folder, asset.name), asset.bytes);
    const plan: Record<string, unknown> = {
      [sender.id]: { steps: [{ arguments: { bot_ids: [worker.id], message: "Produce the four requested deliverables and return the files.", ...(targetRoom ? { group_id: targetRoom.id } : {}) } }], reply: "Assigned", resumeReply: "Delivered the received files" },
      [worker.id]: { steps: assets.map(asset => ({ tool: "attach_file", arguments: { path: join(folder, asset.name) } })), reply: "All four deliverables are attached." },
    };
    if (kind.endsWith("chain")) {
      plan[worker.id] = { steps: [{ arguments: { bot_ids: [helper.id], message: "Produce the four requested deliverables and return the files." } }], reply: "Delegated", resumeReply: "Returning producer's deliverables." };
      plan[helper.id] = { steps: assets.map(asset => ({ tool: "attach_file", arguments: { path: join(folder, asset.name) } })), reply: "All four deliverables are attached." };
    }
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify(plan));
    const threadId = sourceRoom?.activeTaskId ?? sender.activeTaskId;
    if (sourceRoom) await cli("send-channel", "--channel", sourceRoom.id, "--text", "@Editor Produce the deliverables with Artist.");
    else await cli("send", "--bot", sender.id, "--text", "Produce the deliverables with Artist.");
    const waited = sourceRoom ? await cli("wait", "--channel", sourceRoom.id, "--timeout", "30") : await cli("wait", "--bot", sender.id, "--timeout", "30");
    expect(waited.status).toBe("settled");
    const messages = (await api(`/api/threads/${threadId}/messages`)).messages as any[];
    const files = messages.flatMap(message => (message.attachments ?? []).map((file: any) => ({ message, file })));
    expect(files.map(({ file }) => file.mime).sort()).toEqual(assets.map(asset => asset.mime).sort());
    for (const asset of assets) {
      const { message, file } = files.find(({ file }) => file.mime === asset.mime)!;
      const response = await fetch(`${fixture.info.url}/api/threads/${threadId}/messages/${message.id}/file`, {
        method: "POST", headers: { origin: fixture.info.url, "content-type": "application/json" }, body: JSON.stringify({ path: file.path }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(asset.mime);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(asset.bytes);
    }
    const nodes = readHandoffs(fixture.info.dataDir);
    expect(nodes.filter(node => node.parentId)).toHaveLength(kind.endsWith("chain") ? 2 : 1);
    expect(nodes.filter(node => node.parentId).every(node => node.executions === (kind.endsWith("chain") && node.botId === worker.id ? 2 : 1))).toBe(true);
    const evidence = readFileSync(join(fixture.info.dataDir, "room-plan.json.evidence.jsonl"), "utf8");
    expect(nodes.filter(node => node.parentId).map(node => ({ botId: node.botId, result: node.result }))).toEqual(expect.arrayContaining([expect.objectContaining({ result: expect.stringContaining("DoneBot returned attachments") })]));
    const turns = evidence.trim().split("\n").map(line => JSON.parse(line));
    expect(turns.filter(turn => turn.botId === sender.id && turn.resumed).map(turn => JSON.stringify(turn.prompt))).toEqual(expect.arrayContaining([expect.stringContaining("DoneBot returned attachments")]));
  } finally { await fixture.close(); }
}, hostTimeout(90_000));

it.each([false, true])("passes referenced attachments to another bot (room=%s) without returning its inputs twice", async room => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  try {
    const { bot: sender } = await cli("new-bot", "--name", "Writer", "--section", "Studio");
    const { bot: worker } = await cli("new-bot", "--name", "Reviewer", "--section", "Studio");
    const channel = room ? (await handleToolCall("create_channel", { name: "Review", member_ids: [worker.id] },
      (path, options) => request(path, options, fixture.info.url)) as any).channel : undefined;
    const folder = join(fixture.info.dataDir, "workspaces", sender.id);
    mkdirSync(folder, { recursive: true });
    for (const asset of assets) writeFileSync(join(folder, asset.name), asset.bytes);
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify({
      [sender.id]: { steps: [
        ...assets.map(asset => ({ tool: "attach_file", arguments: { path: join(folder, asset.name) } })),
        { arguments: { bot_ids: [worker.id], message: `Review these attached files: ${assets.map(asset => realpathSync(join(folder, asset.name))).join(", ")}`, ...(channel ? { group_id: channel.id } : {}) } },
      ], reply: "Review assigned", resumeReply: "Review received" },
      [worker.id]: { expectContextIncludes: ["DoneBot returned attachments", ...assets.map(asset => asset.mime)], reply: "Reviewed all four files." },
    }));
    await cli("send", "--bot", sender.id, "--text", "Send the four attached files to Reviewer for review.");
    expect((await cli("wait", "--bot", sender.id, "--timeout", "30")).status).toBe("settled");
    const child = readHandoffs(fixture.info.dataDir).find(node => node.parentId)!;
    expect(child.status, child.result).toBe("completed");
    expect(child.executions).toBe(1);
    for (const threadId of [sender.activeTaskId, child.threadId]) {
      const { messages } = await request(`/api/threads/${threadId}/messages`, {}, fixture.info.url) as any;
      const files = messages.flatMap((message: any) => (message.attachments ?? []).map((file: any) => ({ file, message })));
      expect(files.map(({ file }: any) => file.mime).sort()).toEqual(assets.map(asset => asset.mime).sort());
      for (const asset of assets) {
        const { file, message } = files.find(({ file }: any) => file.mime === asset.mime);
        const response = await fetch(`${fixture.info.url}/api/threads/${threadId}/messages/${message.id}/file`, {
          method: "POST", headers: { origin: fixture.info.url, "content-type": "application/json" }, body: JSON.stringify({ path: file.path }),
        });
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(asset.bytes);
      }
    }
  } finally { await fixture.close(); }
}, hostTimeout(60_000));

it.each([false, true])("carries image, video, audio and document attachments in a room post (source room=%s)", async sourceIsRoom => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const tool = (name: string, args: Record<string, unknown>) => handleToolCall(name, args, (path, options) => request(path, options, fixture.info.url)) as Promise<any>;
  try {
    const { bot: sender } = await cli("new-bot", "--name", "Publisher", "--section", "Studio");
    const { bot: reader } = await cli("new-bot", "--name", "Reader", "--section", "Studio");
    const target = (await tool("create_channel", { name: "Delivery", member_ids: [sender.id, reader.id] })).channel;
    const source = sourceIsRoom ? (await tool("create_channel", { name: "Production", member_ids: [sender.id] })).channel : undefined;
    const folder = join(fixture.info.dataDir, "workspaces", sender.id);
    mkdirSync(folder, { recursive: true });
    for (const asset of assets) writeFileSync(join(folder, asset.name), asset.bytes);
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify({
      [sender.id]: { steps: [
        ...assets.map(asset => ({ tool: "attach_file", arguments: { path: join(folder, asset.name) } })),
        { tool: "post_to_room", arguments: { group_id: target.id, message: `Deliverables: ${assets.map(asset => realpathSync(join(folder, asset.name))).join(", ")}` } },
      ], reply: "Posted deliverables" },
      [reader.id]: { expectContextIncludes: assets.map(asset => asset.name), reply: "All delivered files are visible in this room." },
    }));
    if (source) await cli("send-channel", "--channel", source.id, "--text", "@Publisher Post the deliverables to Delivery.");
    else await cli("send", "--bot", sender.id, "--text", "Post the deliverables to Delivery.");
    const waited = source ? await cli("wait", "--channel", source.id, "--timeout", "30") : await cli("wait", "--bot", sender.id, "--timeout", "30");
    expect(waited.status).toBe("settled");
    const { messages } = await request(`/api/threads/${target.activeTaskId}/messages`, {}, fixture.info.url) as any;
    const posted = messages.find((message: any) => message.peerPost);
    expect(posted?.attachments?.map((file: any) => file.mime).sort()).toEqual(assets.map(asset => asset.mime).sort());
    for (const asset of assets) {
      const file = posted.attachments.find((file: any) => file.mime === asset.mime);
      const response = await fetch(`${fixture.info.url}/api/threads/${target.activeTaskId}/messages/${posted.id}/file`, {
        method: "POST", headers: { origin: fixture.info.url, "content-type": "application/json" }, body: JSON.stringify({ path: file.path }),
      });
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(asset.bytes);
    }
    await cli("send-channel", "--channel", target.id, "--text", "@Reader Check the delivered files.");
    expect((await cli("wait", "--channel", target.id, "--timeout", "30")).status).toBe("settled");
    const readerTurns = readFileSync(join(fixture.info.dataDir, "room-plan.json.evidence.jsonl"), "utf8").trim().split("\n")
      .map(line => JSON.parse(line)).filter(turn => turn.botId === reader.id);
    expect(readerTurns).toHaveLength(1);
    const { messages: reviewed } = await request(`/api/threads/${target.activeTaskId}/messages`, {}, fixture.info.url) as any;
    expect(reviewed.some((message: any) => message.text === "All delivered files are visible in this room.")).toBe(true);
    expect(readHandoffs(fixture.info.dataDir).filter(node => node.parentId)).toHaveLength(0);
  } finally { await fixture.close(); }
}, hostTimeout(60_000));
