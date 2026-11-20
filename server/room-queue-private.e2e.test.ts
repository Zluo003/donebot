import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchCloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

it("keeps another member's busy conversation out of room lists, HTTP responses and live or replayed events", async () => {
  const fx = await launchCloudSendFixture({ team: {
    id: "team-queue-private", name: "Queue fixture",
    engine: 'process.env.FAKE_CLAUDE_ROOM_PLAN = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/plan.json";',
  } });
  const team = fx.team!;
  const streams: SseRecorder[] = [];
  const gate = join(team.home, "worker.gate");
  try {
    const tokens: string[] = [];
    for (const [email, role] of [["owner@queue.test", "owner"], ["admin@queue.test", "admin"], ["member@queue.test", "member"], ["bob@queue.test", "member"]] as const) {
      tokens.push((await team.pair({ email, role })).token!);
    }
    const [owner, , , bob] = tokens;
    const lead = (await team.as(owner!, "POST", "/api/bots", { name: "Lead" })).body.bot;
    const worker = (await team.as(owner!, "POST", "/api/bots", { name: "Worker" })).body.bot;
    const created = await team.as(owner!, "POST", "/api/groups", {
      name: "Studio", memberIds: [lead.id, worker.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const room = created.body.group;
    const opened = await team.as(bob!, "POST", `/api/bots/${worker.id}/tasks`, { title: "Private queue fixture" });
    expect(opened.status).toBe(201);
    const privateThread = opened.body.task.threadId;
    const ready = join(team.home, "worker.ready");
    writeFileSync(join(team.home, "plan.json"), JSON.stringify({
      [lead.id]: { steps: [{ arguments: { bot_ids: [worker.id], message: "Cut the trailer" } }], reply: "Assigned", resumeReply: "Reviewed" },
      [worker.id]: { reply: "Done here", gateFile: gate, readyFile: ready },
    }));
    const cursors: string[] = [];
    for (const token of tokens) {
      const stream = await openSse(`${team.base}/api/events`, { ...fx.edge, authorization: `Bearer ${token}` });
      streams.push(stream);
      cursors.push((await stream.until(frame => frame.kind === "hello")).cursor);
    }
    expect((await team.as(bob!, "POST", `/api/bots/${worker.id}/messages`, { threadId: privateThread, text: "Private work" })).status).toBe(202);
    await expect.poll(() => existsSync(ready), { timeout: 30_000 }).toBe(true);
    expect((await team.as(owner!, "POST", `/api/groups/${room.id}/messages`, { text: "@Lead Delegate the cut", threadId: room.threadId })).status).toBe(202);
    const queued = (frame: any) => frame.kind === "group" && frame.group?.id === room.id && frame.group.queue?.some((entry: any) => entry.botId === worker.id && entry.state === "queued");
    for (const [index, token] of tokens.entries()) {
      const frame = await streams[index]!.until(queued, 30_000);
      const entry = frame.group.queue.find((item: any) => item.botId === worker.id);
      const expected = index === 3 ? { busyIn: { threadId: privateThread } } : { busyElsewhere: true };
      expect(entry).toMatchObject(expected);
      if (index !== 3) {
        expect(entry).not.toHaveProperty("busyIn");
        expect(JSON.stringify(streams[index]!.frames)).not.toContain(privateThread);
      }
      for (const path of ["/api/bots?messages=0"]) {
        const result = await team.as(token, "GET", path);
        expect(result.status, path).toBe(200);
        const group = result.body.groups.find((item: any) => item.id === room.id);
        expect(group.queue.find((item: any) => item.botId === worker.id)).toMatchObject(expected);
        if (index !== 3) expect(JSON.stringify(result.body)).not.toContain(privateThread);
      }
      const replay = await openSse(`${team.base}/api/events`, { ...fx.edge, authorization: `Bearer ${token}`, "last-event-id": cursors[index]! });
      streams.push(replay);
      expect((await replay.until(frame => frame.kind === "hello")).resumed).toBe(true);
      expect((await replay.until(queued)).group.queue.find((item: any) => item.botId === worker.id)).toMatchObject(expected);
      if (index !== 3) expect(JSON.stringify(replay.frames)).not.toContain(privateThread);
    }
    writeFileSync(gate, "release");
    await streams[0]!.until(frame => frame.kind === "group" && frame.group?.id === room.id && frame.group.queue?.length === 0, 30_000);
  } finally {
    writeFileSync(gate, "release");
    for (const stream of streams) stream.close();
    await fx.close();
  }
}, 120_000);
