import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Loader2, MessageSquarePlus, RefreshCw, UserPlus, Users } from "lucide-react";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { cn } from "@/lib/cn";
import {
  openCollabDialog,
  refreshCollabOverview,
  resolveTeamActiveChannel,
  useCollabStore,
} from "./collab-store";
import { COLLAB_BUTTON, COLLAB_CARD } from "./collab-types";
import { CollabChatView } from "./CollabChatView";
import { CollabRightPanel } from "./CollabRightPanel";
import { CollabTeamWorkspace } from "./CollabTeamWorkspace";

export function CollabWorkspacePage() {
  const { dragProps } = useCaptionChrome();
  const { overview, loaded, refreshing, error, selection, rightPanelOpen, teamChannelById } = useCollabStore();
  const [filesRefreshKey, setFilesRefreshKey] = useState(0);

  const reload = useCallback(async () => {
    await refreshCollabOverview();
  }, []);

  useEffect(() => {
    if (!loaded) void reload();
  }, [loaded, reload]);

  const activeFriend = selection?.kind === "friend"
    ? overview?.friends.friends.find(f => f.user_id === selection.userId) ?? null
    : null;
  const activeTeam = selection?.kind === "team"
    ? overview?.teams.find(t => t.id === selection.teamId) ?? null
    : null;
  const activeGroup = selection?.kind === "group"
    ? (overview?.groups ?? []).find(g => g.id === selection.groupId) ?? null
    : null;
  const activeScope = activeFriend ? "friend" : activeTeam ? "team" : "group";
  const activeTargetId = activeFriend ? String(activeFriend.user_id) : activeTeam ? activeTeam.id : (activeGroup?.id ?? "");
  const activeTeamChannel = activeTeam
    ? resolveTeamActiveChannel(overview, activeTeam.id, teamChannelById[activeTeam.id])
    : null;
  const activeChatBots = activeTeam
    ? (overview?.chat_bots?.[`team:${activeTeam.id}`] ?? [])
    : activeGroup
      ? (overview?.chat_bots?.[`group:${activeGroup.id}`] ?? [])
      : [];

  if (!loaded) {
    return (
      <main data-collab-workspace="" className="flex min-w-0 flex-1 flex-col items-center justify-center bg-app p-6 text-ink">
        <div className="flex items-center gap-2.5 text-[13.5px] text-ink-secondary">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          <span role="status">正在加载好友与团队…</span>
        </div>
      </main>
    );
  }

  if (!overview) {
    return (
      <main data-collab-workspace="" className="flex min-w-0 flex-1 flex-col bg-app text-ink">
        <header {...dragProps} className="h-[50px] shrink-0" />
        <div className="flex flex-1 items-center justify-center p-6">
          <div className={cn(COLLAB_CARD, "flex w-full max-w-md flex-col gap-3 p-6")}>
            <div className="text-[15px] font-semibold text-ink">协作服务暂未就绪</div>
            <p className="text-[13px] leading-relaxed text-ink-secondary">
              请确认已登录 DoneBot 账号，且网关已升级至最新版本后重试。
            </p>
            {error && (
              <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3.5 py-2.5 text-[12px] text-danger">
                <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}
            <div>
              <button type="button" onClick={() => void reload()} disabled={refreshing} className={`${COLLAB_BUTTON} text-[12.5px]`}>
                <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} aria-hidden="true" />重新连接
              </button>
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (!activeFriend && !activeTeam && !activeGroup) {
    return (
      <main data-collab-workspace="" className="flex min-w-0 flex-1 flex-col bg-app text-ink">
        <header {...dragProps} className="h-[50px] shrink-0" />
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="flex max-w-md flex-col items-center gap-4 text-center">
            <span className="flex size-14 items-center justify-center rounded-2xl bg-accent/14 text-accent-text ring-1 ring-inset ring-accent/25">
              <Users size={24} aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-[17px] font-semibold text-ink">开始与好友或团队协作</h1>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
                创建团队、发起好友群聊或添加好友后，可直接发消息、互传最大 100 MB 文件，并添加授权本机 Bot 在群内 @ 调用。
              </p>
            </div>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2.5">
              <button
                type="button"
                onClick={() => openCollabDialog({ kind: "add-team" })}
                className={`${COLLAB_BUTTON} ui-button-primary h-9 px-4 text-[13px]`}
              >
                <Users size={14} aria-hidden="true" />新建团队
              </button>
              <button
                type="button"
                onClick={() => openCollabDialog({ kind: "create-group" })}
                className={`${COLLAB_BUTTON} h-9 px-4 text-[13px]`}
              >
                <MessageSquarePlus size={14} aria-hidden="true" />发起群聊
              </button>
              <button
                type="button"
                onClick={() => openCollabDialog({ kind: "add-friend" })}
                className={`${COLLAB_BUTTON} h-9 px-4 text-[13px]`}
              >
                <UserPlus size={14} aria-hidden="true" />添加好友
              </button>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main data-collab-workspace="" className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-app text-ink">
      {activeTeam ? (
        <CollabTeamWorkspace
          team={activeTeam}
          chatBots={activeChatBots}
          overview={overview}
          onChatFileSent={() => setFilesRefreshKey(k => k + 1)}
          onReload={reload}
        />
      ) : (
        <CollabChatView
          scopeType={activeScope}
          targetId={activeTargetId}
          friend={activeFriend}
          team={null}
          group={activeGroup}
          chatBots={activeChatBots}
          overview={overview}
          onChatFileSent={() => setFilesRefreshKey(k => k + 1)}
        />
      )}
      {rightPanelOpen && (
        <CollabRightPanel
          friend={activeFriend}
          team={activeTeam}
          activeChannel={activeTeamChannel}
          group={activeGroup}
          chatBots={activeChatBots}
          overview={overview}
          filesRefreshKey={filesRefreshKey}
          onReload={reload}
        />
      )}
    </main>
  );
}
