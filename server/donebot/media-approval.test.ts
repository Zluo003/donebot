import { afterEach, describe, expect, it, vi } from "vitest";
import { addServerLinePacks, setConversationLanguage } from "../server-lines.ts";
import type { Store } from "../store.ts";
import { createMediaApproval } from "./media-approval.ts";
import type { MediaJob } from "./media-store.ts";

afterEach(() => { vi.useRealTimers(); setConversationLanguage(() => undefined); });
function fixture(full = false) {
  let active = true;
  const messages: { id: string; card?: { requestId: string; answered?: string; dismissed?: boolean } }[] = [];
  const store = { bot: () => ({ name: "Synthetic Bot" }), messagesFor: () => messages,
    appendMessage: (_thread: string, message: object) => { const row = { ...message, id: "synthetic-card" }; messages.push(row); return row; },
    patchMessage: (_thread: string, id: string, patch: object) => Object.assign(messages.find(row => row.id === id)!, patch),
  } as unknown as Store;
  const approval = createMediaApproval({ store, full: () => full });
  return { approval, messages, store, setFull: (value: boolean) => { full = value; }, context: { botId: "bot", threadId: "thread", turnId: "turn", active: () => active }, expire: () => { active = false; } };
}
const input = { kind: "image" as const, model: "synthetic-model", parameters: { prompt: "Synthetic fixture" } };
const failed: MediaJob = { version: 1, id: "00000000-0000-4000-8000-000000000001", operationKey: "operation", fingerprint: "fingerprint",
  scope: { accountId: "fixture-user", installationId: "fixture-installation" }, botId: "bot", threadId: "thread", turnId: "turn", kind: "video", model: "primary",
  operation: "generate", status: "failed", error: "Synthetic provider failed", diagnostic: { message: "Synthetic model unavailable" }, fallbackEligible: true,
  fallback: { model: "backup", operation: "generate", adapter: "muse.videos.v1", parameters: { prompt: "Same scene" }, referenceFingerprint: {}, fingerprint: "backup-fingerprint" },
  artifacts: [], waitingStopped: false, createdAt: 1, updatedAt: 1, nextPollAt: 1, attempts: 0 };
describe("DoneBot paid media approval", () => {
  it("does not ask for another confirmation for an image backup or an existing full access video grant", () => {
    const image = fixture(), video = fixture(true);
    expect(image.approval.reviewFallback(image.context, { ...failed, kind: "image" })).toBe("approved");
    expect(video.approval.reviewFallback(video.context, failed)).toBe("approved");
    expect(image.messages).toHaveLength(0); expect(video.messages).toHaveLength(0);
  });

  it("shows the failure and proposed video model and waits for an explicit confirmation exactly once", () => {
    const f = fixture();
    expect(f.approval.reviewFallback(f.context, failed)).toBe("pending");
    expect(f.approval.reviewFallback(f.context, failed)).toBe("pending");
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]!.card).toMatchObject({ title: "Use backup video model backup?", subtitle: expect.stringContaining("Synthetic model unavailable") });
    expect(f.approval.answer(f.messages[0]!.card!.requestId, "allow")).toBe(true);
    expect(f.approval.reviewFallback(f.context, failed)).toBe("approved");
    expect(f.approval.answer(f.messages[0]!.card!.requestId, "allow")).toBe(false);
  });

  it("restores pending background confirmation after shutdown and respects denial", () => {
    const f = fixture();
    expect(f.approval.reviewFallback(f.context, failed)).toBe("pending");
    f.approval.close();
    expect(f.messages[0]!.card?.answered).toBeUndefined();
    const restored = createMediaApproval({ store: f.store, full: () => false });
    expect(restored.reviewFallback(f.context, failed)).toBe("pending");
    expect(f.messages).toHaveLength(1);
    restored.answer(f.messages[0]!.card!.requestId, "deny");
    expect(restored.reviewFallback(f.context, failed)).toBe("declined");
  });

  it("uses a newly granted full access waiver but never honors a stale confirmation", () => {
    const f = fixture(); f.approval.reviewFallback(f.context, failed); f.setFull(true);
    expect(f.approval.reviewFallback(f.context, failed)).toBe("approved");
    expect(f.messages[0]!.card?.answered).toBe("allow");
    const stopped = fixture(); stopped.approval.reviewFallback(stopped.context, failed); stopped.expire();
    stopped.approval.answer(stopped.messages[0]!.card!.requestId, "allow");
    expect(stopped.messages[0]!.card?.answered).toBe("deny");
    expect(stopped.approval.reviewFallback(stopped.context, failed)).toBe("declined");
  });
  it("writes the paid action card in the conversation's language", async () => {
    addServerLinePacks({ "media-fixture": {
      "server.donebot.mediaApprovalTitle": "{bot}: {kind}", "server.donebot.mediaApprovalSubtitle": "{model}: {parameters}",
      "server.donebot.mediaApprovalAllow": "fixture-allow", "server.donebot.mediaApprovalDeny": "fixture-deny", "server.donebot.mediaKindImage": "fixture-image",
    } });
    setConversationLanguage(threadId => threadId === "thread" ? "media-fixture" : undefined);
    const f = fixture(), pending = f.approval.authorize(f.context, input);
    expect(f.messages[0]!.card).toMatchObject({ title: "Synthetic Bot: fixture-image", subtitle: 'synthetic-model: {"prompt":"Synthetic fixture"}', options: ["fixture-allow", "fixture-deny"] });
    f.approval.answer(f.messages[0]!.card!.requestId, "allow");
    await pending;
  });
  it("shows the client-selected model and native parameters in the approval", async () => {
    const f = fixture();
    const pending = f.approval.authorize(f.context, { ...input, parameters: { prompt: "Synthetic fixture", size: "1024x1024" } });
    expect(f.messages[0]!.card).toMatchObject({ subtitle: 'Paid DoneBot model: synthetic-model. {"prompt":"Synthetic fixture","size":"1024x1024"}' });
    f.approval.answer(f.messages[0]!.card!.requestId, "allow");
    await pending;
  });
  it("resolves only the matching explicit Allow and consumes it once", async () => {
    const f = fixture(); const pending = f.approval.authorize(f.context, input);
    expect(f.approval.answer("wrong-request", "allow")).toBe(false);
    const id = f.messages[0]!.card!.requestId;
    expect(f.approval.answer(id, "allow")).toBe(true); await pending;
    expect(f.approval.answer(id, "allow")).toBe(false);
    expect(f.messages[0]!.card).toMatchObject({ answered: "allow", dismissed: false });
  });
  it("denies a card when the turn expires even if Allow arrives later", async () => {
    vi.useFakeTimers(); const f = fixture();
    const pending = expect(f.approval.authorize(f.context, input)).rejects.toMatchObject({ status: 403 });
    const id = f.messages[0]!.card!.requestId; f.expire();
    await vi.advanceTimersByTimeAsync(500); await pending;
    expect(f.approval.answer(id, "allow")).toBe(false);
    expect(f.messages[0]!.card).toMatchObject({ answered: "deny", dismissed: true });
  });
  it("uses the existing full access grant without a duplicate card and rejects pending cards on shutdown", async () => {
    const full = fixture(true); await full.approval.authorize(full.context, input); expect(full.messages).toHaveLength(0);
    const f = fixture(); const pending = expect(f.approval.authorize(f.context, input)).rejects.toMatchObject({ status: 403 });
    f.approval.close(); await pending;
    expect(f.messages[0]!.card).toMatchObject({ answered: "deny", dismissed: true });
  });
});
