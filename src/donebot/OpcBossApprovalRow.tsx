import { useState } from "react";
import {
  ArrowUpRight,
  Check,
  Eye,
  FileText,
  Film,
  Image as ImageIcon,
  Loader2,
  Music,
  RotateCcw,
} from "lucide-react";
import type { OpcArtifactItem } from "../../shared/donebot-opc";
import { opcApi } from "./opc-api";
import {
  claimReviseDraftWork,
  clearReviseDraft,
  releaseReviseDraftWork,
  useReviseDraft,
} from "./paperclip-revise-draft-store";

function KindIcon({ kind }: { kind: OpcArtifactItem["kind"] }) {
  switch (kind) {
    case "image": return <ImageIcon size={16} className="shrink-0 text-ink-tertiary" />;
    case "video": return <Film size={16} className="shrink-0 text-ink-tertiary" />;
    case "audio": return <Music size={16} className="shrink-0 text-ink-tertiary" />;
    default: return <FileText size={16} className="shrink-0 text-ink-tertiary" />;
  }
}

export function OpcBossApprovalRow({
  item,
  onResolved,
  onPreview,
  onJump,
}: {
  item: OpcArtifactItem;
  onResolved: (artifactId: string) => void;
  onPreview: (item: OpcArtifactItem) => void;
  onJump: (item: OpcArtifactItem) => void;
}) {
  const draftKey = `artifact:${item.id}`;
  const [draft, updateDraft] = useReviseDraft(draftKey);
  const [error, setError] = useState("");
  const busy = draft.working !== null;

  const approve = async () => {
    if (!claimReviseDraftWork(draftKey, "approve")) return;
    setError("");
    try {
      await opcApi.reviewArtifact(item.id, {
        botId: item.botId,
        status: "approved",
        threadId: item.threadId,
        artifactTitle: item.title,
      });
      clearReviseDraft(draftKey);
      onResolved(item.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败，请稍后重试。");
      releaseReviseDraftWork(draftKey);
    }
  };

  const requestChanges = async () => {
    if (!draft.revising) {
      updateDraft({ revising: true });
      return;
    }
    if (!claimReviseDraftWork(draftKey, "revise")) return;
    setError("");
    try {
      await opcApi.reviewArtifact(item.id, {
        botId: item.botId,
        status: "changes_requested",
        note: draft.reason.trim(),
        threadId: item.threadId,
        artifactTitle: item.title,
        dispatchRevision: true,
      });
      clearReviseDraft(draftKey);
      onResolved(item.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "派发修改意见失败。");
      releaseReviseDraftWork(draftKey);
    }
  };

  return (
    <article className="py-3.5">
      <div className="flex flex-wrap items-center gap-3.5">
        <button
          type="button"
          onClick={() => onPreview(item)}
          aria-label={`预览「${item.title || item.name}」`}
          className="group relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-ink/[0.04] ring-[0.5px] ring-hairline/50"
        >
          {item.kind === "image" ? (
            <img
              src={item.previewUrl}
              alt={item.title}
              loading="lazy"
              className="size-full object-cover transition-transform duration-200 group-hover:scale-105"
            />
          ) : (
            <KindIcon kind={item.kind} />
          )}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onPreview(item)}
              className="truncate text-left text-[14px] font-medium text-ink hover:underline"
            >
              {item.title || item.name}
            </button>
            <span className="shrink-0 rounded-full bg-ink/[0.06] px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-ink-secondary">
              v{item.version}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-tertiary">
            <span>{item.botName}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{item.threadTitle || item.name}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">
              {new Date(item.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => onPreview(item)}
            title="灯箱预览"
            aria-label="灯箱预览"
            className="flex size-8 items-center justify-center rounded-full text-ink-tertiary transition-colors hover:bg-ink/[0.06] hover:text-ink"
          >
            <Eye size={14} />
          </button>
          <button
            type="button"
            onClick={() => onJump(item)}
            title="查看原对话"
            aria-label="查看原对话"
            className="flex size-8 items-center justify-center rounded-full text-ink-tertiary transition-colors hover:bg-ink/[0.06] hover:text-ink"
          >
            <ArrowUpRight size={14} />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void requestChanges()}
            className="inline-flex h-8 items-center gap-1 rounded-full bg-ink/[0.06] px-3 text-[13px] font-medium text-ink transition-colors hover:bg-ink/[0.11] disabled:opacity-45"
          >
            {draft.working === "revise" ? <Loader2 size={12.5} className="animate-spin" /> : <RotateCcw size={12.5} />}
            {draft.revising ? "发送修改" : "打回修改"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void approve()}
            className="inline-flex h-8 items-center gap-1 rounded-full bg-ink px-3.5 text-[13px] font-medium text-app transition-opacity hover:opacity-85 disabled:opacity-45"
          >
            {draft.working === "approve" ? <Loader2 size={12.5} className="animate-spin" /> : <Check size={12.5} />}
            通过
          </button>
        </div>
      </div>

      {draft.revising && (
        <div className="mt-3 pl-[62px]">
          <textarea
            value={draft.reason}
            onChange={(e) => updateDraft({ reason: e.target.value })}
            rows={2}
            placeholder="写一句修改意见，点击「发送修改」后自动派发给该员工返工…"
            className="w-full resize-none rounded-xl border border-hairline/70 bg-inset px-3 py-2 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary focus:border-ink/40"
          />
          <div className="mt-1.5 flex justify-end">
            <button
              type="button"
              disabled={busy}
              onClick={() => updateDraft({ revising: false })}
              className="text-[12px] text-ink-tertiary hover:text-ink"
            >
              取消批注
            </button>
          </div>
        </div>
      )}

      {error && <p role="alert" className="mt-2 pl-[62px] text-[12px] text-danger">{error}</p>}
    </article>
  );
}
