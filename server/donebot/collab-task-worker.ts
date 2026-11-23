import { isExternalCodingAgentBot } from "../../shared/coding-agents.ts";
import type { DoneBotClaimedTaskBotEvent } from "../../shared/donebot-collab.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import type { CollabBotTurnOptions, CollabBotTurnOutcome } from "./collab-chat-bots.ts";
import { collabClaimTaskBotEvent, collabCompleteTaskBotEvent } from "./collab-gateway.ts";
import { getTaskBinding, saveTaskBinding } from "./collab-task-bindings.ts";
import { downloadDeliverablesToSandbox, type DownloadedDeliverableInfo } from "./collab-task-internal.ts";
import { DoneBotGatewayError, type DoneBotGateway } from "./gateway.ts";

export interface CollabTaskWorkerDeps {
  gateway: DoneBotGateway;
  store: Pick<Store, "bots" | "bot"> & Partial<Pick<Store, "taskByThread" | "createTask" | "appendMessage" | "messagesFor">>;
  startTurn?: (botId: string, text: string, opts: CollabBotTurnOptions) => Promise<unknown>;
  threadBusy?: (botId: string, threadId: string) => boolean;
}

const POLL_MS = 4_000;
const TURN_WAIT_MS = 180_000;
const TURN_CHECK_MS = 300;
const BUSY_WAIT_MS = 15_000;

function pickChiefBot(bots: readonly BotRecord[]): BotRecord | undefined {
  const visible = bots.filter(b => !b.hidden && !isExternalCodingAgentBot(b));
  return visible.find(b => b.chiefOfStaff) ?? visible[0];
}

function hasPendingCard(lines: readonly Message[]): boolean {
  return lines.some(line => line.card?.requestId !== undefined && !line.card.answered && !line.card.dismissed);
}

function formatDeliverablesBlock(files: readonly DownloadedDeliverableInfo[]): string[] {
  if (files.length === 0) return ["本批次未附带文件附件（仅文字/链接交付简报）。"];
  const lines = [`本批次共下载 ${files.length} 个交付文件到本地审阅沙箱：`];
  for (const f of files) {
    const metaParts: string[] = [f.file_mime, `${Math.max(1, Math.round(f.file_size / 1024))} KB`];
    if (f.dimensions) {
      metaParts.push(`${f.dimensions.width}x${f.dimensions.height}（比例 ${f.dimensions.aspect_ratio}）`);
    }
    if (f.media_meta) {
      if (f.media_meta.duration_sec !== undefined) metaParts.push(`时长 ${f.media_meta.duration_sec}s`);
      if (f.media_meta.width && f.media_meta.height) metaParts.push(`${f.media_meta.width}x${f.media_meta.height}`);
      metaParts.push(f.media_meta.has_audio ? "含音轨" : "无音轨");
    }
    lines.push(`- ${f.file_name}（${metaParts.join("，")}）→ 本地路径：${f.local_path}`);
    if (f.keyframe_paths && f.keyframe_paths.length > 0) {
      lines.push(`  视频抽帧预览图（可直接查看画面质量）：${f.keyframe_paths.join(" , ")}`);
    }
    if (f.text_excerpt) {
      lines.push(`  文本内容摘录：\n${f.text_excerpt.slice(0, 1500)}`);
    }
  }
  return lines;
}

export function buildTaskEventPrompt(
  ev: DoneBotClaimedTaskBotEvent,
  downloadedFiles: readonly DownloadedDeliverableInfo[],
): { display: string; full: string } {
  const task = ev.detail.task;
  const criteria = task.acceptance_criteria ?? [];
  const criteriaLines = criteria.length > 0
    ? ["结构化验收清单：", ...criteria.map((c, idx) => `${idx + 1}. ${c}`)]
    : ["（未填写结构化验收清单，请以任务标题与要求为准）"];

  const latestSubmission = [...ev.detail.updates]
    .reverse()
    .find(u => u.kind === "submission" && u.body?.trim());

  if (ev.event_type === "task_assigned") {
    const display = `[团队新任务 · ${ev.team_name}] 收到 ${ev.creator_name || "队友"} 派发的新任务「${task.title}」`;
    const full = [
      `你作为主人的主协调助手，刚刚收到来自团队「${ev.team_name}」${task.channel_name ? `（#${task.channel_name}）` : ""} 的一条新任务派发事件：`,
      `【任务ID】${task.id}（team_id: ${ev.team_id}）`,
      `【任务标题】${task.title}`,
      `【派发人】${ev.creator_name || "团队成员"}`,
      task.due_at ? `【截止时间】${task.due_at}` : "",
      task.description ? `【任务要求】\n${task.description}` : "",
      ...criteriaLines,
      "",
      "请用简洁清晰的中文向主人汇报这条新任务（包含标题、派发人、截止时间、核心要求与验收清单），并询问主人是否要现在开始处理或交给某个专长助手推进。不要擅自提交任务。",
    ].filter(Boolean).join("\n");
    return { display, full };
  }

  if (ev.event_type === "task_submitted") {
    const currentRound = task.auto_revision_count ?? 0;
    const maxRounds = task.max_auto_revisions ?? 2;
    const remainingAuto = Math.max(0, maxRounds - currentRound);
    const display = `[团队待初审 · ${ev.team_name}] ${ev.assignee_name || "负责人"} 提交了任务「${task.title}」的交付成果`;
    const full = [
      `你是下发者/验收人的主协调助手。团队「${ev.team_name}」中的任务「${task.title}」刚刚提交了新交付批次，请你自动执行「第一道 AI 初审」，然后向主人汇报。`,
      `【team_id】${ev.team_id}`,
      `【task_id】${task.id}`,
      `【负责人】${ev.assignee_name || "团队成员"}`,
      `【当前自动返工轮次】已自动返工 ${currentRound} / ${maxRounds} 轮（还可自动驳回 ${remainingAuto} 轮）`,
      task.description ? `【任务要求】\n${task.description}` : "",
      ...criteriaLines,
      "",
      latestSubmission?.body ? `【提交人交付简报】\n${latestSubmission.body}` : "【提交人交付简报】未填写文字简报",
      "",
      ...formatDeliverablesBlock(downloadedFiles),
      "",
      "请严格按以下步骤执行：",
      "1. 如本批次包含图片或视频抽帧图，请优先检查其实际图片内容、尺寸比例与画质；如含文本/文档请阅读核对。若包含视频/音频，请在审阅意见中诚实提醒主人动态流畅度与声音情绪需本人播放终审。",
      "2. 严格区分「硬性不符」与「主观审美」：",
      "   - 只有存在明确、客观的硬性违背（如缺失文件、张数不够、画幅比例错误、文字明显乱码/严重崩图、遗漏核心要求）时，才判 hard_fail；",
      "   - 主观审美偏好或二选一方案绝对禁止自动驳回，必须判 pass 并把建议关注点写入 attention_items 交由主人最终拍板。",
      "3. 必须调用工具 collab_review_team_task（mode='bot_review'）写入你的审阅结论：",
      "   - 合格或仅需主人主观拍板：verdict='pass'，填好 summary、passed_items、attention_items；",
      "   - 明显硬性不符：verdict='hard_fail'，填好 summary、failed_criteria 与具体可执行的 actionable_fixes（网关会在未超 2 轮上限时自动驳回给对方助手修改，超限则自动升级给双方真人）。",
      "4. 调用完工具后，用简洁明了的中文在当前对话向主人汇报：",
      "   - 如果 verdict='pass'：总结交付亮点、已核验通过项、建议主人重点关注/拍板的点，并提示主人可直接回复「通过」或「指出要改的地方并退回」，你会代为执行终审；",
      "   - 如果 verdict='hard_fail'：简短告知主人发现了哪些硬性问题，已自动驳回给对方助手返工（或因达到轮次上限已升级为人工介入）。",
    ].filter(Boolean).join("\n");
    return { display, full };
  }

  if (ev.event_type === "task_bot_rejected") {
    const payload = ev.payload ?? {};
    const round = Number(payload.round ?? task.auto_revision_count ?? 1);
    const maxRounds = Number(payload.max_rounds ?? task.max_auto_revisions ?? 2);
    const reviewerBot = String(payload.reviewer_bot_name ?? "下发方主协调助手");
    const summary = String(payload.summary ?? task.latest_bot_review_summary ?? "初审未通过，请按要求修改。");
    const failed = Array.isArray(payload.failed_criteria) ? payload.failed_criteria.map(String) : [];
    const fixes = Array.isArray(payload.actionable_fixes) ? payload.actionable_fixes.map(String) : [];
    const autoResubmit = payload.auto_resubmit !== false && task.assignee_auto_resubmit !== false;
    const display = `[初审自动驳回 ${round}/${maxRounds}] 「${task.title}」被 ${reviewerBot} 驳回，需要按要求修改`;
    const full = [
      `你负责协助主人推进的团队任务「${task.title}」（团队：${ev.team_name}，team_id: ${ev.team_id}，task_id: ${task.id}）被下发者的主协调助手「${reviewerBot}」初审驳回（第 ${round}/${maxRounds} 轮自动返工）。`,
      `【驳回摘要】${summary}`,
      ...(failed.length > 0 ? ["【未通过的硬性要求】", ...failed.map((f, i) => `${i + 1}. ${f}`)] : []),
      ...(fixes.length > 0 ? ["【具体修改指令】", ...fixes.map((f, i) => `${i + 1}. ${f}`)] : []),
      "",
      "执行与费用护栏（必须严格遵守）：",
      "1. 如果本次修改仅涉及文案、脚本、策划、代码或图片生成/修图：请结合当前对话历史直接按上述修改指令完成修改与自查。",
      autoResubmit
        ? "   修改并核验无误后，请直接调用 collab_submit_team_task 自动重新提交新版任务简报（说明具体改了什么）与新版成果文件路径，然后简洁告知主人本轮自动修正并已重提。"
        : "   修改完成后先不要自动提交，请把修改结果展示给主人等待主人确认后再调用 collab_submit_team_task 提交。",
      "2. 高成本视频/音乐护栏：如果本次修改必须重新调用高成本的视频生成或音乐生成模型，请先整理好修改后的分镜/提示词方案并停下来，向主人说明驳回原因与预计重生成操作，等待主人确认后再生成并提交，绝不擅自扣费重生成视频/音乐。",
    ].join("\n");
    return { display, full };
  }

  // task_human_rejected
  const feedback = String(ev.payload?.feedback ?? "验收人提出了修改意见，请查看任务详情。");
  const display = `[验收人退回修改 · ${ev.team_name}] 「${task.title}」：${feedback.slice(0, 120)}`;
  const full = [
    `团队「${ev.team_name}」中的任务「${task.title}」（team_id: ${ev.team_id}，task_id: ${task.id}）被验收人（${ev.reviewer_name || "验收人"}）人工退回修改：`,
    `【验收人修改意见】\n${feedback}`,
    "",
    "请结合本对话历史，立刻向主人汇报这条修改意见并给出具体修改方案或草稿；修改完成后等待主人点头审批再调用 collab_submit_team_task 重新提交。",
  ].join("\n");
  return { display, full };
}

export function createCollabTaskWorker(deps: CollabTaskWorkerDeps) {
  let active = false;
  let polling = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const runningEvents = new Set<string>();

  async function waitIfBusy(botId: string, threadId: string): Promise<boolean> {
    if (!deps.threadBusy) return true;
    const deadline = Date.now() + BUSY_WAIT_MS;
    while (deps.threadBusy(botId, threadId)) {
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    return true;
  }

  async function runEventTurn(bot: BotRecord, preferredThreadId: string, fallbackTitle: string, display: string, full: string): Promise<void> {
    const { store, startTurn } = deps;
    if (!startTurn || !store.appendMessage || !store.messagesFor) {
      throw new Error("本机自动调度未就绪");
    }
    let threadId = preferredThreadId || bot.threadId;
    const ready = await waitIfBusy(bot.id, threadId);
    if (!ready && store.createTask) {
      const alt = store.createTask(bot.id, fallbackTitle.slice(0, 80), false, undefined, undefined, "ask");
      if (alt) threadId = alt.threadId;
    }
    if (deps.threadBusy?.(bot.id, threadId)) {
      throw new Error("目标机器人会话正忙");
    }

    const userMessage = store.appendMessage(threadId, {
      role: "user",
      kind: "text",
      text: display,
      via: "api",
    });
    const after = () => {
      const all = store.messagesFor!(threadId);
      const idx = all.findIndex(line => line.id === userMessage.id);
      return idx >= 0 ? all.slice(idx + 1) : [];
    };

    let settled: CollabBotTurnOutcome | undefined;
    let dispatchError: string | undefined;
    await startTurn(bot.id, full, {
      threadId,
      automationSource: "api",
      unattended: true,
      userMessage,
      onSettled: outcome => { settled = outcome; },
      onDispatchError: msg => { dispatchError = msg; },
    });

    const deadline = Date.now() + TURN_WAIT_MS;
    while (Date.now() < deadline) {
      if (dispatchError !== undefined) throw new Error(dispatchError);
      if (settled) return;
      if (hasPendingCard(after())) return;
      await new Promise(resolve => setTimeout(resolve, TURN_CHECK_MS));
    }
  }

  async function processEvent(ev: DoneBotClaimedTaskBotEvent): Promise<void> {
    if (runningEvents.has(ev.id)) return;
    runningEvents.add(ev.id);
    const ctx = deps.gateway.collabCtx();
    try {
      let targetBot: BotRecord | undefined;
      let targetThreadId = "";

      if (ev.event_type === "task_bot_rejected" || ev.event_type === "task_human_rejected") {
        const binding = getTaskBinding(ev.task_id);
        if (binding) {
          const boundBot = deps.store.bot(binding.botId);
          if (boundBot && !boundBot.hidden) {
            targetBot = boundBot;
            const threadExists = !deps.store.taskByThread || Boolean(deps.store.taskByThread(boundBot.id, binding.threadId));
            targetThreadId = threadExists ? binding.threadId : boundBot.threadId;
          }
        }
      }

      if (!targetBot) {
        targetBot = pickChiefBot(deps.store.bots);
        targetThreadId = targetBot?.threadId ?? "";
      }

      if (!targetBot) {
        await collabCompleteTaskBotEvent(ctx, ev.id, { status: "failed", error: "本机没有可用的主协调助手或执行助手。" });
        return;
      }

      if (ev.event_type === "task_bot_rejected" || ev.event_type === "task_human_rejected") {
        saveTaskBinding({
          teamId: ev.team_id,
          teamName: ev.team_name,
          taskId: ev.task_id,
          taskTitle: ev.detail.task.title,
          botId: targetBot.id,
          threadId: targetThreadId,
        });
      }

      const downloaded = ev.event_type === "task_submitted"
        ? await downloadDeliverablesToSandbox(deps.gateway, ev.detail).catch(() => [])
        : [];
      const { display, full } = buildTaskEventPrompt(ev, downloaded);
      await runEventTurn(
        targetBot,
        targetThreadId,
        `[团队任务] ${ev.detail.task.title}`,
        display,
        full,
      );
      await collabCompleteTaskBotEvent(ctx, ev.id, { status: "done" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "处理团队任务自动化事件失败";
      await collabCompleteTaskBotEvent(ctx, ev.id, { status: "failed", error: msg.slice(0, 400) }).catch(() => {});
    } finally {
      runningEvents.delete(ev.id);
    }
  }

  async function tick(): Promise<void> {
    if (polling || runningEvents.size >= 2) return;
    polling = true;
    try {
      const res = await collabClaimTaskBotEvent(deps.gateway.collabCtx()) as {
        event?: DoneBotClaimedTaskBotEvent | null;
      };
      if (res?.event) {
        void processEvent(res.event);
      }
    } catch (error) {
      if (error instanceof DoneBotGatewayError && (error.status === 401 || error.status === 403 || error.status === 404)) {
        setActive(false);
      }
    } finally {
      polling = false;
    }
  }

  function setActive(next: boolean) {
    if (active === next) return;
    active = next;
    if (active) {
      if (!timer) {
        timer = setInterval(() => { void tick(); }, POLL_MS);
        timer.unref?.();
      }
      void tick();
    } else if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function kick() {
    if (!active) setActive(true);
    else void tick();
  }

  return { setActive, kick };
}
