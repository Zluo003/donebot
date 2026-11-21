import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { flushDecisionLog, readDecisions } from "../decision-log.ts";
import { UNDO_STALE } from "../direct-apply.ts";
import type { AppConfig } from "../config.ts";
import type { BotRecord, Message } from "../store.ts";
import { createAppSettings, WRITE_BUDGET, type Turn } from "./host.ts";
import { createSettingsRegistry, routeBackedRegistry } from "./registry.ts";
import { PASS } from "../routes/table.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) { await flushDecisionLog(dir); rmSync(dir, { recursive: true, force: true }); }
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "donebot-settings-")); dirs.push(dataDir);
  const cfg = { language: "en", rooms: { turnTimeoutMinutes: 30 }, mcp: {}, computerName: "Studio", threads: { maxConcurrentPerBot: 3 }, openai: { key: "never-return-secret" } } as AppConfig;
  const bot = { id: "kiwi", name: "Kiwi", color: "green" } as BotRecord;
  const messages: Array<Message & { threadId: string }> = [];
  const state = { active: true, owner: "owner" as string | null, guest: false, person: true, group: false, refuse: false };
  let gate: Promise<void> | undefined;
  const patches: Record<string, unknown>[] = [];
  const entries = createSettingsRegistry({ cfg: () => cfg, saveConfig: async (patch, check) => {
    await gate;
    check();
    if (state.refuse) return "fixture save refused";
    patches.push(patch);
    Object.assign(cfg, patch);
    return null;
  } });
  const deps = { store: {
    appendMessage: (threadId: string, input: unknown) => { const message = { ...input as object, threadId, id: `m${messages.length}` } as unknown as Message & { threadId: string }; messages.push(message); return message; },
    bot: (id: string) => id === bot.id ? bot : null,
    messagesFor: (threadId: string) => messages.filter(message => message.threadId === threadId),
    patchMessage: (_threadId: string, id: string, patch: unknown) => { Object.assign(messages.find(message => message.id === id)!, patch); return null; },
  }, dataDir, entries, turnOwner: () => state.owner, guestDriven: () => state.guest, connectorThread: () => state.group ? { group: {} as never } : null,
    language: () => "zh", active: () => state.active, personAsked: () => state.person };
  let host = createAppSettings(deps);
  const turn: Turn = { botId: bot.id, threadId: "thread", generation: "generation" };
  return { cfg, state, messages, patches, entries, dataDir, turn, handle: (body: unknown, one = turn) => host.handle(body, one),
    undo: (requestId = messages.at(-1)!.card!.requestId!, allowed = () => true) => host.undo({ threadId: turn.threadId, requestId, allowed }),
    block: () => { let release!: () => void; gate = new Promise<void>(resolve => { release = resolve; }); return release; },
    restart: () => { host = createAppSettings(deps); },
  };
}
const rename = (value: string) => ({ action: "set", id: "general.deviceName", value });

it("finds Unicode settings, reports real locations and returns only whitelisted values", async () => {
  const fx = fixture();
  const found = await fx.handle({ action: "find", query: "设备名称" });
  expect(JSON.parse(String(found.body.text))).toMatchObject([{ id: "general.deviceName", value: "Studio", scope: "workspace" }]);
  expect(String((await fx.handle({ action: "get", id: "mcp.callTimeoutMinutes" })).body.text)).toContain("More settings → Limits");
  expect(String((await fx.handle({ action: "places", query: "价格" })).body.text)).toContain("Models & pricing");
  const listing = JSON.stringify(await Promise.all(fx.entries.map(entry => fx.handle({ action: "get", id: entry.id }))));
  expect(listing).not.toContain("never-return-secret");
  expect((await fx.handle({ action: "get", id: "openai.key" })).status).toBe(404);
  expect((await fx.handle({ action: "set", id: "models.pricing", value: "free" })).status).toBe(403);
  expect(fx.patches).toHaveLength(0);
});

it.each([null, [], {}, { action: "set", id: "general.deviceName", value: 3 }, { ...rename("A"), botId: "kiwi" },
  { ...rename("A"), scope: "team" }, { action: "get", id: "general.language", value: "en" }, { action: "find", query: "x".repeat(201) },
  { action: "set", id: "general.deviceName" }])("rejects malformed and extra request fields: %j", async input => {
  const fx = fixture();
  expect((await fx.handle(input)).status).toBe(400);
  expect(fx.patches).toHaveLength(0); expect(fx.messages).toHaveLength(0);
});

it.each(["team", "guest", "automation", "ended"])("keeps %s turns from writing even if the bot has Full access", async kind => {
  const fx = fixture();
  if (kind === "team") fx.state.owner = null;
  if (kind === "guest") fx.state.guest = true;
  if (kind === "automation") fx.state.person = false;
  if (kind === "ended") fx.state.active = false;
  expect((await fx.handle(rename("Do not save"))).status).toBe(kind === "ended" ? 401 : 403);
  expect(fx.patches).toHaveLength(0); expect(fx.messages).toHaveLength(0);
  if (kind !== "ended") expect((await fx.handle({ action: "get", id: "general.deviceName" })).status).toBe(200);
});

it("serializes two changes with exact receipts, stale Undo and one successful restore", async () => {
  const fx = fixture(); fx.state.group = true;
  const release = fx.block();
  const first = fx.handle(rename("First")), second = fx.handle(rename("Second"));
  release();
  expect((await first).status).toBe(200); expect((await second).status).toBe(200);
  const [a, b] = fx.messages;
  expect(a!.from).toMatchObject({ botId: "kiwi" });
  expect(a!.card).toMatchObject({ autoApplied: true, answered: "allow", appSettingRequest: { before: "Studio", after: "First" } });
  expect(b!.card?.appSettingRequest).toMatchObject({ before: "First", after: "Second" });
  expect(await fx.undo(a!.card!.requestId)).toMatchObject({ state: "invalid", stale: true });
  expect(await fx.undo(b!.card!.requestId, () => false)).toMatchObject({ state: "invalid", status: 403 });
  const results = await Promise.all([fx.undo(), fx.undo()]);
  expect(results.map(result => "state" in result ? result.state : "unclaimed")).toEqual(["undone", "already_undone"]);
  expect(fx.cfg.computerName).toBe("First");
  expect(await fx.undo(a!.card!.requestId)).toMatchObject({ state: "undone" });
  expect(fx.cfg.computerName).toBe("Studio");
  await flushDecisionLog(fx.dataDir);
  expect(readDecisions(fx.dataDir, 10)).toMatchObject([{ source: "app-settings", summary: "general.deviceName: Studio → First" }, { source: "app-settings", summary: "general.deviceName: First → Second" }]);
});

it.each(["ended", "revoked", "external-edit"])("revalidates at commit after awaiting storage: %s", async kind => {
  const fx = fixture(), release = fx.block();
  const first = fx.handle(rename("No")), queued = fx.handle(rename("Neither"));
  await Promise.resolve(); await Promise.resolve();
  if (kind === "ended") fx.state.active = false;
  if (kind === "revoked") fx.state.owner = null;
  if (kind === "external-edit") fx.cfg.computerName = "From Settings";
  release();
  expect((await first).status).toBe(409);
  if (kind !== "external-edit") {
    expect((await queued).status).toBe(kind === "ended" ? 401 : 403);
    expect(fx.patches).toHaveLength(0);
  } else {
    expect((await queued).status).toBe(200);
    expect(fx.messages[0]!.card!.appSettingRequest?.before).toBe("From Settings");
  }
});

it("preserves later manual edits during Undo, including edits while storage awaits", async () => {
  const fx = fixture(); await fx.handle(rename("Requested"));
  const release = fx.block(), undo = fx.undo();
  await Promise.resolve(); await Promise.resolve();
  fx.cfg.computerName = "Manual";
  release();
  expect(await undo).toMatchObject({ state: "invalid", error: UNDO_STALE, stale: true });
  expect(fx.cfg.computerName).toBe("Manual"); expect(fx.messages[0]!.card!.undone).toBeUndefined();
});

it("validates native values, caps each turn and issues no success card for failed persistence", async () => {
  const fx = fixture();
  expect((await fx.handle({ action: "set", id: "rooms.turnTimeoutMinutes", value: "45" })).status).toBe(200);
  expect(fx.cfg.rooms?.turnTimeoutMinutes).toBe(45);
  expect((await fx.handle({ action: "set", id: "rooms.turnTimeoutMinutes", value: "0" })).status).toBe(400);
  expect((await fx.handle(rename("x".repeat(64)))).status).toBe(400);
  for (let index = 1; index < WRITE_BUDGET; index++) expect((await fx.handle(rename(`Name ${index}`))).status).toBe(200);
  expect((await fx.handle(rename("Overflow"))).status).toBe(429);
  fx.state.refuse = true;
  expect((await fx.handle(rename("Refused"), { ...fx.turn, generation: "next" })).status).toBe(409);
  expect(fx.messages).toHaveLength(WRITE_BUDGET);
});

it("preserves receipts on restart and refuses Undo without an in-memory restore snapshot", async () => {
  const fx = fixture(); await fx.handle(rename("Saved")); fx.restart();
  expect((await fx.handle({ action: "get", id: "general.deviceName" })).body.text).toContain("Saved");
  expect(await fx.undo()).toMatchObject({ state: "invalid", status: 409 });
  expect(fx.cfg.computerName).toBe("Saved");
});

it("passes the same commit guard into the real configuration route adapter", async () => {
  let committed = 0, active = true;
  const cfg = { computerName: "Before" } as AppConfig;
  const entries = routeBackedRegistry(() => cfg, async ctx => {
    if (ctx.path !== "/api/config") return PASS;
    expect(ctx.auth).toEqual({ kind: "loopback", scopes: ["admin", "client"] });
    const patch = await ctx.readBody(ctx.req);
    active = false;
    ctx.assertMutationAllowed?.();
    committed++; Object.assign(cfg, patch);
    ctx.json(ctx.res, 200, {});
  });
  const entry = entries.find(one => one.id === "general.deviceName")!;
  expect(entry.tier).toBe("safe");
  if (entry.tier !== "safe") throw new Error("missing writable entry");
  expect(await entry.write("After", () => { if (!active) throw new Error("ended before commit"); })).toBe("ended before commit");
  expect(committed).toBe(0); expect(cfg.computerName).toBe("Before");
});
