import type { IncomingMessage, ServerResponse } from "node:http";
import type { DoneBotGateway } from "../donebot/gateway.ts";
import { createDoneBotMobileHost } from "../donebot/mobile-host.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { BotRecord, Store, StoreChange } from "../store.ts";

interface MobileRuntimeDeps {
  dataDir: string;
  gateway: DoneBotGateway;
  sessions: SessionRegistry;
  store: Pick<Store, "botByThread" | "markTerminalAssistantMessage" | "patchMessage" | "suggestTaskLink" | "activePath">;
  handle(req: IncomingMessage, res: ServerResponse): unknown;
  name(): string;
  sourceUrl: string;
}

export function createDoneBotMobileRuntime(deps: MobileRuntimeDeps) {
  const { store } = deps;
  const host = createDoneBotMobileHost({
    dataDir: deps.dataDir, gateway: deps.gateway, sessions: deps.sessions,
    handle: deps.handle, name: deps.name,
    ...(deps.sourceUrl.endsWith(".ts") && process.env.NODE_ENV === "test" ? { fixtureRelay: process.env.DONEBOT_MOBILE_FIXTURE_RELAY } : {}),
  });
  return {
    ...host,
    messageChanged(change: StoreChange) {
      if (change.type !== "message" || change.message.role !== "bot" || change.message.kind !== "text" || change.message.turnId) return;
      const bot = store.botByThread(change.threadId);
      if (bot) host.message({ botId: bot.id, threadId: change.threadId, messageId: change.message.id });
    },
    completeTurn(bot: BotRecord | undefined, threadId: string, completedTurnId: string | undefined, ok: boolean) {
      if (!completedTurnId) return;
      const terminal = store.markTerminalAssistantMessage(threadId, completedTurnId);
      if (terminal) {
        store.patchMessage(threadId, terminal.id, { turnSucceeded: ok });
        if (bot) host.message({ botId: bot.id, threadId, messageId: terminal.id });
      }
      if (bot && ok) store.suggestTaskLink(bot.id, threadId, store.activePath(threadId)
        .filter((message) => message.role === "bot" && message.kind === "text" && message.turnId === completedTurnId)
        .map((message) => message.text ?? "").join("\n"));
    },
  };
}
