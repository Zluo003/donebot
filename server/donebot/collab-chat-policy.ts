import { AsyncLocalStorage } from "node:async_hooks";

export const COLLAB_CHAT_THREAD_TITLE_PREFIX = "[群聊] ";
export const COLLAB_CHAT_MEDIA_BLOCK_MESSAGE = "群聊中的机器人仅允许使用文本对话（LLM）和画图，禁止使用视频模型和音乐模型。";

export interface CollabChatThreadMeta {
  scopeType: "team" | "group";
  targetId: string;
  chatBotId: string;
  botName: string;
}

const collabThreads = new Map<string, CollabChatThreadMeta>();
const activeCollabTurn = new AsyncLocalStorage<string>();

export function registerCollabChatThread(threadId: string, meta: CollabChatThreadMeta): void {
  if (!threadId) return;
  collabThreads.set(threadId, meta);
}

export function getCollabChatThread(threadId: string): CollabChatThreadMeta | undefined {
  return threadId ? collabThreads.get(threadId) : undefined;
}

export function isCollabChatThread(threadId: string, taskTitle?: string | null): boolean {
  if (threadId && collabThreads.has(threadId)) return true;
  if (typeof taskTitle === "string" && taskTitle.startsWith(COLLAB_CHAT_THREAD_TITLE_PREFIX)) return true;
  return false;
}

export function runWithCollabChatTurn<T>(threadId: string, fn: () => T): T {
  return activeCollabTurn.run(threadId, fn);
}

export function inCollabChatTurn(): boolean {
  return Boolean(activeCollabTurn.getStore());
}

export function isForbiddenCollabChatMediaTool(toolName: string): boolean {
  const lower = toolName.trim().toLowerCase();
  if (lower === "agents_generate_video" || lower === "agents_generate_audio" || lower === "agents_generate_music") {
    return true;
  }
  return /(?:^|[_-])generate[_-]?(?:video|music|audio|song)(?:$|[_-])/.test(lower);
}

/** Tests only. */
export function resetCollabChatThreadsForTests(): void {
  collabThreads.clear();
}
