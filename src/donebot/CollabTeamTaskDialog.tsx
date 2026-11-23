import { useMemo, useState } from "react";
import { AlertCircle, Check, Loader2, Quote, X } from "lucide-react";
import { api } from "@/state/api";
import { cn } from "@/lib/cn";
import type {
  DoneBotTeamChannel,
  DoneBotTeamTask,
  DoneBotTeamTaskPriority,
} from "../../shared/donebot-collab";
import type { DoneBotTeamMember } from "../../shared/donebot-teams";
import {
  cleanError,
  COLLAB_BUTTON,
  COLLAB_INPUT,
  displayPersonName,
  TASK_PRIORITY_LABEL,
  toDateInputValue,
} from "./collab-types";

export interface TaskFromMessageSeed {
  channelId: string;
  scopeType: "team" | "channel";
  targetId: string;
  messageId: number;
  quote: string;
  defaultTitle: string;
}

const PRIORITIES: DoneBotTeamTaskPriority[] = ["low", "normal", "high", "urgent"];

export function CollabTeamTaskDialog({
  teamId,
  myUserId,
  channels,
  members,
  jobTitles,
  editingTask,
  defaultChannelId = "",
  seedFromMessage,
  onClose,
  onSaved,
}: {
  teamId: string;
  myUserId: number;
  channels: DoneBotTeamChannel[];
  members: DoneBotTeamMember[];
  jobTitles: Record<number, string>;
  editingTask?: DoneBotTeamTask | null;
  defaultChannelId?: string;
  seedFromMessage?: TaskFromMessageSeed | null;
  onClose: () => void;
  onSaved: (task: DoneBotTeamTask) => Promise<void> | void;
}) {
  const activeChannels = useMemo(() => channels.filter(c => !c.archived_at), [channels]);
  const [title, setTitle] = useState(editingTask?.title ?? seedFromMessage?.defaultTitle ?? "");
  const [description, setDescription] = useState(editingTask?.description ?? "");
  const [channelId, setChannelId] = useState(editingTask?.channel_id ?? seedFromMessage?.channelId ?? defaultChannelId);
  const [priority, setPriority] = useState<DoneBotTeamTaskPriority>(editingTask?.priority ?? "normal");
  const [assigneeId, setAssigneeId] = useState<string>(editingTask?.assignee_id ? String(editingTask.assignee_id) : "");
  const [reviewerId, setReviewerId] = useState<string>(
    editingTask
      ? (editingTask.reviewer_id ? String(editingTask.reviewer_id) : "")
      : (myUserId ? String(myUserId) : ""),
  );
  const [collaboratorIds, setCollaboratorIds] = useState<number[]>(editingTask?.collaborator_ids ?? []);
  const [dueDate, setDueDate] = useState<string>(toDateInputValue(editingTask?.due_at));
  const [notifyChannel, setNotifyChannel] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selectedChannel = useMemo(
    () => activeChannels.find(ch => ch.id === channelId) ?? null,
    [activeChannels, channelId],
  );
  const eligibleMembers = useMemo(() => {
    if (!selectedChannel?.is_private) return members;
    const allowed = new Set(selectedChannel.member_ids);
    return members.filter(m => allowed.has(m.user_id));
  }, [members, selectedChannel]);

  const memberOptionLabel = (m: DoneBotTeamMember) => {
    const name = displayPersonName(m);
    const role = jobTitles[m.user_id];
    return role ? `${name}（${role}）` : name;
  };

  const toggleCollaborator = (uid: number) => {
    setCollaboratorIds(prev => (prev.includes(uid) ? prev.filter(id => id !== uid) : [...prev, uid]));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle || busy) return;
    setBusy(true);
    setError("");
    try {
      const nextAssignee = assigneeId ? Number(assigneeId) : null;
      const nextReviewer = reviewerId ? Number(reviewerId) : null;
      const eligibleIds = new Set(eligibleMembers.map(m => m.user_id));
      const cleanCollaborators = collaboratorIds.filter(
        uid => eligibleIds.has(uid) && uid !== nextAssignee,
      );

      let saved: DoneBotTeamTask;
      if (editingTask) {
        saved = await api<DoneBotTeamTask>(`/api/donebot/collab/teams/${teamId}/tasks/${editingTask.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            channel_id: channelId,
            title: cleanTitle,
            description: description.trim(),
            priority,
            ...(nextAssignee ? { assignee_id: nextAssignee } : { clear_assignee: true }),
            ...(nextReviewer ? { reviewer_id: nextReviewer } : { clear_reviewer: true }),
            collaborator_ids: cleanCollaborators,
            ...(dueDate ? { due_at: dueDate } : { clear_due_at: true }),
          }),
        });
      } else {
        saved = await api<DoneBotTeamTask>(`/api/donebot/collab/teams/${teamId}/tasks`, {
          method: "POST",
          body: JSON.stringify({
            channel_id: channelId,
            title: cleanTitle,
            description: description.trim(),
            priority,
            assignee_id: nextAssignee,
            reviewer_id: nextReviewer,
            collaborator_ids: cleanCollaborators,
            due_at: dueDate || null,
            source_scope_type: seedFromMessage?.scopeType ?? "",
            source_target_id: seedFromMessage?.targetId ?? "",
            source_message_id: seedFromMessage?.messageId ?? null,
            source_quote: seedFromMessage?.quote ?? "",
            notify_channel: notifyChannel,
          }),
        });
      }
      await onSaved(saved);
      onClose();
    } catch (cause) {
      setError(cleanError(cause, editingTask ? "更新任务失败。" : "创建任务失败。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={editingTask ? "编辑团队任务" : "新建团队任务"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs"
      onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <form
        onSubmit={e => void submit(e)}
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-menu text-ink shadow-2xl ring-1 ring-ink/12"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-ink/[0.07] px-5 py-3.5">
          <h2 className="text-[15.5px] font-semibold text-ink">
            {editingTask ? "编辑任务" : seedFromMessage ? "从聊天消息转为团队任务" : "新建团队任务"}
          </h2>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.08] hover:text-ink"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4">
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
              <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          {seedFromMessage?.quote && (
            <div className="flex items-start gap-2 rounded-xl bg-inset/70 px-3 py-2 text-[12px] text-ink-secondary ring-1 ring-inset ring-ink/[0.07]">
              <Quote size={13} className="mt-0.5 shrink-0 text-ink-tertiary" aria-hidden="true" />
              <span className="line-clamp-3 whitespace-pre-wrap">{seedFromMessage.quote}</span>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label htmlFor="collab-task-title" className="text-[12.5px] font-medium text-ink-secondary">任务标题</label>
            <input
              id="collab-task-title"
              autoFocus
              data-collab-task-title-input=""
              maxLength={160}
              placeholder="例如：第3集分镜图与5秒样片、双十一主图视觉定稿"
              value={title}
              onChange={e => setTitle(e.target.value)}
              className={COLLAB_INPUT}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="collab-task-desc" className="text-[12.5px] font-medium text-ink-secondary">任务要求与验收标准</label>
            <textarea
              id="collab-task-desc"
              rows={3}
              data-collab-task-desc-input=""
              maxLength={8000}
              placeholder="写清背景、尺寸/时长要求、参考风格或需要对齐的重点（可选）"
              value={description}
              onChange={e => setDescription(e.target.value)}
              className={`${COLLAB_INPUT} resize-y`}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="collab-task-assignee" className="text-[12.5px] font-medium text-ink-secondary">负责人（真人）</label>
              <select
                id="collab-task-assignee"
                data-collab-task-assignee-select=""
                value={assigneeId}
                onChange={e => setAssigneeId(e.target.value)}
                className={COLLAB_INPUT}
              >
                <option value="">暂不指定（待认领）</option>
                {eligibleMembers.map(m => (
                  <option key={m.user_id} value={String(m.user_id)}>{memberOptionLabel(m)}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="collab-task-reviewer" className="text-[12.5px] font-medium text-ink-secondary">验收人（拍板确认）</label>
              <select
                id="collab-task-reviewer"
                data-collab-task-reviewer-select=""
                value={reviewerId}
                onChange={e => setReviewerId(e.target.value)}
                className={COLLAB_INPUT}
              >
                <option value="">团队任意管理员可验收</option>
                {eligibleMembers.map(m => (
                  <option key={m.user_id} value={String(m.user_id)}>{memberOptionLabel(m)}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="collab-task-channel" className="text-[12.5px] font-medium text-ink-secondary">所属频道</label>
              <select
                id="collab-task-channel"
                value={channelId}
                onChange={e => setChannelId(e.target.value)}
                className={COLLAB_INPUT}
              >
                <option value="">团队通用</option>
                {activeChannels.map(ch => (
                  <option key={ch.id} value={ch.id}>
                    {ch.is_private ? `🔒 ${ch.name}` : `#${ch.name}`}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="collab-task-priority" className="text-[12.5px] font-medium text-ink-secondary">优先级</label>
              <select
                id="collab-task-priority"
                value={priority}
                onChange={e => setPriority(e.target.value as DoneBotTeamTaskPriority)}
                className={COLLAB_INPUT}
              >
                {PRIORITIES.map(p => (
                  <option key={p} value={p}>{TASK_PRIORITY_LABEL[p]}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="collab-task-due" className="text-[12.5px] font-medium text-ink-secondary">截止日期</label>
              <input
                id="collab-task-due"
                type="date"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
                className={COLLAB_INPUT}
              />
            </div>
          </div>

          {eligibleMembers.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-ink-secondary">协作者（可选，配合推进的同事）</span>
              <div className="flex flex-wrap gap-1.5">
                {eligibleMembers
                  .filter(m => String(m.user_id) !== assigneeId)
                  .map(m => {
                    const active = collaboratorIds.includes(m.user_id);
                    return (
                      <button
                        key={m.user_id}
                        type="button"
                        onClick={() => toggleCollaborator(m.user_id)}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] ring-1 ring-inset transition-colors",
                          active
                            ? "bg-accent/14 text-accent-text ring-accent/30"
                            : "bg-inset/70 text-ink-secondary ring-ink/[0.08] hover:text-ink",
                        )}
                      >
                        {active && <Check size={11} aria-hidden="true" />}
                        <span>{displayPersonName(m)}</span>
                      </button>
                    );
                  })}
              </div>
            </div>
          )}

          {!editingTask && (
            <label className="flex cursor-pointer items-center gap-2 rounded-xl bg-inset/50 px-3 py-2 text-[12.5px] text-ink-secondary ring-1 ring-inset ring-ink/[0.06]">
              <input
                type="checkbox"
                checked={notifyChannel}
                onChange={e => setNotifyChannel(e.target.checked)}
                className="size-4 accent-accent"
              />
              <span>创建后自动在对应频道发送一条任务分工通知</span>
            </label>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-ink/[0.07] px-5 py-3.5">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className={`${COLLAB_BUTTON} h-8 px-3.5 text-[12.5px]`}
          >
            取消
          </button>
          <button
            type="submit"
            data-collab-task-submit=""
            disabled={busy || !title.trim()}
            className={`${COLLAB_BUTTON} ui-button-primary h-8 px-4 text-[12.5px]`}
          >
            {busy && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
            {editingTask ? "保存修改" : "创建任务"}
          </button>
        </div>
      </form>
    </div>
  );
}
