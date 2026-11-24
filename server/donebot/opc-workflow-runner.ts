import type {
  OpcWorkflowDefinition,
  OpcWorkflowStep,
  OpcWorkflowStepRun,
} from "../../shared/donebot-opc.ts";
import type { WireMessage } from "../../shared/wire.ts";
import type { Store } from "../store.ts";

export interface WorkflowTurnInput {
  botId: string;
  prompt: string;
  threadId?: string;
  workflowTitle?: string;
  peerFrom?: { botId: string; name: string };
}

export interface WorkflowTurnOutput {
  ok: boolean;
  text: string;
  threadId: string;
}

export interface WorkflowHostStartTurnOptions {
  threadId?: string;
  unattended?: boolean;
  peerAsk?: WireMessage["peerAsk"];
  onSettled?: (outcome: { ok: boolean; text: string }) => void;
  onDispatchError?: (message: string) => void;
}

function safeFence(content: string): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map(m => m[0].length));
  return "`".repeat(longest + 1);
}

/**
 * Builds natural-language handoff prompts between workflow nodes and resolves `peerFrom`
 * so downstream bots receive genuine peer-to-peer chat messages in their conversation threads.
 */
export function buildWorkflowStepPrompt(params: {
  wf: OpcWorkflowDefinition;
  step: OpcWorkflowStep;
  stepIndex: number;
  totalSteps: number;
  completedSteps: readonly OpcWorkflowStepRun[];
  isFinalStep: boolean;
  revisionNote?: string;
}): { prompt: string; peerFrom?: { botId: string; name: string } } {
  const { wf, step, stepIndex, totalSteps, completedSteps, isFinalStep, revisionNote } = params;

  if (revisionNote) {
    const prompt = [
      `【老板打回返工 · 工作流「${wf.name}」第 ${stepIndex + 1}/${totalSteps} 步「${step.name}」】`,
      `老板修改意见：\n${revisionNote}`,
      "请结合本对话中的上一版产出与上述修改意见，直接在本对话中输出完善后的完整新版结果（切勿调用 coordinate_bots / start_thread 转发）。",
    ].join("\n\n");
    return { prompt };
  }

  const footer = isFinalStep
    ? (step.approvalGate
      ? "这是本工作流的最后一步，完成后将呈送老板台拍板确认；请直接在本对话中输出结构清晰、完整的最终成果（切勿调用 coordinate_bots / start_thread 转发）。"
      : "这是本工作流的最后一步，请直接在本对话中向老板输出完整最终成果（切勿调用 coordinate_bots / start_thread 转发）。")
    : (step.approvalGate
      ? "请直接在本对话中输出本环节完整交付内容；完成后将呈送老板台拍板，通过后系统会自动把你的回复交接给下一节点员工（切勿手动调用 coordinate_bots / start_thread 转发）。"
      : "请直接在本对话中输出本环节完整交付内容；完成后系统会自动把你的回复交接给下一节点员工（切勿手动调用 coordinate_bots / start_thread 转发）。");

  if (completedSteps.length === 0) {
    const prompt = [
      `【固定工作流：${wf.name} · 第 ${stepIndex + 1}/${totalSteps} 步「${step.name}」${isFinalStep ? "（最终步骤）" : ""}】`,
      `任务指令：\n${step.instruction}`,
      footer,
    ].join("\n\n");
    return { prompt };
  }

  const peerCandidate = [...completedSteps].reverse().find(s => s.botId !== step.botId);
  const peerFrom = peerCandidate ? { botId: peerCandidate.botId, name: peerCandidate.botName } : undefined;

  if (completedSteps.length === 1) {
    const upstream = completedSteps[0]!;
    const body = upstream.output?.trim() || "（上游未产生文本内容）";
    const fence = safeFence(body);
    const prompt = [
      `【工作流交接：${wf.name} · 第 ${stepIndex + 1}/${totalSteps} 步「${step.name}」${isFinalStep ? "（最终步骤）" : ""}】`,
      `来自上游节点「${upstream.stepName}（${upstream.botName}）」的交付内容：\n${fence}\n${body}\n${fence}`,
      `本步任务指令：\n${step.instruction}`,
      footer,
    ].join("\n\n");
    return { prompt, peerFrom };
  }

  const prevBlock = completedSteps
    .map((s, idx) => `### 上游节点 ${idx + 1} · ${s.stepName}（${s.botName}）\n${s.output?.trim() || "（无文本内容）"}`)
    .join("\n\n");
  const fence = safeFence(prevBlock);
  const prompt = [
    `【工作流汇聚交接：${wf.name} · 第 ${stepIndex + 1}/${totalSteps} 步「${step.name}」${isFinalStep ? "（最终步骤）" : ""}】`,
    `上游各节点已完成交付内容：\n${fence}\n${prevBlock}\n${fence}`,
    `本步任务指令：\n${step.instruction}`,
    footer,
  ].join("\n\n");
  return { prompt, peerFrom };
}

/**
 * Executes a real conversation turn on the target bot (supporting all drivers including Antigravity,
 * DeepSeek Harness, and standard gateway LLMs), writes messages into the bot's chat thread, and
 * captures the full assistant reply text once settled.
 */
export function createWorkflowTurnRunner(deps: {
  store: Store;
  threadBusy: (botId: string, threadId: string) => boolean;
  startTurn: (botId: string, text: string, opts?: WorkflowHostStartTurnOptions) => Promise<unknown>;
}): (input: WorkflowTurnInput) => Promise<WorkflowTurnOutput> {
  return async (input: WorkflowTurnInput): Promise<WorkflowTurnOutput> => {
    const bot = deps.store.bot(input.botId);
    if (!bot || bot.hidden) {
      return { ok: false, text: `步骤负责员工不存在或已归档（${input.botId}）`, threadId: "" };
    }

    let targetThreadId = input.threadId && deps.store.taskByThread(bot.id, input.threadId)
      ? input.threadId
      : bot.threadId;

    if (deps.threadBusy(bot.id, targetThreadId)) {
      const created = deps.store.createTask(bot.id, input.workflowTitle || "固定工作流", false);
      if (created?.threadId) {
        targetThreadId = created.threadId;
      }
    }

    const beforeCount = deps.store.messagesFor(targetThreadId).length;

    return new Promise<WorkflowTurnOutput>((resolve) => {
      let settled = false;
      const finish = (result: WorkflowTurnOutput) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      void deps.startTurn(bot.id, input.prompt, {
        threadId: targetThreadId,
        unattended: true,
        ...(input.peerFrom
          ? { peerAsk: { botId: input.peerFrom.botId, name: input.peerFrom.name, unattended: true } }
          : {}),
        onSettled: (outcome) => {
          if (!outcome.ok) {
            finish({
              ok: false,
              text: outcome.text?.trim() || "员工执行回合失败。",
              threadId: targetThreadId,
            });
            return;
          }
          const addedTexts = deps.store
            .messagesFor(targetThreadId)
            .slice(beforeCount)
            .filter(m => m.role === "bot" && m.kind === "text" && Boolean(m.text?.trim()))
            .map(m => m.text!.trim());
          const combined = addedTexts.length > 0
            ? addedTexts.join("\n\n")
            : (outcome.text?.trim() || "");
          if (!combined || combined === "The bot finished without a text reply") {
            finish({
              ok: false,
              text: "该步骤员工未输出任何文本内容，请检查员工模型状态或调整任务指令。",
              threadId: targetThreadId,
            });
            return;
          }
          finish({ ok: true, text: combined, threadId: targetThreadId });
        },
        onDispatchError: (message) => {
          finish({
            ok: false,
            text: message?.trim() || "派发员工对话回合失败。",
            threadId: targetThreadId,
          });
        },
      }).catch((err) => {
        finish({
          ok: false,
          text: err instanceof Error ? err.message : String(err),
          threadId: targetThreadId,
        });
      });
    });
  };
}
