import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";

let fixture: VerificationServer;
const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
};
const ok = async (method: string, path: string, body?: unknown) => {
  const answer = await call(method, path, body);
  expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
  return answer.body;
};
const newBot = async (name: string) => (await runControlOmb(["new-bot", "--name", name, "--url", fixture.info.url]) as { bot: { id: string; activeTaskId: string } }).bot;
const send = (bot: { id: string; activeTaskId: string }, text: string) => call("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.activeTaskId, sendId: randomUUID() });
const busy = async (botId: string) => ((await ok("GET", "/api/bots")).bots as Array<{ id: string; tasks?: Array<{ busy?: boolean }> }>)
  .find((bot) => bot.id === botId)?.tasks?.some((task) => task.busy) === true;

beforeAll(async () => { fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang" }); }, 120_000);
afterAll(async () => { await fixture?.close(); });

it("pausing a bot stops its running work and refuses new work until it is resumed", async () => {
  const ada = await newBot("Ada");
  expect((await send(ada, "Start a long job.")).status).toBeLessThan(300);
  await expect.poll(() => busy(ada.id), { timeout: 20_000 }).toBe(true);

  expect(await ok("POST", "/api/paused", { kind: "bot", id: ada.id, paused: true })).toMatchObject({ bots: [ada.id], heldBots: [ada.id], stopped: 1 });
  await expect.poll(() => busy(ada.id), { timeout: 20_000 }).toBe(false);
  expect((await ok("GET", "/api/config")).heldBots).toEqual([ada.id]);

  const refused = await send(ada, "One more thing.");
  expect(refused.status).toBe(409);
  expect(refused.body).toMatchObject({ code: "bot_held" });
  expect(JSON.stringify(refused.body)).toContain("Ada is paused");

  expect(await ok("POST", "/api/paused", { kind: "bot", id: ada.id, paused: false })).toMatchObject({ bots: [], heldBots: [], stopped: 0 });
  expect((await send(ada, "Carry on.")).status).toBeLessThan(300);
  await expect.poll(() => busy(ada.id), { timeout: 20_000 }).toBe(true);
}, 120_000);

it("pausing a department pauses its bots, keeps the pause through a rename, and leaves other bots working", async () => {
  const bo = await newBot("Bo");
  const cy = await newBot("Cy");
  await ok("POST", "/api/sidebar-sections", { name: "Sales", botIds: [bo.id] });
  expect(await ok("POST", "/api/paused", { kind: "department", id: "Sales", paused: true })).toMatchObject({ departments: ["Sales"], heldBots: expect.arrayContaining([bo.id]) });
  const refused = await send(bo, "Hello.");
  expect(refused.status).toBe(409);
  expect(JSON.stringify(refused.body)).toContain("Sales department");
  expect((await send(cy, "Hello.")).status).toBeLessThan(300);

  await ok("PATCH", "/api/sidebar-sections?section=Sales", { name: "Revenue" });
  expect(await ok("GET", "/api/paused")).toMatchObject({ departments: ["Revenue"], heldBots: expect.arrayContaining([bo.id]) });
  expect((await send(bo, "Still there?")).status).toBe(409);

  await ok("POST", "/api/paused", { kind: "department", id: "Revenue", paused: false });
  expect((await send(bo, "Back to work.")).status).toBeLessThan(300);
  expect((await call("POST", "/api/paused", { kind: "department", id: "Nowhere", paused: true })).status).toBe(404);
}, 120_000);


it("pauses all existing and new bots and resumes without clearing a department pause", async () => {
  await ok("POST", "/api/paused", { kind: "department", id: "Revenue", paused: true });
  const running = ((await ok("GET", "/api/bots")).bots as Array<{ id: string }>).map((bot) => bot.id);
  const paused = await ok("POST", "/api/paused", { kind: "all", paused: true });
  expect(paused).toMatchObject({ all: true, departments: ["Revenue"], heldBots: expect.arrayContaining(running) });
  for (const id of running) await expect.poll(() => busy(id), { timeout: 20_000 }).toBe(false);
  const ed = await newBot("Ed");
  expect((await send(ed, "Wait while everyone is paused.")).body.code).toBe("bot_held");
  expect((await ok("GET", "/api/paused")).heldBots).toContain(ed.id);
  const resumed = await ok("POST", "/api/paused", { kind: "all", paused: false });
  expect(resumed).not.toHaveProperty("all");
  expect(resumed.departments).toEqual(["Revenue"]);
  expect((await send(ed, "Continue.")).status).toBeLessThan(300);
  await expect.poll(() => busy(ed.id), { timeout: 20_000 }).toBe(true);
  expect((await ok("POST", "/api/turns/stop", { all: true })).stopped).toBeGreaterThan(0);
  await expect.poll(() => busy(ed.id), { timeout: 20_000 }).toBe(false);
  expect((await ok("GET", "/api/paused")).departments).toEqual(["Revenue"]);
}, 120_000);


it("interrupts a paused bot in a room and refuses its next room turn", async () => {
  const roomBot = await newBot("Room worker");
  const { group } = await ok("POST", "/api/groups", { name: "Pause fixture", memberIds: [roomBot.id] });
  await ok("PATCH", `/api/groups/${group.id}/setup`, { action: "skip" });
  await runControlOmb(["send-channel", "--channel", group.id, "--text", "Do a long job.", "--url", fixture.info.url]);
  const roomBusy = async () => ((await ok("GET", "/api/bots")).groups as Array<{ id: string; busyBotId?: string | null }>).find((one) => one.id === group.id)?.busyBotId;
  await expect.poll(roomBusy, { timeout: 20_000 }).toBe(roomBot.id);
  expect((await ok("POST", "/api/paused", { kind: "bot", id: roomBot.id, paused: true })).stopped).toBe(1);
  await expect.poll(roomBusy, { timeout: 20_000 }).not.toBe(roomBot.id);
  await runControlOmb(["send-channel", "--channel", group.id, "--text", "Still paused?", "--url", fixture.info.url]);
  expect(await roomBusy()).not.toBe(roomBot.id);
  await ok("POST", "/api/paused", { kind: "bot", id: roomBot.id, paused: false });
  await runControlOmb(["send-channel", "--channel", group.id, "--text", "Continue in the room.", "--url", fixture.info.url]);
  await expect.poll(roomBusy, { timeout: 20_000 }).toBe(roomBot.id);
  await ok("POST", "/api/turns/stop", { botIds: [roomBot.id] });
  await expect.poll(roomBusy, { timeout: 20_000 }).not.toBe(roomBot.id);
}, 120_000);
