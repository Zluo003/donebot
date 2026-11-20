// Under the inbox's lines: what else is going on, each opening where it is. What a team's person has to fix, and the
// conversations at work, with the pin that keeps them open in the sidebar.
import { Pin, PinOff } from "lucide-react";
import type { InboxView } from "../../../shared/inbox";
import { t } from "@/lib/i18n";
import { useStore, type AppState } from "@/state/store";
import { useTeamPeople } from "@/state/team-people";
import { AttentionThreadRows, attentionJumpAction, crossBotAttentionThreads, type AttentionThread, type OpenThread } from "../SidebarBotActivity";
import { NeedsYouLine } from "../TeamOwner";
import { setAttentionPinned, useAttentionPinned } from "./attention-pinned";
import { closeInbox } from "@/state/inbox";
import { inboxFixes } from "./inbox-view";

export function inboxAttentionEntries(state: Pick<AppState, "bots" | "pendingQueued" | "groups">, view: InboxView | null): AttentionThread[] {
  const rows = view?.rows ?? [];
  const asked = new Set(rows.filter((row) => row.tab === "needs-you").map((row) => row.origin?.threadId));
  const read = readNewsThreads(view);
  const atWork = (task: { busy?: boolean; activity?: string; queued?: boolean }) => task.busy === true || task.activity === "working" || task.queued === true;
  const inProgress = (task: AttentionThread["task"]) => atWork(task) || task.activity === "waiting-on-you" || task.waitingForTeammates === true
    || (task.unread === true && !read.has(task.threadId));
  return crossBotAttentionThreads(state.bots, state.pendingQueued, undefined, state.groups)
    .filter((entry) => !asked.has(entry.task.threadId) && inProgress(entry.task));
}

export function inboxOpenThread(state: Pick<AppState, "activeView" | "selectedId" | "bots" | "groups">): OpenThread | undefined {
  if (state.activeView !== "chat") return undefined;
  const bot = state.bots.find((one) => one.id === state.selectedId);
  if (bot) return { kind: "bot", botId: bot.id, threadId: bot.threadId };
  const group = state.groups.find((one) => one.id === state.selectedId);
  return group ? { kind: "group", groupId: group.id, threadId: group.threadId } : undefined;
}

export function readNewsThreads(view: InboxView | null): Set<string> {
  const read = new Set<string>();
  const unread = new Set<string>();
  for (const row of view?.rows ?? []) {
    const threadId = row.origin?.threadId;
    if (!threadId || !(row.tab === "info" || (row.tab === "done" && row.kind === "result"))) continue;
    (row.unread ? unread : read).add(threadId);
  }
  for (const threadId of unread) read.delete(threadId);
  return read;
}

export function unreadConversations(entries: readonly AttentionThread[], view?: InboxView | null): number {
  const lined = new Set<string>();
  for (const row of view?.rows ?? []) if (row.tab === "info" && row.unread && row.origin?.threadId) lined.add(row.origin.threadId);
  return entries.filter((entry) => entry.task.unread === true && !lined.has(entry.task.threadId)).length;
}

export function InboxActive({ view, current, exclude }: {
  view: InboxView | null; current?: OpenThread;
  exclude?: ReadonlySet<string>;
}) {
  const { state, dispatch } = useStore();
  const team = useTeamPeople();
  const pinned = useAttentionPinned();
  const entries = inboxAttentionEntries(state, view).filter((entry) => !exclude?.has(entry.task.threadId));
  const fixes = inboxFixes(team?.needsYou, view);
  return (
    <>
      {fixes.length > 0 && (
        <section data-inbox-fixes className="border-t border-hairline/40 px-1.5 py-1.5">
          {fixes.map((item) => <NeedsYouLine key={`${item.kind}:${item.id}`} item={item} onOpened={closeInbox} />)}
        </section>
      )}
      {(entries.length > 0 || pinned) && (
        <section data-inbox-active aria-label={t("attention.title")} className="border-t border-hairline/40 px-1.5 py-1.5">
          <div className="flex items-center gap-1 px-2 py-0.5">
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink-secondary">{t("attention.title")}</span>
            <button type="button" data-inbox-pin onClick={() => setAttentionPinned(!pinned)} aria-label={t(pinned ? "attention.unpin" : "attention.pin")} title={t(pinned ? "attention.unpin" : "attention.pin")}
              className="flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
              {pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
            </button>
          </div>
          <AttentionThreadRows inset entries={entries} unreadDot current={current} onJump={(entry) => dispatch(attentionJumpAction(entry))} />
        </section>
      )}
    </>
  );
}
