import { afterEach, describe, expect, it, vi } from "vitest";
import { addServerLinePacks, setConversationLanguage } from "../server-lines.ts";
import type { Store } from "../store.ts";
import { createMediaApproval } from "./media-approval.ts";

afterEach(() => { vi.useRealTimers(); setConversationLanguage(() => undefined); });
function fixture(full = false) {
  let active = true;
  const messages: { id: string; card?: { requestId: string; answered?: string; dismissed?: boolean } }[] = [];
  const store = { bot: () => ({ name: "Synthetic Bot" }), messagesFor: () => messages,
    appendMessage: (_thread: string, message: object) => { const row = { ...message, id: "synthetic-card" }; messages.push(row); return row; },
    patchMessage: (_thread: string, id: string, patch: object) => Object.assign(messages.find(row => row.id === id)!, patch),
  } as unknown as Store;
  const approval = createMediaApproval({ store, full: () => full });
  return { approval, messages, context: { botId: "bot", threadId: "thread", turnId: "turn", active: () => active }, expire: () => { active = false; } };
}
const input = { kind: "image" as const, model: "synthetic-model", parameters: { prompt: "Synthetic fixture" } };
describe("DoneBot paid media approval", () => {
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
