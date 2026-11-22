import { useMemo, useState } from "react";
import { Bell, Bot, FolderOpen, Loader2, Pencil, Plus, RefreshCw, Users } from "lucide-react";
import { cn } from "@/lib/cn";
import { useStore } from "@/state/store";
import {
  collabPendingCount,
  isCollabEligible,
  openCollabDestination,
  refreshCollabOverview,
  setCollabSidebarTab,
  useCollabStore,
  type CollabSelection,
  type CollabSidebarTab,
} from "./collab-store";
import {
  displayPersonName,
  TEAM_ROLES,
  type CollabOverview,
} from "./collab-types";
import { CollabAvatar, CollabProfileDialog, CollabTeamBadge } from "./CollabAvatar";

const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

const OPTIONS = [
  { id: "bots" as const, label: "机器人", Icon: Bot },
  { id: "collab" as const, label: "好友与团队", Icon: Users },
] as const;

function selectionEquals(a: CollabSelection, b: CollabSelection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "friend" && b.kind === "friend") return a.userId === b.userId;
  if (a.kind === "team" && b.kind === "team") return a.teamId === b.teamId;
  return true;
}

function friendHasOnlineFolder(overview: CollabOverview, userId: number): boolean {
  return overview.folders.shared_with_me.some(f => f.owner_user_id === userId && f.online);
}

function friendSummary(overview: CollabOverview, userId: number): string {
  const incomingFolders = overview.folders.shared_with_me.filter(f => f.owner_user_id === userId).length;
  const outgoingFolders = overview.folders.owned.filter(f =>
    f.grants.some(g => g.subject_type === "user" && g.subject_id === String(userId)),
  ).length;
  const incomingBots = overview.bots.shared_with_me.filter(b => b.owner_user_id === userId).length;
  const outgoingBots = overview.bots.owned.filter(b =>
    b.grants.some(g => g.subject_type === "user" && g.subject_id === String(userId)),
  ).length;
  const folders = incomingFolders + outgoingFolders;
  const bots = incomingBots + outgoingBots;
  const parts: string[] = [];
  if (folders > 0) parts.push(`${folders} 个文件夹`);
  if (bots > 0) parts.push(`${bots} 个 Bot`);
  return parts.length > 0 ? parts.join(" · ") : "已加好友";
}

export function CollabSidebarSwitch({ compact, listOnly = false }: { compact: boolean; listOnly?: boolean }) {
  const { state, dispatch } = useStore();
  const collab = useCollabStore();

  if (!isCollabEligible(state.config)) return null;

  const pending = collabPendingCount(collab.overview);
  const badgeText = pending > 9 ? "9+" : String(pending);

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
          const showBadge = id === "collab" && pending > 0;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              data-collab-switch-option={id}
              aria-label={compact ? (showBadge ? `${label}（${pending} 条待处理）` : label) : undefined}
              title={compact ? (showBadge ? `${label}（${pending} 条待处理）` : label) : undefined}
              onClick={() => choose(id)}
              className={cn(
                "relative flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-colors",
                FOCUS_RING,
                compact ? "size-9 rounded-xl" : "h-8 min-w-0 flex-1 px-2.5 text-[12.5px]",
                active
                  ? "bg-composer text-ink shadow-[0_1px_2px_rgb(0_0_0/0.12)] ring-[0.5px] ring-ink/10"
                  : "text-ink-secondary hover:text-ink",
              )}
            >
              {compact ? <Icon size={16} strokeWidth={1.75} aria-hidden="true" /> : <span className="truncate">{label}</span>}
              {showBadge && (
                <span
                  data-collab-pending-badge={pending}
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
  const [profileOpen, setProfileOpen] = useState(false);
  const isCollabView = state.activeView === "collab";
  const needle = query.trim().toLowerCase();

  const friends = useMemo(() => {
    const list = overview?.friends.friends ?? [];
    if (!needle) return list;
    return list.filter(f =>
      f.email.toLowerCase().includes(needle)
      || (f.nickname ?? "").toLowerCase().includes(needle)
      || (f.remark ?? "").toLowerCase().includes(needle),
    );
  }, [overview, needle]);

  const teams = useMemo(() => {
    const list = overview?.teams ?? [];
    if (!needle) return list;
    return list.filter(t => t.name.toLowerCase().includes(needle));
  }, [overview, needle]);

  const select = (target: CollabSelection) => {
    openCollabDestination(dispatch, target);
    onClose?.();
  };

  const pending = collabPendingCount(overview);
  const outgoingCount = overview?.friends.outgoing_requests.length ?? 0;
  const folderCount = overview ? overview.folders.owned.length + overview.folders.shared_with_me.length : 0;
  const botCount = overview ? overview.bots.owned.length + overview.bots.shared_with_me.length : 0;
  const myEmail = overview?.identity.email || state.config?.donebot?.user?.email || "";
  const myNickname = overview?.identity.nickname || state.config?.profile?.name || "";
  const myAvatar = overview?.identity.avatar_url || state.config?.profile?.avatarUrl || "";

  if (icons) {
    return (
      <nav aria-label="好友与团队" data-collab-sidebar-list="icons" className="flex flex-col items-center gap-1.5 py-1">
        <button
          type="button"
          onClick={() => select({ kind: "inbox" })}
          aria-label={pending > 0 ? `消息与申请（${pending} 条待处理）` : "消息与申请"}
          title="消息与申请"
          aria-current={isCollabView && selection.kind === "inbox" ? "page" : undefined}
          className={cn(
            "relative flex size-[46px] items-center justify-center rounded-xl transition-colors",
            FOCUS_RING,
            isCollabView && selection.kind === "inbox" ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
          )}
        >
          <Bell size={19} aria-hidden="true" />
          {pending > 0 && (
            <span className="absolute right-1 top-1 inline-flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white">
              {pending > 9 ? "9+" : pending}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => select({ kind: "folders" })}
          aria-label="共享文件夹"
          title="共享文件夹"
          aria-current={isCollabView && selection.kind === "folders" ? "page" : undefined}
          className={cn(
            "flex size-[46px] items-center justify-center rounded-xl transition-colors",
            FOCUS_RING,
            isCollabView && selection.kind === "folders" ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
          )}
        >
          <FolderOpen size={19} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => select({ kind: "bots" })}
          aria-label="共享 Bot"
          title="共享 Bot"
          aria-current={isCollabView && selection.kind === "bots" ? "page" : undefined}
          className={cn(
            "flex size-[46px] items-center justify-center rounded-xl transition-colors",
            FOCUS_RING,
            isCollabView && selection.kind === "bots" ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
          )}
        >
          <Bot size={19} aria-hidden="true" />
        </button>

        {(friends.length > 0 || teams.length > 0) && <div aria-hidden="true" className="my-1 h-px w-8 bg-hairline/70" />}

        {friends.map(friend => {
          const active = isCollabView && selectionEquals(selection, { kind: "friend", userId: friend.user_id });
          const name = displayPersonName(friend);
          return (
            <button
              key={`f:${friend.user_id}`}
              type="button"
              onClick={() => select({ kind: "friend", userId: friend.user_id })}
              aria-label={name}
              title={name}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex size-10 items-center justify-center rounded-full transition-transform hover:scale-105",
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
            </button>
          );
        })}

        {teams.map(team => {
          const active = isCollabView && selectionEquals(selection, { kind: "team", teamId: team.id });
          return (
            <button
              key={`t:${team.id}`}
              type="button"
              onClick={() => select({ kind: "team", teamId: team.id })}
              aria-label={team.name}
              title={team.name}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex size-10 items-center justify-center rounded-xl transition-transform hover:scale-105",
                FOCUS_RING,
                active && "ring-2 ring-accent ring-offset-2 ring-offset-panel",
              )}
            >
              <CollabTeamBadge name={team.name} size={36} />
            </button>
          );
        })}
      </nav>
    );
  }

  return (
    <>
      <nav aria-label="好友与团队" data-collab-sidebar-list="full" className="flex flex-col gap-3.5 pb-3 pt-1">
        {/* Compact self-profile card for quick avatar & nickname editing */}
        {!needle && myEmail && (
          <div className="flex items-center gap-2.5 rounded-xl bg-raised/65 px-2.5 py-2 ring-1 ring-inset ring-ink/[0.06]">
            <CollabAvatar
              avatarUrl={myAvatar}
              nickname={myNickname}
              email={myEmail}
              size={34}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold text-ink">
                {myNickname || myEmail}
              </div>
              <div className="truncate text-[11px] text-ink-tertiary">
                {myNickname ? myEmail : "点击右侧设置昵称与头像"}
              </div>
            </div>
            <button
              type="button"
              data-collab-edit-profile=""
              aria-label="编辑我的头像和昵称"
              title="编辑头像和昵称"
              onClick={() => setProfileOpen(true)}
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-ink/[0.08] hover:text-ink",
                FOCUS_RING,
              )}
            >
              <Pencil size={13} aria-hidden="true" />
            </button>
          </div>
        )}

        {/* Top quick entries */}
        {!needle && (
          <div className="flex flex-col gap-0.5">
            <button
              type="button"
              data-collab-nav="inbox"
              aria-current={isCollabView && selection.kind === "inbox" ? "page" : undefined}
              onClick={() => select({ kind: "inbox" })}
              className={cn(
                "flex min-h-9 w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors",
                FOCUS_RING,
                isCollabView && selection.kind === "inbox"
                  ? "bg-raised text-ink shadow-[0_1px_2px_rgb(0_0_0/0.08)]"
                  : "text-ink hover:bg-raised/50",
              )}
            >
              <span className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset",
                pending > 0
                  ? "bg-danger/15 text-danger ring-danger/25"
                  : "bg-ink/[0.06] text-ink-secondary ring-ink/[0.07]",
              )}>
                <Bell size={14} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">消息与申请</span>
              {pending > 0 ? (
                <span className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-danger px-1.5 text-[11px] font-semibold leading-5 tabular-nums text-white">
                  {pending > 99 ? "99+" : pending}
                </span>
              ) : outgoingCount > 0 ? (
                <span className="shrink-0 text-[11px] text-ink-tertiary">待确认 {outgoingCount}</span>
              ) : null}
            </button>

            <button
              type="button"
              data-collab-nav="folders"
              aria-current={isCollabView && selection.kind === "folders" ? "page" : undefined}
              onClick={() => select({ kind: "folders" })}
              className={cn(
                "flex min-h-9 w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors",
                FOCUS_RING,
                isCollabView && selection.kind === "folders"
                  ? "bg-raised text-ink shadow-[0_1px_2px_rgb(0_0_0/0.08)]"
                  : "text-ink hover:bg-raised/50",
              )}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#009957]/14 text-[#4CC98C] ring-1 ring-inset ring-[#009957]/24">
                <FolderOpen size={14} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">共享文件夹</span>
              {folderCount > 0 && (
                <span className="shrink-0 rounded-md bg-ink/[0.06] px-1.5 py-0.5 text-[11px] tabular-nums text-ink-secondary">{folderCount}</span>
              )}
            </button>

            <button
              type="button"
              data-collab-nav="bots"
              aria-current={isCollabView && selection.kind === "bots" ? "page" : undefined}
              onClick={() => select({ kind: "bots" })}
              className={cn(
                "flex min-h-9 w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors",
                FOCUS_RING,
                isCollabView && selection.kind === "bots"
                  ? "bg-raised text-ink shadow-[0_1px_2px_rgb(0_0_0/0.08)]"
                  : "text-ink hover:bg-raised/50",
              )}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent/14 text-accent-text ring-1 ring-inset ring-accent/24">
                <Bot size={14} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">共享 Bot</span>
              {botCount > 0 && (
                <span className="shrink-0 rounded-md bg-ink/[0.06] px-1.5 py-0.5 text-[11px] tabular-nums text-ink-secondary">{botCount}</span>
              )}
            </button>
          </div>
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
            {/* Friends section */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between px-2.5 py-0.5">
                <span className="text-[11px] font-semibold tracking-wide text-ink-tertiary">
                  好友 · {overview.friends.friends.length}
                </span>
                <button
                  type="button"
                  aria-label="添加好友"
                  title="添加好友"
                  onClick={() => select({ kind: "inbox" })}
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
                    return (
                      <li key={friend.user_id}>
                        <button
                          type="button"
                          data-collab-friend-row={friend.user_id}
                          aria-current={active ? "page" : undefined}
                          onClick={() => select({ kind: "friend", userId: friend.user_id })}
                          className={cn(
                            "flex min-h-12 w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors",
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
                            <span className="block truncate text-[13px] font-medium text-ink">{name}</span>
                            <span className="block truncate text-[11px] text-ink-tertiary">
                              {friendSummary(overview, friend.user_id)}
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

            {/* Teams section */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between px-2.5 py-0.5">
                <span className="text-[11px] font-semibold tracking-wide text-ink-tertiary">
                  团队 · {overview.teams.length}
                </span>
                <button
                  type="button"
                  aria-label="新建团队"
                  title="新建团队"
                  onClick={() => select({ kind: "contacts", focus: "create-team" })}
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
                    return (
                      <li key={team.id}>
                        <button
                          type="button"
                          data-collab-team-row={team.id}
                          aria-current={active ? "page" : undefined}
                          onClick={() => select({ kind: "team", teamId: team.id })}
                          className={cn(
                            "flex min-h-12 w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors",
                            FOCUS_RING,
                            active ? "bg-raised text-ink shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-ink hover:bg-raised/50",
                          )}
                        >
                          <CollabTeamBadge name={team.name} size={34} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-ink">{team.name}</span>
                            <span className="block truncate text-[11px] text-ink-tertiary">
                              {memberCount > 0 ? `${memberCount} 人 · ` : ""}{TEAM_ROLES[team.role]}
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
          </>
        )}
      </nav>

      <CollabProfileDialog
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        email={myEmail}
        initialNickname={myNickname}
        initialAvatarUrl={myAvatar}
        onSaved={() => void refreshCollabOverview({ silent: true })}
      />
    </>
  );
}
