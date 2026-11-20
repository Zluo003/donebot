import { dirname } from "node:path";

import { createDialer } from "../bot-link/dial.ts";
import { createBotLink } from "../bot-link/link.ts";
import type { Coordinator, HandoffView } from "../coordinator.ts";
import { redactSecretsInText } from "../redact.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createBotLinkRoutes, linkSessionUser } from "../routes/bot-link.ts";
import { isLinkedId } from "../bot-link/protocol.ts";
import type { Level } from "../runtime/types.ts";
import type { BotRecord, Store } from "../store.ts";
import type { HandoffFiles, PassedFile } from "./handoff-files.ts";
import { sentRow, teammateResultRow } from "./handoff-sent.ts";
import { createLinkedRooms, type LinkedRoomsDeps } from "./bot-link-rooms.ts";

export interface BotLinkHostDeps {
  dataDir: string;
  environmentId: string;
  personal(): boolean;
  account?(): string | null;
  store: Pick<Store, "bots" | "bot" | "standIns" | "createTask" | "taskByThread" | "appendMessage" | "patchTask" | "onChange" | "group" | "groups" | "groupTaskByThread" | "markGroupThreadUnread" | "activePath" | "messagesFor" | "patchGroup">;
  
  roomLine: LinkedRoomsDeps["line"];
  roomFollow?: LinkedRoomsDeps["follow"];
  
  roomWindow: LinkedRoomsDeps["window"];
  roomOpener?: LinkedRoomsDeps["opener"];
  
  roomChanged?(groupId: string): void;
  coordinator(): Coordinator;
  kick(): void;
  level(bot: BotRecord): Level;
  refusal(bot: BotRecord): string | null;
  language(threadId: string): string | undefined;
  personName(threadId: string): string | undefined;
  sessions: { issue(input: { label: string; scopes: Array<"admin" | "client">; email?: string; userId?: string }): { token: string; session: { id: string } }; revoke(id: string): boolean };
  local(auth: RequestAuth): boolean;
  owner(auth: RequestAuth): boolean;
  power(): { sleeping(): boolean; sleepSignal(): AbortSignal } | null | undefined;
  files: Pick<HandoffFiles, "carried" | "crossed" | "sentWith" | "returnedWith">;
  
  storeFile(path: string, name: string, root: string): Promise<{ attachment: { kind: string; path: string; mime: string; name?: string }; bytes: number }>;
  log(line: string): void;
}

export function createBotLinkHost(deps: BotLinkHostDeps) {
  const { store } = deps;

  const syncStandIns = () => {
    const next = new Map<string, BotRecord>();
    for (const { id, peer, place, kind, bot } of link.linked()) {
      next.set(id, { id, name: bot.name, color: bot.color ?? "blue", threadId: "", tasks: [], resumeCursors: {}, modelSelection: { instanceId: "", model: bot.model ?? "" },
        home: { place: peer, placeName: place.name, botId: bot.id, kind }, ...(bot.title ? { title: bot.title } : {}), ...(bot.description ? { description: bot.description } : {}),
        ...(bot.mascotBody ? { mascotBody: bot.mascotBody } : {}), ...(bot.mascotFaceColor ? { mascotFaceColor: bot.mascotFaceColor } : {}) } as unknown as BotRecord);
    }

    rooms.sync();
    for (const { id, gone, name, color, place, placeName, botId, kind, title, mascotBody, mascotFaceColor } of rooms.absent()) {
      next.set(id, { id, name, color: color ?? "blue", threadId: "", tasks: [], resumeCursors: {}, modelSelection: { instanceId: "", model: "" },
        home: { place, placeName, botId, ...(kind ? { kind } : {}), gone }, ...(title ? { title } : {}), ...(mascotBody ? { mascotBody } : {}), ...(mascotFaceColor ? { mascotFaceColor } : {}) } as unknown as BotRecord);
    }
    store.standIns.clear();
    for (const [id, record] of next) if (isLinkedId(id)) store.standIns.set(id, record);
    for (const group of store.groups) {
      const far = group.dm || !group.memberIds.some(isLinkedId) ? "" : JSON.stringify(rooms.far(group));
      if ((farTold.get(group.id) ?? "") === far) continue;
      if (far) farTold.set(group.id, far); else farTold.delete(group.id);
      deps.roomChanged?.(group.id);
    }
  };
  
  const farTold = new Map<string, string>();
  const rooms = createLinkedRooms({ dataDir: deps.dataDir, store, coordinator: deps.coordinator, on: () => link.on(), linked: (peer) => link.has(peer), online: (peer) => link.online(peer), linkedBots: () => link.linked(), selfName: () => link.selfName(), wanted: () => link.wanted(),
    personName: deps.personName, line: deps.roomLine, window: deps.roomWindow, log: deps.log, ...(deps.roomOpener ? { opener: deps.roomOpener } : {}), ...(deps.roomFollow ? { follow: deps.roomFollow } : {}) });
  const link = createBotLink({
    permitted: deps.personal,
    dataDir: deps.dataDir, coordinator: deps.coordinator, kick: deps.kick, log: deps.log, rooms, directoryChanged: () => { syncStandIns(); }, revoke: (sessionId) => { deps.sessions.revoke(sessionId); },
    bots: () => store.bots, bot: (id) => store.bot(id),
    refusal: (bot) => deps.personal() ? deps.refusal(bot as BotRecord) : "Personal bot links cannot execute work in a team or shared workspace.",
    model: (bot) => (bot as BotRecord).modelSelection.model,
    level: (bot) => deps.level(bot as BotRecord),
    openThread: (bot, title, opener) => store.createTask(bot.id, title, false, undefined, { ...opener, at: Date.now(), kind: "work" })?.threadId,
    hasThread: (botId, threadId) => Boolean(store.taskByThread(botId, threadId)),
    personName: deps.personName,
    files: {
      carried: deps.files.carried, crossed: deps.files.crossed,
      store: async (files) => {
        const stored: PassedFile[] = [];
        for (const file of files) {
          const { attachment, bytes } = await deps.storeFile(file.path, file.name, dirname(file.path));
          if (attachment.kind === "image" || attachment.kind === "file") stored.push({ kind: attachment.kind, path: attachment.path, name: attachment.name || file.name, mime: attachment.mime, bytes });
        }
        return stored;
      },
    },
    sentRow: ({ sender, threadId, recipient, workThreadId, nodeId, reason, doneWhen, roomId }) => {
      const room = roomId ? store.group(roomId) : undefined;
      store.appendMessage(threadId, sentRow({ sender: { id: sender.id, name: sender.name, color: sender.color ?? "blue" }, recipient: { ...recipient, color: "blue" }, threadId: workThreadId, via: "direct", language: deps.language(threadId), ...(room ? { room: { id: room.id, name: room.name, here: true } } : {}),
        ...(reason ? { reason } : {}), ...(doneWhen ? { doneWhen: redactSecretsInText(doneWhen) } : {}), ...deps.files.sentWith(nodeId) }));
    },
    resultRow: (parent: HandoffView, child: HandoffView, name: string) => {
      const room = parent.groupId ? store.group(parent.groupId) : undefined;
      if (parent.groupId ? !room || !store.groupTaskByThread(room.id, parent.threadId) : !store.taskByThread(parent.botId, parent.threadId)) return;
      const done = child.status === "completed";
      store.appendMessage(parent.threadId, { role: "bot", kind: "activity", roomRequest: { id: child.id, phase: "result" }, ...deps.files.returnedWith(child, parent),
        tool: { name: teammateResultRow(deps.language(parent.threadId), child, name, undefined, undefined), ok: done,
          ...(done && child.result.trim() ? { output: redactSecretsInText(child.result.trim()).slice(0, 2_000) } : {}) } });
      if (room) store.markGroupThreadUnread(room.id, parent.threadId, true);
      else if (!parent.parentId && parent.reply !== "poll") store.patchTask(parent.botId, parent.threadId, { unread: true });
    },
  });
  const dialer = createDialer({ link, log: deps.log });
  const accountChanged = () => {
    const state = link.status();
    if (deps.account && state.on && state.role === "dialer" && (!state.account || state.account !== deps.account())) {
      link.turnOff(false);
      void dialer.stop();
    }
  };
  let stopWatching: (() => void) | undefined, upkeep: NodeJS.Timeout | undefined;
  
  const watch = () => {
    stopWatching ??= store.onChange((change) => { if (change.type.startsWith("bot.")) link.botsChanged(); });
    watchRooms();
    if (upkeep) return;
    upkeep = setInterval(() => link.tidy(), 60 * 60_000);
    upkeep.unref?.();
  };

  let stopWatchingRooms: (() => void) | undefined;
  const watchRooms = () => { stopWatchingRooms ??= store.onChange((change) => { if (change.type === "group" && (store.standIns.size > 0 || rooms.any())) syncStandIns(); }); };
  const personalRoutes = createBotLinkRoutes({ link, dialer, turnedOn: watch, environmentId: deps.environmentId, local: deps.local, owner: deps.owner, power: deps.power, ...(deps.account ? { account: deps.account } : {}),

    issue: (auth, label, computerId) => {
      const issued = deps.sessions.issue({ label, scopes: [...auth.scopes], userId: linkSessionUser(computerId), ...(auth.kind === "session" && auth.session.email ? { email: auth.session.email } : {}) });
      return { token: issued.token, sessionId: issued.session.id };
    },
    revoke: (sessionId) => { deps.sessions.revoke(sessionId); } });
  return {
    link, rooms, accountChanged, routes: (async (context) => {
      accountChanged();
      if ((context.path === "/api/bot-link" || context.path.startsWith("/api/bot-link/")) && !deps.personal()) {
        void dialer.stop();
        link.turnOff(false);
        context.req.resume();
        return context.json(context.res, 403, { error: "Personal bot links are unavailable in a team or shared workspace." });
      }
      return personalRoutes(context);
    }) satisfies import("../routes/table.ts").RouteHandler,
    
    start(): void {
      accountChanged();
      if (!deps.personal()) { link.turnOff(false); return; }
      
      if (!link.on()) { if (rooms.any()) { syncStandIns(); watchRooms(); } return; }
      syncStandIns();
      watch();
      link.tidy();
      if (link.role() === "dialer") dialer.start({ gentle: true });
    },
    close(): void { if (upkeep) clearInterval(upkeep); stopWatching?.(); stopWatchingRooms?.(); dialer.close(); link.close(); },
  };
}
