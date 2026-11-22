import { redactSecretsInText } from "../../shared/redact.ts";
import type { DoneBotClaimedBotInvocation } from "../../shared/donebot-collab.ts";
import type { Message, Store } from "../store.ts";
import { collabClaimBotInvocation, collabReplyBotInvocation } from "./collab-gateway.ts";
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

function collectReplyText(lines: readonly Message[]): string {
  return redactSecretsInText(
    lines
      .filter(line => line.role === "bot" && line.kind === "text" && typeof line.text === "string" && line.text.trim())
      .map(line => line.text!.trim())
      .join("\n\n"),
  );
}

function formatChatPrompt(inv: DoneBotClaimedBotInvocation): { display: string; full: string } {
  const kindLabel = inv.scope_type === "team" ? "团队聊天" : "好友群聊";
  const chatTitle = inv.chat_name?.trim() || inv.target_id;
  const trigger = inv.recent_messages.find(m => m.id === inv.message_id) ?? inv.recent_messages[inv.recent_messages.length - 1];
  const triggerSender = trigger
    ? (trigger.sender_remark?.trim() || trigger.sender_nickname?.trim() || trigger.sender_email)
    : "群成员";
  const triggerBody = trigger?.body?.trim() || "(空消息)";

  const historyLines = inv.recent_messages.slice(-20).map(msg => {
    const who = msg.sender_kind === "bot"
      ? `[机器人] ${msg.sender_bot_name || "Bot"}`
      : (msg.sender_remark?.trim() || msg.sender_nickname?.trim() || msg.sender_email);
    const content = msg.kind === "file"
      ? `[文件: ${msg.file_name || "文件"}]${msg.body ? ` ${msg.body}` : ""}`
      : msg.body;
    return `${who}: ${content}`;
  });

  const display = `[${kindLabel} · ${chatTitle}] ${triggerSender}: ${triggerBody}`;
  const full = [
    `你在 DoneBot ${kindLabel}「${chatTitle}」中被已获授权的成员 ${triggerSender} 通过 @${inv.bot_name} 调用。`,
    "你正在机器人所有者的本机 DoneBot 中执行任务，请结合最近群聊上下文直接回复对方的问题或任务，回答要清晰、实用、简洁，不要泄露本机隐私路径或凭据。",
    "",
    "最近群聊记录：",
    ...historyLines,
    "",
    `请直接回复 ${triggerSender} 的最新消息：${triggerBody}`,
  ].join("\n");

  return { display, full };
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

  async function processInvocation(inv: DoneBotClaimedBotInvocation): Promise<void> {
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

      const { display, full } = formatChatPrompt(inv);
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
        void processInvocation(res.invocation);
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
