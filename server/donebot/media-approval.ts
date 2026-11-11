import { randomUUID } from "node:crypto";
import type { Store } from "../store.ts";
import { conversationLanguage, serverLine } from "../server-lines.ts";
import type { MediaContext, MediaSubmission } from "./media.ts";

const MEDIA_KIND_LINES = {
  image: "server.donebot.mediaKindImage", video: "server.donebot.mediaKindVideo", music: "server.donebot.mediaKindMusic",
} as const;

export function createMediaApproval(deps: { store: Store; full(botId: string, threadId: string): boolean }) {
  const pending = new Map<string, { context: MediaContext; finish(allowed: boolean, dismissed: boolean): void }>();
  return {
    authorize(context: MediaContext, input: MediaSubmission): Promise<void> {
      if (!context.active()) return Promise.reject(new Error("This media turn has ended."));
      if (deps.full(context.botId, context.threadId)) return Promise.resolve();
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        let interval: ReturnType<typeof setInterval>;
        const deadline = Date.now() + 15 * 60_000;
        const bot = deps.store.bot(context.botId);
        const language = conversationLanguage(context.threadId);
        const kind = serverLine(language, MEDIA_KIND_LINES[input.kind]);
        const model = input.model;
        const card = deps.store.appendMessage(context.threadId, { role: "bot", kind: "options", card: {
          title: serverLine(language, "server.donebot.mediaApprovalTitle", { bot: bot?.name ?? "Bot", kind }),
          subtitle: serverLine(language, "server.donebot.mediaApprovalSubtitle", { model, parameters: JSON.stringify(input.parameters).slice(0, 600) }),
          options: [serverLine(language, "server.donebot.mediaApprovalAllow"), serverLine(language, "server.donebot.mediaApprovalDeny")], requestId, tool: "donebot_media",
        } });
        const entry = { context, finish(allowed: boolean, dismissed: boolean) {
          if (!pending.delete(requestId)) return;
          clearInterval(interval);
          const current = deps.store.messagesFor(context.threadId).find(x => x.id === card.id);
          if (current?.card && !current.card.answered) deps.store.patchMessage(context.threadId, card.id, { card: { ...current.card, answered: allowed ? "allow" : "deny", dismissed } });
          if (allowed && context.active()) resolve();
          else reject(Object.assign(new Error("Media generation permission was denied or expired."), { status: 403 }));
        } };
        pending.set(requestId, entry);
        interval = setInterval(() => { if (!context.active() || Date.now() >= deadline) entry.finish(false, true); }, 500);
        interval.unref?.();
      });
    },
    answer(requestId: string, behavior?: string): boolean {
      const entry = pending.get(requestId);
      if (!entry) return false;
      entry.finish(behavior === "allow", false);
      return true;
    },
    close(): void { for (const entry of pending.values()) entry.finish(false, true); },
  };
}
