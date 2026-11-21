import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Audience } from "../audience.ts";
import type { CheckBackRecord } from "../host/check-backs.ts";
import { drainChannelMessages, queueChannelMessage, restoreChannelMessages } from "../channel-queue.ts";
import { useQueueProvenance } from "../queue-provenance.ts";
import { Runtime } from "../runtime/runtime.ts";
import { openRuntimeStore } from "../runtime/store.ts";
import type { Assignment, RunResult, TurnRunner } from "../runtime/types.ts";
import { drainSteeredMessages, queueSteeredMessage, restoreSteeredMessages, type SteerStore } from "../steer-queue.ts";
import type { BotRecord, Message } from "../store.ts";
import { TeamRequestStore, type TeamRequestBinding } from "./team-requests.ts";
import type { DoneBotTeamRuntime } from "./team-runtime.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "donebot-team-lineage-"));
  cleanups.push(() => rmSync(directory, { force: true, recursive: true }));
  const runtime = { team: { id: randomUUID(), name: "Fixture" }, instanceId: randomUUID() } as DoneBotTeamRuntime;
  const requests = new TeamRequestStore(directory, runtime);
  const actor = { userId: "3", memberVersion: 2, person: "member-three" };
  const bind = (sourceId = "source", audience: Audience = "team") => {
    const sender = requests.sender({ id: actor.person, name: "Member" }, actor);
    requests.captureMessage("source-thread", { id: sourceId, role: "user", kind: "text", text: "fixture", at: 1, sender });
    return requests.bind({ sourceId, botId: "chief", threadId: "source-thread", audience, generation: 1 });
  };
  return { directory, runtime, requests, actor, bind };
}

it("keeps delegation provenance durable and immutable, including duplicate work from later steps", () => {
  const fx = fixture(), binding = fx.bind();
  fx.requests.attachRun("root-run", binding.id);
  const work = { id: "child", botId: "builder", threadId: "child-thread" };
  fx.requests.handOn("root-run", work, "team");
  const child = fx.requests.forRun(work.id);
  expect(child).toMatchObject({ actor: fx.actor, parentId: binding.id, rootId: binding.id, botId: work.botId, threadId: work.threadId });
  const restarted = new TeamRequestStore(fx.directory, fx.runtime);
  const later = restarted.derive(binding.id, "step:2");
  restarted.attachRun("later-turn", later.id);
  restarted.handOn("later-turn", work, "team", true);
  expect(restarted.forRun(work.id)).toEqual(child);
  expect(() => restarted.handOn("later-turn", work, "team")).toThrow();
  for (const altered of [{ ...work, botId: "other" }, { ...work, threadId: "other" }]) {
    expect(() => restarted.handOn("root-run", altered, "team", true)).toThrow();
  }
  expect(() => restarted.handOn("root-run", work, "room:other", true)).toThrow();
  const unrelated = fx.bind("different-source");
  restarted.attachRun("unrelated-run", unrelated.id);
  expect(() => restarted.handOn("unrelated-run", work, "team", true)).toThrow();
  expect(() => restarted.attachRun(work.id, unrelated.id)).toThrow();
  expect(() => restarted.forRun("unknown-run")).toThrow();
});

it("prevents private or room contexts from widening their audience while retaining the original member", () => {
  const fx = fixture();
  const shared = fx.bind("shared"), privateBinding = fx.bind("private", "member:member-three"), room = fx.bind("room", "room:one");
  for (const [binding, allowed, denied] of [
    [shared, ["team", "room:one", "member:member-three"], ["member:other"]],
    [privateBinding, ["member:member-three"], ["team", "room:one", "member:other"]],
    [room, ["room:one", "member:member-three"], ["team", "room:two", "member:other"]],
  ] as const) {
    fx.requests.attachRun(binding.id, binding.id);
    for (const audience of allowed) {
      fx.requests.checkHandOn(binding.id, audience);
      expect(fx.requests.derive(binding.id, audience, { botId: "builder", threadId: "destination", audience }).actor).toEqual(fx.actor);
    }
    for (const audience of denied) {
      expect(() => fx.requests.checkHandOn(binding.id, audience)).toThrow();
      expect(() => fx.requests.derive(binding.id, audience, { botId: "builder", threadId: "destination", audience })).toThrow();
    }
  }
});

it("binds helpers to the exact original run and keeps each folded prefix independent after restart", () => {
  const fx = fixture(), parent = fx.bind("private", "member:member-three");
  fx.requests.attachRun("turn", parent.id);
  const input = { runId: "turn", botId: "chief", threadId: "source-thread", operation: "compaction:b3" };
  const helper = fx.requests.helper(input);
  expect(helper).toMatchObject({ botId: parent.botId, threadId: parent.threadId, ordinal: 0 });
  expect(helper.bindingId).not.toBe(parent.id);
  expect(fx.requests.binding(helper.bindingId)).toMatchObject({ actor: fx.actor, audience: parent.audience, parentId: parent.id, operation: "helper:compaction:b3" });
  const restarted = new TeamRequestStore(fx.directory, fx.runtime);
  expect(restarted.helper(input)).toEqual(helper);
  expect(restarted.helper({ ...input, operation: "compaction:b5" }).bindingId).not.toBe(helper.bindingId);
  for (const altered of [{ ...input, runId: "missing" }, { ...input, botId: "other" }, { ...input, threadId: "other" }]) {
    expect(() => restarted.helper(altered)).toThrow();
  }
  const next = restarted.derive(parent.id, "step:2");
  restarted.attachRun("next-turn", next.id);
  expect(restarted.helper({ ...input, runId: "next-turn" }).bindingId).not.toBe(helper.bindingId);
});

it("records an authenticated control action under its actual member without inheriting the last writer", () => {
  const fx = fixture();
  fx.bind();
  const actor = { userId: "4", memberVersion: 3, person: "member-four" };
  const sender = fx.requests.sender({ id: actor.person, name: "Other member" }, actor);
  fx.requests.captureAction("source-thread", "compact-action", sender);
  const binding = fx.requests.bind({ sourceId: "compact-action", botId: "chief", threadId: "source-thread", audience: "team", generation: 1 });
  expect(binding.actor).toEqual(actor);
  for (const unverified of [undefined, { ...sender }]) expect(() => fx.requests.captureAction("source-thread", "unverified-action", unverified)).toThrow();
  expect(() => fx.requests.captureAction("source-thread", "compact-action", fx.requests.sender({ id: fx.actor.person, name: "Original" }, fx.actor))).toThrow();
});

it("continues the exact dispatched operation once per event without changing its member or audience", () => {
  const fx = fixture(), root = fx.bind("private", "member:member-three");
  fx.requests.attachRun("native-turn", root.id);
  const input = { runId: "native-turn", botId: root.botId, threadId: root.threadId, audience: root.audience as Audience, generation: 1, operation: "computer-selection:browser" };
  const continued = fx.requests.continueRun(input);
  expect(continued).toMatchObject({ actor: fx.actor, audience: root.audience, parentId: root.id, operation: "continue:computer-selection:browser" });
  expect(continued.id).not.toBe(root.id);
  const restarted = new TeamRequestStore(fx.directory, fx.runtime);
  expect(restarted.continueRun(input)).toEqual(continued);
  for (const altered of [{ ...input, runId: "unknown" }, { ...input, botId: "other" }, { ...input, threadId: "other" }, { ...input, generation: 2 }, { ...input, audience: "team" as const }]) {
    expect(() => restarted.continueRun(altered)).toThrow();
  }
  fx.requests.attachRun("continued-turn", continued.id);
  expect(fx.requests.continueRun({ ...input, runId: "continued-turn" }).id).not.toBe(continued.id);
});

it("keeps goal retries stable across restart and gives each accepted step its own original-member operation", () => {
  const fx = fixture(), root = fx.bind("goal-source", "member:member-three");
  const input = { sourceId: root.sourceId, botId: root.botId, threadId: root.threadId, audience: root.audience as Audience, generation: 1,
    runId: "goal-fixture", step: 1 };
  const first = fx.requests.goalStep(input);
  expect(first).toMatchObject({ actor: fx.actor, parentId: root.id, rootId: root.id, audience: root.audience });
  expect(first.id).not.toBe(root.id);
  const requests = new TeamRequestStore(fx.directory, fx.runtime);
  const other = requests.sender({ id: "member-four", name: "Other" }, { userId: "4", memberVersion: 1, person: "member-four" });
  requests.captureMessage(root.threadId, { id: "latest", role: "user", kind: "text", text: "Other request", at: 2, sender: other });
  expect(requests.goalStep(input)).toEqual(first);
  const next = requests.goalStep({ ...input, step: 2 });
  const fresh = requests.goalStep({ ...input, runId: "other-goal" });
  expect(new Set([root.id, first.id, next.id, fresh.id]).size).toBe(4);
  expect(next.actor).toEqual(fx.actor);
  expect(() => requests.goalStep({ ...input, sourceId: "latest", audience: "team" })).toThrow();
  requests.captureMessage(root.threadId, { id: "unverified", role: "user", kind: "text", text: "Forged", at: 3, sender: { id: fx.actor.person, name: "Forged" } });
  for (const sourceId of ["", "missing", "unverified"]) expect(() => requests.goalStep({ ...input, sourceId })).toThrow();
  for (const step of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => requests.goalStep({ ...input, step })).toThrow();
  for (const changed of [{ runId: "" }, { runId: "x".repeat(201) }, { botId: "other" }, { threadId: "other" },
    { audience: "team" as const }, { audience: "member:member-four" as const }, { generation: 2 }]) {
    expect(() => requests.goalStep({ ...input, ...changed })).toThrow();
  }
  expect(requests.goalStep({ ...input, runId: "x".repeat(200) })).toMatchObject({ actor: fx.actor });
  const renewed = requests.sender({ id: fx.actor.person, name: "Renewed" }, { ...fx.actor, memberVersion: 3 });
  requests.captureAction(root.threadId, "renewed", renewed);
  expect(() => requests.goalStep({ ...input, sourceId: "renewed" })).toThrow();
  expect(() => requests.captureAction(root.threadId, root.sourceId, renewed)).toThrow();
});

it("saves exact check-back authority across restart without trusting the pending file or latest writer", () => {
  const fx = fixture(), parent = fx.bind("private", "member:member-three");
  fx.requests.attachRun("asking-turn", parent.id);
  const record: CheckBackRecord = { id: randomUUID(), botId: parent.botId, threadId: parent.threadId, note: "Check CI", condition: "CI still running",
    dueAt: 90_000, createdAt: 1, zone: "UTC", origin: { kind: "user", request: "Fix CI", person: fx.actor.person } };
  const input = { record, audience: parent.audience as Audience, generation: 1 };
  fx.requests.scheduleCheckBack({ ...input, runId: "asking-turn" });
  const bound = fx.requests.checkBack(input);
  expect(bound).toMatchObject({ actor: fx.actor, audience: parent.audience, parentId: parent.id });
  expect(bound.id).not.toBe(parent.id);
  const requests = new TeamRequestStore(fx.directory, fx.runtime);
  expect(requests.checkBack({ ...input, record: { ...record, lineMessageId: "line", tries: 2, startingAt: 91_000 } })).toEqual(bound);
  for (const changed of [{ id: randomUUID() }, { botId: "other" }, { threadId: "other" }, { note: "Other job" }, { condition: "Always" }, { dueAt: 95_000 },
    { createdAt: 2 }, { zone: "Asia/Shanghai" }, { origin: { ...record.origin, request: "Different request" } }]) {
    expect(() => requests.checkBack({ ...input, record: { ...record, ...changed } })).toThrow();
  }
  for (const changed of [{ audience: "team" as const }, { generation: 2 }]) expect(() => requests.checkBack({ ...input, ...changed })).toThrow();
  for (const changed of [{ runId: "missing" }, { audience: "team" as const }, { generation: 2 }, { record: { ...record, origin: { kind: "outside" as const } } },
    { record: { ...record, origin: { kind: "user" as const, request: "CI", person: "other-member" } } }]) {
    expect(() => requests.scheduleCheckBack({ ...input, runId: "asking-turn", ...changed })).toThrow();
  }
  requests.attachRun("woken-turn", bound.id);
  const next = { ...record, id: randomUUID(), createdAt: 91_000, dueAt: 180_000 };
  requests.scheduleCheckBack({ ...input, record: next, runId: "woken-turn" });
  expect(requests.checkBack({ ...input, record: next })).toMatchObject({ actor: fx.actor, parentId: bound.id });
  expect(() => requests.scheduleCheckBack({ ...input, runId: "woken-turn" })).toThrow();
  expect(requests.checkBack(input)).toEqual(bound);
});

it.each(["direct", "room"] as const)("captures %s queued members before persistence and keeps permission versions separate after restart", async kind => {
  const fx = fixture();
  let requests = fx.requests;
  useQueueProvenance({ capture: (threadId, queueId, sender) => requests.captureQueue(threadId, queueId, sender), identity: (threadId, queueId) => requests.queueIdentity(threadId, queueId) });
  cleanups.push(() => useQueueProvenance(undefined));
  const sender = requests.sender({ id: fx.actor.person, name: "Member" }, fx.actor);
  const renewed = requests.sender({ ...sender, name: "Renamed" }, { ...fx.actor, memberVersion: 3 });
  const otherActor = { userId: "4", memberVersion: 1, person: "member-four" };
  const other = requests.sender({ id: otherActor.person, name: "Other" }, otherActor);
  const rows: Message[] = [];
  const store: SteerStore = {
    bot: () => ({ id: "chief", busy: false } as BotRecord), patchMessage: () => null,
    appendMessage: (threadId, input) => {
      const message = { ...input, id: randomUUID(), at: Date.now() };
      rows.push(message); requests.captureMessage(threadId, message); return message;
    },
  };
  for (const [index, person] of [sender, sender, renewed, other, { ...sender }].entries()) {
    if (kind === "direct") queueSteeredMessage("chief", "source-thread", `line ${index}`, { sender: person });
    else queueChannelMessage("room", "source-thread", `line ${index}`, { sender: person });
  }
  requests = new TeamRequestStore(fx.directory, fx.runtime);
  if (kind === "direct") restoreSteeredMessages(); else restoreChannelMessages();
  const groups: Array<{ count: number; actor?: TeamRequestBinding["actor"] }> = [];
  const bind = (last: Message, sourceIds: string[], count: number) => {
    try {
      const binding = requests.bind({ sourceId: last.id, sourceIds, botId: "chief", threadId: "source-thread", audience: kind === "room" ? "room:room" : "team", generation: 1 });
      groups.push({ count, actor: binding.actor });
    } catch { groups.push({ count }); }
  };
  for (let index = 0; index < 4; index++) {
    if (kind === "direct") drainSteeredMessages(store, (_bot, _thread, _prompt, last, ids) => bind(last, ids, ids.length));
    else drainChannelMessages(() => false, ({ threadId, items }) => {
      const messages = items.map(item => store.appendMessage(threadId, { role: "user", kind: "text", text: item.text, sender: item.sender, queueId: item.id }));
      bind(messages.at(-1)!, items.map(item => item.id), items.length);
    });
    await flush();
  }
  expect(groups).toEqual([{ count: 2, actor: fx.actor }, { count: 1, actor: { ...fx.actor, memberVersion: 3 } }, { count: 1, actor: otherActor }, { count: 1 }]);
  expect(rows).toHaveLength(5);
  expect(rows.map(message => message.text)).toEqual(["line 0", "line 1", "line 2", "line 3", "line 4"]);
});

it("reuses a crashed model step through real coordinator recovery and separates answered, continued and resumed steps", async () => {
  const fx = fixture(), rootBinding = fx.bind();
  const turns: Array<{ node: Assignment; binding: TeamRequestBinding }> = [];
  const held = new Map<string, (value: RunResult) => void>();
  const boot = () => {
    const requests = new TeamRequestStore(fx.directory, fx.runtime);
    const store = openRuntimeStore(join(fx.directory, "runtime.db"));
    const runner: TurnRunner = {
      canStart: () => true, validate: () => undefined, park: () => {}, report: () => {}, changed: () => {},
      names: node => ({ requester: "Member", assignee: node.assignee.botId }),
      run: node => {
        const binding = requests.coordinated({ id: node.id, botId: node.assignee.botId, threadId: node.assignee.destination.threadId,
          audience: "team", generation: 1, executions: node.executions, restarts: node.restarts });
        turns.push({ node, binding });
        return new Promise<RunResult>(resolve => held.set(node.id, resolve));
      },
    };
    const runtime = new Runtime(store, runner);
    runtime.open();
    cleanups.push(() => { runtime.close(); store.close(); });
    return { requests, store, runtime, close: () => { cleanups.pop()!(); } };
  };
  const first = boot();
  const root = first.runtime.begin({ id: "root-run", origin: { kind: "person", source: "chat" }, requester: { kind: "person", threadId: "source-thread", chief: true },
    assignee: { botId: "chief", destination: { kind: "standing_thread", threadId: "source-thread" } }, brief: "Build", level: "ask" });
  first.requests.attachRun(root.id, rootBinding.id);
  const queued = first.runtime.enqueue({ parentId: root.id, origin: root.origin, requester: { kind: "bot_turn", botId: "chief", threadId: "source-thread", chief: true },
    assignee: { botId: "builder", destination: { kind: "work_thread", threadId: "child-thread" } }, brief: "Build", levels: { own: "ask" } });
  if (!queued.ok) throw new Error(queued.reason);
  const work = { id: queued.assignment.id, botId: "builder", threadId: "child-thread" };
  first.requests.handOn(root.id, work, "team");
  first.runtime.tick();
  const original = turns.at(-1)!;
  expect(original.node).toMatchObject({ id: work.id, executions: 1, restarts: 0 });
  first.close();
  const second = boot();
  second.runtime.tick();
  expect(turns.at(-1)).toMatchObject({ node: { id: work.id, executions: 2, restarts: 1 }, binding: original.binding });
  held.get(work.id)!({ kind: "needs_input", question: "Which region?" });
  await flush();
  expect(second.runtime.answer(work.id, "EU")).toBe(true);
  second.runtime.tick();
  const answered = turns.at(-1)!;
  expect(answered.node).toMatchObject({ id: work.id, executions: 3, restarts: 1 });
  expect(answered.binding.id).not.toBe(original.binding.id);
  expect(answered.binding.actor).toEqual(fx.actor);
  held.get(work.id)!({ kind: "continue", text: "Partial", note: "Finish" });
  await flush();
  second.runtime.tick();
  const continued = turns.at(-1)!;
  expect(continued.node).toMatchObject({ id: work.id, executions: 4, restarts: 1 });
  expect(continued.binding.id).not.toBe(answered.binding.id);
  second.close();
  const third = boot();
  third.runtime.tick();
  expect(turns.at(-1)).toMatchObject({ node: { id: work.id, executions: 5, restarts: 2 }, binding: continued.binding });
  held.get(work.id)!({ kind: "completed", text: "Built" });
  await flush();
  third.runtime.tick();
  expect(turns.at(-1)).toMatchObject({ node: { id: root.id, executions: 2, restarts: 0 }, binding: { actor: fx.actor, operation: "step:2", parentId: rootBinding.id } });
  expect(turns.at(-1)!.binding.id).not.toBe(rootBinding.id);
  held.get(root.id)!({ kind: "completed", text: "Done" });
  await flush();
  expect(third.store.get(root.id)).toMatchObject({ status: "completed" });
  const node = { id: work.id, botId: "builder", threadId: "child-thread", audience: "team" as const, generation: 1, executions: 5, restarts: 2 };
  for (const altered of [{ ...node, botId: "other" }, { ...node, threadId: "other" }, { ...node, audience: "member:member-three" as const },
    { ...node, generation: 2 }, { ...node, executions: 0 }, { ...node, restarts: 5 }]) {
    expect(() => third.requests.coordinated(altered)).toThrow();
  }
});
