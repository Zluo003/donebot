import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  Calendar,
  CheckCircle2,
  Hash,
  Loader2,
  Paperclip,
  Pencil,
  Play,
  Quote,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api } from "@/state/api";
import { useStore } from "@/state/store";
import { openBot } from "@/state/thread-navigation";
import { cn } from "@/lib/cn";
import {
  DONEBOT_COLLAB_MAX_FILE_BYTES,
  type DoneBotTeamTask,
  type DoneBotTeamTaskDetail,
  type DoneBotTeamTaskStatus,
  type DoneBotTeamTaskUpdate,
} from "../../shared/donebot-collab";
import type { DoneBotTeamIdentity, DoneBotTeamMember } from "../../shared/donebot-teams";
import { setCollabSidebarTab } from "./collab-store";
import {
  cleanError,
  COLLAB_BUTTON,
  COLLAB_INPUT,
  displayPersonName,
  formatFileSize,
  formatShortDueDate,
  isTaskOverdue,
  TASK_PRIORITY_DOT,
  TASK_PRIORITY_LABEL,
  TASK_STATUS_LABEL,
  TASK_STATUS_PILL,
} from "./collab-types";
import { classifyChatMediaKind } from "./collab-chat-helpers";
import { CollabMediaPreviewDialog, type CollabMediaPreviewTarget } from "./CollabMediaPreview";
import {
  buildBotHandOffPrompt,
  CollabTaskBotReviewCard,
  CollabTaskCriteriaCard,
  CollabTaskDeliverablesGallery,
  CollabTaskTimeline,
  downloadTaskFile,
  taskFileUrl,
  uploadTaskFile,
} from "./CollabTeamTaskSections";

const DETAIL_AUTO_REFRESH_MS = 5_000;
const MAX_SUBMIT_FILES = 10;

export function CollabTeamTaskDetailPanel({
  team,
  taskId,
  myUserId,
  members,
  jobTitles,
  onClose,
  onEdit,
  onMutated,
  onDeleted,
}: {
  team: DoneBotTeamIdentity;
  taskId: string;
  myUserId: number;
  members: DoneBotTeamMember[];
  jobTitles: Record<number, string>;
  onClose: () => void;
  onEdit: (task: DoneBotTeamTask) => void;
  onMutated: (task: DoneBotTeamTask) => Promise<void> | void;
  onDeleted: (taskId: string) => Promise<void> | void;
}) {
  const { state: appState, dispatch } = useStore();
  const [detail, setDetail] = useState<DoneBotTeamTaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [actionPane, setActionPane] = useState<null | "submit" | "reject" | "approve" | "bot">(null);
  const [submitBody, setSubmitBody] = useState("");
  const [submitFiles, setSubmitFiles] = useState<File[]>([]);
  const [submitNotify, setSubmitNotify] = useState(true);
  const [reviewBody, setReviewBody] = useState("");
  const [reviewNotify, setReviewNotify] = useState(true);
  const [commentDraft, setCommentDraft] = useState("");
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [previewMedia, setPreviewMedia] = useState<CollabMediaPreviewTarget | null>(null);
  const submitFileRef = useRef<HTMLInputElement>(null);
  const commentFileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const detailSeqRef = useRef(0);
  const submitInputId = useId();
  const commentFileId = useId();

  busyRef.current = busy;

  const memberById = useMemo(
    () => new Map(members.map(m => [m.user_id, m])),
    [members],
  );
  const availableLocalBots = useMemo(
    () => (appState.bots ?? []).filter(b => !b.hidden),
    [appState.bots],
  );

  const loadDetail = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    const seq = ++detailSeqRef.current;
    if (!silent) {
      setLoading(true);
      setError("");
    }
    try {
      const next = await api<DoneBotTeamTaskDetail>(`/api/donebot/collab/teams/${team.id}/tasks/${taskId}`);
      if (seq !== detailSeqRef.current) return;
      setDetail(next);
    } catch (cause) {
      if (seq !== detailSeqRef.current) return;
      if (!silent) setError(cleanError(cause, "加载任务详情失败。"));
    } finally {
      if (!silent && seq === detailSeqRef.current) setLoading(false);
    }
  }, [team.id, taskId]);

  useEffect(() => {
    setActionPane(null);
    setSubmitBody("");
    setSubmitFiles([]);
    setReviewBody("");
    setCommentDraft("");
    void loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (busyRef.current) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void loadDetail({ silent: true });
    }, DETAIL_AUTO_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && !busyRef.current) {
        void loadDetail({ silent: true });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadDetail]);

  const task = detail?.task ?? null;
  const updates = detail?.updates ?? [];
  const deliverables = useMemo(
    () => updates.filter(u => u.kind === "submission" && u.file_id),
    [updates],
  );
  const latestFeedback = useMemo(
    () => [...updates].reverse().find(u => u.kind === "request_changes" || u.kind === "bot_reject"),
    [updates],
  );

  const personLabel = (uid?: number) => {
    if (!uid) return "未指定";
    const m = memberById.get(uid);
    if (!m) return `成员 #${uid}`;
    const name = displayPersonName(m);
    const title = jobTitles[uid];
    return title ? `${name} · ${title}` : name;
  };

  const canExecute = Boolean(
    task && (
      !task.assignee_id
      || task.assignee_id === myUserId
      || task.collaborator_ids.includes(myUserId)
    ),
  );
  const canReview = Boolean(
    task && (
      task.reviewer_id === myUserId
      || !task.reviewer_id
      || team.role === "owner"
      || team.role === "admin"
    ),
  );
  const canDelete = Boolean(
    task && (task.creator_id === myUserId || team.role === "owner" || team.role === "admin"),
  );
  const canReopen = Boolean(task && task.status === "done" && (canReview || canExecute || canDelete));

  const assigneeShortName = task?.assignee_id
    ? (memberById.get(task.assignee_id) ? displayPersonName(memberById.get(task.assignee_id)!) : `成员 #${task.assignee_id}`)
    : "负责人";
  const reviewerShortName = task?.reviewer_id
    ? (memberById.get(task.reviewer_id) ? displayPersonName(memberById.get(task.reviewer_id)!) : `成员 #${task.reviewer_id}`)
    : "验收人";
  const showStartBtn = Boolean(task && canExecute && task.status === "todo");
  const showSubmitBtn = Boolean(
    task && canExecute && (
      task.status === "todo"
      || task.status === "in_progress"
      || task.status === "bot_revising"
      || task.status === "changes_requested"
      || task.status === "blocked"
    ),
  );
  const showReviewBtns = Boolean(
    task && canReview && (
      task.status === "in_review"
      || task.status === "bot_reviewing"
      || task.status === "ready_for_review"
    ),
  );
  const showBlockBtn = Boolean(
    task && canExecute && (task.status === "in_progress" || task.status === "changes_requested"),
  );
  const showHandoffBtn = Boolean(
    task && canExecute && availableLocalBots.length > 0 && task.status !== "done",
  );
  const hasActionButtons = showStartBtn || showSubmitBtn || showReviewBtns || showBlockBtn || canReopen || showHandoffBtn;
  const passiveStatusNote = !task ? "" : (
    task.status === "todo" ? `已指派给 ${assigneeShortName}，等待对方开始处理`
      : task.status === "in_progress" ? `${assigneeShortName} 正在处理中`
      : task.status === "bot_revising" ? `${assigneeShortName} 的助手正在按二审意见自动返工`
      : task.status === "changes_requested" ? `已退回给 ${assigneeShortName} 修改`
      : task.status === "blocked" ? `任务已阻塞，等待 ${assigneeShortName} 处理`
      : task.status === "in_review" || task.status === "bot_reviewing" || task.status === "ready_for_review"
        ? `已提交交付物，等待 ${reviewerShortName} 验收`
      : "任务已完成"
  );

  const quickStatus = async (status: DoneBotTeamTaskStatus, note?: string) => {
    if (!task || busy) return;
    setBusy(true);
    setError("");
    try {
      const updated = await api<DoneBotTeamTask>(`/api/donebot/collab/teams/${team.id}/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status, ...(note ? { note } : {}) }),
      });
      await loadDetail();
      await onMutated(updated);
    } catch (cause) {
      setError(cleanError(cause, "更新任务状态失败。"));
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!task || busy) return;
    setBusy(true);
    setError("");
    try {
      for (const file of submitFiles) {
        if (file.size === 0) throw new Error(`不能上传空文件「${file.name}」。`);
        if (file.size > DONEBOT_COLLAB_MAX_FILE_BYTES) {
          throw new Error(`「${file.name}」超过 100 MB 限制。`);
        }
      }
      let next: DoneBotTeamTaskDetail;
      if (submitFiles.length === 1) {
        setUploadPct(0);
        next = await uploadTaskFile(team.id, task.id, "submission", submitFiles[0]!, submitBody, submitNotify, setUploadPct);
      } else if (submitFiles.length > 1) {
        const batchId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `batch-${Date.now()}`;
        setUploadPct(0);
        for (let i = 0; i < submitFiles.length; i += 1) {
          const file = submitFiles[i]!;
          await uploadTaskFile(
            team.id,
            task.id,
            "submission",
            file,
            "",
            false,
            pct => setUploadPct(Math.round(((i + pct / 100) / submitFiles.length) * 95)),
            { batchId, finalize: false },
          );
        }
        next = await api<DoneBotTeamTaskDetail>(`/api/donebot/collab/teams/${team.id}/tasks/${task.id}/submit`, {
          method: "POST",
          body: JSON.stringify({
            body: submitBody.trim(),
            batch_id: batchId,
            notify_channel: submitNotify,
          }),
        });
        setUploadPct(100);
      } else {
        next = await api<DoneBotTeamTaskDetail>(`/api/donebot/collab/teams/${team.id}/tasks/${task.id}/submit`, {
          method: "POST",
          body: JSON.stringify({ body: submitBody.trim(), notify_channel: submitNotify }),
        });
      }
      setDetail(next);
      setActionPane(null);
      setSubmitBody("");
      setSubmitFiles([]);
      await onMutated(next.task);
    } catch (cause) {
      setError(cleanError(cause, "提交验收失败。"));
    } finally {
      setUploadPct(null);
      setBusy(false);
    }
  };

  const handleReview = async (decision: "approve" | "request_changes") => {
    if (!task || busy) return;
    if (decision === "request_changes" && !reviewBody.trim()) {
      setError("退回修改时请填写具体的修改意见。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const next = await api<DoneBotTeamTaskDetail>(`/api/donebot/collab/teams/${team.id}/tasks/${task.id}/review`, {
        method: "POST",
        body: JSON.stringify({
          decision,
          body: reviewBody.trim(),
          notify_channel: reviewNotify,
        }),
      });
      setDetail(next);
      setActionPane(null);
      setReviewBody("");
      await onMutated(next.task);
    } catch (cause) {
      setError(cleanError(cause, decision === "approve" ? "验收通过操作失败。" : "退回修改操作失败。"));
    } finally {
      setBusy(false);
    }
  };

  const handleSendComment = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = commentDraft.trim();
    if (!task || !text || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await api<DoneBotTeamTaskDetail>(`/api/donebot/collab/teams/${team.id}/tasks/${task.id}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: text }),
      });
      setDetail(next);
      setCommentDraft("");
      await onMutated(next.task);
    } catch (cause) {
      setError(cleanError(cause, "发送评论失败。"));
    } finally {
      setBusy(false);
    }
  };

  const handleUploadCommentFile = async (file: File) => {
    if (!task || busy) return;
    setError("");
    if (file.size === 0) {
      setError("不能上传空文件。");
      return;
    }
    if (file.size > DONEBOT_COLLAB_MAX_FILE_BYTES) {
      setError(`「${file.name}」超过 100 MB 限制。`);
      return;
    }
    setBusy(true);
    setUploadPct(0);
    try {
      const next = await uploadTaskFile(team.id, task.id, "comment", file, commentDraft.trim(), false, setUploadPct);
      setDetail(next);
      setCommentDraft("");
      await onMutated(next.task);
    } catch (cause) {
      setError(cleanError(cause, "上传参考附件失败。"));
    } finally {
      setUploadPct(null);
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!task || busy) return;
    if (!window.confirm(`确定删除任务「${task.title}」及其全部记录和附件？此操作不可撤销。`)) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/donebot/collab/teams/${team.id}/tasks/${task.id}`, { method: "DELETE" });
      await onDeleted(task.id);
    } catch (cause) {
      setError(cleanError(cause, "删除任务失败。"));
    } finally {
      setBusy(false);
    }
  };

  const handOffToLocalBot = async (botId: string) => {
    if (!task || busy) return;
    const bot = availableLocalBots.find(b => b.id === botId);
    if (!bot) return;
    setBusy(true);
    setError("");
    try {
      const isChief = Boolean(bot.chiefOfStaff);
      await api("/api/donebot/collab/task-bindings", {
        method: "POST",
        body: JSON.stringify({
          teamId: team.id,
          teamName: team.name,
          taskId: task.id,
          taskTitle: task.title,
          botId: bot.id,
          threadId: bot.threadId,
          ...(isChief ? { chiefBotId: bot.id, chiefThreadId: bot.threadId } : {}),
        }),
      }).catch(() => {});
      if (task.status === "todo") {
        const updated = await api<DoneBotTeamTask>(`/api/donebot/collab/teams/${team.id}/tasks/${task.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "in_progress" }),
        }).catch(() => null);
        if (updated) void onMutated(updated);
      }
      const recentMsgs = (bot.messages ?? []).slice(-12);
      const alreadyIntroducedTask = !latestFeedback && recentMsgs.some(
        m => typeof m.text === "string" && m.text.includes("[团队新任务") && m.text.includes(task.title),
      );
      const prompt = alreadyIntroducedTask
        ? (isChief
            ? `好的，按上面任务「${task.title}」的要求现在就开始编排推进：严禁亲自干活，请派发匹配能力的专长子助手（缺少则自动创建并配好 SOUL.md 和 Skill），子助手完成后由你一审，再按当前代审设置提交或汇报给我确认。`
            : `好的，按上面任务「${task.title}」的要求现在就开始执行吧；完成后先发给我审核，等我说「提交任务」再提交团队验收。`)
        : buildBotHandOffPrompt(team.name, task, latestFeedback, { isChief });
      setCollabSidebarTab("bots");
      openBot(dispatch, bot, false);
      dispatch({ type: "showChat" });
      dispatch({
        type: "send",
        botId: bot.id,
        threadId: bot.threadId,
        text: prompt,
        ...(bot.busy ? { followUp: "queue" as const } : {}),
      });
      setActionPane(null);
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = async (fileId: string, fileName: string) => {
    if (downloadingId) return;
    setDownloadingId(fileId);
    setError("");
    try {
      await downloadTaskFile(fileId, fileName);
    } catch (cause) {
      setError(cleanError(cause, "下载附件失败。"));
    } finally {
      setDownloadingId(null);
    }
  };

  const openMediaPreview = (u: DoneBotTeamTaskUpdate) => {
    if (!u.file_id) return;
    const mediaKind = classifyChatMediaKind(u.file_mime, u.file_name);
    if (mediaKind === "file") {
      void handleDownload(u.file_id, u.file_name || "file");
      return;
    }
    setPreviewMedia({
      kind: mediaKind,
      fileId: u.file_id,
      src: taskFileUrl(u.file_id, true),
      name: u.file_name || "交付物",
      size: u.file_size,
    });
  };

  const overdue = task ? isTaskOverdue(task.due_at, task.status) : false;

  return (
    <section
      data-collab-task-detail={taskId}
      className="flex min-h-0 w-full flex-col border-l border-ink/[0.08] bg-app lg:w-[460px] xl:w-[500px] lg:shrink-0"
    >
      {/* Detail header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-ink/[0.07] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {task && (
            <span className={cn("inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", TASK_STATUS_PILL[task.status])}>
              {TASK_STATUS_LABEL[task.status]}
            </span>
          )}
          {task && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-ink-tertiary">
              <span className={cn("size-1.5 rounded-full", TASK_PRIORITY_DOT[task.priority])} />
              {TASK_PRIORITY_LABEL[task.priority]}优先级
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {task && (
            <button
              type="button"
              title="编辑任务"
              aria-label="编辑任务"
              onClick={() => onEdit(task)}
              className="flex size-7 items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.08] hover:text-ink"
            >
              <Pencil size={13.5} aria-hidden="true" />
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              title="删除任务"
              aria-label="删除任务"
              disabled={busy}
              onClick={() => void handleDelete()}
              className="flex size-7 items-center justify-center rounded-full text-ink-secondary hover:bg-danger/10 hover:text-danger"
            >
              <Trash2 size={13.5} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            title="关闭详情"
            aria-label="关闭任务详情"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.08] hover:text-ink"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-secondary">
            <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            <span>正在加载任务详情…</span>
          </div>
        ) : !task ? (
          <div className="py-12 text-center text-[13px] text-danger">{error || "任务不存在或无权查看。"}</div>
        ) : (
          <div className="flex flex-col gap-4">
            {error && (
              <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
                <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span className="flex-1">{error}</span>
                <button type="button" onClick={() => setError("")} className="opacity-70 hover:opacity-100"><X size={13} /></button>
              </div>
            )}

            <div>
              <h2 className="text-[16px] font-semibold leading-snug text-ink">{task.title}</h2>
              {task.description && (
                <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-secondary">
                  {task.description}
                </p>
              )}
              {task.source_quote && (
                <div className="mt-2.5 flex items-start gap-2 rounded-xl bg-inset/65 px-3 py-2 text-[12px] text-ink-secondary ring-1 ring-inset ring-ink/[0.07]">
                  <Quote size={13} className="mt-0.5 shrink-0 text-ink-tertiary" aria-hidden="true" />
                  <span className="whitespace-pre-wrap">{task.source_quote}</span>
                </div>
              )}
            </div>

            {/* Primary workflow action bar */}
            <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-card/85 p-3 ring-1 ring-inset ring-ink/[0.07]">
              {showStartBtn && (
                <button
                  type="button"
                  data-collab-task-start=""
                  disabled={busy}
                  onClick={() => void quickStatus("in_progress")}
                  className={`${COLLAB_BUTTON} ui-button-primary h-8 px-3.5 text-[12.5px]`}
                >
                  <Play size={12.5} aria-hidden="true" />开始处理
                </button>
              )}

              {showSubmitBtn && (
                <button
                  type="button"
                  data-collab-task-open-submit=""
                  disabled={busy}
                  onClick={() => setActionPane(prev => (prev === "submit" ? null : "submit"))}
                  className={cn(
                    `${COLLAB_BUTTON} h-8 px-3.5 text-[12.5px]`,
                    task.status !== "todo" && "ui-button-primary",
                  )}
                >
                  <Upload size={13} aria-hidden="true" />提交验收
                </button>
              )}

              {showReviewBtns && (
                <>
                  <button
                    type="button"
                    data-collab-task-open-approve=""
                    disabled={busy}
                    onClick={() => setActionPane(prev => (prev === "approve" ? null : "approve"))}
                    className={`${COLLAB_BUTTON} h-8 bg-success/16 px-3.5 text-[12.5px] font-medium text-success ring-1 ring-inset ring-success/30 hover:bg-success/24`}
                  >
                    <CheckCircle2 size={13.5} aria-hidden="true" />验收通过
                  </button>
                  <button
                    type="button"
                    data-collab-task-open-reject=""
                    disabled={busy}
                    onClick={() => setActionPane(prev => (prev === "reject" ? null : "reject"))}
                    className={`${COLLAB_BUTTON} h-8 bg-orange-500/14 px-3.5 text-[12.5px] font-medium text-orange-500 ring-1 ring-inset ring-orange-500/30 hover:bg-orange-500/22`}
                  >
                    <RotateCcw size={13} aria-hidden="true" />退回修改
                  </button>
                </>
              )}

              {showBlockBtn && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void quickStatus("blocked")}
                  className={`${COLLAB_BUTTON} h-8 px-3 text-[12px] text-danger hover:bg-danger/10`}
                >
                  <AlertTriangle size={12.5} aria-hidden="true" />标记阻塞
                </button>
              )}

              {canReopen && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void quickStatus("in_progress")}
                  className={`${COLLAB_BUTTON} h-8 px-3 text-[12px]`}
                >
                  <RotateCcw size={12.5} aria-hidden="true" />重新打开
                </button>
              )}

              {showHandoffBtn && (
                <button
                  type="button"
                  data-collab-task-handoff-bot=""
                  disabled={busy}
                  onClick={() => setActionPane(prev => (prev === "bot" ? null : "bot"))}
                  className={`${COLLAB_BUTTON} ml-auto h-8 bg-accent/12 px-3 text-[12px] font-medium text-accent-text ring-1 ring-inset ring-accent/25 hover:bg-accent/20`}
                >
                  <Sparkles size={12.5} aria-hidden="true" />带给我的助手干活
                </button>
              )}

              {!hasActionButtons && (
                <span data-collab-task-passive-status="" className="text-[12.5px] text-ink-secondary">
                  {passiveStatusNote}
                </span>
              )}
            </div>

            {/* Contextual inline action panes */}
            {actionPane === "submit" && canExecute && (
              <form
                onSubmit={e => void handleSubmitReview(e)}
                data-collab-task-submit-form=""
                className="flex flex-col gap-2.5 rounded-2xl bg-card p-3.5 ring-1 ring-inset ring-accent/30"
              >
                <div className="text-[13px] font-medium text-ink">提交交付物并送审</div>
                <textarea
                  rows={2}
                  data-collab-task-submit-note=""
                  placeholder="写明交付说明、版本变化或文件所在共享文件夹位置（可选）"
                  value={submitBody}
                  onChange={e => setSubmitBody(e.target.value)}
                  className={`${COLLAB_INPUT} resize-y`}
                />
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <input
                      ref={submitFileRef}
                      id={submitInputId}
                      type="file"
                      multiple
                      className="sr-only"
                      onChange={e => {
                        const picked = Array.from(e.target.files ?? []);
                        if (picked.length > 0) {
                          setSubmitFiles(prev => [...prev, ...picked].slice(0, MAX_SUBMIT_FILES));
                        }
                        e.target.value = "";
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => submitFileRef.current?.click()}
                      className={`${COLLAB_BUTTON} h-8 px-3 text-[12px]`}
                    >
                      <Paperclip size={13} aria-hidden="true" />
                      {submitFiles.length > 0 ? `继续添加文件（${submitFiles.length}/${MAX_SUBMIT_FILES}）` : "上传图片 / 视频 / 文件（支持多选）"}
                    </button>
                  </div>
                  {submitFiles.length > 0 && (
                    <div className="flex flex-col gap-1">
                      {submitFiles.map((file, idx) => (
                        <div key={`${file.name}-${idx}`} className="flex min-w-0 items-center gap-1.5 rounded-lg bg-inset px-2.5 py-1 text-[12px] text-ink">
                          <span className="truncate flex-1">{file.name}</span>
                          <span className="shrink-0 text-ink-tertiary">{formatFileSize(file.size)}</span>
                          <button
                            type="button"
                            onClick={() => setSubmitFiles(prev => prev.filter((_, i) => i !== idx))}
                            className="text-ink-tertiary hover:text-ink"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {uploadPct !== null && (
                  <progress className="donebot-upload-progress" max={100} value={uploadPct} />
                )}
                <div className="flex items-center justify-between gap-2 pt-0.5">
                  <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-secondary">
                    <input
                      type="checkbox"
                      checked={submitNotify}
                      onChange={e => setSubmitNotify(e.target.checked)}
                      className="size-3.5 accent-accent"
                    />
                    <span>通知到频道</span>
                  </label>
                  <div className="flex items-center gap-1.5">
                    <button type="button" onClick={() => setActionPane(null)} className={`${COLLAB_BUTTON} h-7 px-3 text-[12px]`}>取消</button>
                    <button
                      type="submit"
                      data-collab-task-submit-confirm=""
                      disabled={busy}
                      className={`${COLLAB_BUTTON} ui-button-primary h-7 px-3.5 text-[12px]`}
                    >
                      {busy && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}确认提交验收
                    </button>
                  </div>
                </div>
              </form>
            )}

            {(actionPane === "approve" || actionPane === "reject") && (
              <div
                data-collab-task-review-form={actionPane}
                className={cn(
                  "flex flex-col gap-2.5 rounded-2xl bg-card p-3.5 ring-1 ring-inset",
                  actionPane === "approve" ? "ring-success/35" : "ring-orange-500/35",
                )}
              >
                <div className="text-[13px] font-medium text-ink">
                  {actionPane === "approve" ? "确认验收通过并定稿" : "退回修改（请写明修改意见）"}
                </div>
                <textarea
                  rows={2}
                  autoFocus
                  data-collab-task-review-input=""
                  placeholder={actionPane === "approve"
                    ? "可填写验收评语（选填，留空默认「验收通过，已定稿」）"
                    : "例如：第2秒人物光线偏暗、标题字号加大、主图卖点文案换一下"}
                  value={reviewBody}
                  onChange={e => setReviewBody(e.target.value)}
                  className={`${COLLAB_INPUT} resize-y`}
                />
                <div className="flex items-center justify-between gap-2">
                  <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-secondary">
                    <input
                      type="checkbox"
                      checked={reviewNotify}
                      onChange={e => setReviewNotify(e.target.checked)}
                      className="size-3.5 accent-accent"
                    />
                    <span>同步发到频道</span>
                  </label>
                  <div className="flex items-center gap-1.5">
                    <button type="button" onClick={() => setActionPane(null)} className={`${COLLAB_BUTTON} h-7 px-3 text-[12px]`}>取消</button>
                    <button
                      type="button"
                      data-collab-task-review-confirm=""
                      disabled={busy || (actionPane === "reject" && !reviewBody.trim())}
                      onClick={() => void handleReview(actionPane === "approve" ? "approve" : "request_changes")}
                      className={cn(
                        `${COLLAB_BUTTON} h-7 px-3.5 text-[12px] font-medium`,
                        actionPane === "approve"
                          ? "bg-success text-white hover:opacity-90"
                          : "bg-orange-500 text-white hover:opacity-90",
                      )}
                    >
                      {busy && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                      {actionPane === "approve" ? "确认通过" : "确认退回修改"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {actionPane === "bot" && canExecute && (
              <div className="flex flex-col gap-2 rounded-2xl bg-card p-3.5 ring-1 ring-inset ring-accent/30">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-medium text-ink">选择一个本机助手私下协助</span>
                  <button type="button" onClick={() => setActionPane(null)} className="text-ink-tertiary hover:text-ink"><X size={13} /></button>
                </div>
                <p className="text-[11.5px] leading-relaxed text-ink-tertiary">
                  选择主协调助手时会自动派发给匹配的专长子助手（缺人则自动创建并配好 Skill 与 SOUL.md）并由主协调一审；也可直接指定某位专长子助手干活。
                </p>
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {availableLocalBots.map(bot => (
                    <button
                      key={bot.id}
                      type="button"
                      disabled={busy}
                      data-collab-handoff-bot-pick={bot.id}
                      onClick={() => void handOffToLocalBot(bot.id)}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-inset px-3 py-1.5 text-[12.5px] font-medium text-ink ring-1 ring-inset ring-ink/[0.08] hover:bg-accent/14 hover:text-accent-text hover:ring-accent/30 disabled:opacity-50"
                    >
                      <Bot size={13} aria-hidden="true" />
                      <span>{bot.name}</span>
                      {bot.chiefOfStaff && <span className="rounded bg-accent/15 px-1 text-[10px] text-accent-text">主协调</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <CollabTaskBotReviewCard task={task} />

            <CollabTaskCriteriaCard criteria={task.acceptance_criteria} />

            {/* Metadata grid */}
            <div className="grid grid-cols-2 gap-2.5 rounded-2xl bg-card/65 p-3 text-[12px] ring-1 ring-inset ring-ink/[0.07]">
              <div>
                <div className="text-ink-tertiary">负责人</div>
                <div className="mt-0.5 font-medium text-ink">{personLabel(task.assignee_id)}</div>
              </div>
              <div>
                <div className="text-ink-tertiary">验收人</div>
                <div className="mt-0.5 font-medium text-ink">
                  {task.reviewer_id ? personLabel(task.reviewer_id) : "团队管理员"}
                </div>
              </div>
              <div>
                <div className="text-ink-tertiary">所属频道</div>
                <div className="mt-0.5 flex items-center gap-1 font-medium text-ink">
                  <Hash size={11.5} className="text-ink-tertiary" aria-hidden="true" />
                  <span>{task.channel_name || "团队通用"}</span>
                </div>
              </div>
              <div>
                <div className="text-ink-tertiary">截止时间</div>
                <div className={cn("mt-0.5 flex items-center gap-1 font-medium", overdue ? "text-danger" : "text-ink")}>
                  <Calendar size={11.5} aria-hidden="true" />
                  <span>{task.due_at ? `${formatShortDueDate(task.due_at)}${overdue ? "（已逾期）" : ""}` : "未设定"}</span>
                </div>
              </div>
              {task.collaborator_ids.length > 0 && (
                <div className="col-span-2 border-t border-ink/[0.06] pt-2">
                  <div className="text-ink-tertiary">协作者</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {task.collaborator_ids.map(uid => (
                      <span key={uid} className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11.5px] text-ink">
                        {personLabel(uid)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <CollabTaskDeliverablesGallery
              deliverables={deliverables}
              latestBatchId={task.latest_submission_batch_id}
              downloadingId={downloadingId}
              onPreview={openMediaPreview}
              onDownload={(fileId, fileName) => void handleDownload(fileId, fileName)}
            />

            <CollabTaskTimeline
              updates={updates}
              downloadingId={downloadingId}
              onPreview={openMediaPreview}
              onDownload={(fileId, fileName) => void handleDownload(fileId, fileName)}
            />
          </div>
        )}
      </div>

      {/* Bottom comment composer */}
      {task && (
        <form
          onSubmit={e => void handleSendComment(e)}
          className="flex shrink-0 items-center gap-2 border-t border-ink/[0.07] bg-app px-4 py-3"
        >
          <input
            ref={commentFileRef}
            id={commentFileId}
            type="file"
            className="sr-only"
            onChange={e => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void handleUploadCommentFile(file);
            }}
          />
          <button
            type="button"
            disabled={busy}
            title="上传参考附件"
            aria-label="上传参考附件"
            onClick={() => commentFileRef.current?.click()}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.08] hover:text-ink"
          >
            <Paperclip size={15} aria-hidden="true" />
          </button>
          <input
            type="text"
            data-collab-task-comment-input=""
            placeholder="补充进展、讨论细节或反馈意见…"
            value={commentDraft}
            onChange={e => setCommentDraft(e.target.value)}
            disabled={busy}
            className={`${COLLAB_INPUT} h-9 py-1.5`}
          />
          <button
            type="submit"
            data-collab-task-comment-send=""
            disabled={busy || !commentDraft.trim()}
            aria-label="发送评论"
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
              commentDraft.trim() && !busy
                ? "bg-accent text-accent-ink hover:opacity-90"
                : "bg-ink/[0.08] text-ink-tertiary",
            )}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          </button>
        </form>
      )}

      <CollabMediaPreviewDialog
        preview={previewMedia}
        downloading={downloadingId !== null}
        onClose={() => setPreviewMedia(null)}
        onDownload={(fileId, fileName) => void handleDownload(fileId, fileName)}
      />
    </section>
  );
}
