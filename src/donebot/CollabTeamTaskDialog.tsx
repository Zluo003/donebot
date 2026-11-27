import { useMemo, useState } from "react";
import { AlertCircle, Bot, Check, FileEdit, Loader2, Quote, Sparkles, X } from "lucide-react";
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
  TASK_PRIORITY_DOT,
  TASK_PRIORITY_LABEL,
  toDateInputValue,
} from "./collab-types";
import { CollabSelect, type CollabSelectOption } from "./CollabSelect";
import { CollabTeamTaskDispatchBar } from "./CollabTeamTaskDispatchBar";

export interface TaskFromMessageSeed {
  channelId: string;
  scopeType: "team" | "channel";
  targetId: string;
  messageId: number;
  quote: string;
  defaultTitle: string;
}

const PRIORITIES: DoneBotTeamTaskPriority[] = ["low", "normal", "high", "urgent"];

const MAX_REVISIONS_OPTIONS: readonly CollabSelectOption[] = [
  { value: "2", label: "最多自动驳回 2 轮（推荐）" },
  { value: "1", label: "最多自动驳回 1 轮" },
  { value: "3", label: "最多自动驳回 3 轮" },
  { value: "0", label: "仅附审阅意见，不自动驳回" },
];

export function CollabTeamTaskDialog({
  teamId,
  teamName = "",
  myUserId,
  channels,
  members,
  jobTitles,
  editingTask,
  defaultChannelId = "",
  seedFromMessage,
  onClose,
  onSaved,
  onAiDispatched,
}: {
  teamId: string;
  teamName?: string;
  myUserId: number;
  channels: DoneBotTeamChannel[];
  members: DoneBotTeamMember[];
  jobTitles: Record<number, string>;
  editingTask?: DoneBotTeamTask | null;
  defaultChannelId?: string;
  seedFromMessage?: TaskFromMessageSeed | null;
  onClose: () => void;
  onSaved: (task: DoneBotTeamTask) => Promise<void> | void;
  onAiDispatched?: () => Promise<void> | void;
}) {
  const activeChannels = useMemo(() => channels.filter(c => !c.archived_at), [channels]);
  const [createMode, setCreateMode] = useState<"ai" | "manual">(editingTask || seedFromMessage ? "manual" : "ai");
  const [title, setTitle] = useState(editingTask?.title ?? seedFromMessage?.defaultTitle ?? "");
  const [description, setDescription] = useState(editingTask?.description ?? "");
  const [criteriaText, setCriteriaText] = useState((editingTask?.acceptance_criteria ?? []).join("\n"));
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
  const [autoReviewEnabled, setAutoReviewEnabled] = useState(editingTask?.auto_review_enabled ?? true);
  const [maxAutoRevisions, setMaxAutoRevisions] = useState<string>(String(editingTask?.max_auto_revisions ?? 2));
  const [assigneeAutoResubmit, setAssigneeAutoResubmit] = useState(editingTask?.assignee_auto_resubmit ?? true);
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

  const assigneeOptions = useMemo<CollabSelectOption[]>(() => [
    { value: "", label: "暂不指定（待认领）" },
    ...eligibleMembers.map(m => ({
      value: String(m.user_id),
      label: displayPersonName(m),
      hint: jobTitles[m.user_id],
    })),
  ], [eligibleMembers, jobTitles]);

  const reviewerOptions = useMemo<CollabSelectOption[]>(() => [
    { value: "", label: "团队任意管理员可验收" },
    ...eligibleMembers.map(m => ({
      value: String(m.user_id),
      label: displayPersonName(m),
      hint: jobTitles[m.user_id],
    })),
  ], [eligibleMembers, jobTitles]);

  const channelOptions = useMemo<CollabSelectOption[]>(() => [
    { value: "", label: "团队通用" },
    ...activeChannels.map(ch => ({
      value: ch.id,
      label: ch.is_private ? `🔒 ${ch.name}` : `#${ch.name}`,
    })),
  ], [activeChannels]);

  const priorityOptions = useMemo<CollabSelectOption[]>(() => PRIORITIES.map(p => ({
    value: p,
    label: TASK_PRIORITY_LABEL[p],
    dotClass: TASK_PRIORITY_DOT[p],
  })), []);

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
      const acceptanceCriteria = criteriaText
        .split(/\r?\n/)
        .map(line => line.replace(/^[-*•\d.)、\s]+/, "").trim())
        .filter(Boolean)
        .slice(0, 12);
      const parsedMaxRevisions = Math.max(0, Math.min(5, Number(maxAutoRevisions) || 0));

      let saved: DoneBotTeamTask;
      if (editingTask) {
        saved = await api<DoneBotTeamTask>(`/api/donebot/collab/teams/${teamId}/tasks/${editingTask.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            channel_id: channelId,
            title: cleanTitle,
            description: description.trim(),
            acceptance_criteria: acceptanceCriteria,
            priority,
            ...(nextAssignee ? { assignee_id: nextAssignee } : { clear_assignee: true }),
            ...(nextReviewer ? { reviewer_id: nextReviewer } : { clear_reviewer: true }),
            collaborator_ids: cleanCollaborators,
            ...(dueDate ? { due_at: dueDate } : { clear_due_at: true }),
            auto_review_enabled: autoReviewEnabled,
            max_auto_revisions: parsedMaxRevisions,
            assignee_auto_resubmit: assigneeAutoResubmit,
          }),
        });
      } else {
        saved = await api<DoneBotTeamTask>(`/api/donebot/collab/teams/${teamId}/tasks`, {
          method: "POST",
          body: JSON.stringify({
            channel_id: channelId,
            title: cleanTitle,
            description: description.trim(),
            acceptance_criteria: acceptanceCriteria,
            priority,
            assignee_id: nextAssignee,
            reviewer_id: nextReviewer,
            collaborator_ids: cleanCollaborators,
            due_at: dueDate || null,
            auto_review_enabled: autoReviewEnabled,
            max_auto_revisions: parsedMaxRevisions,
            assignee_auto_resubmit: assigneeAutoResubmit,
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
      aria-label={editingTask ? "编辑团队任务" : "派发团队任务"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs"
      onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-menu text-ink shadow-2xl ring-1 ring-ink/12">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-ink/[0.07] px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <h2 className="shrink-0 text-[16px] font-semibold text-ink">
              {editingTask ? "编辑任务" : seedFromMessage ? "从聊天消息转为任务" : "派发团队任务"}
            </h2>
            {!editingTask && (
              <div
                role="tablist"
                aria-label="派发方式"
                className="flex items-center rounded-full bg-ink/[0.06] p-0.5 ring-1 ring-inset ring-ink/[0.08]"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={createMode === "ai"}
                  data-collab-task-mode="ai"
                  onClick={() => setCreateMode("ai")}
                  className={cn(
                    "inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium transition-colors",
                    createMode === "ai"
                      ? "bg-composer text-accent-text shadow-xs"
                      : "text-ink-secondary hover:text-ink",
                  )}
                >
                  <Sparkles size={11.5} aria-hidden="true" />
                  <span>主协调助手派发</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={createMode === "manual"}
                  data-collab-task-mode="manual"
                  onClick={() => setCreateMode("manual")}
                  className={cn(
                    "inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium transition-colors",
                    createMode === "manual"
                      ? "bg-composer text-ink shadow-xs"
                      : "text-ink-secondary hover:text-ink",
                  )}
                >
                  <FileEdit size={11} aria-hidden="true" />
                  <span>手动填表</span>
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.08] hover:text-ink"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>

        {!editingTask && createMode === "ai" ? (
          <CollabTeamTaskDispatchBar
            teamId={teamId}
            teamName={teamName}
            channelId={channelId || undefined}
            members={members}
            jobTitles={jobTitles}
            sourceQuote={seedFromMessage?.quote}
            mode="dialog"
            onDispatched={async () => { await onAiDispatched?.(); }}
            onCloseDialog={onClose}
          />
        ) : (
          <form onSubmit={e => void submit(e)} className="flex min-h-0 flex-1 flex-col overflow-hidden">

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
            <label htmlFor="collab-task-title" className="text-[13px] font-medium text-ink-secondary">任务标题</label>
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
            <label htmlFor="collab-task-desc" className="text-[13px] font-medium text-ink-secondary">任务背景与详细要求</label>
            <textarea
              id="collab-task-desc"
              rows={2}
              data-collab-task-desc-input=""
              maxLength={8000}
              placeholder="写清背景、参考风格或需要对齐的重点（可选）"
              value={description}
              onChange={e => setDescription(e.target.value)}
              className={`${COLLAB_INPUT} resize-y`}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="collab-task-criteria" className="text-[13px] font-medium text-ink-secondary">
              客观验收清单（每行一条，供主协调助手自动初审对照）
            </label>
            <textarea
              id="collab-task-criteria"
              rows={3}
              data-collab-task-criteria-input=""
              maxLength={2000}
              placeholder={"例如：\n共 3 张 9:16 竖图\n古风红衣女主服饰与发饰一致\n画面无文字乱码、无水印"}
              value={criteriaText}
              onChange={e => setCriteriaText(e.target.value)}
              className={`${COLLAB_INPUT} resize-y`}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="collab-task-assignee" className="text-[13px] font-medium text-ink-secondary">负责人（真人）</label>
              <CollabSelect
                id="collab-task-assignee"
                ariaLabel="负责人（真人）"
                testAttr="data-collab-task-assignee-select"
                value={assigneeId}
                options={assigneeOptions}
                onChange={setAssigneeId}
                disabled={busy}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="collab-task-reviewer" className="text-[13px] font-medium text-ink-secondary">验收人（最终确认）</label>
              <CollabSelect
                id="collab-task-reviewer"
                ariaLabel="验收人（最终确认）"
                testAttr="data-collab-task-reviewer-select"
                value={reviewerId}
                options={reviewerOptions}
                onChange={setReviewerId}
                disabled={busy}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="collab-task-channel" className="text-[13px] font-medium text-ink-secondary">所属频道</label>
              <CollabSelect
                id="collab-task-channel"
                ariaLabel="所属频道"
                value={channelId}
                options={channelOptions}
                onChange={setChannelId}
                disabled={busy}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="collab-task-priority" className="text-[13px] font-medium text-ink-secondary">优先级</label>
              <CollabSelect
                id="collab-task-priority"
                ariaLabel="优先级"
                value={priority}
                options={priorityOptions}
                onChange={next => setPriority(next as DoneBotTeamTaskPriority)}
                disabled={busy}
                menuMinWidth={124}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="collab-task-due" className="text-[13px] font-medium text-ink-secondary">截止日期</label>
              <input
                id="collab-task-due"
                type="date"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
                className={COLLAB_INPUT}
              />
            </div>
          </div>

          {/* Bot automation policy */}
          <div className="flex flex-col gap-2 rounded-2xl bg-inset/50 p-3 ring-1 ring-inset ring-ink/[0.06]">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
              <Bot size={13.5} className="text-accent-text" aria-hidden="true" />
              <span>助手自动初审与返工规则</span>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ink-secondary">
              <input
                type="checkbox"
                checked={autoReviewEnabled}
                onChange={e => setAutoReviewEnabled(e.target.checked)}
                className="size-3.5 accent-accent"
              />
              <span>提交后由验收人的主协调助手自动初审并生成审阅意见</span>
            </label>
            {autoReviewEnabled && (
              <div className="flex flex-col gap-2 pl-5">
                <CollabSelect
                  ariaLabel="自动驳回轮次上限"
                  value={maxAutoRevisions}
                  options={MAX_REVISIONS_OPTIONS}
                  onChange={setMaxAutoRevisions}
                  disabled={busy}
                />
                <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ink-tertiary">
                  <input
                    type="checkbox"
                    checked={assigneeAutoResubmit}
                    onChange={e => setAssigneeAutoResubmit(e.target.checked)}
                    className="size-3.5 accent-accent"
                  />
                  <span>文案/图片类返工自动重提，仅高成本生视频先询问接收者确认</span>
                </label>
              </div>
            )}
          </div>

          {eligibleMembers.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-ink-secondary">协作者（可选，配合推进的同事）</span>
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
                          "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] ring-1 ring-inset transition-colors",
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
            <label className="flex cursor-pointer items-center gap-2 rounded-xl bg-inset/50 px-3 py-2 text-[13px] text-ink-secondary ring-1 ring-inset ring-ink/[0.06]">
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
            className={`${COLLAB_BUTTON} h-8 px-3.5 text-[13px]`}
          >
            取消
          </button>
          <button
            type="submit"
            data-collab-task-submit=""
            disabled={busy || !title.trim()}
            className={`${COLLAB_BUTTON} ui-button-primary h-8 px-4 text-[13px]`}
          >
            {busy && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
            {editingTask ? "保存修改" : "创建任务"}
          </button>
        </div>
          </form>
        )}
      </div>
    </div>
  );
}
