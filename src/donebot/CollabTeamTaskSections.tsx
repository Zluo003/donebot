import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  Download,
  Eye,
  FileText,
  ListChecks,
  Loader2,
  MessageSquare,
  Music,
  Paperclip,
  Play,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { api } from "@/state/api";
import { cn } from "@/lib/cn";
import type {
  DoneBotCollabTaskPrefs,
  DoneBotTeamTask,
  DoneBotTeamTaskDetail,
  DoneBotTeamTaskUpdate,
} from "../../shared/donebot-collab";
import {
  displayPersonName,
  formatChatTime,
  formatFileSize,
  formatShortDueDate,
} from "./collab-types";
import { classifyChatMediaKind, formatMessageStamp } from "./collab-chat-helpers";
import { CollabAvatar } from "./CollabAvatar";

export function taskFileUrl(fileId: string, inline = false): string {
  return `/api/donebot/collab/tasks/files/${encodeURIComponent(fileId)}${inline ? "?inline=1" : ""}`;
}

export async function downloadTaskFile(fileId: string, fileName: string) {
  const res = await fetch(taskFileUrl(fileId, false), { credentials: "same-origin" });
  if (!res.ok) {
    let msg = `下载失败（HTTP ${res.status}）。`;
    try {
      const payload = await res.json() as { error?: string };
      if (payload?.error) msg = payload.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = fileName || "file";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}

export function uploadTaskFile(
  teamId: string,
  taskId: string,
  kind: "submission" | "comment",
  file: File,
  body: string,
  notifyChannel: boolean,
  onProgress: (pct: number) => void,
  opts?: { batchId?: string; finalize?: boolean },
): Promise<DoneBotTeamTaskDetail> {
  const params = new URLSearchParams({ kind, name: file.name });
  if (body.trim()) params.set("body", body.trim());
  if (notifyChannel) params.set("notify_channel", "1");
  if (opts?.batchId) params.set("batch_id", opts.batchId);
  if (opts?.finalize === false) params.set("finalize", "0");
  const url = `/api/donebot/collab/teams/${teamId}/tasks/${taskId}/files?${params.toString()}`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = evt => {
      if (evt.lengthComputable && evt.total > 0) {
        onProgress(Math.min(100, Math.round((evt.loaded / evt.total) * 100)));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        try {
          resolve(JSON.parse(xhr.responseText) as DoneBotTeamTaskDetail);
        } catch {
          reject(new Error("服务器返回了无效的任务数据。"));
        }
        return;
      }
      let message = `上传失败（HTTP ${xhr.status}）。`;
      try {
        const parsed = JSON.parse(xhr.responseText) as { error?: string; message?: string };
        if (parsed?.error) message = parsed.error;
        else if (parsed?.message) message = parsed.message;
      } catch { /* ignore */ }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("网络中断，上传失败。"));
    xhr.ontimeout = () => reject(new Error("上传超时，请稍后重试。"));
    xhr.send(file);
  });
}

const TASK_PREFS_EVENT = "donebot-collab-task-prefs-changed";

export function ChiefAutoSubmitToggle({ variant = "compact" }: { variant?: "compact" | "card" }) {
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void api<DoneBotCollabTaskPrefs>("/api/donebot/collab/task-prefs")
      .then(res => {
        if (alive && typeof res?.chief_auto_submit_on_approve === "boolean") {
          setEnabled(res.chief_auto_submit_on_approve);
        }
      })
      .catch(() => {});
    const onChanged = (evt: Event) => {
      const detail = (evt as CustomEvent<DoneBotCollabTaskPrefs>).detail;
      if (detail && typeof detail.chief_auto_submit_on_approve === "boolean") {
        setEnabled(detail.chief_auto_submit_on_approve);
      }
    };
    window.addEventListener(TASK_PREFS_EVENT, onChanged);
    return () => {
      alive = false;
      window.removeEventListener(TASK_PREFS_EVENT, onChanged);
    };
  }, []);

  const toggle = async () => {
    if (saving) return;
    const next = !enabled;
    setSaving(true);
    setEnabled(next);
    try {
      const saved = await api<DoneBotCollabTaskPrefs>("/api/donebot/collab/task-prefs", {
        method: "PATCH",
        body: JSON.stringify({ chief_auto_submit_on_approve: next }),
      });
      const resolved = typeof saved?.chief_auto_submit_on_approve === "boolean" ? saved.chief_auto_submit_on_approve : next;
      setEnabled(resolved);
      window.dispatchEvent(new CustomEvent<DoneBotCollabTaskPrefs>(TASK_PREFS_EVENT, {
        detail: { chief_auto_submit_on_approve: resolved },
      }));
    } catch {
      setEnabled(!next);
    } finally {
      setSaving(false);
    }
  };

  const tooltip = "开启后，接收任务时主协调助手一审通过专长子助手的成果将直接代你提交团队验收；关闭（默认）时，一审通过先发给你确认后再提交。派发方主协调助手始终只做二审，不能代替终审。";

  if (variant === "card") {
    return (
      <div
        data-collab-task-prefs-card=""
        className="flex items-start justify-between gap-4 rounded-2xl bg-card/75 p-4 ring-1 ring-inset ring-ink/[0.08]"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
            <ShieldCheck size={15} className="text-accent-text" aria-hidden="true" />
            <span>主协调助手代人审批并自动提交团队任务</span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
            接收任务时，主协调助手会自动选派（或创建含 SOUL.md 与 Skill 的）专长子助手干活并执行一审。开启后，一审合格将直接自动提交团队验收；关闭（默认）则一审通过后先发给你确认再提交。派发方主协调助手始终仅做二审与驳回，终审必须由派发人确认。
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="主协调助手代人审批并自动提交团队任务"
          data-collab-chief-auto-submit=""
          disabled={saving}
          onClick={() => void toggle()}
          className={cn(
            "relative mt-0.5 inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors disabled:opacity-60",
            enabled ? "bg-accent" : "bg-ink/20",
          )}
        >
          <span
            className={cn(
              "inline-block size-5 rounded-full bg-white shadow-xs transition-transform",
              enabled ? "translate-x-5" : "translate-x-0",
            )}
          />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      data-collab-chief-auto-submit=""
      disabled={saving}
      title={tooltip}
      onClick={() => void toggle()}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-medium transition-colors ring-1 ring-inset disabled:opacity-60",
        enabled
          ? "bg-accent/14 text-accent-text ring-accent/30 hover:bg-accent/20"
          : "bg-ink/[0.04] text-ink-secondary ring-ink/[0.08] hover:bg-ink/[0.08] hover:text-ink",
      )}
    >
      <ShieldCheck size={12.5} aria-hidden="true" />
      <span>主协调代审提交：{enabled ? "开" : "关"}</span>
    </button>
  );
}

export function buildBotHandOffPrompt(
  teamName: string,
  task: DoneBotTeamTask,
  latestFeedback?: DoneBotTeamTaskUpdate,
  opts?: { isChief?: boolean },
): string {
  const isChief = opts?.isChief === true;
  const lines = [
    isChief
      ? `请作为主协调助手统筹推进团队「${teamName}」中的这项任务（严禁你亲自下场干活，请按能力自动派发给匹配的专长子助手；缺少该能力子助手时自动 create_bot 写好 SOUL.md 并用 skill_find/skill_import/skill_manage 配好 Skill 后再派发，子助手完成后由你自动一审）：`
      : `请帮我完成团队「${teamName}」中的这项任务，我会先审核效果，确认后再让你提交给团队验收：`,
    `【任务标题】${task.title}`,
    `【任务标识】team_id: ${task.team_id} / task_id: ${task.id}`,
  ];
  if (task.channel_name) lines.push(`【所属频道】#${task.channel_name}`);
  if (task.due_at) lines.push(`【截止时间】${formatShortDueDate(task.due_at)}`);
  if (task.description?.trim()) lines.push(`【任务要求】\n${task.description.trim()}`);
  if (task.acceptance_criteria && task.acceptance_criteria.length > 0) {
    lines.push(`【客观验收清单】\n${task.acceptance_criteria.map((c, idx) => `${idx + 1}. ${c}`).join("\n")}`);
  }
  if (task.source_quote?.trim()) lines.push(`【原讨论摘录】\n${task.source_quote.trim()}`);
  if (latestFeedback?.body?.trim()) lines.push(`【最新退回修改意见】\n${latestFeedback.body.trim()}`);
  lines.push(
    isChief
      ? "本会话已绑定该团队任务。若涉及高成本视频/音乐生成请先向我确认方案；其余常规任务请立即选派或自动创建专长子助手执行。子助手完成后由你自动一审（不合格直接用 coordinate_bots(rework=true) 驳回局部修改；一审通过后请按 collab_get_team_task().task_prefs.chief_auto_submit_on_approve 决定：开启则直接调用 collab_submit_team_task 代为提交，关闭则先汇报等我确认后再提交）。"
      : "本会话已绑定该团队任务。请先给出思路或成果，等我确认并说「提交任务」时，再调用 collab_submit_team_task 直接提交简报与成果文件。",
  );
  return lines.join("\n\n");
}

export function CollabTaskCriteriaCard({ criteria }: { criteria?: readonly string[] }) {
  if (!criteria || criteria.length === 0) return null;
  return (
    <div
      data-collab-task-criteria=""
      className="flex flex-col gap-2 rounded-2xl bg-card/70 p-3 ring-1 ring-inset ring-ink/[0.07]"
    >
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-secondary">
        <ListChecks size={13} className="text-accent-text" aria-hidden="true" />
        <span>客观验收清单（{criteria.length} 项）</span>
      </div>
      <ol className="flex flex-col gap-1.5 pl-0.5">
        {criteria.map((item, idx) => (
          <li key={`${idx}-${item}`} className="flex items-start gap-2 text-[12.5px] leading-relaxed text-ink">
            <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-ink/[0.08] text-[10.5px] font-medium tabular-nums text-ink-secondary">
              {idx + 1}
            </span>
            <span className="min-w-0 flex-1 break-words">{item}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function CollabTaskBotReviewCard({ task }: { task: DoneBotTeamTask }) {
  const review = task.latest_bot_review;
  if (task.status === "bot_reviewing") {
    return (
      <div
        data-collab-task-bot-review="reviewing"
        className="flex items-start gap-2.5 rounded-2xl bg-sky-500/[0.08] p-3 ring-1 ring-inset ring-sky-500/25"
      >
        <Bot size={16} className="mt-0.5 shrink-0 text-sky-500" aria-hidden="true" />
        <div className="min-w-0 flex-1 text-[12.5px]">
          <div className="font-medium text-ink">派发方主协调助手正在自动二审本批次交付物…</div>
          <p className="mt-0.5 text-[11.5px] text-ink-secondary">
            二审仅负责核验硬性要求与驳回，绝不代替终审；你也可以随时直接人工审批通过或退回。
          </p>
        </div>
      </div>
    );
  }
  if (!review) return null;
  const isPass = review.verdict === "pass";
  const isReject = review.verdict === "hard_fail";
  const boxCls = isPass
    ? "bg-emerald-500/[0.06] ring-emerald-500/25"
    : isReject
      ? "bg-purple-500/[0.07] ring-purple-500/25"
      : "bg-amber-500/[0.08] ring-amber-500/25";
  const titleText = isPass
    ? "派发方助手二审通过 · 待派发人终审"
    : isReject
      ? `派发方助手二审驳回（已返工 ${task.auto_revision_count ?? 1}/${task.max_auto_revisions ?? 2} 轮）`
      : "派发方助手已升级人工介入";
  return (
    <div
      data-collab-task-bot-review={review.verdict}
      className={cn("flex flex-col gap-2 rounded-2xl p-3 ring-1 ring-inset", boxCls)}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold text-ink">
          <Sparkles size={13.5} className={isPass ? "text-emerald-500" : isReject ? "text-purple-400" : "text-amber-500"} aria-hidden="true" />
          <span className="truncate">{titleText}</span>
        </div>
        {review.bot_name && (
          <span className="shrink-0 rounded-full bg-ink/[0.06] px-2 py-0 text-[10.5px] leading-5 text-ink-secondary">
            {review.bot_name}
          </span>
        )}
      </div>
      {review.summary && (
        <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink">{review.summary}</p>
      )}
      {review.passed_items && review.passed_items.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-medium text-emerald-500">已核验通过</div>
          {review.passed_items.map((item, idx) => (
            <div key={idx} className="flex items-start gap-1.5 text-[12px] text-ink-secondary">
              <CheckCircle2 size={12.5} className="mt-0.5 shrink-0 text-emerald-500" aria-hidden="true" />
              <span>{item}</span>
            </div>
          ))}
        </div>
      )}
      {review.attention_items && review.attention_items.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-medium text-amber-500">建议你重点关注与确认</div>
          {review.attention_items.map((item, idx) => (
            <div key={idx} className="flex items-start gap-1.5 text-[12px] text-ink">
              <Eye size={12.5} className="mt-0.5 shrink-0 text-amber-500" aria-hidden="true" />
              <span>{item}</span>
            </div>
          ))}
        </div>
      )}
      {review.failed_criteria && review.failed_criteria.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-medium text-orange-500">未达标的硬性要求</div>
          {review.failed_criteria.map((item, idx) => (
            <div key={idx} className="flex items-start gap-1.5 text-[12px] text-ink">
              <AlertTriangle size={12.5} className="mt-0.5 shrink-0 text-orange-500" aria-hidden="true" />
              <span>{item}</span>
            </div>
          ))}
        </div>
      )}
      {review.actionable_fixes && review.actionable_fixes.length > 0 && (
        <div className="flex flex-col gap-1 rounded-xl bg-inset/60 px-2.5 py-2">
          <div className="text-[11px] font-medium text-ink-secondary">已发给接收方助手的修改指令</div>
          {review.actionable_fixes.map((item, idx) => (
            <div key={idx} className="text-[12px] text-ink">{idx + 1}. {item}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CollabTaskDeliverablesGallery({
  deliverables,
  latestBatchId,
  downloadingId,
  onPreview,
  onDownload,
}: {
  deliverables: DoneBotTeamTaskUpdate[];
  latestBatchId?: string;
  downloadingId: string | null;
  onPreview: (u: DoneBotTeamTaskUpdate) => void;
  onDownload: (fileId: string, fileName: string) => void;
}) {
  if (deliverables.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold text-ink-secondary">
          已提交交付物（{deliverables.length} 个文件）
        </span>
        <span className="text-[11px] text-ink-tertiary">点击图片/视频/音频可直接预览验收</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {deliverables.map((u, idx) => {
          const mediaKind = classifyChatMediaKind(u.file_mime, u.file_name);
          const isLatest = latestBatchId
            ? u.batch_id === latestBatchId
            : idx === deliverables.length - 1;
          return (
            <div
              key={u.id}
              className="group relative flex flex-col overflow-hidden rounded-xl bg-card ring-1 ring-inset ring-ink/[0.08]"
            >
              <button
                type="button"
                onClick={() => onPreview(u)}
                className="relative flex h-24 w-full items-center justify-center overflow-hidden bg-inset/70 text-ink-secondary hover:opacity-90"
              >
                {mediaKind === "image" && u.file_id ? (
                  <img
                    src={taskFileUrl(u.file_id, true)}
                    alt={u.file_name || "交付图"}
                    className="h-full w-full object-cover"
                  />
                ) : mediaKind === "video" ? (
                  <div className="flex flex-col items-center gap-1">
                    <span className="flex size-9 items-center justify-center rounded-full bg-black/55 text-white">
                      <Play size={16} aria-hidden="true" />
                    </span>
                    <span className="text-[11px]">播放视频样片</span>
                  </div>
                ) : mediaKind === "audio" ? (
                  <div className="flex flex-col items-center gap-1">
                    <Music size={22} className="text-amber-500" aria-hidden="true" />
                    <span className="text-[11px]">试听音频</span>
                  </div>
                ) : (
                  <FileText size={24} className="text-ink-tertiary" aria-hidden="true" />
                )}
                <span className={cn(
                  "absolute left-1.5 top-1.5 rounded-full px-1.5 py-0 text-[10px] font-semibold leading-4",
                  isLatest ? "bg-accent text-accent-ink" : "bg-black/60 text-white",
                )}>
                  v{idx + 1}{isLatest ? " · 最新" : ""}
                </span>
              </button>
              <div className="flex items-center gap-1.5 px-2.5 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11.5px] font-medium text-ink">{u.file_name || "交付文件"}</div>
                  <div className="text-[10.5px] text-ink-tertiary">{formatFileSize(u.file_size)}</div>
                </div>
                {u.file_id && (
                  <button
                    type="button"
                    aria-label={`下载 ${u.file_name}`}
                    disabled={downloadingId !== null}
                    onClick={() => onDownload(u.file_id!, u.file_name || "file")}
                    className="flex size-6 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.08] hover:text-ink"
                  >
                    {downloadingId === u.file_id
                      ? <Loader2 size={12} className="animate-spin" />
                      : <Download size={12} />}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CollabTaskTimeline({
  updates,
  downloadingId,
  onPreview,
  onDownload,
}: {
  updates: DoneBotTeamTaskUpdate[];
  downloadingId: string | null;
  onPreview: (u: DoneBotTeamTaskUpdate) => void;
  onDownload: (fileId: string, fileName: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-secondary">
        <MessageSquare size={12.5} aria-hidden="true" />
        <span>进展与评审记录（{updates.length}）</span>
      </div>
      <div className="flex flex-col gap-2">
        {updates.map(u => {
          const actorName = displayPersonName({
            remark: u.actor_remark,
            nickname: u.actor_nickname,
            email: u.actor_email,
          });
          if (u.kind === "status_change") {
            return (
              <div key={u.id} className="flex items-center gap-2 px-1 py-0.5 text-[11.5px] text-ink-tertiary">
                <Clock size={11.5} className="shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-ink-secondary">{actorName}</span> {u.body}
                </span>
                <span className="shrink-0 tabular-nums">{formatChatTime(u.created_at)}</span>
              </div>
            );
          }
          const badge = u.kind === "submission"
            ? { label: "提交验收", cls: "bg-accent/14 text-accent-text ring-accent/25" }
            : u.kind === "approve"
              ? { label: "验收通过", cls: "bg-success/14 text-success ring-success/25" }
              : u.kind === "request_changes"
                ? { label: "退回修改", cls: "bg-orange-500/15 text-orange-500 ring-orange-500/30" }
                : u.kind === "bot_review_pass"
                  ? { label: "助手二审通过", cls: "bg-emerald-500/14 text-emerald-500 ring-emerald-500/25" }
                  : u.kind === "bot_reject"
                    ? { label: "助手二审驳回", cls: "bg-purple-500/15 text-purple-400 ring-purple-500/30" }
                    : u.kind === "bot_escalate"
                      ? { label: "升级人工介入", cls: "bg-amber-500/15 text-amber-500 ring-amber-500/30" }
                      : null;
          const isBotActor = u.actor_kind === "bot";
          return (
            <div
              key={u.id}
              data-collab-task-update={u.kind}
              className={cn(
                "flex flex-col gap-1.5 rounded-2xl p-3 ring-1 ring-inset",
                u.kind === "request_changes" || u.kind === "bot_escalate"
                  ? "bg-orange-500/[0.06] ring-orange-500/25"
                  : u.kind === "bot_reject"
                    ? "bg-purple-500/[0.06] ring-purple-500/25"
                    : u.kind === "approve" || u.kind === "bot_review_pass"
                      ? "bg-success/[0.06] ring-success/25"
                      : "bg-card/80 ring-ink/[0.07]",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <CollabAvatar
                    avatarUrl={u.actor_avatar_url}
                    remark={u.actor_remark}
                    nickname={u.actor_nickname}
                    email={u.actor_email}
                    size={22}
                  />
                  <span className="truncate text-[12.5px] font-medium text-ink">{actorName}</span>
                  {isBotActor && (
                    <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-ink/[0.07] px-1.5 py-0 text-[10px] font-medium leading-4 text-ink-secondary">
                      <Bot size={10} aria-hidden="true" />
                      {u.actor_bot_name?.trim() || "助手"}
                    </span>
                  )}
                  {badge && (
                    <span className={cn("inline-flex shrink-0 rounded-full px-1.5 py-0 text-[10px] font-medium leading-4 ring-1 ring-inset", badge.cls)}>
                      {badge.label}
                    </span>
                  )}
                </div>
                <span className="shrink-0 text-[11px] text-ink-tertiary">{formatMessageStamp(u.created_at)}</span>
              </div>
              {u.body && (
                <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">{u.body}</p>
              )}
              {u.file_id && (
                <div className="flex items-center gap-2 rounded-xl bg-inset/75 px-2.5 py-2 text-[12px] ring-1 ring-inset ring-ink/[0.07]">
                  <button
                    type="button"
                    onClick={() => onPreview(u)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-accent-text"
                  >
                    <Paperclip size={13} className="shrink-0 text-ink-tertiary" aria-hidden="true" />
                    <span className="truncate font-medium">{u.file_name || "附件"}</span>
                    <span className="shrink-0 text-[11px] text-ink-tertiary">{formatFileSize(u.file_size)}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`下载 ${u.file_name}`}
                    disabled={downloadingId !== null}
                    onClick={() => onDownload(u.file_id!, u.file_name || "file")}
                    className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.08] hover:text-ink"
                  >
                    {downloadingId === u.file_id ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
