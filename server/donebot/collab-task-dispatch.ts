import { isExternalCodingAgentBot } from "../../shared/coding-agents.ts";
import type { DoneBotTeamChannel, DoneBotTeamMemberProfile } from "../../shared/donebot-collab.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import type { CollabBotTurnOptions } from "./collab-chat-bots.ts";
import { collabListTeamChannels, collabListTeamMemberProfiles } from "./collab-gateway.ts";
import { DoneBotGatewayError, type DoneBotGateway } from "./gateway.ts";

export interface CollabTaskDispatchDeps {
  gateway: DoneBotGateway;
  store: Pick<Store, "bots" | "bot"> & Partial<Pick<Store, "taskByThread" | "createTask" | "appendMessage" | "messagesFor">>;
  startTurn?: (botId: string, text: string, opts: CollabBotTurnOptions) => Promise<unknown>;
  threadBusy?: (botId: string, threadId: string) => boolean;
  kickTaskWorker?: () => void;
}

export interface CollabTaskDispatchInput {
  prompt: string;
  channel_id?: string;
  source_quote?: string;
}

export interface CollabTaskDispatchResult {
  bot_id: string;
  bot_name: string;
  thread_id: string;
  ok: boolean;
  reply: string;
  pending_card: boolean;
}

const BUSY_WAIT_MS = 10_000;
const TURN_WAIT_MS = 90_000;
const TURN_CHECK_MS = 200;

function pickChiefBot(bots: readonly BotRecord[]): BotRecord | undefined {
  const visible = bots.filter(b => !b.hidden && !isExternalCodingAgentBot(b));
  return visible.find(b => b.chiefOfStaff) ?? visible[0];
}

function hasPendingCard(lines: readonly Message[]): boolean {
  return lines.some(line => line.card?.requestId !== undefined && !line.card.answered && !line.card.dismissed);
}

function localTodayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function dispatchTeamTaskViaChiefBot(
  deps: CollabTaskDispatchDeps,
  teamId: string,
  input: CollabTaskDispatchInput,
): Promise<CollabTaskDispatchResult> {
  const promptText = input.prompt.trim();
  if (!promptText) {
    throw new DoneBotGatewayError(400, "invalid_input", "请用一句话描述你想派发的任务。");
  }
  const chief = pickChiefBot(deps.store.bots);
  if (!chief) {
    throw new DoneBotGatewayError(400, "no_chief_bot", "本机暂无可用的主协调助手，请先创建一个机器人。");
  }
  if (!deps.startTurn || !deps.store.appendMessage || !deps.store.messagesFor) {
    throw new DoneBotGatewayError(503, "dispatch_unavailable", "本机主协调助手调度未就绪，请稍后再试。");
  }

  const ctx = deps.gateway.collabCtx();
  const [identity, snap, members, channels, profiles] = await Promise.all([
    deps.gateway.collabIdentity(),
    deps.gateway.workspaceSnapshot().catch(() => ({ workspaces: [] })),
    deps.gateway.teamMembers(teamId).catch(() => []),
    collabListTeamChannels(ctx, teamId, false).catch(() => []) as Promise<DoneBotTeamChannel[]>,
    collabListTeamMemberProfiles(ctx, teamId).catch(() => []) as Promise<DoneBotTeamMemberProfile[]>,
  ]);

  const teamName = snap.workspaces?.find(w => w.id === teamId)?.name || "当前团队";
  const myUserId = Number(identity.account_id);
  const jobByUser = new Map<number, string>();
  for (const p of Array.isArray(profiles) ? profiles : []) {
    if (p.job_title?.trim()) jobByUser.set(p.user_id, p.job_title.trim());
  }

  const memberLines = (Array.isArray(members) ? members : []).map(m => {
    const label = m.remark?.trim() || m.nickname?.trim() || m.email;
    const tags = [m.role === "owner" ? "所有者" : m.role === "admin" ? "管理员" : "成员"];
    const job = jobByUser.get(m.user_id);
    if (job) tags.push(`岗位：${job}`);
    if (m.user_id === myUserId) tags.push("主人本人/默认验收人");
    return `- user_id=${m.user_id} | ${label}（${tags.join("，")}）`;
  });

  const activeChannels = (Array.isArray(channels) ? channels : []).filter(c => !c.archived_at);
  const preferredChannel = input.channel_id?.trim()
    ? activeChannels.find(c => c.id === input.channel_id?.trim())
    : undefined;
  const channelLines = activeChannels.map(ch =>
    `- channel_id=${ch.id} | ${ch.is_private ? `🔒 ${ch.name}` : `#${ch.name}`}${ch.id === preferredChannel?.id ? "（用户当前所在频道）" : ""}`,
  );

  const display = `[团队派发任务 · ${teamName}] ${promptText}`;
  const full = [
    `主人正在团队「${teamName}」的任务面板里直接让你派发任务。当前本地日期：${localTodayIso()}。`,
    `【团队ID】${teamId}`,
    `【主人 user_id（默认验收人）】${myUserId}`,
    ...(preferredChannel ? [`【默认频道】${preferredChannel.name}（channel_id: ${preferredChannel.id}）`] : []),
    "",
    "【本团队完整成员名单】",
    ...(memberLines.length > 0 ? memberLines : ["（暂无成员信息）"]),
    "",
    "【本团队活跃频道列表】",
    ...(channelLines.length > 0 ? channelLines : ["（暂无子频道，可不填 channel_id）"]),
    ...(input.source_quote?.trim() ? ["", "【引用的聊天原消息】", input.source_quote.trim()] : []),
    "",
    `【主人的派发需求】\n${promptText}`,
    "",
    "请严格按规则执行：",
    "1. 上方已给出本团队最新完整的 team_id、成员 user_id 和 channel_id，直接据此匹配，无需再调用 collab_team_directory。",
    "2. 如果这是 1~2 条清晰明确的任务需求，请立即调用 collab_create_team_task 创建任务（自动提炼 2~5 条客观可验证的 acceptance_criteria，默认 reviewer_id 为主人，auto_review_enabled=true，max_auto_revisions=2，notify_channel=true），完成后用简洁中文给出回执（含任务标题、负责人、截止时间与验收清单）。",
    "3. 如果需求一次要拆成 3 条及以上任务，或指派对象/核心要求存在明显歧义，请先用简洁列表展示草案并向主人确认，不要擅自批量建单。",
  ].join("\n");

  let threadId = chief.threadId;
  if (deps.threadBusy) {
    const busyDeadline = Date.now() + BUSY_WAIT_MS;
    while (deps.threadBusy(chief.id, threadId) && Date.now() < busyDeadline) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (deps.threadBusy(chief.id, threadId) && deps.store.createTask) {
      const alt = deps.store.createTask(chief.id, `[派发任务] ${promptText.slice(0, 50)}`, false, undefined, undefined, "ask");
      if (alt) threadId = alt.threadId;
    }
    if (deps.threadBusy(chief.id, threadId)) {
      throw new DoneBotGatewayError(409, "chief_bot_busy", `「${chief.name}」当前正在处理其他任务，请稍后再试或直接切到对话中派发。`);
    }
  }

  const userMessage = deps.store.appendMessage(threadId, {
    role: "user",
    kind: "text",
    text: display,
    via: "api",
  });
  const after = () => {
    const all = deps.store.messagesFor!(threadId);
    const idx = all.findIndex(line => line.id === userMessage.id);
    return idx >= 0 ? all.slice(idx + 1) : [];
  };

  let settled = false;
  let dispatchError: string | undefined;
  await deps.startTurn(chief.id, full, {
    threadId,
    automationSource: "api",
    unattended: true,
    userMessage,
    onTurnSettled: () => { settled = true; },
    onDispatchError: msg => { dispatchError = msg; },
  });

  const deadline = Date.now() + TURN_WAIT_MS;
  let pendingCard = false;
  while (Date.now() < deadline) {
    if (dispatchError !== undefined) {
      throw new DoneBotGatewayError(502, "chief_bot_failed", dispatchError);
    }
    if (settled) break;
    if (hasPendingCard(after())) {
      pendingCard = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, TURN_CHECK_MS));
  }

  deps.kickTaskWorker?.();

  const replyFromMessages = [...after()]
    .reverse()
    .find(m => m.role === "bot" && typeof m.text === "string" && m.text.trim())
    ?.text?.trim() ?? "";
  const reply = (replyFromMessages || (pendingCard
    ? `「${chief.name}」需要你进一步确认后再继续，请打开对话确认。`
    : `已通知「${chief.name}」处理该派发需求，任务创建后将自动出现在看板上。`));

  return {
    bot_id: chief.id,
    bot_name: chief.name,
    thread_id: threadId,
    ok: true,
    reply,
    pending_card: pendingCard,
  };
}
