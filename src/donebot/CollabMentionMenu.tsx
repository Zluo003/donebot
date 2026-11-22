import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { DoneBotCollabChatBot } from "../../shared/donebot-collab";
import {
  displayPersonName,
  personSecondaryLabel,
  type LocalBotSummary,
} from "./collab-types";
import { CollabAvatar, CollabBotBadge } from "./CollabAvatar";

export interface MentionableMember {
  user_id: number;
  email: string;
  nickname?: string;
  remark?: string;
  avatar_url?: string;
  roleLabel?: string;
}

export type CollabMentionItem =
  | {
    kind: "member";
    key: string;
    insertName: string;
    disabled: false;
    member: MentionableMember;
  }
  | {
    kind: "bot";
    key: string;
    insertName: string;
    disabled: boolean;
    bot: DoneBotCollabChatBot;
  };

export function buildCollabMentionItems(opts: {
  query: string;
  members: readonly MentionableMember[];
  chatBots: readonly DoneBotCollabChatBot[];
}): CollabMentionItem[] {
  const q = opts.query.trim().toLowerCase();
  const items: CollabMentionItem[] = [];

  for (const bot of opts.chatBots) {
    if (
      !q
      || bot.bot_name.toLowerCase().includes(q)
      || (bot.owner_nickname ?? "").toLowerCase().includes(q)
      || (bot.owner_remark ?? "").toLowerCase().includes(q)
      || (bot.bot_title ?? "").toLowerCase().includes(q)
    ) {
      items.push({
        kind: "bot",
        key: `bot:${bot.id}`,
        insertName: bot.bot_name,
        disabled: !bot.can_invoke,
        bot,
      });
    }
  }

  for (const member of opts.members) {
    const label = displayPersonName(member);
    if (
      !q
      || label.toLowerCase().includes(q)
      || (member.nickname ?? "").toLowerCase().includes(q)
      || (member.remark ?? "").toLowerCase().includes(q)
      || member.email.toLowerCase().includes(q)
    ) {
      items.push({
        kind: "member",
        key: `member:${member.user_id}`,
        insertName: label,
        disabled: false,
        member,
      });
    }
  }

  return items;
}

export function renderMentionHighlightedText(text: string, mine: boolean): ReactNode {
  if (!text || !text.includes("@")) return text;
  const parts: ReactNode[] = [];
  const regex = /(^|[\s([{"'，。！？、])(@[^\s@，。！？、]{1,40})/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    const prefix = match[1] ?? "";
    const mention = match[2] ?? "";
    const start = match.index;
    if (start > lastIndex) parts.push(text.slice(lastIndex, start));
    if (prefix) parts.push(prefix);
    parts.push(
      <span
        key={key++}
        className={mine ? "font-semibold underline decoration-current/45 underline-offset-2" : "font-medium text-accent-text"}
      >
        {mention}
      </span>,
    );
    lastIndex = start + match[0].length;
  }
  if (lastIndex === 0) return text;
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

export function CollabMentionMenu({
  items,
  activeKey,
  myUserId,
  localBotById,
  onSelect,
}: {
  items: readonly CollabMentionItem[];
  activeKey: string | null;
  myUserId: number;
  localBotById: ReadonlyMap<string, LocalBotSummary>;
  onSelect: (item: CollabMentionItem) => void;
}) {
  const bots = items.filter((item): item is Extract<CollabMentionItem, { kind: "bot" }> => item.kind === "bot");
  const members = items.filter((item): item is Extract<CollabMentionItem, { kind: "member" }> => item.kind === "member");
  const hasBoth = bots.length > 0 && members.length > 0;

  return (
    <div
      data-collab-mention-menu=""
      role="listbox"
      aria-label="选择要 @ 提及的群成员或机器人"
      className="overflow-hidden rounded-2xl bg-menu p-1.5 shadow-xl ring-1 ring-ink/12"
    >
      <div className="max-h-60 overflow-y-auto">
        {bots.length > 0 && (
          <div>
            <div className="px-2.5 py-1 text-[11px] font-medium text-ink-tertiary">
              {hasBoth ? "群内机器人（本机处理）" : "选择要调用的群内机器人（在 Bot 所在本机处理）"}
            </div>
            <ul className="flex flex-col gap-0.5">
              {bots.map(item => {
                const { bot } = item;
                const active = !item.disabled && activeKey === item.key;
                const ownerName = bot.owner_user_id === myUserId
                  ? "我"
                  : displayPersonName({ remark: bot.owner_remark, nickname: bot.owner_nickname, email: bot.owner_email });
                const localMatch = bot.owner_user_id === myUserId ? localBotById.get(bot.local_bot_id) : undefined;
                return (
                  <li key={item.key} role="option" aria-selected={active} aria-disabled={item.disabled}>
                    <button
                      type="button"
                      data-collab-mention-item={bot.id}
                      disabled={item.disabled}
                      onMouseDown={e => {
                        e.preventDefault();
                        onSelect(item);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
                        active ? "bg-raised text-ink" : "text-ink enabled:hover:bg-raised/60",
                        item.disabled && "cursor-not-allowed opacity-55",
                      )}
                    >
                      <CollabBotBadge
                        name={bot.bot_name}
                        color={bot.bot_color || localMatch?.color}
                        avatarUrl={bot.bot_avatar_url || localMatch?.avatar_url}
                        bodyId={localMatch?.mascot_body}
                        faceColor={localMatch?.mascot_face_color}
                        size={28}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-ink">@{bot.bot_name}</div>
                        <div className="truncate text-[11px] text-ink-tertiary">
                          {ownerName} 的本机 Bot{bot.bot_title ? ` · ${bot.bot_title}` : ""}
                        </div>
                      </div>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1 ring-inset",
                          bot.can_invoke
                            ? "bg-success/12 text-success ring-success/25"
                            : "bg-ink/[0.05] text-ink-tertiary ring-ink/10",
                        )}
                      >
                        {bot.can_invoke ? "可调用" : "需所有者授权"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {members.length > 0 && (
          <div className={hasBoth ? "mt-1.5 border-t border-hairline/40 pt-1" : ""}>
            <div className="px-2.5 py-1 text-[11px] font-medium text-ink-tertiary">
              群成员
            </div>
            <ul className="flex flex-col gap-0.5">
              {members.map(item => {
                const { member } = item;
                const active = activeKey === item.key;
                const sub = personSecondaryLabel(member);
                return (
                  <li key={item.key} role="option" aria-selected={active}>
                    <button
                      type="button"
                      data-collab-mention-member={member.user_id}
                      onMouseDown={e => {
                        e.preventDefault();
                        onSelect(item);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
                        active ? "bg-raised text-ink" : "text-ink hover:bg-raised/60",
                      )}
                    >
                      <CollabAvatar
                        avatarUrl={member.avatar_url}
                        remark={member.remark}
                        nickname={member.nickname}
                        email={member.email}
                        size={28}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-ink">@{item.insertName}</div>
                        {sub && <div className="truncate text-[11px] text-ink-tertiary">{sub}</div>}
                      </div>
                      {member.roleLabel && (
                        <span className="shrink-0 rounded-full bg-ink/[0.05] px-2 py-0.5 text-[10.5px] font-medium text-ink-secondary ring-1 ring-inset ring-ink/10">
                          {member.roleLabel}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
