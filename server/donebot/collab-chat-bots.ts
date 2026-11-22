import { redactSecretsInText } from "../../shared/redact.ts";
import type {
  DoneBotClaimedBotInvocation,
  DoneBotCollabChatBot,
  DoneBotCollabGroup,
} from "../../shared/donebot-collab.ts";
import type { DoneBotTeamMember } from "../../shared/donebot-teams.ts";
import type { Message, Store } from "../store.ts";
import {
  collabClaimBotInvocation,
  collabListChatBots,
  collabListGroups,
  collabReplyBotInvocation,
} from "./collab-gateway.ts";
import { DoneBotGatewayError, type DoneBotGateway } from "./gateway.ts";

export interface CollabBotTurnOutcome {
  ok: boolean;
  text: string;
}

export interface CollabBotTurnOptions {
  threadId: string;
  automationSource: "api";
  unattended: true;
  userMessage: Message;
  onSettled: (outcome: CollabBotTurnOutcome) => void;
  onDispatchError: (message: string) => void;
}

export interface CollabChatBotWorkerDeps {
  gateway: DoneBotGateway;
  store: Pick<Store, "bot"> & Partial<Pick<Store, "taskByThread" | "createTask" | "appendMessage" | "messagesFor">>;
  startTurn?: (botId: string, text: string, opts: CollabBotTurnOptions) => Promise<unknown>;
  threadBusy?: (botId: string, threadId: string) => boolean;
  generateBotText?: (botId: string, prompt: string, signal?: AbortSignal) => Promise<string | undefined>;
}

const POLL_MS = 3_000;
const TURN_WAIT_MS = 120_000;
const TURN_CHECK_MS = 250;

function hasPendingCard(lines: readonly Message[]): boolean {
  return lines.some(line => line.card?.requestId !== undefined && !line.card.answered && !line.card.dismissed);
}

export interface CollabChatContextMember {
  userId: number;
  name: string;
  roleLabel: string;
}

export interface CollabChatContextBot {
  id: string;
  name: string;
  title: string;
  ownerUserId: number;
  ownerName: string;
}

export interface CollabChatContext {
  chatName?: string;
  ownerUserId: number;
  ownerName: string;
  members: CollabChatContextMember[];
  chatBots: CollabChatContextBot[];
}

function formatPersonLabel(person: { remark?: string; nickname?: string; email?: string }): string {
  const remark = person.remark?.trim() || "";
  const nickname = person.nickname?.trim() || "";
  const email = person.email?.trim() || "";
  if (remark && nickname && remark !== nickname) return `${remark}（昵称：${nickname}）`;
  return remark || nickname || email || "群成员";
}

function teamRoleLabel(role: DoneBotTeamMember["role"]): string {
  if (role === "owner") return "团队所有者";
  if (role === "admin") return "团队管理员";
  return "团队成员";
}

export function collectReplyText(lines: readonly Message[]): string {
  const picked: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (line.role !== "bot") continue;
    if (line.kind === "text") {
      const text = typeof line.text === "string" ? line.text.trim() : "";
      if (text) picked.unshift(text);
      continue;
    }
    if (picked.length > 0) break;
  }
  return redactSecretsInText(picked.join("\n\n"));
}

async function loadChatContext(
  deps: CollabChatBotWorkerDeps,
  inv: DoneBotClaimedBotInvocation,
  ownerIdentity: { account_id: string; email: string },
): Promise<CollabChatContext> {
  const ctx = deps.gateway.collabCtx();
  const ownerUserId = Number(ownerIdentity.account_id) || 0;
  let chatName = inv.chat_name?.trim() || "";
  let members: CollabChatContextMember[] = [];
  let chatBots: CollabChatContextBot[] = [];

  await Promise.all([
    (async () => {
      try {
        if (inv.scope_type === "group") {
          const raw = await collabListGroups(ctx);
          const groups = Array.isArray(raw) ? (raw as DoneBotCollabGroup[]) : [];
          const found = groups.find(g => g.id === inv.target_id);
          if (found) {
            if (!chatName && found.name?.trim()) chatName = found.name.trim();
            members = (found.members ?? []).map(m => ({
              userId: m.user_id,
              name: formatPersonLabel(m),
              roleLabel: m.user_id === found.creator_id ? "群主" : "群成员",
            }));
          }
        } else if (inv.scope_type === "team" && typeof deps.gateway.teamMembers === "function") {
          const list = await deps.gateway.teamMembers(inv.target_id);
          members = (Array.isArray(list) ? list : []).map(m => ({
            userId: m.user_id,
            name: formatPersonLabel(m),
            roleLabel: teamRoleLabel(m.role),
          }));
        }
      } catch { /* Best-effort roster lookup */ }
    })(),
    (async () => {
      try {
        const raw = await collabListChatBots(ctx, inv.scope_type, inv.target_id);
        const list = Array.isArray(raw) ? (raw as DoneBotCollabChatBot[]) : [];
        chatBots = list.map(b => ({
          id: b.id,
          name: b.bot_name,
          title: b.bot_title?.trim() || "",
          ownerUserId: b.owner_user_id,
          ownerName: formatPersonLabel({
            remark: b.owner_remark,
            nickname: b.owner_nickname,
            email: b.owner_email,
          }),
        }));
      } catch { /* Best-effort chat bots lookup */ }
    })(),
  ]);

  const ownerFromRoster = members.find(m => m.userId === ownerUserId)?.name
    || chatBots.find(b => b.id === inv.chat_bot_id)?.ownerName
    || ownerIdentity.email;

  return {
    chatName,
    ownerUserId,
    ownerName: ownerFromRoster,
    members,
    chatBots,
  };
}

export function formatChatPrompt(
  inv: DoneBotClaimedBotInvocation,
  chatContext?: CollabChatContext,
): { display: string; full: string } {
  const kindLabel = inv.scope_type === "team" ? "团队聊天" : "好友群聊";
  const chatTitle = chatContext?.chatName?.trim() || inv.chat_name?.trim() || inv.target_id;
  const memberById = new Map((chatContext?.members ?? []).map(m => [m.userId, m]));
  const trigger = inv.recent_messages.find(m => m.id === inv.message_id) ?? inv.recent_messages[inv.recent_messages.length - 1];
  const triggerSenderId = trigger?.sender_id ?? 0;
  const triggerSender = (triggerSenderId ? memberById.get(triggerSenderId)?.name : undefined)
    || (trigger ? formatPersonLabel({
      remark: trigger.sender_remark,
      nickname: trigger.sender_nickname,
      email: trigger.sender_email,
    }) : "群成员");
  const triggerBody = trigger?.body?.trim() || "(空消息)";
  const ownerUserId = chatContext?.ownerUserId ?? 0;
  const ownerName = chatContext?.ownerName || "";
  const callerIsOwner = ownerUserId > 0 && triggerSenderId === ownerUserId;

  const rosterLines: string[] = [];
  if (chatContext && chatContext.members.length > 0) {
    rosterLines.push(`当前${kindLabel}完整成员名单（共 ${chatContext.members.length} 人）：`);
    for (const m of chatContext.members) {
      const tags = [m.roleLabel];
      if (ownerUserId > 0 && m.userId === ownerUserId) tags.push("你的主人/Bot所有者");
      if (triggerSenderId > 0 && m.userId === triggerSenderId) tags.push("当前发言人");
      rosterLines.push(`- ${m.name}（${tags.join("、")}）`);
    }
  }
  if (chatContext && chatContext.chatBots.length > 0) {
    rosterLines.push(`当前群内已添加的机器人（共 ${chatContext.chatBots.length} 个）：`);
    for (const b of chatContext.chatBots) {
      const selfTag = b.id === inv.chat_bot_id ? "你本人，" : "";
      const titlePart = b.title ? `，简介：${b.title}` : "";
      rosterLines.push(`- ${b.name}（${selfTag}所有者：${b.ownerName}${titlePart}）`);
    }
  }

  const historyLines = inv.recent_messages.slice(-20).map(msg => {
    const who = msg.sender_kind === "bot"
      ? `[机器人] ${msg.sender_bot_name || "Bot"}`
      : (memberById.get(msg.sender_id)?.name || formatPersonLabel({
        remark: msg.sender_remark,
        nickname: msg.sender_nickname,
        email: msg.sender_email,
      }));
    const content = msg.kind === "file"
      ? `[文件: ${msg.file_name || "文件"}]${msg.body ? ` ${msg.body}` : ""}`
      : msg.body;
    return `${who}: ${content}`;
  });

  const display = `[${kindLabel} · ${chatTitle}] ${triggerSender}: ${triggerBody}`;
  const fullParts = [
    `你在 DoneBot ${kindLabel}「${chatTitle}」中被${callerIsOwner ? "你的主人" : "已获主人授权的群成员"} ${triggerSender} 通过 @${inv.bot_name} 调用。`,
    ownerName ? `你的主人（Bot 所有者）是：${ownerName}。` : "",
    "你正在主人本机 DoneBot 中处理群聊任务，请结合群成员名单和最近群聊上下文直接回复，回答清晰、实用、简洁，不要泄露本机隐私路径或凭据。",
    ...(rosterLines.length > 0
      ? [
        "",
        ...rosterLines,
        "重要：以上成员和机器人名单就是本群当前的全部真实成员（包括尚未发言的成员），请直接以此名单为准，无需调用工具去查群成员；切勿把主人本机中未加入本群的其他机器人或联系人混成本群成员。",
      ]
      : []),
    "",
    "最近群聊记录：",
    ...historyLines,
    "",
    `请直接回复 ${triggerSender} 的最新消息：${triggerBody}`,
  ].filter((line, idx, arr) => !(line === "" && (idx === 0 || arr[idx - 1] === "")));

  return { display, full: fullParts.join("\n") };
}

export function createCollabChatBotWorker(deps: CollabChatBotWorkerDeps) {
  let active = false;
  let polling = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const runningInvocations = new Set<string>();
  const threadByChat = new Map<string, string>();

  async function runViaLocalTurn(inv: DoneBotClaimedBotInvocation, display: string, full: string): Promise<string> {
    const { store, startTurn, threadBusy } = deps;
    if (!startTurn || !store.taskByThread || !store.createTask || !store.appendMessage || !store.messagesFor) {
      return "";
    }
    const key = `${inv.local_bot_id}:${inv.scope_type}:${inv.target_id}`;
    let threadId = threadByChat.get(key);
    if (threadId && !store.taskByThread(inv.local_bot_id, threadId)) {
      threadId = undefined;
    }
    if (!threadId) {
      const title = `[群聊] ${inv.chat_name?.trim() || "协作群聊"}`.slice(0, 80);
      const task = store.createTask(inv.local_bot_id, title, false, undefined, undefined, "ask");
      if (!task) return "";
      threadId = task.threadId;
      threadByChat.set(key, threadId);
    }
    if (threadBusy?.(inv.local_bot_id, threadId)) {
      return "";
    }

    const userMessage = store.appendMessage(threadId, {
      role: "user",
      kind: "text",
      text: display,
      via: "api",
    });
    const after = () => {
      const all = store.messagesFor!(threadId!);
      const idx = all.findIndex(line => line.id === userMessage.id);
      return idx >= 0 ? all.slice(idx + 1) : [];
    };

    let settled: CollabBotTurnOutcome | undefined;
    let dispatchError: string | undefined;
    await startTurn(inv.local_bot_id, full, {
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
      if (settled) break;
      if (hasPendingCard(after())) {
        return "该操作涉及本机敏感权限，需要机器人所有者在 DoneBot 对应会话中审批后继续。";
      }
      await new Promise(resolve => setTimeout(resolve, TURN_CHECK_MS));
    }
    if (hasPendingCard(after())) {
      return "该操作涉及本机敏感权限，需要机器人所有者在 DoneBot 对应会话中审批后继续。";
    }
    const text = collectReplyText(after());
    if (text) return text;
    if (settled && !settled.ok && settled.text) {
      throw new Error(settled.text);
    }
    return settled?.text?.trim() ? redactSecretsInText(settled.text.trim()) : "";
  }

  async function processInvocation(
    inv: DoneBotClaimedBotInvocation,
    identity: { account_id: string; email: string },
  ): Promise<void> {
    if (runningInvocations.has(inv.id)) return;
    runningInvocations.add(inv.id);
    const ctx = deps.gateway.collabCtx();
    try {
      const bot = deps.store.bot(inv.local_bot_id);
      if (!bot || bot.hidden) {
        await collabReplyBotInvocation(ctx, inv.id, {
          body: `抱歉，本机未找到机器人「${inv.bot_name}」，可能已被移除或停用。`,
        });
        return;
      }

      const chatContext = await loadChatContext(deps, inv, identity);
      const { display, full } = formatChatPrompt(inv, chatContext);
      let reply = "";
      try {
        reply = await runViaLocalTurn(inv, display, full);
      } catch {
        reply = "";
      }
      if (!reply && deps.generateBotText) {
        const text = await deps.generateBotText(bot.id, full, AbortSignal.timeout(90_000));
        if (text?.trim()) reply = redactSecretsInText(text.trim());
      }
      if (!reply) {
        await collabReplyBotInvocation(ctx, inv.id, {
          body: `抱歉，${bot.name} 当前正忙或未能生成回复，请稍后再 @ 我重试。`,
        });
        return;
      }
      await collabReplyBotInvocation(ctx, inv.id, { body: reply });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "本机机器人执行失败";
      await collabReplyBotInvocation(ctx, inv.id, { error: msg.slice(0, 400) }).catch(() => {});
    } finally {
      runningInvocations.delete(inv.id);
    }
  }

  async function tick(): Promise<void> {
    if (polling || runningInvocations.size >= 3) return;
    polling = true;
    try {
      const identity = await deps.gateway.collabIdentity();
      const res = await collabClaimBotInvocation(deps.gateway.collabCtx(), identity.installation_id) as {
        invocation?: DoneBotClaimedBotInvocation | null;
      };
      if (res?.invocation) {
        void processInvocation(res.invocation, identity);
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

  function stop() {
    setActive(false);
  }

  return { setActive, kick, stop };
}
