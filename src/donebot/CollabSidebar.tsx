import { useMemo } from "react";
import { Bell, Bot, Loader2, Plus, RefreshCw, Users } from "lucide-react";
import { cn } from "@/lib/cn";
import { useStore } from "@/state/store";
import type { DoneBotChatSummary } from "../../shared/donebot-collab";
import {
  collabPendingCount,
  collabTotalBadgeCount,
  findChatSummary,
  isHumanTeamCollabVisible,
  openCollabDestination,
  openCollabDialog,
  refreshCollabOverview,
  setCollabSidebarTab,
  teamLatestChatSummary,
  teamTaskCountsFor,
  teamTotalUnreadCount,
  useCollabStore,
  type CollabSelection,
  type CollabSidebarTab,
} from "./collab-store";
import {
  displayPersonName,
  formatChatTime,
  TEAM_ROLES,
  type CollabOverview,
} from "./collab-types";
import { CollabAvatar, CollabTeamBadge } from "./CollabAvatar";

const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

const OPTIONS = [
  { id: "bots" as const, label: "机器人", Icon: Bot },
  { id: "collab" as const, label: "好友与团队", Icon: Users },
] as const;

function selectionEquals(a: CollabSelection, b: CollabSelection): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "friend" && b.kind === "friend") return a.userId === b.userId;
  if (a.kind === "team" && b.kind === "team") return a.teamId === b.teamId;
  if (a.kind === "group" && b.kind === "group") return a.groupId === b.groupId;
  return false;
}

function friendHasOnlineFolder(overview: CollabOverview, userId: number): boolean {
  return overview.folders.shared_with_me.some(f => f.owner_user_id === userId && f.online);
}

function chatSnippet(
  summary: DoneBotChatSummary | undefined,
  showSender: boolean,
  myUserId: number,
  myLabel: string,
): string {
  if (!summary || !summary.last_message_id) return "";
  const content = summary.last_kind === "file"
    ? `[文件] ${summary.last_file_name || "文件"}`
    : (summary.last_body || "").replace(/\s+/g, " ").trim();
  if (!content) return "";
  if (
    showSender
    && summary.last_sender_name
    && (summary.last_sender_id !== myUserId || summary.last_sender_name !== myLabel)
  ) {
    return `${summary.last_sender_name}: ${content}`;
  }
  return content;
}

export function CollabSidebarSwitch({ compact, listOnly = false }: { compact: boolean; listOnly?: boolean }) {
  const { state, dispatch } = useStore();
  const collab = useCollabStore();

  if (!isHumanTeamCollabVisible(state.config)) return null;

  const totalBadge = collabTotalBadgeCount(collab.overview);
  const badgeText = totalBadge > 99 ? "99+" : String(totalBadge);

  const choose = (next: CollabSidebarTab) => {
    setCollabSidebarTab(next);
    if (next === "collab") {
      void refreshCollabOverview({ silent: true });
      if (!listOnly && state.activeView !== "collab") {
        dispatch({ type: "showCollab" });
      }
    } else if (!listOnly && state.activeView === "collab") {
      dispatch({ type: "showChat" });
    }
  };

  return (
    <div data-collab-sidebar-switch={collab.sidebarTab} className={compact ? "mx-auto mb-1.5" : "px-3 pb-2"}>
      <div
        role="radiogroup"
        aria-label="切换列表视图"
        className={cn(
          "flex rounded-full bg-ink/[0.06] p-0.5 ring-[0.5px] ring-inset ring-ink/[0.07]",
          compact && "flex-col rounded-[14px]",
        )}
      >
        {OPTIONS.map(({ id, label, Icon }) => {
          const active = collab.sidebarTab === id;
          const showBadge = id === "collab" && totalBadge > 0;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              data-collab-switch-option={id}
              aria-label={compact ? (showBadge ? `${label}（${totalBadge} 条未读或待处理）` : label) : undefined}
              title={compact ? (showBadge ? `${label}（${totalBadge} 条未读或待处理）` : label) : undefined}
              onClick={() => choose(id)}
              className={cn(
                "relative flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-colors",
                FOCUS_RING,
                compact ? "size-9 rounded-xl" : "h-8 min-w-0 flex-1 px-2.5 text-[13px]",
                active
                  ? "bg-composer text-ink shadow-[0_1px_2px_rgb(0_0_0/0.12)] ring-[0.5px] ring-ink/10"
                  : "text-ink-secondary hover:text-ink",
              )}
            >
              {compact ? <Icon size={16} strokeWidth={1.75} aria-hidden="true" /> : <span className="truncate">{label}</span>}
              {showBadge && (
                <span
                  data-collab-pending-badge={totalBadge}
                  className={cn(
                    "inline-flex min-w-4 shrink-0 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 tabular-nums text-white",
                    compact && "absolute -right-0.5 -top-0.5",
                  )}
                >
                  {badgeText}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CollabSidebarList({
  query = "",
  icons = false,
  onClose,
}: {
  query?: string;
  icons?: boolean;
  onClose?: () => void;
}) {
  const { state, dispatch } = useStore();
  const { overview, loaded, refreshing, selection } = useCollabStore();
  const isCollabView = state.activeView === "collab";
  const needle = query.trim().toLowerCase();
  const myUserId = Number(overview?.identity.account_id ?? 0);
  const myLabel = overview ? displayPersonName({ nickname: overview.identity.nickname, email: overview.identity.email }) : "";

  const teams = useMemo(() => {
    const list = overview?.teams ?? [];
    if (!needle) return list;
    return list.filter(t => t.name.toLowerCase().includes(needle));
  }, [overview, needle]);

  const groups = useMemo(() => {
    const list = overview?.groups ?? [];
    if (!needle) return list;
    return list.filter(g =>
      g.name.toLowerCase().includes(needle)
      || g.members.some(m =>
        m.email.toLowerCase().includes(needle)
        || (m.nickname ?? "").toLowerCase().includes(needle)
        || (m.remark ?? "").toLowerCase().includes(needle),
      ),
    );
  }, [overview, needle]);

  const friends = useMemo(() => {
    const list = overview?.friends.friends ?? [];
    if (!needle) return list;
    return list.filter(f =>
      f.email.toLowerCase().includes(needle)
      || (f.nickname ?? "").toLowerCase().includes(needle)
      || (f.remark ?? "").toLowerCase().includes(needle),
    );
  }, [overview, needle]);

  const select = (target: CollabSelection) => {
    openCollabDestination(dispatch, target);
    onClose?.();
  };

  const pending = collabPendingCount(overview);

  if (icons) {
    return (
      <nav aria-label="好友与团队" data-collab-sidebar-list="icons" className="flex flex-col items-center gap-1.5 py-1">
        {pending > 0 && (
          <button
            type="button"
            data-collab-requests-trigger=""
            onClick={() => openCollabDialog({ kind: "requests" })}
            aria-label={`有 ${pending} 条待处理的申请或邀请`}
            title={`有 ${pending} 条待处理的申请或邀请`}
            className={cn(
              "relative flex size-10 items-center justify-center rounded-full bg-danger/15 text-danger ring-1 ring-inset ring-danger/25",
              FOCUS_RING,
            )}
          >
            <Bell size={17} aria-hidden="true" />
            <span className="absolute -right-0.5 -top-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white">
              {pending > 9 ? "9+" : pending}
            </span>
          </button>
        )}

        {teams.map(team => {
          const active = isCollabView && selectionEquals(selection, { kind: "team", teamId: team.id });
          const unread = teamTotalUnreadCount(overview, team.id);
          return (
            <button
              key={`t:${team.id}`}
              type="button"
              onClick={() => select({ kind: "team", teamId: team.id })}
              aria-label={team.name}
              title={team.name}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex size-10 items-center justify-center rounded-xl transition-transform hover:scale-105",
                FOCUS_RING,
                active && "ring-2 ring-accent ring-offset-2 ring-offset-panel",
              )}
            >
              <CollabTeamBadge name={team.name} avatarUrl={team.avatar_url} size={36} />
              {unread > 0 && (
                <span className="absolute -right-0.5 -top-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white">
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </button>
          );
        })}

        {groups.map(group => {
          const active = isCollabView && selectionEquals(selection, { kind: "group", groupId: group.id });
          const unread = findChatSummary(overview, "group", group.id)?.unread_count ?? 0;
          return (
            <button
              key={`g:${group.id}`}
              type="button"
              onClick={() => select({ kind: "group", groupId: group.id })}
              aria-label={group.name}
              title={group.name}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex size-10 items-center justify-center rounded-xl transition-transform hover:scale-105",
                FOCUS_RING,
                active && "ring-2 ring-accent ring-offset-2 ring-offset-panel",
              )}
            >
              <CollabTeamBadge name={group.name} avatarUrl={group.avatar_url} size={36} />
              {unread > 0 && (
                <span className="absolute -right-0.5 -top-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white">
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </button>
          );
        })}

        {friends.map(friend => {
          const active = isCollabView && selectionEquals(selection, { kind: "friend", userId: friend.user_id });
          const name = displayPersonName(friend);
          const unread = findChatSummary(overview, "friend", String(friend.user_id))?.unread_count ?? 0;
          return (
            <button
              key={`f:${friend.user_id}`}
              type="button"
              onClick={() => select({ kind: "friend", userId: friend.user_id })}
              aria-label={name}
              title={name}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex size-10 items-center justify-center rounded-full transition-transform hover:scale-105",
                FOCUS_RING,
                active && "ring-2 ring-accent ring-offset-2 ring-offset-panel",
              )}
            >
              <CollabAvatar
                avatarUrl={friend.avatar_url}
                remark={friend.remark}
                nickname={friend.nickname}
                email={friend.email}
                size={36}
                online={overview && friendHasOnlineFolder(overview, friend.user_id) ? true : undefined}
              />
              {unread > 0 && (
                <span className="absolute -right-0.5 -top-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white">
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    );
  }

  return (
    <nav aria-label="好友与团队" data-collab-sidebar-list="full" className="flex flex-col gap-3.5 pb-3 pt-1">
      {/* Compact pending-requests banner shown ONLY when there are incoming requests/invitations */}
      {!needle && pending > 0 && (
        <button
          type="button"
          data-collab-requests-trigger=""
          onClick={() => openCollabDialog({ kind: "requests" })}
          className={cn(
            "flex items-center gap-2.5 rounded-xl bg-danger/12 px-3 py-2 text-left text-[13px] font-medium text-danger ring-1 ring-inset ring-danger/25 transition-colors hover:bg-danger/18",
            FOCUS_RING,
          )}
        >
          <Bell size={14} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">有 {pending} 条好友申请或团队邀请</span>
          <span className="shrink-0 rounded-full bg-danger px-1.5 text-[11px] font-semibold leading-4 tabular-nums text-white">
            处理
          </span>
        </button>
      )}

      {!loaded && (
        <div className="flex items-center gap-2 px-3 py-4 text-[12px] text-ink-secondary">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          <span>正在同步好友与团队…</span>
        </div>
      )}

      {loaded && !overview && (
        <div className="mx-1 flex flex-col gap-2 rounded-xl bg-raised/55 p-3 text-[12px] text-ink-secondary ring-1 ring-inset ring-ink/[0.07]">
          <span>暂时无法连接协作服务</span>
          <button
            type="button"
            disabled={refreshing}
            onClick={() => void refreshCollabOverview()}
            className={cn("inline-flex items-center gap-1.5 self-start rounded-lg bg-ink/[0.08] px-2.5 py-1 text-[11px] font-medium text-ink hover:bg-ink/[0.12]", FOCUS_RING)}
          >
            <RefreshCw size={11} className={refreshing ? "animate-spin" : ""} aria-hidden="true" />重试
          </button>
        </div>
      )}

      {overview && (
        <>
          {/* Teams section (top) */}
          <div className="flex flex-col gap-1" data-collab-section="teams">
            <div className="flex items-center justify-between px-2.5 py-0.5">
              <span className="text-[11px] font-semibold tracking-wide text-ink-tertiary">
                团队 · {overview.teams.length}
              </span>
              <button
                type="button"
                data-collab-add-team=""
                aria-label="新建团队"
                title="新建团队"
                onClick={() => openCollabDialog({ kind: "add-team" })}
                className={cn("flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink", FOCUS_RING)}
              >
                <Plus size={14} aria-hidden="true" />
              </button>
            </div>
            {teams.length > 0 ? (
              <ul className="flex flex-col gap-0.5">
                {teams.map(team => {
                  const active = isCollabView && selectionEquals(selection, { kind: "team", teamId: team.id });
                  const memberCount = overview.team_members[team.id]?.length ?? 0;
                  const { summary, channelName } = teamLatestChatSummary(overview, team.id);
                  const rawSnippet = chatSnippet(summary, true, myUserId, myLabel);
                  const snippet = rawSnippet
                    ? (channelName ? `#${channelName} · ${rawSnippet}` : rawSnippet)
                    : `${memberCount > 0 ? `${memberCount} 人 · ` : ""}${TEAM_ROLES[team.role]}`;
                  const timeText = formatChatTime(summary?.last_created_at);
                  const unread = teamTotalUnreadCount(overview, team.id);
                  const counts = teamTaskCountsFor(overview, team.id);
                  const reviewCount = counts?.review_by_me ?? 0;
                  const mineCount = counts?.assigned_to_me ?? 0;
                  const taskPill = reviewCount > 0
                    ? `${reviewCount} 待验收`
                    : mineCount > 0
                      ? `${mineCount} 待办`
                      : "";
                  return (
                    <li key={team.id}>
                      <button
                        type="button"
                        data-collab-team-row={team.id}
                        aria-current={active ? "page" : undefined}
                        onClick={() => select({ kind: "team", teamId: team.id })}
                        className={cn(
                          "flex min-h-[50px] w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors",
                          FOCUS_RING,
                          active ? "bg-raised text-ink shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-ink hover:bg-raised/50",
                        )}
                      >
                        <CollabTeamBadge name={team.name} avatarUrl={team.avatar_url} size={34} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-1.5">
                            <span className="truncate text-[14px] font-medium text-ink">{team.name}</span>
                            {timeText && (
                              <span className="shrink-0 text-[11px] tabular-nums text-ink-tertiary">{timeText}</span>
                            )}
                          </span>
                          <span className="flex items-center justify-between gap-1.5">
                            <span className="truncate text-[12px] text-ink-tertiary">{snippet}</span>
                            <span className="flex shrink-0 items-center gap-1">
                              {taskPill && (
                                <span
                                  data-collab-team-task-pill=""
                                  className={cn(
                                    "inline-flex shrink-0 items-center rounded-full px-1.5 py-0 text-[10px] font-medium leading-4 ring-1 ring-inset",
                                    reviewCount > 0
                                      ? "bg-amber-500/14 text-amber-500 ring-amber-500/25"
                                      : "bg-accent/14 text-accent-text ring-accent/25",
                                  )}
                                >
                                  {taskPill}
                                </span>
                              )}
                              {unread > 0 && (
                                <span className="inline-flex min-w-4 shrink-0 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 tabular-nums text-white">
                                  {unread > 99 ? "99+" : unread}
                                </span>
                              )}
                            </span>
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-2.5 py-2 text-[12px] text-ink-tertiary">
                {needle ? "没有匹配的团队" : "还没有团队，点右上角 + 创建"}
              </p>
            )}
          </div>

          {/* Friend Groups section */}
          <div className="flex flex-col gap-1" data-collab-section="groups">
            <div className="flex items-center justify-between px-2.5 py-0.5">
              <span className="text-[11px] font-semibold tracking-wide text-ink-tertiary">
                群聊 · {(overview.groups ?? []).length}
              </span>
              <button
                type="button"
                data-collab-create-group=""
                aria-label="发起好友群聊"
                title="发起好友群聊"
                onClick={() => openCollabDialog({ kind: "create-group" })}
                className={cn("flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink", FOCUS_RING)}
              >
                <Plus size={14} aria-hidden="true" />
              </button>
            </div>
            {groups.length > 0 ? (
              <ul className="flex flex-col gap-0.5">
                {groups.map(group => {
                  const active = isCollabView && selectionEquals(selection, { kind: "group", groupId: group.id });
                  const summary = findChatSummary(overview, "group", group.id);
                  const snippet = chatSnippet(summary, true, myUserId, myLabel)
                    || `${group.members.length} 位成员`;
                  const timeText = formatChatTime(summary?.last_created_at);
                  const unread = summary?.unread_count ?? 0;
                  return (
                    <li key={group.id}>
                      <button
                        type="button"
                        data-collab-group-row={group.id}
                        aria-current={active ? "page" : undefined}
                        onClick={() => select({ kind: "group", groupId: group.id })}
                        className={cn(
                          "flex min-h-[50px] w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors",
                          FOCUS_RING,
                          active ? "bg-raised text-ink shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-ink hover:bg-raised/50",
                        )}
                      >
                        <CollabTeamBadge name={group.name} avatarUrl={group.avatar_url} size={34} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-1.5">
                            <span className="truncate text-[14px] font-medium text-ink">{group.name}</span>
                            {timeText && (
                              <span className="shrink-0 text-[11px] tabular-nums text-ink-tertiary">{timeText}</span>
                            )}
                          </span>
                          <span className="flex items-center justify-between gap-1.5">
                            <span className="truncate text-[12px] text-ink-tertiary">{snippet}</span>
                            {unread > 0 && (
                              <span className="inline-flex min-w-4 shrink-0 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 tabular-nums text-white">
                                {unread > 99 ? "99+" : unread}
                              </span>
                            )}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-2.5 py-2 text-[12px] text-ink-tertiary">
                {needle ? "没有匹配的群聊" : "还没有好友群聊，点右上角 + 发起"}
              </p>
            )}
          </div>

          {/* Friends section (below teams & groups) */}
          <div className="flex flex-col gap-1" data-collab-section="friends">
            <div className="flex items-center justify-between px-2.5 py-0.5">
              <span className="text-[11px] font-semibold tracking-wide text-ink-tertiary">
                好友 · {overview.friends.friends.length}
              </span>
              <button
                type="button"
                data-collab-add-friend=""
                aria-label="添加好友"
                title="添加好友"
                onClick={() => openCollabDialog({ kind: "add-friend" })}
                className={cn("flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink", FOCUS_RING)}
              >
                <Plus size={14} aria-hidden="true" />
              </button>
            </div>
            {friends.length > 0 ? (
              <ul className="flex flex-col gap-0.5">
                {friends.map(friend => {
                  const active = isCollabView && selectionEquals(selection, { kind: "friend", userId: friend.user_id });
                  const name = displayPersonName(friend);
                  const hasOnline = friendHasOnlineFolder(overview, friend.user_id);
                  const summary = findChatSummary(overview, "friend", String(friend.user_id));
                  const snippet = chatSnippet(summary, false, myUserId, myLabel) || (hasOnline ? "共享文件夹在线" : "点击开始聊天");
                  const timeText = formatChatTime(summary?.last_created_at);
                  const unread = summary?.unread_count ?? 0;
                  return (
                    <li key={friend.user_id}>
                      <button
                        type="button"
                        data-collab-friend-row={friend.user_id}
                        aria-current={active ? "page" : undefined}
                        onClick={() => select({ kind: "friend", userId: friend.user_id })}
                        className={cn(
                          "flex min-h-[50px] w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors",
                          FOCUS_RING,
                          active ? "bg-raised text-ink shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-ink hover:bg-raised/50",
                        )}
                      >
                        <CollabAvatar
                          avatarUrl={friend.avatar_url}
                          remark={friend.remark}
                          nickname={friend.nickname}
                          email={friend.email}
                          size={34}
                          online={hasOnline ? true : undefined}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-1.5">
                            <span className="truncate text-[14px] font-medium text-ink">{name}</span>
                            {timeText && (
                              <span className="shrink-0 text-[11px] tabular-nums text-ink-tertiary">{timeText}</span>
                            )}
                          </span>
                          <span className="flex items-center justify-between gap-1.5">
                            <span className="truncate text-[12px] text-ink-tertiary">{snippet}</span>
                            {unread > 0 && (
                              <span className="inline-flex min-w-4 shrink-0 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 tabular-nums text-white">
                                {unread > 99 ? "99+" : unread}
                              </span>
                            )}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-2.5 py-2 text-[12px] text-ink-tertiary">
                {needle ? "没有匹配的好友" : "还没有好友，点右上角 + 添加"}
              </p>
            )}
          </div>
        </>
      )}
    </nav>
  );
}
