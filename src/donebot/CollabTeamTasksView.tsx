import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Calendar,
  Columns3,
  Hash,
  LayoutList,
  ListTodo,
  Loader2,
  MessageSquare,
  Paperclip,
  Plus,
  RefreshCw,
} from "lucide-react";
import { api } from "@/state/api";
import { cn } from "@/lib/cn";
import type {
  DoneBotTeamChannel,
  DoneBotTeamTask,
  DoneBotTeamTaskStatus,
} from "../../shared/donebot-collab";
import type { DoneBotTeamIdentity, DoneBotTeamMember } from "../../shared/donebot-teams";
import { teamTaskCountsFor } from "./collab-store";
import {
  cleanError,
  COLLAB_BUTTON,
  displayPersonName,
  formatShortDueDate,
  isTaskOverdue,
  TASK_PRIORITY_DOT,
  TASK_PRIORITY_LABEL,
  TASK_STATUS_LABEL,
  TASK_STATUS_PILL,
  type CollabOverview,
} from "./collab-types";
import { CollabAvatar } from "./CollabAvatar";
import { CollabTeamTaskDetailPanel } from "./CollabTeamTaskDetail";

type TaskScopeFilter = "all" | "mine" | "review" | "created";
type TaskStatusFilter = "open" | "all" | DoneBotTeamTaskStatus;
type TaskLayoutMode = "list" | "board";

const BOARD_COLUMNS: ReadonlyArray<{
  id: string;
  label: string;
  statuses: readonly DoneBotTeamTaskStatus[];
  accentCls: string;
}> = [
  { id: "todo", label: "待开始", statuses: ["todo"], accentCls: "bg-ink-tertiary" },
  { id: "active", label: "进行中 / 待修改", statuses: ["in_progress", "changes_requested", "blocked"], accentCls: "bg-accent" },
  { id: "review", label: "待验收", statuses: ["in_review"], accentCls: "bg-amber-500" },
  { id: "done", label: "已完成", statuses: ["done"], accentCls: "bg-success" },
];

export function CollabTeamTasksView({
  team,
  channels,
  members,
  jobTitles,
  overview,
  refreshKey,
  selectedTaskId,
  onSelectTask,
  onOpenCreate,
  onOpenEdit,
  onReloadOverview,
}: {
  team: DoneBotTeamIdentity;
  channels: DoneBotTeamChannel[];
  members: DoneBotTeamMember[];
  jobTitles: Record<number, string>;
  overview: CollabOverview;
  refreshKey: number;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  onOpenCreate: (defaultChannelId?: string) => void;
  onOpenEdit: (task: DoneBotTeamTask) => void;
  onReloadOverview: () => Promise<void>;
}) {
  const [tasks, setTasks] = useState<DoneBotTeamTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [scope, setScope] = useState<TaskScopeFilter>("all");
  const [channelFilter, setChannelFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<TaskStatusFilter>("open");
  const [layout, setLayout] = useState<TaskLayoutMode>("list");

  const myUserId = Number(overview.identity.account_id);
  const activeChannels = useMemo(() => channels.filter(c => !c.archived_at), [channels]);
  const memberById = useMemo(
    () => new Map(members.map(m => [m.user_id, m])),
    [members],
  );
  const counts = teamTaskCountsFor(overview, team.id);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (channelFilter) params.set("channel_id", channelFilter);
      params.set("status", layout === "board" ? "all" : statusFilter);
      if (scope !== "all") params.set("scope", scope);
      const list = await api<DoneBotTeamTask[]>(
        `/api/donebot/collab/teams/${team.id}/tasks?${params.toString()}`,
      );
      setTasks(Array.isArray(list) ? list : []);
    } catch (cause) {
      setError(cleanError(cause, "加载团队任务失败，请确认网关已升级至最新版本。"));
    } finally {
      setLoading(false);
    }
  }, [team.id, channelFilter, statusFilter, scope, layout]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks, refreshKey]);

  const handleMutated = async () => {
    await Promise.all([loadTasks(), onReloadOverview()]);
  };

  const handleDeleted = async (deletedId: string) => {
    if (selectedTaskId === deletedId) onSelectTask(null);
    await Promise.all([loadTasks(), onReloadOverview()]);
  };

  const renderPersonChip = (uid: number | undefined, roleHint: string) => {
    if (!uid) {
      return <span className="text-[11.5px] text-ink-tertiary">{roleHint}：待认领</span>;
    }
    const m = memberById.get(uid);
    const label = m ? displayPersonName(m) : `成员 #${uid}`;
    return (
      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
        {m && (
          <CollabAvatar
            avatarUrl={m.avatar_url}
            remark={m.remark}
            nickname={m.nickname}
            email={m.email}
            size={18}
          />
        )}
        <span className="max-w-[110px] truncate">{roleHint}：{label}</span>
      </span>
    );
  };

  const renderTaskCard = (task: DoneBotTeamTask, compact = false) => {
    const selected = selectedTaskId === task.id;
    const overdue = isTaskOverdue(task.due_at, task.status);
    const needsMyReview = task.status === "in_review" && task.reviewer_id === myUserId;
    const needsMyFix = task.status === "changes_requested" && task.assignee_id === myUserId;
    return (
      <button
        key={task.id}
        type="button"
        data-collab-task-card={task.id}
        onClick={() => onSelectTask(task.id)}
        className={cn(
          "flex w-full flex-col gap-2 rounded-2xl p-3 text-left transition-colors ring-1 ring-inset",
          selected
            ? "bg-raised ring-accent/45 shadow-[0_1px_3px_rgb(0_0_0/0.12)]"
            : "bg-card/85 ring-ink/[0.07] hover:bg-raised/65 hover:ring-ink/[0.14]",
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              title={`${TASK_PRIORITY_LABEL[task.priority]}优先级`}
              className={cn("size-2 shrink-0 rounded-full", TASK_PRIORITY_DOT[task.priority])}
            />
            <span className={cn("truncate text-[13.5px] font-medium", task.status === "done" ? "text-ink-tertiary line-through" : "text-ink")}>
              {task.title}
            </span>
          </div>
          {!compact && (
            <span className={cn("inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1 ring-inset", TASK_STATUS_PILL[task.status])}>
              {TASK_STATUS_LABEL[task.status]}
            </span>
          )}
        </div>

        {(needsMyReview || needsMyFix) && (
          <div className="flex flex-wrap gap-1.5">
            {needsMyReview && (
              <span className="inline-flex rounded-full bg-amber-500/14 px-2 py-0 text-[10.5px] font-medium leading-5 text-amber-500 ring-1 ring-inset ring-amber-500/25">
                待你验收拍板
              </span>
            )}
            {needsMyFix && (
              <span className="inline-flex rounded-full bg-orange-500/14 px-2 py-0 text-[10.5px] font-medium leading-5 text-orange-500 ring-1 ring-inset ring-orange-500/25">
                验收退回，待你修改
              </span>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {renderPersonChip(task.assignee_id, "负责")}
          {!compact && task.reviewer_id && renderPersonChip(task.reviewer_id, "验收")}
          {task.channel_name && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-ink/[0.05] px-2 py-0 text-[11px] text-ink-secondary">
              <Hash size={10} aria-hidden="true" />
              {task.channel_name}
            </span>
          )}
          {task.due_at && (
            <span className={cn("inline-flex items-center gap-1 text-[11px]", overdue ? "font-medium text-danger" : "text-ink-tertiary")}>
              <Calendar size={11} aria-hidden="true" />
              {formatShortDueDate(task.due_at)}{overdue ? " 逾期" : ""}
            </span>
          )}
          <span className="ml-auto flex items-center gap-2 text-[11px] text-ink-tertiary">
            {task.deliverable_count > 0 && (
              <span className="inline-flex items-center gap-0.5 text-ink-secondary" title="已提交交付物">
                <Paperclip size={11} aria-hidden="true" />{task.deliverable_count}
              </span>
            )}
            {task.update_count > 0 && (
              <span className="inline-flex items-center gap-0.5" title="评论与评审记录">
                <MessageSquare size={11} aria-hidden="true" />{task.update_count}
              </span>
            )}
          </span>
        </div>
      </button>
    );
  };

  return (
    <div data-collab-team-tasks="" className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* Filter & action toolbar */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-ink/[0.07] px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {([
              { id: "all" as const, label: "全部任务" },
              { id: "mine" as const, label: "指派给我", count: counts?.assigned_to_me ?? 0 },
              { id: "review" as const, label: "待我验收", count: counts?.review_by_me ?? 0 },
              { id: "created" as const, label: "我创建的" },
            ]).map(item => (
              <button
                key={item.id}
                type="button"
                data-collab-task-scope={item.id}
                onClick={() => setScope(item.id)}
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium transition-colors",
                  scope === item.id
                    ? "bg-ink/[0.11] text-ink ring-1 ring-inset ring-ink/[0.12]"
                    : "text-ink-secondary hover:bg-ink/[0.06] hover:text-ink",
                )}
              >
                <span>{item.label}</span>
                {item.count !== undefined && item.count > 0 && (
                  <span className={cn(
                    "inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-4 tabular-nums",
                    item.id === "review" ? "bg-amber-500 text-white" : "bg-accent text-accent-ink",
                  )}>
                    {item.count}
                  </span>
                )}
              </button>
            ))}

            <select
              aria-label="按频道筛选任务"
              value={channelFilter}
              onChange={e => setChannelFilter(e.target.value)}
              className="h-7 rounded-full bg-ink/[0.05] px-2.5 text-[12px] text-ink outline-none ring-1 ring-inset ring-ink/[0.08]"
            >
              <option value="">全部频道</option>
              {activeChannels.map(ch => (
                <option key={ch.id} value={ch.id}>{ch.is_private ? `🔒 ${ch.name}` : `#${ch.name}`}</option>
              ))}
            </select>

            {layout === "list" && (
              <select
                aria-label="按状态筛选任务"
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value as TaskStatusFilter)}
                className="h-7 rounded-full bg-ink/[0.05] px-2.5 text-[12px] text-ink outline-none ring-1 ring-inset ring-ink/[0.08]"
              >
                <option value="open">未完成</option>
                <option value="in_review">待验收</option>
                <option value="changes_requested">待修改</option>
                <option value="in_progress">进行中</option>
                <option value="todo">待开始</option>
                <option value="blocked">已阻塞</option>
                <option value="done">已完成</option>
                <option value="all">全部状态</option>
              </select>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <div className="flex rounded-full bg-ink/[0.06] p-0.5 ring-1 ring-inset ring-ink/[0.07]">
              <button
                type="button"
                title="列表视图"
                aria-label="列表视图"
                aria-pressed={layout === "list"}
                onClick={() => setLayout("list")}
                className={cn(
                  "flex size-6 items-center justify-center rounded-full transition-colors",
                  layout === "list" ? "bg-composer text-ink shadow-xs" : "text-ink-secondary hover:text-ink",
                )}
              >
                <LayoutList size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                title="看板视图"
                aria-label="看板视图"
                aria-pressed={layout === "board"}
                onClick={() => setLayout("board")}
                className={cn(
                  "flex size-6 items-center justify-center rounded-full transition-colors",
                  layout === "board" ? "bg-composer text-ink shadow-xs" : "text-ink-secondary hover:text-ink",
                )}
              >
                <Columns3 size={13} aria-hidden="true" />
              </button>
            </div>

            <button
              type="button"
              title="刷新任务"
              aria-label="刷新任务"
              onClick={() => void loadTasks()}
              className="flex size-7 items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.08] hover:text-ink"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} aria-hidden="true" />
            </button>

            <button
              type="button"
              data-collab-new-task=""
              onClick={() => onOpenCreate(channelFilter || undefined)}
              className={`${COLLAB_BUTTON} ui-button-primary h-7 px-3 text-[12px]`}
            >
              <Plus size={13} aria-hidden="true" />新建任务
            </button>
          </div>
        </div>

        {/* Main list / board */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {error && (
            <div role="alert" className="mb-3 flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
              <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-ink-secondary">
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />
              <span>正在加载任务…</span>
            </div>
          ) : tasks.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-accent/12 text-accent-text ring-1 ring-inset ring-accent/25">
                <ListTodo size={22} aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-[15px] font-semibold text-ink">当前视图暂无任务</h3>
                <p className="mt-1 max-w-sm text-[12.5px] leading-relaxed text-ink-tertiary">
                  新建任务并指派给真人负责人与验收人；也可以在频道聊天里把任意一条消息一键「转为任务」。
                </p>
              </div>
              <button
                type="button"
                onClick={() => onOpenCreate(channelFilter || undefined)}
                className={`${COLLAB_BUTTON} ui-button-primary h-8 px-4 text-[12.5px]`}
              >
                <Plus size={13.5} aria-hidden="true" />新建第一个任务
              </button>
            </div>
          ) : layout === "list" ? (
            <div className="mx-auto flex w-full max-w-[820px] flex-col gap-2">
              {tasks.map(task => renderTaskCard(task, false))}
            </div>
          ) : (
            <div className="grid min-h-full grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
              {BOARD_COLUMNS.map(col => {
                const colTasks = tasks.filter(t => col.statuses.includes(t.status));
                return (
                  <div
                    key={col.id}
                    className="flex flex-col gap-2 rounded-2xl bg-inset/45 p-2.5 ring-1 ring-inset ring-ink/[0.06]"
                  >
                    <div className="flex items-center justify-between px-1.5 py-0.5">
                      <span className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-secondary">
                        <span className={cn("size-2 rounded-full", col.accentCls)} />
                        {col.label}
                      </span>
                      <span className="rounded-full bg-ink/[0.07] px-1.5 text-[11px] tabular-nums text-ink-tertiary">
                        {colTasks.length}
                      </span>
                    </div>
                    <div className="flex flex-col gap-2">
                      {colTasks.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-ink/[0.08] py-6 text-center text-[11.5px] text-ink-tertiary">
                          暂无
                        </div>
                      ) : (
                        colTasks.map(task => renderTaskCard(task, true))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Task detail split drawer */}
      {selectedTaskId && (
        <CollabTeamTaskDetailPanel
          team={team}
          taskId={selectedTaskId}
          myUserId={myUserId}
          members={members}
          jobTitles={jobTitles}
          onClose={() => onSelectTask(null)}
          onEdit={onOpenEdit}
          onMutated={handleMutated}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  );
}
