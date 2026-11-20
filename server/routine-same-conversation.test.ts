import { describe, expect, it } from "vitest";
import type { RoutineRun } from "./routines.ts";
import { continuedConversation, previousEventThread } from "./routine-same-conversation.ts";

const run = (id: string, extra: Partial<RoutineRun> = {}): RoutineRun => ({ id, botId: "scout", webhookId: "hook", target: "bot", ...extra } as RoutineRun);

describe("event conversation continuity", () => {
  it("uses the latest matching bot and trigger, skipping runs that never obtained a conversation", () => {
    const current = run("current");
    const runs = [current, run("queued"), run("other-bot", { botId: "peer", threadId: "private-peer" }), run("other-hook", { webhookId: "other", threadId: "other-event" }), run("latest", { threadId: "latest-chat" }), run("older", { threadId: "old-chat" })];
    expect(previousEventThread(runs, current)).toBe("latest-chat");
    expect(continuedConversation(runs, current, thread => thread === "latest-chat")).toBe("latest-chat");
  });

  it("starts fresh when the latest conversation is deleted, even if an older conversation still exists", () => {
    const current = run("current");
    expect(continuedConversation([run("latest", { threadId: "deleted" }), run("old", { threadId: "exists" })], current, thread => thread === "exists")).toBeNull();
  });

  it("does not continue a room or an event without an earlier conversation", () => {
    expect(continuedConversation([run("old", { threadId: "shared" })], run("room", { target: "room-goal" }), () => true)).toBeNull();
    expect(continuedConversation([], run("first"), () => true)).toBeNull();
  });
});
