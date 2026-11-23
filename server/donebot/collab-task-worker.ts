import { isExternalCodingAgentBot } from "../../shared/coding-agents.ts";
import type { DoneBotClaimedTaskBotEvent, DoneBotCollabTaskPrefs } from "../../shared/donebot-collab.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import type { CollabBotTurnOptions } from "./collab-chat-bots.ts";
import { collabClaimTaskBotEvent, collabCompleteTaskBotEvent } from "./collab-gateway.ts";
import { getTaskBinding, saveTaskBinding } from "./collab-task-bindings.ts";
import { downloadDeliverablesToSandbox, type DownloadedDeliverableInfo } from "./collab-task-internal.ts";
import { getCollabTaskPrefs } from "./collab-task-prefs.ts";
import { DoneBotGatewayError, type DoneBotGateway } from "./gateway.ts";

export interface DelegatedWorkerInfo {
  botId: string;
  botName: string;
  threadId: string;
  title?: string;
}

export interface TaskEventPromptOptions {
  chiefAutoSubmitOnApprove?: boolean;
  availableSpecialists?: ReadonlyArray<{ id: string; name: string; title?: string; description?: string }>;
  targetIsChief?: boolean;
  delegatedWorkers?: readonly DelegatedWorkerInfo[];
}

export interface CollabTaskWorkerDeps {
  gateway: DoneBotGateway;
  store: Pick<Store, "bots" | "bot"> & Partial<Pick<Store, "taskByThread" | "createTask" | "appendMessage" | "messagesFor">>;
  startTurn?: (botId: string, text: string, opts: CollabBotTurnOptions) => Promise<unknown>;
  threadBusy?: (botId: string, threadId: string) => boolean;
  listChildThreads?: (parentThreadId: string) => DelegatedWorkerInfo[];
  getTaskPrefs?: () => DoneBotCollabTaskPrefs;
}

const POLL_MS = 8_000;
const RATE_LIMIT_BACKOFF_MS = 30_000;
const TURN_WAIT_MS = 180_000;
const TURN_CHECK_MS = 300;
const BUSY_WAIT_MS = 15_000;

function pickChiefBot(bots: readonly BotRecord[]): BotRecord | undefined {
  const visible = bots.filter(b => !b.hidden && !isExternalCodingAgentBot(b));
  return visible.find(b => b.chiefOfStaff) ?? visible[0];
}

function listAvailableSpecialists(
  bots: readonly BotRecord[],
  chiefId?: string,
): Array<{ id: string; name: string; title?: string; description?: string }> {
  return bots
    .filter(b => !b.hidden && !b.chiefOfStaff && b.id !== chiefId && !isExternalCodingAgentBot(b))
    .map(b => ({
      id: b.id,
      name: b.name,
      ...(b.title?.trim() ? { title: b.title.trim() } : {}),
      ...(b.description?.trim() ? { description: b.description.trim().slice(0, 140) } : {}),
    }));
}

function formatSpecialistsBlock(
  specialists?: ReadonlyArray<{ id: string; name: string; title?: string; description?: string }>,
): string[] {
  if (!specialists || specialists.length === 0) {
    return ["【本机已有专长子助手】当前暂无可用的专长子助手，请根据本次任务所需能力自动创建匹配的子助手。"];
  }
  return [
    "【本机已有专长子助手】（先据此匹配，匹配不到再新建，切勿重复建同类助手）：",
    ...specialists.map(s => {
      const role = s.title ? ` — ${s.title}` : "";
      const desc = s.description ? `（${s.description}）` : "";
      return `- @${s.name}${role}${desc} [bot_id: ${s.id}]`;
    }),
  ];
}

function formatDelegatedWorkersBlock(workers?: readonly DelegatedWorkerInfo[]): string[] {
  if (!workers || workers.length === 0) return [];
  return [
    "【本任务已派发过的专长子助手与工作线程】",
    ...workers.map(w => `- @${w.botName} [bot_id: ${w.botId}, thread_id: ${w.threadId}${w.title ? `, 线程：${w.title}` : ""}]`),
  ];
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

function collectReviewImageAttachments(files: readonly DownloadedDeliverableInfo[]): NonNullable<Message["attachments"]> {
  const out: NonNullable<Message["attachments"]> = [];
  for (const f of files) {
    if (out.length >= 5) break;
    if (f.file_mime.toLowerCase().startsWith("image/")) {
      out.push({ kind: "image", path: f.local_path, mime: f.file_mime, name: f.file_name });
    } else if (f.keyframe_paths && f.keyframe_paths.length > 0) {
      for (let i = 0; i < f.keyframe_paths.length && out.length < 5; i += 1) {
        out.push({ kind: "image", path: f.keyframe_paths[i]!, mime: "image/jpeg", name: `${f.file_name}_frame_${i + 1}.jpg` });
      }
    }
  }
  return out;
}

export function buildTaskEventPrompt(
  ev: DoneBotClaimedTaskBotEvent,
  downloadedFiles: readonly DownloadedDeliverableInfo[],
  opts?: TaskEventPromptOptions,
): { display: string; full: string } {
  const task = ev.detail.task;
  const criteria = task.acceptance_criteria ?? [];
  const criteriaLines = criteria.length > 0
    ? ["结构化验收清单：", ...criteria.map((c, idx) => `${idx + 1}. ${c}`)]
    : ["（未填写结构化验收清单，请以任务标题与要求为准）"];

  const latestSubmission = [...ev.detail.updates]
    .reverse()
    .find(u => u.kind === "submission" && u.body?.trim());

  const autoSubmitEnabled = opts?.chiefAutoSubmitOnApprove === true;
  const targetIsChief = opts?.targetIsChief !== false;

  if (ev.event_type === "task_assigned") {
    const display = `[团队新任务 · ${ev.team_name}] 收到 ${ev.creator_name || "队友"} 派发的新任务「${task.title}」`;
    const full = [
      `你是接收方主人的主协调助手（Chief of Staff），刚刚收到来自团队「${ev.team_name}」${task.channel_name ? `（#${task.channel_name}）` : ""} 的一条新任务，本对话已自动绑定为该任务的专属协调线程：`,
      `【任务ID】${task.id}（team_id: ${ev.team_id}）`,
      `【任务标题】${task.title}`,
      `【派发人】${ev.creator_name || "团队成员"}`,
      task.due_at ? `【截止时间】${task.due_at}` : "",
      task.description ? `【任务要求】\n${task.description}` : "",
      ...criteriaLines,
      "",
      ...formatSpecialistsBlock(opts?.availableSpecialists),
      "",
      `【当前主协调代人审批提交配置】${autoSubmitEnabled ? "已开启（一审通过后可直接代主人自动提交团队验收）" : "未开启（默认：一审通过后必须先呈报主人确认，待主人回复同意后再提交团队验收）"}`,
      "",
      "请严格按以下「主协调编排 + 子助手执行 + 一审质检」闭环执行：",
      "1. 【角色铁律：严禁主协调助手亲自干活】你只负责需求拆解、匹配/创建专长子助手、派发执行、一审质检与对外提交；严禁你自己亲自调用 generate_image / generate_video / generate_music 或亲自编写交付成品。",
      "2. 【选派或自动创建专长子助手（含 SOUL.md 与 Skill）】：",
      "   - 先对照本机已有专长子助手（或调用 list_bots 复核）选择能力最匹配的一位（或多领域拆分派发）；切勿重复创建同类助手。",
      "   - 若缺少匹配该任务能力的专长子助手，立即自动补齐（不要先停下来询问主人）：",
      "     a) 调用 create_bot(name, role, instructions) 创建该岗位专长子助手，在 instructions 中写入清晰完整的 SOUL.md（角色身份、专业职责、工作流程、客观质量自检标准、边界与交付规范：生成的图片/视频/音乐会自动附带切勿重复 attach_file，文档/文案文件/表格/PDF/代码等必须调用 attach_file 附带给主协调助手）；",
      "     b) 调用 skill_find(query, bot_id=新子助手id) 检索匹配的现成高质量 Skill：若找到匹配且可靠的现成技能，调用 skill_import(source, bot_id, preview=false) 导入并用 skill_manage(action='enable', bot_id, skill_name) 启用；若未找到合适现成技能或联网受限，直接调用 skill_manage(action='create', bot_id, skill_md, source='conversation', gist) 为该子助手定制创建并启用专业 SKILL.md。",
      "3. 【派发给专长子助手执行（含高成本视频/音乐护栏）】：",
      "   - 高成本视频/音乐护栏：若本次任务核心需要调用高成本的**视频生成或音乐生成**模型，先在本对话向主人简洁汇报任务要点、选定/新建的专长子助手和初步生成方案，等待主人确认后再派发生成，严禁未经主人确认自动扣费生成视频或音乐。",
      "   - 常规任务（文案、文档、策划、代码、数据分析、图片/设计等）：立即调用 coordinate_bots(bot_ids=[子助手id], thread='new', reply='resume', title=任务简标题, message=完整需求+客观验收清单+交付规范) 派发干活，并明确叮嘱子助手「完成后直接把成果和交付文件汇报给我审核，不要自己调用团队任务提交工具」。派发成功后，向主人发一条简洁汇报（含任务概要、派发给了哪位专长助手；若刚新建了子助手，一并列出名称、SOUL 定位与已配 Skill），然后结束本轮等待子助手自动回传唤醒。",
      "4. 【子助手完成后自动一审（当你被子助手回传结果自动唤醒时）】：",
      "   - 先调用 collab_get_team_task() 读取最新任务状态、客观验收清单、recent_thread_attachments（已汇集子助手回传的全部交付物本地路径、尺寸/音视频元数据/文档摘录/提示词摘要）以及最新的 task_prefs.chief_auto_submit_on_approve。",
      "   - 逐条对照任务要求和客观验收清单执行一审：",
      "     * 若发现硬性缺陷或未达标项：严禁自己替子助手重做！直接调用 coordinate_bots(bot_ids=[子助手id], thread=原工作线程id, rework=true, message=具体不符合项与局部修改要求) 驳回给子助手修改（保留已合格成果，严禁重做已合格部分；本地一审自动返工最多 2 轮，超过 2 轮仍不达标则停止循环并升级汇报给主人）。",
      "     * 若一审全部合格：以 collab_get_team_task().task_prefs.chief_auto_submit_on_approve 实时值为准：",
      "       - 为 true（主人已开启代人审批提交）：直接调用 collab_submit_team_task 提交结构化交付简报与全部交付文件给团队验收，然后简洁告知主人「已一审通过并代为提交团队验收」；",
      "       - 为 false（默认关闭）：绝不私自提交！向主人呈报一审通过结论、交付物清单与效果摘要，等主人回复确认（如「可以/提交任务」）后，再调用 collab_submit_team_task 提交既有成果（严禁在主人确认后重新生成或重做已确认成果）。",
    ].filter(Boolean).join("\n");
    return { display, full };
  }

  if (ev.event_type === "task_submitted") {
    const currentRound = task.auto_revision_count ?? 0;
    const maxRounds = task.max_auto_revisions ?? 2;
    const remainingAuto = Math.max(0, maxRounds - currentRound);
    const display = `[团队待二审 · ${ev.team_name}] ${ev.assignee_name || "负责人"} 提交了任务「${task.title}」的交付成果`;
    const full = [
      `你是派发人/验收人的主协调助手。团队「${ev.team_name}」中的任务「${task.title}」刚刚提交了新交付批次，请你自动执行「二审质检」（只允许驳回或呈报待终审，绝对不能终审通过），然后向主人汇报。`,
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
      "请严格按以下步骤与铁律执行二审：",
      "1. 【终审权限铁律】派发方主协调助手只能做「二审」：发现硬性不符允许驳回，二审合格只能流转到待终审（ready_for_review）呈报主人，**绝对禁止在本轮执行终审通过（done），严禁调用 mode='human_decision'**！终审通过必须由派发人本人决定。",
      "2. 如本批次包含图片或视频抽帧图，请结合已附带的预览图片与尺寸/比例数据逐项核查画面质量、物种/元素准确性与是否无文字乱码/水印；如含文档/代码请阅读核对；若包含视频/音频，请在审阅意见中诚实提醒主人动态流畅度与声音情绪需本人播放终审。",
      "3. 严格区分「硬性不符」与「主观审美」：",
      "   - 只有存在明确、客观的硬性违背（如缺失文件、张数不够、画幅比例错误、文字明显乱码/严重崩图、遗漏核心要求）时，才判 hard_fail；",
      "   - 主观审美偏好或二选一方案绝对禁止自动驳回，必须判 pass 并把建议关注点写入 attention_items 交由主人终审拍板。",
      "4. 必须调用工具 collab_review_team_task（mode='bot_review'）写入你的二审结论：",
      "   - 二审合格或仅需主人主观拍板：verdict='pass'，填好 summary、passed_items、attention_items（状态将进入待终审拍板 ready_for_review，不会直接完成）；",
      "   - 明显硬性不符：verdict='hard_fail'，填好 summary、failed_criteria 与具体可执行的 actionable_fixes（网关会在未超上限时自动驳回给对方主协调助手安排子助手局部修改，超限则升级给双方真人）。",
      "5. 调用完工具后，用简洁明了的中文在当前对话向主人汇报：",
      "   - 如果 verdict='pass'：总结交付亮点、已核验通过项、建议主人重点关注/拍板的点，并提示主人可在任务详情页点击「验收通过 / 退回修改」，或直接在本对话明确回复「通过」/「指出修改意见退回」由你代为执行终审；",
      "   - 如果 verdict='hard_fail'：简短告知主人发现了哪些硬性问题，已二审驳回给对方返工（或因达到轮次上限已升级为人工介入）。",
    ].filter(Boolean).join("\n");
    return { display, full };
  }

  if (ev.event_type === "task_bot_rejected") {
    const payload = ev.payload ?? {};
    const round = Number(payload.round ?? task.auto_revision_count ?? 1);
    const maxRounds = Number(payload.max_rounds ?? task.max_auto_revisions ?? 2);
    const reviewerBot = String(payload.reviewer_bot_name ?? "派发方主协调助手");
    const summary = String(payload.summary ?? task.latest_bot_review_summary ?? "二审未通过，请按要求修改。");
    const failed = Array.isArray(payload.failed_criteria) ? payload.failed_criteria.map(String) : [];
    const fixes = Array.isArray(payload.actionable_fixes) ? payload.actionable_fixes.map(String) : [];
    const autoResubmit = payload.auto_resubmit !== false && task.assignee_auto_resubmit !== false;
    const display = `[二审自动驳回 ${round}/${maxRounds}] 「${task.title}」被 ${reviewerBot} 驳回，需要局部修改`;
    const workerLines = formatDelegatedWorkersBlock(opts?.delegatedWorkers);
    const full = [
      `团队任务「${task.title}」（团队：${ev.team_name}，team_id: ${ev.team_id}，task_id: ${task.id}）被派发方主协调助手「${reviewerBot}」二审驳回（第 ${round}/${maxRounds} 轮自动返工）。`,
      `【驳回摘要】${summary}`,
      ...(failed.length > 0 ? ["【未通过的硬性要求】", ...failed.map((f, i) => `${i + 1}. ${f}`)] : []),
      ...(fixes.length > 0 ? ["【具体修改指令】", ...fixes.map((f, i) => `${i + 1}. ${f}`)] : []),
      ...(workerLines.length > 0 ? ["", ...workerLines] : []),
      "",
      "执行与费用护栏（必须严格遵守）：",
      targetIsChief
        ? [
            "1. 【严禁主协调助手亲自干活】请不要自己亲自改图/改稿/重做！请调用 coordinate_bots（优先指定上方原专长子助手的 bot_id 和 thread_id，并传 rework=true；若此前尚未派发专长子助手，先按能力匹配或 create_bot + 配 Skill/SOUL.md 后派发）把上述驳回项下发给专长子助手做**局部返工**，并明确要求子助手只修改被指出的不符合项、保留未改动原版，改完后附带新版文件回传给你一审。",
            "2. 【高成本视频/音乐护栏】如果本次修改必须重新调用高成本的视频生成或音乐生成模型，请先整理修改方案并停下来，向主人说明驳回原因与预计重生成操作，等待主人确认后再派发生成，绝不擅自扣费重生成视频/音乐。",
            "3. 【子助手改完回传后的一审与提交】当你被子助手回传自动唤醒后，先调用 collab_get_team_task() 核对最新成果并进行一审；若一审仍不合格，继续 coordinate_bots(rework=true) 让子助手修正（本地最多 2 轮）；一审合格后：",
            autoResubmit || autoSubmitEnabled
              ? "   调用 collab_submit_team_task 自动重新提交复审——未改动原文件通过 latest_submission_files 的 file_id 传入 reuse_file_ids，新改文件传入 file_paths（严禁重做未要求改动的成果），随后简洁告知主人已完成局部修改并重提。"
              : "   先不要自动提交，将一审通过的新版成果展示给主人，等待主人确认后再调用 collab_submit_team_task（配合 reuse_file_ids 与 file_paths）提交。",
          ].join("\n")
        : [
            "1. 如果本次修改仅涉及文案、脚本、策划、代码、文档或图片生成/修图：请结合当前对话历史直接按上述修改指令完成局部修改与自查。只修改/重做被要求改动的部分，提交时通过 collab_get_team_task 的 latest_submission_files（reuse_file_ids）与 recent_thread_attachments 保留未改动原文件并替换新版，严禁重做未要求改动或主人已确认的版本。",
            autoResubmit
              ? "   修改并核验无误后，请直接调用 collab_submit_team_task 自动重新提交新版任务简报（说明具体改了什么）与新版成果文件路径，然后简洁告知主人本轮自动修正并已重提。"
              : "   修改完成后先不要自动提交，请把修改结果展示给主人等待主人确认后再调用 collab_submit_team_task 提交。",
            "2. 高成本视频/音乐护栏：如果本次修改必须重新调用高成本的视频生成或音乐生成模型，请先整理好修改后的分镜/提示词方案并停下来，向主人说明驳回原因与预计重生成操作，等待主人确认后再生成并提交，绝不擅自扣费重生成视频/音乐。",
          ].join("\n"),
    ].join("\n");
    return { display, full };
  }

  // task_human_rejected
  const feedback = String(ev.payload?.feedback ?? "验收人提出了修改意见，请查看任务详情。");
  const display = `[验收人退回修改 · ${ev.team_name}] 「${task.title}」：${feedback.slice(0, 120)}`;
  const workerLines = formatDelegatedWorkersBlock(opts?.delegatedWorkers);
  const full = [
    `团队「${ev.team_name}」中的任务「${task.title}」（team_id: ${ev.team_id}，task_id: ${task.id}）被派发人/验收人（${ev.reviewer_name || "验收人"}）终审退回修改：`,
    `【验收人修改意见】\n${feedback}`,
    ...(workerLines.length > 0 ? ["", ...workerLines] : []),
    "",
    targetIsChief
      ? [
          "请按以下流程处理：",
          "1. 【严禁主协调助手亲自干活】若属于常规修改（文案、文档、代码、图片等），立即调用 coordinate_bots（优先复用上方原专长子助手与原工作线程并传 rework=true；若无则先匹配或 create_bot + 配 Skill/SOUL.md 后派发）将验收人意见转化为明确的**局部修改指令**下发给专长子助手（只改被要求改动的部分，保留未改动原版），并同步告知主人已安排子助手修改；若涉及高成本视频/音乐重生成，先向主人汇报方案并等主人确认后再派发。",
          "2. 待子助手修改回传并自动唤醒你后，先调用 collab_get_team_task() 进行一审核验：",
          autoSubmitEnabled
            ? "   当前主人已开启「主协调助手代人审批提交」，一审合格后可直接调用 collab_submit_team_task（用 reuse_file_ids 保留未改动原文件 + file_paths 提交新版）重新提交复审并告知主人；若仍有歧义或重大变更请先请主人确认。"
            : "   当前未开启代人审批提交，一审合格后请将新版成果与修改说明呈报主人，等主人确认后再调用 collab_submit_team_task（用 reuse_file_ids 保留未改动原文件 + file_paths 提交新版）重新提交，严禁在主人确认后再次重新生成。",
        ].join("\n")
      : "请结合本对话历史，立刻向主人汇报这条修改意见并给出具体修改方案或草稿；若只需局部返工（无论是图片、视频、音乐/音频还是文档/代码），只修改被要求改动的部分，其余未改动成果保留原版。修改完成后等待主人点头审批，审批后直接调用 collab_submit_team_task（通过 file_paths 与 reuse_file_ids 保留未改动原文件并替换新版）重新提交，严禁在主人确认后再次重新生成或重做已确认版本。",
  ].join("\n");
  return { display, full };
}

export function createCollabTaskWorker(deps: CollabTaskWorkerDeps) {
  let active = false;
  let polling = false;
  let backoffUntil = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const runningEvents = new Set<string>();
  const readPrefs = () => deps.getTaskPrefs?.() ?? getCollabTaskPrefs();

  async function waitIfBusy(botId: string, threadId: string): Promise<boolean> {
    if (!deps.threadBusy) return true;
    const deadline = Date.now() + BUSY_WAIT_MS;
    while (deps.threadBusy(botId, threadId)) {
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    return true;
  }

  async function runEventTurn(
    bot: BotRecord,
    preferredThreadId: string,
    fallbackTitle: string,
    display: string,
    full: string,
    attachments?: Message["attachments"],
  ): Promise<string> {
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
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
    const after = () => {
      const all = store.messagesFor!(threadId);
      const idx = all.findIndex(line => line.id === userMessage.id);
      return idx >= 0 ? all.slice(idx + 1) : [];
    };

    let settled = false;
    let dispatchError: string | undefined;
    await startTurn(bot.id, full, {
      threadId,
      unattended: true,
      userMessage,
      onTurnSettled: () => { settled = true; },
      onDispatchError: msg => { dispatchError = msg; },
    });

    const deadline = Date.now() + TURN_WAIT_MS;
    while (Date.now() < deadline) {
      if (dispatchError !== undefined) throw new Error(dispatchError);
      if (settled) return threadId;
      if (hasPendingCard(after())) return threadId;
      await new Promise(resolve => setTimeout(resolve, TURN_CHECK_MS));
    }
    return threadId;
  }

  async function processEvent(ev: DoneBotClaimedTaskBotEvent): Promise<void> {
    if (runningEvents.has(ev.id)) return;
    runningEvents.add(ev.id);
    const ctx = deps.gateway.collabCtx();
    try {
      // If the assignee already picked up and bound this task locally (or started it), do not re-trigger it with a stale task_assigned prompt.
      if (ev.event_type === "task_assigned" && (getTaskBinding(ev.task_id) || ev.detail.task.status !== "todo")) {
        await collabCompleteTaskBotEvent(ctx, ev.id, { status: "done" });
        return;
      }
      let targetBot: BotRecord | undefined;
      let targetThreadId = "";
      const existingBinding = getTaskBinding(ev.task_id);

      if (ev.event_type === "task_bot_rejected" || ev.event_type === "task_human_rejected") {
        if (existingBinding?.chiefBotId) {
          const chiefBot = deps.store.bot(existingBinding.chiefBotId);
          if (chiefBot && !chiefBot.hidden) {
            targetBot = chiefBot;
            const preferred = existingBinding.chiefThreadId || existingBinding.threadId;
            const threadExists = !deps.store.taskByThread || Boolean(deps.store.taskByThread(chiefBot.id, preferred));
            targetThreadId = threadExists ? preferred : chiefBot.threadId;
          }
        }
        if (!targetBot && existingBinding) {
          const boundBot = deps.store.bot(existingBinding.botId);
          if (boundBot && !boundBot.hidden) {
            targetBot = boundBot;
            const threadExists = !deps.store.taskByThread || Boolean(deps.store.taskByThread(boundBot.id, existingBinding.threadId));
            targetThreadId = threadExists ? existingBinding.threadId : boundBot.threadId;
          }
        }
      }

      if (!targetBot) {
        targetBot = pickChiefBot(deps.store.bots);
        if (targetBot) {
          if (ev.event_type === "task_assigned" && deps.store.createTask) {
            const dedicated = deps.store.createTask(
              targetBot.id,
              `[团队任务] ${ev.detail.task.title.slice(0, 60)}`,
              false,
              undefined,
              undefined,
              "ask",
            );
            targetThreadId = dedicated?.threadId || targetBot.threadId;
          } else {
            targetThreadId = targetBot.threadId;
          }
        }
      }

      if (!targetBot) {
        await collabCompleteTaskBotEvent(ctx, ev.id, { status: "failed", error: "本机没有可用的主协调助手或执行助手。" });
        return;
      }

      const targetIsChief = Boolean(targetBot.chiefOfStaff);
      if (ev.event_type === "task_assigned" || ev.event_type === "task_bot_rejected" || ev.event_type === "task_human_rejected") {
        saveTaskBinding({
          teamId: ev.team_id,
          teamName: ev.team_name,
          taskId: ev.task_id,
          taskTitle: ev.detail.task.title,
          botId: targetBot.id,
          threadId: targetThreadId,
          ...(targetIsChief ? { chiefBotId: targetBot.id, chiefThreadId: targetThreadId } : {}),
        });
      }

      const downloaded = ev.event_type === "task_submitted"
        ? await downloadDeliverablesToSandbox(deps.gateway, ev.detail).catch(() => [])
        : [];
      const reviewAttachments = ev.event_type === "task_submitted" ? collectReviewImageAttachments(downloaded) : undefined;
      const delegatedWorkers = (ev.event_type === "task_bot_rejected" || ev.event_type === "task_human_rejected")
        ? (deps.listChildThreads?.(targetThreadId) ?? [])
        : [];
      const prefs = readPrefs();
      const { display, full } = buildTaskEventPrompt(ev, downloaded, {
        chiefAutoSubmitOnApprove: prefs.chief_auto_submit_on_approve,
        availableSpecialists: listAvailableSpecialists(deps.store.bots, targetBot.id),
        targetIsChief,
        delegatedWorkers,
      });
      const actualThreadId = await runEventTurn(
        targetBot,
        targetThreadId,
        `[团队任务] ${ev.detail.task.title}`,
        display,
        full,
        reviewAttachments,
      );
      if (
        actualThreadId !== targetThreadId
        && (ev.event_type === "task_assigned" || ev.event_type === "task_bot_rejected" || ev.event_type === "task_human_rejected")
      ) {
        saveTaskBinding({
          teamId: ev.team_id,
          teamName: ev.team_name,
          taskId: ev.task_id,
          taskTitle: ev.detail.task.title,
          botId: targetBot.id,
          threadId: actualThreadId,
          ...(targetIsChief ? { chiefBotId: targetBot.id, chiefThreadId: actualThreadId } : {}),
        });
      }
      await collabCompleteTaskBotEvent(ctx, ev.id, { status: "done" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "处理团队任务自动化事件失败";
      await collabCompleteTaskBotEvent(ctx, ev.id, { status: "failed", error: msg.slice(0, 400) }).catch(() => {});
    } finally {
      runningEvents.delete(ev.id);
    }
  }

  async function tick(): Promise<void> {
    if (polling || runningEvents.size >= 2 || Date.now() < backoffUntil) return;
    polling = true;
    try {
      const res = await collabClaimTaskBotEvent(deps.gateway.collabCtx()) as {
        event?: DoneBotClaimedTaskBotEvent | null;
      };
      if (res?.event) {
        void processEvent(res.event);
      }
    } catch (error) {
      if (error instanceof DoneBotGatewayError) {
        if (error.status === 429) {
          backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
        } else if (error.status === 401 || error.status === 403 || error.status === 404) {
          setActive(false);
        }
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
