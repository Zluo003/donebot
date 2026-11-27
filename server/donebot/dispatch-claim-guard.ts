/**
 * Catches a coordinator turn that tells the person work was handed off while the turn called no tool at all,
 * and asks the coordinator once, in a hidden continuation, to actually dispatch or correct itself.
 */

const CLAIM = new RegExp([
  "(?:已经?|刚刚?|现在(?:就)?|马上|立刻|立即|这就|这边)\\s*(?:重新)?(?:派|安排|交给|转交|分派|指派|下发|发给|委派|通知)",
  "派给",
  "派单给",
  "派发给",
  "已发送给",
  "正在(?:画|绘制|生成|制作|处理|做|写|跑|修改|赶)",
  "(?:他|她)(?:会|将|正在)[^。！？!?\\n]{0,20}(?:画|绘制|生成|制作|处理|做|写)",
  "\\b(?:I(?:'ve| have)|have|has)\\s+(?:assigned|dispatched|handed|delegated)\\b",
  "\\b(?:assigned|handed (?:it )?(?:off|over)|dispatched) (?:it )?to\\b",
].join("|"), "iu");

const QUESTION = /[？?]\s*$|吗|要不要|是否|需不需要|需要我|可以吗|好吗/u;
const NEGATED = /(?:没有?|未|还没|尚未|不)[^。！？!?\n]{0,6}(?:派|安排|发给|交给)/u;

export function claimsDispatch(reply: string): boolean {
  const sentences = reply.split(/(?<=[。！!？?\n])/u).map((s) => s.trim()).filter(Boolean);
  return sentences.some((sentence) => !QUESTION.test(sentence) && !NEGATED.test(sentence) && CLAIM.test(sentence));
}

export const DISPATCH_CORRECTION_NOTE = [
  "[DoneBot 系统核查——这不是用户的新消息]",
  "你上一条回复声称已经派单、已安排或队友正在处理，但上一回合实际没有调用任何工具，所以没有任何任务发给任何队友。",
  "现在请立即纠正：",
  "1. 若不确定队友 id，先调用 list_bots；",
  "2. 调用 coordinate_bots，把用户最初的完整需求派发给合适的队友；",
  "3. 工具返回成功后，再用一句话如实告诉用户已派给谁。",
  "如果这件事其实不需要派单（应由你亲自完成，或需要先向用户确认），就直接去做或提问，并如实更正上一句话。不要再在未调用工具的情况下声称已派单。",
].join("\n");

export const DISPATCH_CORRECTION_ACTIVITY = "系统核查：上一句声称已派单，但实际没有调用派单工具，已自动要求重新派发";

export interface CompletedTurn {
  botId: string;
  threadId: string;
  turnId: string;
  reply: string;
  toolCalls: number;
  succeeded: boolean | undefined;
  /** A person's own direct request, not a routine, a teammate hand-off, a card continuation or a bot-opened thread. */
  personTurn: boolean;
  requestMessageId?: string;
}

export interface DispatchClaimGuardDeps {
  isCoordinator(botId: string): boolean;
  threadBusy(botId: string, threadId: string): boolean;
  noteCorrection(threadId: string): void;
  startCorrection(botId: string, threadId: string, note: string, requestMessageId: string | undefined): Promise<unknown>;
  log?(line: string): void;
  waitStepMs?: number;
  waitLimitMs?: number;
}

export function createDispatchClaimGuard(deps: DispatchClaimGuardDeps) {
  const corrected = new Set<string>();
  const stepMs = deps.waitStepMs ?? 300;
  const limitMs = deps.waitLimitMs ?? 20_000;

  const startWhenFree = (botId: string, threadId: string, requestMessageId: string | undefined, waited = 0): void => {
    if (deps.threadBusy(botId, threadId)) {
      if (waited >= limitMs) {
        deps.log?.(`dispatch claim guard: ${threadId} stayed busy, correction skipped`);
        return;
      }
      setTimeout(() => startWhenFree(botId, threadId, requestMessageId, waited + stepMs), stepMs);
      return;
    }
    deps.noteCorrection(threadId);
    void deps.startCorrection(botId, threadId, DISPATCH_CORRECTION_NOTE, requestMessageId).catch((error: unknown) => {
      deps.log?.(`dispatch claim guard: correction for ${threadId} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  return {
    /** True when a correction was scheduled for this turn. */
    afterTurn(turn: CompletedTurn): boolean {
      if (!turn.personTurn || turn.succeeded === false || turn.toolCalls > 0) return false;
      if (!turn.reply.trim() || !deps.isCoordinator(turn.botId) || !claimsDispatch(turn.reply)) return false;
      const key = `${turn.threadId}:${turn.requestMessageId ?? turn.turnId}`;
      if (corrected.has(key)) return false;
      corrected.add(key);
      if (corrected.size > 500) corrected.delete(corrected.values().next().value!);
      deps.log?.(`dispatch claim guard: ${turn.botId} claimed a hand-off with no tool call in ${turn.threadId}; asking it to dispatch`);
      setTimeout(() => startWhenFree(turn.botId, turn.threadId, turn.requestMessageId), stepMs);
      return true;
    },
  };
}
