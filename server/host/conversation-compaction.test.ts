import { describe, expect, it } from "vitest";
import { compactBudget } from "../context-budget.ts";
import type { BotRecord, Message } from "../store.ts";
import { claudeCompactionDisabled, createConversationCompaction, foldBackstop, foldDue, type ConversationCompactionDeps } from "./conversation-compaction.ts";

describe("foldBackstop", () => {
  it("sits above where each engine compacts by itself and below its limit", () => {
    // Claude Code with --autocompact 200000 compacts near 167k; with its own window on a 1M model, near 967k.
    expect(foldBackstop(200_000, 200_000)).toBe(190_000);
    expect(foldBackstop(1_000_000, 200_000)).toBe(190_000);
    expect(foldBackstop(1_000_000)).toBe(990_000);
    expect(foldBackstop(200_000, 100_000)).toBe(95_000);
    // Codex compacts at 90% of the window it reports.
    expect(foldBackstop(272_000)).toBeGreaterThan(272_000 * 0.9);
    expect(foldBackstop(272_000)).toBeLessThan(272_000);
    expect(foldBackstop(8_000)).toBe(7_600);
  });
});

describe("foldDue", () => {
  const claude = { engineCompacts: true, estimatedBytes: 0, window: 200_000, nativeCompactAt: 200_000 };

  it("leaves a self-compacting engine's session alone below the backstop, where the fold used to run first", () => {
    expect(compactBudget(200_000, undefined, 200_000)).toBe(160_000);
    for (const contextTokens of [160_000, 164_274, 170_000, 189_999]) expect(foldDue({ ...claude, contextTokens })).toBe(false);
  });

  it("folds a session its engine left uncompacted", () => {
    expect(foldDue({ ...claude, contextTokens: 190_000 })).toBe(true);
    expect(foldDue({ engineCompacts: true, estimatedBytes: 0, window: 1_000_000, contextTokens: 989_999 })).toBe(false);
    expect(foldDue({ engineCompacts: true, estimatedBytes: 0, window: 1_000_000, contextTokens: 990_000 })).toBe(true);
  });

  it("never folds a self-compacting engine's session on a transcript estimate, which is not what its session holds", () => {
    expect(foldDue({ ...claude, estimatedBytes: 4_000_000 })).toBe(false);
    expect(foldDue({ ...claude, estimatedBytes: 4_000_000, idleFraction: 0.85 })).toBe(false);
  });

  it("keeps the fold where it was for an engine that does not compact itself", () => {
    const fed = { engineCompacts: false, estimatedBytes: 0, window: 200_000 };
    expect(foldDue({ ...fed, contextTokens: 159_999 })).toBe(false);
    expect(foldDue({ ...fed, contextTokens: 160_000 })).toBe(true);
    expect(foldDue({ ...fed, estimatedBytes: 640_000 })).toBe(true);
    expect(foldDue({ ...fed, contextTokens: 136_000, idleFraction: 0.85 })).toBe(true);
    expect(foldDue({ ...fed, contextTokens: 135_999, idleFraction: 0.85 })).toBe(false);
  });

  it("keeps the fold where it was for Claude Code with its own compaction switched off", () => {
    expect(foldDue({ engineCompacts: false, estimatedBytes: 0, window: 200_000, nativeCompactAt: 200_000, contextTokens: 160_000 })).toBe(true);
  });

  it("honours a compactAt the person set, for every engine", () => {
    expect(foldDue({ ...claude, configuredCompactAt: 0.5, contextTokens: 99_999 })).toBe(false);
    expect(foldDue({ ...claude, configuredCompactAt: 0.5, contextTokens: 100_000 })).toBe(true);
    expect(foldDue({ ...claude, configuredCompactAt: 120_000, contextTokens: 120_000 })).toBe(true);
    // Still never past the engine's own point.
    expect(foldDue({ ...claude, configuredCompactAt: 0.99, contextTokens: 180_000 })).toBe(true);
  });
});

describe("claudeCompactionDisabled", () => {
  it("reads Claude Code's own switches", () => {
    expect(claudeCompactionDisabled({})).toBe(false);
    expect(claudeCompactionDisabled({ DISABLE_AUTO_COMPACT: "1" })).toBe(true);
    expect(claudeCompactionDisabled({ DISABLE_COMPACT: "true" })).toBe(true);
    expect(claudeCompactionDisabled({ DISABLE_AUTO_COMPACT: "0", DISABLE_COMPACT: "" })).toBe(false);
  });
});

describe("compactConversation", () => {
  const bot = { id: "bot" } as BotRecord;
  const thread = "thread";
  function setup(options: { tokens: number; nativeCompaction?: boolean; engineCompactionOn?: boolean; engineCompact?: boolean; compactAt?: number }) {
    const messages: Message[] = ["one", "two", "three", "four"].flatMap((word, index) => [
      { id: `u${index}`, role: "user", kind: "text", text: `ask ${word}`, at: index * 2 } as Message,
      { id: `b${index}`, role: "bot", kind: "text", text: `answer ${word}`, at: index * 2 + 1 } as Message,
    ]);
    const asked: string[] = [];
    const deps: ConversationCompactionDeps = {
      store: {
        taskByThread: () => ({ lastContextModel: "engine:model", usage: { context: { tokens: options.tokens, window: 200_000 } }, resumeCursors: {} }) as never,
        activePath: () => messages,
        patchTask: () => undefined as never,
        appendMessage: (_threadId: string, message: Partial<Message>) => { const made = { id: `m${messages.length}`, ...message } as Message; messages.push(made); return made; },
      } as never,
      context: () => (options.compactAt === undefined ? undefined : { compactAt: options.compactAt }),
      directContext: (_bot, _thread, all) => all.filter((m) => m.kind === "text").map((m) => ({ id: m.id, role: m.role === "user" ? "user" as const : "assistant" as const, text: m.text ?? "" })),
      latestCompaction: () => undefined,
      nativeCompactTokens: () => 200_000,
      engineCompactionOn: () => options.engineCompactionOn ?? true,
      engineCompact: async (target) => { asked.push(target.instanceId); return options.engineCompact ?? false; },
      generateText: () => undefined,
      claimIsCurrent: () => true,
      controllers: new Map(),
      cancelled: (reason) => new Error(reason),
      idleFraction: 0.85,
    };
    const instance = { instanceId: "engine", driverKind: "claudeAgent", adapter: { capabilities: { nativeCompaction: options.nativeCompaction ?? true } } };
    const run = (manual: boolean, idle?: AbortSignal) => createConversationCompaction(deps)({ bot, threadId: thread, generation: "g", instance, model: "model", excludedIds: new Set(), manual, idle });
    const folds = () => messages.filter((m) => m.kind === "compaction");
    return { run, folds, asked, deps };
  }

  it("writes no fold before a turn at 164k on an engine that compacts itself, and one on an engine that does not", async () => {
    const own = setup({ tokens: 164_274 });
    await own.run(false);
    expect(own.folds()).toHaveLength(0);
    const fed = setup({ tokens: 164_274, nativeCompaction: false });
    await fed.run(false);
    expect(fed.folds()).toHaveLength(1);
    expect(fed.folds()[0]!.compaction).toMatchObject({ by: "harness", tokensBefore: 164_274 });
  });

  it("folds a session that reached the backstop: its engine did not compact", async () => {
    const stuck = setup({ tokens: 191_000 });
    await stuck.run(false);
    expect(stuck.folds()).toHaveLength(1);
    expect(stuck.asked).toEqual([]);
  });

  it.each([false, true])("passes the exact fold and generation to the helper, manual=%s", async manual => {
    const fx = setup({ tokens: 191_000, nativeCompaction: false });
    const scopes: unknown[] = [];
    fx.deps.generateText = (botId, instance, scope) => {
      scopes.push({ botId, instanceId: instance.instanceId, ...scope });
      return async () => "Fixture historical summary";
    };
    await fx.run(manual);
    const foldedThroughId = manual ? "b3" : "b1";
    expect(scopes).toEqual([{ botId: "bot", instanceId: "engine", threadId: "thread", generation: "g", idle: undefined, foldedThroughId }]);
    expect(fx.folds()[0]!.compaction).toMatchObject({ foldedThroughId, summary: expect.stringContaining("Fixture historical summary") });
  });

  it("identifies idle compaction without inventing an active member", async () => {
    const fx = setup({ tokens: 191_000, nativeCompaction: false });
    const idle = new AbortController().signal;
    let scope: unknown;
    fx.deps.generateText = (_botId, _instance, value) => { scope = value; return undefined; };
    await fx.run(false, idle);
    expect(scope).toEqual({ threadId: "thread", generation: "g", idle, foldedThroughId: "b1" });
    expect(fx.folds()[0]!.compaction?.summary).toContain("ask one");
  });

  it("folds at the usual point when the engine's own compaction is switched off", async () => {
    const off = setup({ tokens: 164_274, engineCompactionOn: false });
    await off.run(false);
    expect(off.folds()).toHaveLength(1);
  });

  it("Compact now asks the engine first and writes no fold of its own when the engine did it", async () => {
    const done = setup({ tokens: 50_000, engineCompact: true });
    await done.run(true);
    expect(done.asked).toEqual(["engine"]);
    expect(done.folds()).toHaveLength(0);
    expect(done.deps.controllers.size).toBe(0);
  });

  it("Compact now falls back to the fold when the engine has no compaction to offer, and never asks an engine without one", async () => {
    const refused = setup({ tokens: 50_000, engineCompact: false });
    await refused.run(true);
    expect(refused.asked).toEqual(["engine"]);
    expect(refused.folds()).toHaveLength(1);
    expect(refused.folds()[0]!.compaction).toMatchObject({ by: "person" });
    const fed = setup({ tokens: 50_000, nativeCompaction: false, engineCompact: true });
    await fed.run(true);
    expect(fed.asked).toEqual([]);
    expect(fed.folds()).toHaveLength(1);
  });
});
