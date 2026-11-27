import { afterEach, describe, expect, it, vi } from "vitest";
import { claimsDispatch, createDispatchClaimGuard, DISPATCH_CORRECTION_NOTE, type CompletedTurn } from "./dispatch-claim-guard.ts";

describe("claimsDispatch", () => {
  it("flags the hand-off claims the chief made without calling a tool", () => {
    for (const reply of [
      "好的，已安排造型师出图，完成后向您汇报。",
      "老板，造型师上次启动时额度用尽，请求还没提交。现在我重新派单给她出图。",
      "老板您说得对，我刚才只说了一句话，实际上还没调用工具派单。现在马上派给造型师。",
      "老板，已经派给造型师了，她正在画。",
      "给造型师安排了，他会按皮克斯3D卡通风格画出毛驴形象。",
      "I've assigned this to the designer.",
    ]) expect(claimsDispatch(reply), reply).toBe(true);
  });

  it("leaves questions, honest negations and plain answers alone", () => {
    for (const reply of [
      "老板，话筒让给哪位?需要我派活还是您打算告诉我接下来做什么?",
      "需要我派给造型师吗？",
      "我还没有派单，先确认一下尺寸。",
      "老板好，我是多宝，您在 DoneBot 的个人助手。",
      "皮克斯风格的女子图已经画好了，就是上面这张。",
    ]) expect(claimsDispatch(reply), reply).toBe(false);
  });
});

describe("createDispatchClaimGuard", () => {
  afterEach(() => vi.useRealTimers());

  const turn = (over: Partial<CompletedTurn> = {}): CompletedTurn => ({
    botId: "chief", threadId: "t1", turnId: "turn-1", reply: "好的，已安排造型师出图，完成后向您汇报。",
    toolCalls: 0, succeeded: true, personTurn: true, requestMessageId: "m1", ...over,
  });

  function rig(busyFor = 0) {
    vi.useFakeTimers();
    let busy = busyFor;
    const startCorrection = vi.fn(async () => {});
    const noteCorrection = vi.fn();
    const guard = createDispatchClaimGuard({
      isCoordinator: (id) => id === "chief",
      threadBusy: () => busy-- > 0,
      noteCorrection,
      startCorrection,
      waitStepMs: 100,
      waitLimitMs: 1_000,
    });
    return { guard, startCorrection, noteCorrection };
  }

  it("starts one hidden correction once the thread is free, and never twice for the same request", async () => {
    const { guard, startCorrection, noteCorrection } = rig(3);
    expect(guard.afterTurn(turn())).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(noteCorrection).toHaveBeenCalledWith("t1");
    expect(startCorrection).toHaveBeenCalledExactlyOnceWith("chief", "t1", DISPATCH_CORRECTION_NOTE, "m1");
    expect(guard.afterTurn(turn({ turnId: "turn-2" }))).toBe(false);
  });

  it("skips turns that used a tool, failed, were not a person's request, or came from a non-coordinator", async () => {
    const { guard, startCorrection } = rig();
    expect(guard.afterTurn(turn({ toolCalls: 1 }))).toBe(false);
    expect(guard.afterTurn(turn({ succeeded: false }))).toBe(false);
    expect(guard.afterTurn(turn({ personTurn: false }))).toBe(false);
    expect(guard.afterTurn(turn({ botId: "designer" }))).toBe(false);
    expect(guard.afterTurn(turn({ reply: "需要我派给造型师吗？" }))).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(startCorrection).not.toHaveBeenCalled();
  });

  it("gives up quietly when the thread never frees", async () => {
    const { guard, startCorrection } = rig(1_000);
    guard.afterTurn(turn());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(startCorrection).not.toHaveBeenCalled();
  });
});
