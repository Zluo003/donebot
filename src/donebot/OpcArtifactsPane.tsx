// Lightbox keyboard navigation & gallery viewer adapted from Paperclip ImageGalleryModal
// (https://github.com/paperclipai/paperclip) — Copyright (c) 2025 Paperclip AI (MIT License).

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Film,
  FlaskConical,
  Image as ImageIcon,
  Loader2,
  Music,
  Pencil,
  Plus,
  RotateCcw,
  Target,
  X,
} from "lucide-react";
import type { OpcArtifactItem, OpcArtifactReviewStatus, OpcProjectGoal } from "../../shared/donebot-opc";
import { cn } from "@/lib/cn";
import { useStore, type Bot } from "@/state/store";
import { opcApi } from "./opc-api";
import { OpcSkillStudioModal } from "./OpcSkillStudioModal";
import { OpcNativeDialog } from "./paperclip-ui";
import {
  claimReviseDraftWork,
  clearReviseDraft,
  releaseReviseDraftWork,
  useReviseDraft,
} from "./paperclip-revise-draft-store";

function statusMeta(status: OpcArtifactReviewStatus): { label: string; dot: string; text: string } {
  switch (status) {
    case "approved":
      return { label: "已通过", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" };
    case "changes_requested":
      return { label: "需修改", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" };
    default:
      return { label: "待审", dot: "bg-accent", text: "text-accent" };
  }
}

function ArtifactLightbox({
  items,
  index,
  open,
  onClose,
  onIndexChange,
  onReviewed,
  onJumpMessage,
}: {
  items: OpcArtifactItem[];
  index: number;
  open: boolean;
  onClose: () => void;
  onIndexChange: (next: number) => void;
  onReviewed: (id: string, status: OpcArtifactReviewStatus, note?: string) => void;
  onJumpMessage: (item: OpcArtifactItem) => void;
}) {
  const titleId = useId();
  const current = items[index] ?? null;
  const draftKey = current ? `artifact:${current.id}` : null;
  const [draft, updateDraft] = useReviseDraft(draftKey);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || items.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onIndexChange((index - 1 + items.length) % items.length);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onIndexChange((index + 1) % items.length);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, index, items.length, onIndexChange]);

  if (!current || !draftKey) return null;

  const submitReview = async (status: "approved" | "changes_requested") => {
    const work = status === "approved" ? "approve" : "revise";
    if (!claimReviseDraftWork(draftKey, work)) return;
    setError("");
    try {
      await opcApi.reviewArtifact(current.id, {
        botId: current.botId,
        status,
        note: status === "changes_requested" ? draft.reason.trim() : undefined,
        threadId: current.threadId,
        artifactTitle: current.title,
        dispatchRevision: status === "changes_requested",
      });
      clearReviseDraft(draftKey);
      onReviewed(current.id, status, status === "changes_requested" ? draft.reason.trim() : undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交审批失败。");
      releaseReviseDraftWork(draftKey);
    }
  };

  const meta = statusMeta(current.reviewStatus);
  const busy = draft.working !== null;

  return (
    <OpcNativeDialog
      open={open}
      onClose={onClose}
      ariaLabelledBy={titleId}
      className="w-[min(94vw,960px)]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-hairline/60 px-5 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 id={titleId} className="truncate text-[14.5px] font-semibold text-ink">
              {current.title || current.name}
            </h1>
            <span className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-ink-secondary">
              v{current.version}
            </span>
            <span className={cn("inline-flex items-center gap-1 text-[11.5px] font-medium", meta.text)}>
              <span className={cn("size-1.5 rounded-full", meta.dot)} />
              {meta.label}
            </span>
          </div>
          <div className="mt-0.5 text-[11.5px] tabular-nums text-ink-tertiary">
            {current.name} · {index + 1} / {items.length}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => { onClose(); onJumpMessage(current); }}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            原对话 <ArrowUpRight size={13} />
          </button>
          <a
            href={current.previewUrl}
            download={current.name}
            className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
            aria-label={`下载 ${current.name}`}
            title="下载原文件"
          >
            <Download size={15} />
          </a>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭预览"
            className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="relative flex min-h-[300px] max-h-[56dvh] flex-1 items-center justify-center bg-app/90 px-12 py-4">
        {items.length > 1 && (
          <button
            type="button"
            onClick={() => onIndexChange((index - 1 + items.length) % items.length)}
            aria-label="上一个作品"
            className="absolute left-3 rounded-full bg-panel/90 p-2 text-ink-secondary shadow hover:bg-raised hover:text-ink"
          >
            <ChevronLeft size={18} />
          </button>
        )}

        {current.kind === "image" ? (
          <img
            src={current.previewUrl}
            alt={current.title || current.name}
            className="max-h-[50dvh] max-w-full rounded-lg object-contain select-none"
            draggable={false}
          />
        ) : current.kind === "video" ? (
          <video
            src={current.previewUrl}
            controls
            playsInline
            className="max-h-[50dvh] max-w-full rounded-lg"
          />
        ) : current.kind === "audio" ? (
          <div className="flex flex-col items-center gap-3 p-6">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-card text-accent">
              <Music size={26} />
            </div>
            <audio src={current.previewUrl} controls className="w-80 max-w-full" />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2.5 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-card text-ink-secondary">
              <FileText size={26} />
            </div>
            <div className="text-[13.5px] font-medium text-ink">{current.name}</div>
            <a
              href={current.previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[12.5px] text-accent hover:underline"
            >
              打开或下载文档
            </a>
          </div>
        )}

        {items.length > 1 && (
          <button
            type="button"
            onClick={() => onIndexChange((index + 1) % items.length)}
            aria-label="下一个作品"
            className="absolute right-3 rounded-full bg-panel/90 p-2 text-ink-secondary shadow hover:bg-raised hover:text-ink"
          >
            <ChevronRight size={18} />
          </button>
        )}
      </div>

      <div className="border-t border-hairline/60 bg-panel px-5 py-3.5 space-y-2.5">
        {current.reviewNote && (
          <div className="rounded-lg bg-card px-3 py-2 text-[12px] text-ink-secondary">
            上次批注：{current.reviewNote}
          </div>
        )}
        {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            type="text"
            value={draft.reason}
            onChange={(e) => updateDraft({ reason: e.target.value, revising: true })}
            placeholder="需要调整？直接输入批注并点「打回修改」，将自动派给该 Bot 返工…"
            className="min-w-0 flex-1 rounded-xl border border-hairline/70 bg-card px-3 py-2 text-[12.5px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void submitReview("changes_requested")}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-raised px-3.5 text-[12.5px] font-medium text-ink hover:bg-control disabled:opacity-50"
          >
            {draft.working === "revise" ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
            打回修改
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submitReview("approved")}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-accent px-4 text-[12.5px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
          >
            {draft.working === "approve" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            通过定稿
          </button>
        </div>
      </div>
    </OpcNativeDialog>
  );
}

export function OpcArtifactsPane({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [goal, setGoal] = useState<OpcProjectGoal | null>(null);
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalTitle, setGoalTitle] = useState("");
  const [goalObjective, setGoalObjective] = useState("");
  const [goalRedlines, setGoalRedlines] = useState("");
  const [goalDeliverables, setGoalDeliverables] = useState("");
  const [savingGoal, setSavingGoal] = useState(false);

  const [artifacts, setArtifacts] = useState<OpcArtifactItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | OpcArtifactReviewStatus>("all");
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [studioOpen, setStudioOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [goals, items] = await Promise.all([
        opcApi.listGoals(bot.id),
        opcApi.listArtifacts({ botId: bot.id }),
      ]);
      const active = goals.find(g => g.status === "active") ?? goals[0] ?? null;
      setGoal(active);
      setArtifacts(items);
    } catch {
      // Quiet degrade when offline.
    } finally {
      setLoading(false);
    }
  }, [bot.id]);

  useEffect(() => {
    void load();
  }, [load, bot.messages]);

  const openGoalEditor = () => {
    setGoalTitle(goal?.title ?? "");
    setGoalObjective(goal?.objective ?? "");
    setGoalRedlines((goal?.redlines ?? []).join("\n"));
    setGoalDeliverables((goal?.deliverables ?? []).map(d => d.title).join("\n"));
    setEditingGoal(true);
  };

  const saveGoal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goalTitle.trim()) return;
    setSavingGoal(true);
    try {
      const prevMap = new Map((goal?.deliverables ?? []).map(d => [d.title, d]));
      const deliverables = goalDeliverables
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(title => {
          const prev = prevMap.get(title);
          return prev ? { id: prev.id, title, done: prev.done, artifactId: prev.artifactId } : { title, done: false };
        });
      const saved = await opcApi.saveGoal({
        ...(goal ? { id: goal.id } : {}),
        botId: bot.id,
        title: goalTitle.trim(),
        objective: goalObjective.trim(),
        redlines: goalRedlines.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
        deliverables,
        status: "active",
      });
      setGoal(saved);
      setEditingGoal(false);
    } finally {
      setSavingGoal(false);
    }
  };

  const filtered = useMemo(
    () => (filter === "all" ? artifacts : artifacts.filter(a => a.reviewStatus === filter)),
    [artifacts, filter],
  );

  const doneCount = goal ? goal.deliverables.filter(d => d.done).length : 0;
  const totalCount = goal ? goal.deliverables.length : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 pb-5 pt-2">
      {/* Collapsible Project Goal Card (Goal Ancestry) + Skill Studio Entry */}
      <section aria-label="项目目标卡" className="rounded-xl bg-card/85 ring-[0.5px] ring-hairline/60">
        {editingGoal ? (
          <form onSubmit={saveGoal} className="space-y-2.5 p-3">
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] font-medium text-ink">设定项目目标卡</span>
              <button
                type="button"
                onClick={() => setEditingGoal(false)}
                className="text-[11.5px] text-ink-tertiary hover:text-ink"
              >
                取消
              </button>
            </div>
            <input
              type="text"
              required
              value={goalTitle}
              onChange={(e) => setGoalTitle(e.target.value)}
              placeholder="项目标题（如：12月小红书增长冲刺）"
              className="w-full rounded-lg border border-hairline/70 bg-panel px-2.5 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
            />
            <textarea
              rows={2}
              value={goalObjective}
              onChange={(e) => setGoalObjective(e.target.value)}
              placeholder="最终目标（自动注入每次对话，防止偏航）"
              className="w-full resize-none rounded-lg border border-hairline/70 bg-panel px-2.5 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
            />
            <textarea
              rows={2}
              value={goalRedlines}
              onChange={(e) => setGoalRedlines(e.target.value)}
              placeholder="硬性红线（每行一条，如：严禁水印 / 严禁夸大宣传）"
              className="w-full resize-none rounded-lg border border-hairline/70 bg-panel px-2.5 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
            />
            <textarea
              rows={2}
              value={goalDeliverables}
              onChange={(e) => setGoalDeliverables(e.target.value)}
              placeholder="交付清单（每行一项，如：3 套爆款标题 + 封面图）"
              className="w-full resize-none rounded-lg border border-hairline/70 bg-panel px-2.5 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={savingGoal}
                className="inline-flex h-7 items-center gap-1 rounded-lg bg-accent px-3 text-[12px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
              >
                {savingGoal && <Loader2 size={12} className="animate-spin" />}
                保存目标
              </button>
            </div>
          </form>
        ) : goal ? (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
              <div className="flex min-w-0 items-center gap-2">
                <Target size={14} className="shrink-0 text-accent" aria-hidden="true" />
                <span className="truncate text-[12.5px] font-medium text-ink">{goal.title}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {totalCount > 0 && (
                  <span className="text-[11px] tabular-nums text-ink-tertiary">
                    {doneCount}/{totalCount}
                  </span>
                )}
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); openGoalEditor(); }}
                  aria-label="编辑项目目标卡"
                  className="rounded p-1 text-ink-tertiary hover:bg-raised hover:text-ink"
                >
                  <Pencil size={12} />
                </button>
              </div>
            </summary>
            <div className="space-y-2 border-t border-hairline/40 px-3 pb-3 pt-2 text-[12px]">
              {goal.objective && <p className="leading-relaxed text-ink-secondary">{goal.objective}</p>}
              {goal.redlines.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[11px] font-medium text-ink-tertiary">红线约束</div>
                  <ul className="space-y-0.5 text-ink-secondary">
                    {goal.redlines.map((r, i) => <li key={i}>· {r}</li>)}
                  </ul>
                </div>
              )}
              {goal.deliverables.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[11px] font-medium text-ink-tertiary">交付清单</div>
                  {goal.deliverables.map(d => (
                    <label key={d.id} className="flex cursor-pointer items-center gap-2 text-ink">
                      <input
                        type="checkbox"
                        checked={d.done}
                        onChange={() => {
                          void opcApi.toggleDeliverable(goal.id, d.id, !d.done).then(setGoal);
                        }}
                        className="rounded border-hairline accent-accent"
                      />
                      <span className={cn(d.done && "line-through text-ink-tertiary")}>{d.title}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </details>
        ) : (
          <div className="flex items-center justify-between gap-2 px-3 py-2.5">
            <button
              type="button"
              onClick={openGoalEditor}
              className="flex min-w-0 flex-1 items-center gap-2 text-left text-[12.5px] text-ink-secondary hover:text-ink"
            >
              <Plus size={14} className="shrink-0 text-accent" />
              <span className="truncate">添加项目目标卡（自动防偏航）</span>
            </button>
          </div>
        )}
      </section>

      {/* Toolbar: Filter pills + Skill Studio quick trigger */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-lg bg-card/80 p-0.5 ring-[0.5px] ring-hairline/50">
          {([
            { id: "all", label: "全部" },
            { id: "pending", label: "待审" },
            { id: "approved", label: "已通过" },
            { id: "changes_requested", label: "需修改" },
          ] as const).map(opt => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setFilter(opt.id)}
              className={cn(
                "rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors",
                filter === opt.id ? "bg-raised text-ink" : "text-ink-tertiary hover:text-ink",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setStudioOpen(true)}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11.5px] font-medium text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
          title="版本快照回滚与真题试岗评测"
        >
          <FlaskConical size={13} className="text-accent" />
          能力实验室
        </button>
      </div>

      {/* Artifacts Gallery */}
      {loading && artifacts.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-12 text-[12.5px] text-ink-tertiary">
          <Loader2 size={14} className="animate-spin" /> 加载作品柜…
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl bg-card/50 px-4 py-12 text-center">
          <ImageIcon size={20} strokeWidth={1.5} className="text-ink-tertiary" />
          <p className="mt-2.5 text-[13px] font-medium text-ink">
            {artifacts.length === 0 ? "还没有交付作品" : "当前筛选下暂无作品"}
          </p>
          <p className="mt-1 text-[12px] text-ink-tertiary">
            {bot.name} 生成的图片、视频、音频和文档会自动收录在这里，供你随时拍板。
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          {filtered.map((item, idx) => {
            const meta = statusMeta(item.reviewStatus);
            const isVisual = item.kind === "image" || item.kind === "video";
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setLightboxIndex(idx)}
                className={cn(
                  "group flex flex-col overflow-hidden rounded-xl bg-card text-left ring-[0.5px] ring-hairline/60 transition-all hover:ring-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  !isVisual && "col-span-2 flex-row items-center gap-3 p-2.5",
                )}
              >
                {item.kind === "image" ? (
                  <div className="relative aspect-[4/3] w-full overflow-hidden bg-app">
                    <img
                      src={item.previewUrl}
                      alt={item.title || item.name}
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                    />
                    <span className="absolute right-1.5 top-1.5 rounded bg-black/55 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-white backdrop-blur-sm">
                      v{item.version}
                    </span>
                  </div>
                ) : item.kind === "video" ? (
                  <div className="relative flex aspect-[4/3] w-full items-center justify-center bg-app text-ink-secondary">
                    <Film size={22} />
                    <span className="absolute right-1.5 top-1.5 rounded bg-black/55 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-white">
                      v{item.version}
                    </span>
                  </div>
                ) : (
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-raised text-ink-secondary">
                    {item.kind === "audio" ? <Music size={15} /> : <FileText size={15} />}
                  </div>
                )}

                <div className={cn("min-w-0 flex-1", isVisual && "p-2")}>
                  <div className="truncate text-[12px] font-medium text-ink">{item.title || item.name}</div>
                  <div className="mt-1 flex items-center justify-between gap-1 text-[11px]">
                    <span className={cn("inline-flex items-center gap-1", meta.text)}>
                      <span className={cn("size-1.5 rounded-full", meta.dot)} />
                      {meta.label}
                    </span>
                    {!isVisual && (
                      <span className="font-mono text-[10.5px] tabular-nums text-ink-tertiary">v{item.version}</span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {lightboxIndex !== null && filtered[lightboxIndex] && (
        <ArtifactLightbox
          items={filtered}
          index={lightboxIndex}
          open={true}
          onClose={() => setLightboxIndex(null)}
          onIndexChange={setLightboxIndex}
          onReviewed={(id, status, note) => {
            setArtifacts(prev => prev.map(a => (a.id === id ? { ...a, reviewStatus: status, reviewNote: note } : a)));
          }}
          onJumpMessage={(item) => {
            dispatch({ type: "focusMessage", threadId: item.threadId, messageId: item.reportMessageId });
          }}
        />
      )}

      <OpcSkillStudioModal bot={bot} open={studioOpen} onClose={() => setStudioOpen(false)} />
    </div>
  );
}
