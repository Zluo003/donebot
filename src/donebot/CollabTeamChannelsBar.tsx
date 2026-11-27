import { useState } from "react";
import {
  AlertCircle,
  Archive,
  Check,
  Hash,
  Loader2,
  Lock,
  Plus,
  Settings2,
  X,
} from "lucide-react";
import { api } from "@/state/api";
import { cn } from "@/lib/cn";
import type { DoneBotTeamChannel } from "../../shared/donebot-collab";
import type { DoneBotTeamIdentity, DoneBotTeamMember } from "../../shared/donebot-teams";
import { findChatSummary } from "./collab-store";
import {
  cleanError,
  COLLAB_BUTTON,
  COLLAB_INPUT,
  displayPersonName,
  type CollabOverview,
} from "./collab-types";
import { CollabAvatar } from "./CollabAvatar";

const CHANNEL_SUGGESTIONS = ["新品视觉", "内容排期", "分镜制作", "成片审阅", "投放复盘"];

export function CollabTeamChannelsBar({
  team,
  channels,
  activeChannel,
  members,
  jobTitles,
  overview,
  onSelectChannel,
  onReload,
}: {
  team: DoneBotTeamIdentity;
  channels: DoneBotTeamChannel[];
  activeChannel: DoneBotTeamChannel | null;
  members: DoneBotTeamMember[];
  jobTitles: Record<number, string>;
  overview: CollabOverview;
  onSelectChannel: (channelId: string) => void;
  onReload: () => Promise<void>;
}) {
  const [dialogMode, setDialogMode] = useState<"create" | "edit" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [memberIds, setMemberIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const myUserId = Number(overview.identity.account_id);
  const visibleChannels = channels.filter(ch => !ch.archived_at);
  const canManageActive = Boolean(
    activeChannel
    && (activeChannel.created_by === myUserId || team.role === "owner" || team.role === "admin"),
  );

  const openCreate = () => {
    setName("");
    setDescription("");
    setIsPrivate(false);
    setMemberIds(myUserId ? [myUserId] : []);
    setError("");
    setDialogMode("create");
  };

  const openEdit = () => {
    if (!activeChannel) return;
    setName(activeChannel.name);
    setDescription(activeChannel.description ?? "");
    setIsPrivate(activeChannel.is_private);
    setMemberIds(activeChannel.is_private
      ? (activeChannel.member_ids.length > 0 ? activeChannel.member_ids : (myUserId ? [myUserId] : []))
      : (myUserId ? [myUserId] : []));
    setError("");
    setDialogMode("edit");
  };

  const toggleMember = (userId: number) => {
    if (userId === myUserId) return;
    setMemberIds(prev => (prev.includes(userId) ? prev.filter(id => id !== userId) : [...prev, userId]));
  };

  const submitDialog = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim().replace(/^#+/, "").trim();
    if (!cleanName || busy) return;
    setBusy(true);
    setError("");
    try {
      if (dialogMode === "create") {
        const created = await api<DoneBotTeamChannel>(`/api/donebot/collab/teams/${team.id}/channels`, {
          method: "POST",
          body: JSON.stringify({
            name: cleanName,
            description: description.trim(),
            is_private: isPrivate,
            member_ids: isPrivate ? memberIds : [],
          }),
        });
        setDialogMode(null);
        await onReload();
        if (created?.id) onSelectChannel(created.id);
      } else if (dialogMode === "edit" && activeChannel) {
        await api<DoneBotTeamChannel>(`/api/donebot/collab/teams/${team.id}/channels/${activeChannel.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: cleanName,
            description: description.trim(),
            ...(activeChannel.is_default ? {} : {
              is_private: isPrivate,
              ...(isPrivate ? { member_ids: memberIds } : {}),
            }),
          }),
        });
        setDialogMode(null);
        await onReload();
      }
    } catch (cause) {
      setError(cleanError(cause, dialogMode === "create" ? "创建频道失败。" : "保存频道设置失败。"));
    } finally {
      setBusy(false);
    }
  };

  const archiveChannel = async () => {
    if (!activeChannel || activeChannel.is_default || busy) return;
    if (!window.confirm(`确定归档频道「#${activeChannel.name}」？归档后成员列表中将不再显示，但历史任务不会被删除。`)) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/donebot/collab/teams/${team.id}/channels/${activeChannel.id}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: true }),
      });
      setDialogMode(null);
      const fallback = visibleChannels.find(ch => ch.is_default && ch.id !== activeChannel.id)
        ?? visibleChannels.find(ch => ch.id !== activeChannel.id);
      await onReload();
      if (fallback) onSelectChannel(fallback.id);
    } catch (cause) {
      setError(cleanError(cause, "归档频道失败。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        data-collab-team-channels-bar=""
        className="flex shrink-0 items-center gap-2 border-b border-ink/[0.07] bg-app/90 px-4 py-2"
      >
        <div
          role="tablist"
          aria-label="团队频道"
          className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-0.5"
        >
          {visibleChannels.map(ch => {
            const selected = activeChannel?.id === ch.id;
            const summary = findChatSummary(overview, ch.chat_scope_type, ch.chat_target_id);
            const unread = selected ? 0 : (summary?.unread_count ?? 0);
            return (
              <button
                key={ch.id}
                type="button"
                role="tab"
                aria-selected={selected}
                data-collab-channel-pill={ch.id}
                onClick={() => onSelectChannel(ch.id)}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[13px] font-medium transition-colors",
                  selected
                    ? "bg-ink/[0.11] text-ink ring-1 ring-inset ring-ink/[0.12]"
                    : "text-ink-secondary hover:bg-ink/[0.06] hover:text-ink",
                )}
              >
                {ch.is_private
                  ? <Lock size={11} className="shrink-0 opacity-75" aria-hidden="true" />
                  : <Hash size={12} className="shrink-0 opacity-70" aria-hidden="true" />}
                <span className="max-w-[140px] truncate">{ch.name}</span>
                {unread > 0 && (
                  <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 tabular-nums text-white">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </button>
            );
          })}
          <button
            type="button"
            data-collab-create-channel=""
            onClick={openCreate}
            title="新建频道"
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink"
          >
            <Plus size={13} aria-hidden="true" />
            <span>新建频道</span>
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {activeChannel?.description && (
            <span className="hidden max-w-[220px] truncate text-[12px] text-ink-tertiary xl:inline">
              {activeChannel.description}
            </span>
          )}
          {canManageActive && (
            <button
              type="button"
              data-collab-edit-channel=""
              title="管理当前频道"
              aria-label="管理当前频道"
              onClick={openEdit}
              className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/[0.08] hover:text-ink"
            >
              <Settings2 size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {dialogMode && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={dialogMode === "create" ? "新建团队频道" : "管理团队频道"}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs"
          onClick={e => { if (e.target === e.currentTarget && !busy) setDialogMode(null); }}
        >
          <form
            onSubmit={e => void submitDialog(e)}
            className="flex w-full max-w-md flex-col gap-4 rounded-2xl bg-menu p-5 text-ink shadow-2xl ring-1 ring-ink/12"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-semibold text-ink">
                {dialogMode === "create" ? "新建团队频道" : `管理 #${activeChannel?.name ?? ""}`}
              </h2>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setDialogMode(null)}
                className="flex size-7 items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.08] hover:text-ink"
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>

            {error && (
              <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
                <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <label htmlFor="collab-channel-name" className="text-[13px] font-medium text-ink-secondary">频道名称</label>
              <input
                id="collab-channel-name"
                autoFocus
                data-collab-channel-name-input=""
                maxLength={60}
                placeholder="例如：第1-5集分镜、主图视觉、投流素材"
                value={name}
                onChange={e => setName(e.target.value)}
                className={COLLAB_INPUT}
              />
              {dialogMode === "create" && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {CHANNEL_SUGGESTIONS.map(preset => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setName(preset)}
                      className="rounded-full bg-ink/[0.05] px-2.5 py-0.5 text-[11px] text-ink-secondary hover:bg-ink/[0.1] hover:text-ink"
                    >
                      #{preset}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="collab-channel-desc" className="text-[13px] font-medium text-ink-secondary">频道简介（可选）</label>
              <input
                id="collab-channel-desc"
                maxLength={200}
                placeholder="说明这个频道用来推进什么项目或事项"
                value={description}
                onChange={e => setDescription(e.target.value)}
                className={COLLAB_INPUT}
              />
            </div>

            {!(dialogMode === "edit" && activeChannel?.is_default) && (
              <div className="flex flex-col gap-2.5 rounded-xl bg-inset/60 p-3 ring-1 ring-inset ring-ink/[0.07]">
                <label className="flex cursor-pointer items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                      <Lock size={13} aria-hidden="true" />设为私密频道
                    </div>
                    <p className="mt-0.5 text-[12px] text-ink-tertiary">
                      仅被选中的团队成员可查看该频道的消息、文件与关联任务。
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    data-collab-channel-private-toggle=""
                    checked={isPrivate}
                    onChange={e => setIsPrivate(e.target.checked)}
                    className="mt-1 size-4 accent-accent"
                  />
                </label>

                {isPrivate && (
                  <div className="flex max-h-40 flex-col gap-1 overflow-y-auto border-t border-ink/[0.07] pt-2">
                    <div className="text-[12px] text-ink-tertiary">选择可见成员（含你自己）</div>
                    {members.map(member => {
                      const checked = member.user_id === myUserId || memberIds.includes(member.user_id);
                      const title = jobTitles[member.user_id];
                      return (
                        <button
                          key={member.user_id}
                          type="button"
                          onClick={() => toggleMember(member.user_id)}
                          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-ink/[0.05]"
                        >
                          <span className={cn(
                            "flex size-4 shrink-0 items-center justify-center rounded border",
                            checked ? "border-accent bg-accent text-accent-ink" : "border-ink/25",
                          )}>
                            {checked && <Check size={11} aria-hidden="true" />}
                          </span>
                          <CollabAvatar
                            avatarUrl={member.avatar_url}
                            remark={member.remark}
                            nickname={member.nickname}
                            email={member.email}
                            size={22}
                          />
                          <span className="min-w-0 flex-1 truncate text-ink">{displayPersonName(member)}</span>
                          {title && (
                            <span className="shrink-0 rounded-full bg-ink/[0.06] px-1.5 py-0 text-[10px] text-ink-secondary">
                              {title}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center justify-between gap-2 pt-1">
              <div>
                {dialogMode === "edit" && activeChannel && !activeChannel.is_default && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void archiveChannel()}
                    className={`${COLLAB_BUTTON} h-8 px-3 text-[12px] text-danger hover:bg-danger/10`}
                  >
                    <Archive size={13} aria-hidden="true" />归档频道
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setDialogMode(null)}
                  className={`${COLLAB_BUTTON} h-8 px-3.5 text-[13px]`}
                >
                  取消
                </button>
                <button
                  type="submit"
                  data-collab-channel-submit=""
                  disabled={busy || !name.trim()}
                  className={`${COLLAB_BUTTON} ui-button-primary h-8 px-4 text-[13px]`}
                >
                  {busy && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                  {dialogMode === "create" ? "创建频道" : "保存"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
