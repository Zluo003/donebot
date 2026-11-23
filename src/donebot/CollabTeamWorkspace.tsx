import { useMemo, useState } from "react";
import {
  ChevronRight,
  ListTodo,
  MessageSquare,
  PanelRight,
  UserPlus,
} from "lucide-react";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { ELEVATED_FLOAT, ELEVATED_HOVER } from "@/components/elevated";
import { roundButtonCls } from "@/components/bot-panel/rows";
import { cn } from "@/lib/cn";
import type {
  DoneBotChatMessage,
  DoneBotCollabChatBot,
  DoneBotTeamChannel,
  DoneBotTeamTask,
} from "../../shared/donebot-collab";
import type { DoneBotTeamIdentity } from "../../shared/donebot-teams";
import {
  openCollabDialog,
  resolveTeamActiveChannel,
  setTeamActiveChannel,
  setTeamWorkspaceView,
  teamTaskActionCount,
  teamTotalUnreadCount,
  toggleCollabRightPanel,
  useCollabStore,
} from "./collab-store";
import { displayPersonName, teamJobTitleMap, type CollabOverview } from "./collab-types";
import { CollabTeamBadge } from "./CollabAvatar";
import { CollabChatView } from "./CollabChatView";
import { CollabTeamChannelsBar } from "./CollabTeamChannelsBar";
import { CollabTeamTaskDialog, type TaskFromMessageSeed } from "./CollabTeamTaskDialog";
import { CollabTeamTasksView } from "./CollabTeamTasksView";

export function CollabTeamWorkspace({
  team,
  chatBots,
  overview,
  onChatFileSent,
  onReload,
}: {
  team: DoneBotTeamIdentity;
  chatBots: DoneBotCollabChatBot[];
  overview: CollabOverview;
  onChatFileSent: () => void;
  onReload: () => Promise<void>;
}) {
  const { dragProps } = useCaptionChrome();
  const { rightPanelOpen, teamViewById, teamChannelById } = useCollabStore();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [tasksRefreshKey, setTasksRefreshKey] = useState(0);
  const [taskDialog, setTaskDialog] = useState<{
    open: boolean;
    editingTask?: DoneBotTeamTask | null;
    defaultChannelId?: string;
    seed?: TaskFromMessageSeed | null;
  }>({ open: false });

  const myUserId = Number(overview.identity.account_id);
  const members = overview.team_members[team.id] ?? [];
  const channels: DoneBotTeamChannel[] = overview.team_channels?.[team.id] ?? [];
  const jobTitles = useMemo(() => teamJobTitleMap(overview, team.id), [overview, team.id]);
  const activeView = teamViewById[team.id] ?? "channels";
  const activeChannel = useMemo(
    () => resolveTeamActiveChannel(overview, team.id, teamChannelById[team.id]),
    [overview, team.id, teamChannelById],
  );

  const chatScopeType = activeChannel?.chat_scope_type ?? "team";
  const chatTargetId = activeChannel?.chat_target_id ?? team.id;
  const unreadTotal = teamTotalUnreadCount(overview, team.id);
  const pendingTasks = teamTaskActionCount(overview, team.id);
  const canInviteTeam = team.role !== "member";

  const handleConvertMessageToTask = (msg: DoneBotChatMessage) => {
    const sender = msg.sender_kind === "bot"
      ? (msg.sender_bot_name || "机器人")
      : displayPersonName({
        remark: msg.sender_remark,
        nickname: msg.sender_nickname,
        email: msg.sender_email,
      });
    const rawText = msg.kind === "file"
      ? (msg.body?.trim() ? `${msg.body.trim()}（附件：${msg.file_name || "文件"}）` : `处理附件：${msg.file_name || "文件"}`)
      : msg.body.trim();
    const firstLine = rawText.split(/\r?\n/)[0]?.trim() || "处理频道讨论事项";
    const defaultTitle = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
    setTaskDialog({
      open: true,
      editingTask: null,
      defaultChannelId: activeChannel?.id ?? "",
      seed: {
        channelId: activeChannel?.id ?? "",
        scopeType: chatScopeType,
        targetId: chatTargetId,
        messageId: msg.id,
        quote: `${sender}：${rawText.slice(0, 400)}`,
        defaultTitle,
      },
    });
  };

  return (
    <section
      data-collab-team-workspace={team.id}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app"
    >
      {/* Unified Team Header */}
      <header {...dragProps} className="flex h-[54px] shrink-0 items-center justify-between gap-3 border-b border-ink/[0.06] px-4 max-md:pl-12">
        <button
          type="button"
          data-collab-chat-head-pill=""
          aria-expanded={rightPanelOpen}
          title={rightPanelOpen ? "收起右侧详情栏" : "展开右侧详情栏"}
          onClick={() => toggleCollabRightPanel()}
          className={cn(
            "group flex min-w-0 max-w-[min(45%,300px)] items-center gap-2 rounded-full py-[6px] pl-[7px] pr-[13px] text-ink",
            ELEVATED_FLOAT,
            ELEVATED_HOVER,
          )}
        >
          <CollabTeamBadge name={team.name} avatarUrl={team.avatar_url} size={26} />
          <span dir="auto" className="min-w-0 truncate text-[14px] font-medium leading-5">{team.name}</span>
          <span className="shrink-0 text-[12px] text-ink-tertiary">{members.length} 位成员</span>
          {!rightPanelOpen && (
            <ChevronRight size={13} aria-hidden="true" className="shrink-0 text-ink-tertiary transition-transform group-hover:translate-x-0.5" />
          )}
        </button>

        {/* Center view switcher: 频道聊天 | 任务分工 */}
        <div
          role="tablist"
          aria-label="团队工作视图"
          className="flex shrink-0 items-center rounded-full bg-ink/[0.06] p-0.5 ring-[0.5px] ring-inset ring-ink/[0.08]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeView === "channels"}
            data-collab-team-view-tab="channels"
            onClick={() => setTeamWorkspaceView(team.id, "channels")}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-colors",
              activeView === "channels"
                ? "bg-composer text-ink shadow-[0_1px_2px_rgb(0_0_0/0.12)] ring-[0.5px] ring-ink/10"
                : "text-ink-secondary hover:text-ink",
            )}
          >
            <MessageSquare size={13} aria-hidden="true" />
            <span>频道聊天</span>
            {unreadTotal > 0 && (
              <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 tabular-nums text-white">
                {unreadTotal > 99 ? "99+" : unreadTotal}
              </span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeView === "tasks"}
            data-collab-team-view-tab="tasks"
            onClick={() => setTeamWorkspaceView(team.id, "tasks")}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-colors",
              activeView === "tasks"
                ? "bg-composer text-ink shadow-[0_1px_2px_rgb(0_0_0/0.12)] ring-[0.5px] ring-ink/10"
                : "text-ink-secondary hover:text-ink",
            )}
          >
            <ListTodo size={13} aria-hidden="true" />
            <span>任务分工</span>
            {pendingTasks > 0 && (
              <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-4 tabular-nums text-accent-ink">
                {pendingTasks > 99 ? "99+" : pendingTasks}
              </span>
            )}
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {canInviteTeam && (
            <button
              type="button"
              data-collab-chat-invite=""
              aria-label="邀请团队成员"
              title="邀请团队成员"
              onClick={() => openCollabDialog({ kind: "invite-team", teamId: team.id })}
              className={roundButtonCls}
            >
              <UserPlus size={15} className="pointer-events-none" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            data-collab-toggle-panel=""
            aria-label={rightPanelOpen ? "收起右侧栏" : "展开右侧栏"}
            title={rightPanelOpen ? "收起右侧栏" : "展开右侧栏"}
            aria-pressed={rightPanelOpen}
            onClick={() => toggleCollabRightPanel()}
            className={cn(roundButtonCls, rightPanelOpen && "bg-ink/[0.12]")}
          >
            <PanelRight size={15} className="pointer-events-none" aria-hidden="true" />
          </button>
        </div>
      </header>

      {activeView === "channels" ? (
        <>
          <CollabTeamChannelsBar
            team={team}
            channels={channels}
            activeChannel={activeChannel}
            members={members}
            jobTitles={jobTitles}
            overview={overview}
            onSelectChannel={channelId => setTeamActiveChannel(team.id, channelId)}
            onReload={onReload}
          />
          <CollabChatView
            scopeType={chatScopeType}
            targetId={chatTargetId}
            team={team}
            channel={activeChannel}
            chatBots={chatBots}
            overview={overview}
            memberJobTitles={jobTitles}
            hideHeader
            onChatFileSent={onChatFileSent}
            onConvertToTask={handleConvertMessageToTask}
          />
        </>
      ) : (
        <CollabTeamTasksView
          team={team}
          channels={channels}
          members={members}
          jobTitles={jobTitles}
          overview={overview}
          refreshKey={tasksRefreshKey}
          selectedTaskId={selectedTaskId}
          onSelectTask={setSelectedTaskId}
          onOpenCreate={defaultChannelId => setTaskDialog({ open: true, editingTask: null, defaultChannelId, seed: null })}
          onOpenEdit={task => setTaskDialog({ open: true, editingTask: task, defaultChannelId: task.channel_id ?? "", seed: null })}
          onReloadOverview={onReload}
        />
      )}

      {taskDialog.open && (
        <CollabTeamTaskDialog
          teamId={team.id}
          myUserId={myUserId}
          channels={channels}
          members={members}
          jobTitles={jobTitles}
          editingTask={taskDialog.editingTask}
          defaultChannelId={taskDialog.defaultChannelId ?? activeChannel?.id ?? ""}
          seedFromMessage={taskDialog.seed}
          onClose={() => setTaskDialog({ open: false })}
          onSaved={async saved => {
            setTasksRefreshKey(k => k + 1);
            await onReload();
            if (taskDialog.seed) {
              setSelectedTaskId(saved.id);
              setTeamWorkspaceView(team.id, "tasks");
            } else {
              setSelectedTaskId(saved.id);
            }
          }}
        />
      )}
    </section>
  );
}
