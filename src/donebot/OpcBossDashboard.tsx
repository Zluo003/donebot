import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Coins,
  FileText,
  Film,
  Image as ImageIcon,
  Loader2,
  Music,
  RotateCcw,
} from "lucide-react";
import type { OpcArtifactItem, OpcBossOverview } from "../../shared/donebot-opc";
import { closeInbox } from "@/state/inbox";
import { useStore } from "@/state/store";
import { formatCny } from "./market-api";
import { opcApi } from "./opc-api";
import {
  claimReviseDraftWork,
  clearReviseDraft,
  releaseReviseDraftWork,
  useReviseDraft,
} from "./paperclip-revise-draft-store";
import { OpcDecisionCardFooter, OpcInsetPanel, OpcMetricCard } from "./paperclip-ui";

function ArtifactKindIcon({ kind }: { kind: OpcArtifactItem["kind"] }) {
  switch (kind) {
    case "image": return <ImageIcon size={14} className="shrink-0 text-ink-tertiary" />;
    case "video": return <Film size={14} className="shrink-0 text-ink-tertiary" />;
    case "audio": return <Music size={14} className="shrink-0 text-ink-tertiary" />;
    default: return <FileText size={14} className="shrink-0 text-ink-tertiary" />;
  }
}

function BossApprovalCard({
  item,
  onResolved,
  onJump,
}: {
  item: OpcArtifactItem;
  onResolved: (artifactId: string) => void;
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
    <article className="flex flex-col gap-2.5 rounded-xl bg-card p-3 ring-[0.5px] ring-hairline/60">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-ink">审批交付物</span>
        <span className="truncate text-[11px] text-ink-tertiary tabular-nums">
          {item.botName} · v{item.version}
        </span>
      </div>

      <OpcInsetPanel>
        <div className="flex items-center gap-2.5">
          {item.kind === "image" ? (
            <img
              src={item.previewUrl}
              alt={item.title}
              loading="lazy"
              className="size-11 shrink-0 rounded-md object-cover bg-raised"
            />
          ) : (
            <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-raised">
              <ArtifactKindIcon kind={item.kind} />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-ink">{item.title || item.name}</div>
            <div className="truncate text-[11.5px] text-ink-tertiary">{item.threadTitle || item.name}</div>
          </div>
          <button
            type="button"
            onClick={() => onJump(item)}
            aria-label={`定位到「${item.title || item.name}」`}
            title="查看原对话"
            className="rounded-md p-1 text-ink-tertiary transition-colors hover:bg-raised hover:text-ink"
          >
            <ArrowUpRight size={14} />
          </button>
        </div>

        {draft.revising && (
          <div className="space-y-1.5 pt-1">
            <textarea
              value={draft.reason}
              onChange={(e) => updateDraft({ reason: e.target.value })}
              rows={2}
              placeholder="写一句修改意见（将自动发给该 Bot 返工）…"
              className="w-full resize-none rounded-lg border border-hairline/70 bg-panel px-2.5 py-1.5 text-[12px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
            />
          </div>
        )}
      </OpcInsetPanel>

      {error && <p role="alert" className="text-[11.5px] text-danger">{error}</p>}

      <OpcDecisionCardFooter
        leading={
          draft.revising ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => updateDraft({ revising: false })}
              className="text-[11.5px] text-ink-tertiary hover:text-ink"
            >
              取消批注
            </button>
          ) : null
        }
      >
        <button
          type="button"
          disabled={busy}
          onClick={() => void requestChanges()}
          className="inline-flex h-7 items-center gap-1 rounded-lg bg-raised px-2.5 text-[12px] font-medium text-ink-secondary transition-colors hover:bg-control hover:text-ink disabled:opacity-50"
        >
          {draft.working === "revise" ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
          {draft.revising ? "发送修改" : "打回修改"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void approve()}
          className="inline-flex h-7 items-center gap-1 rounded-lg bg-accent px-2.5 text-[12px] font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {draft.working === "approve" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          通过
        </button>
      </OpcDecisionCardFooter>
    </article>
  );
}

export function OpcBossDashboard() {
  const { dispatch } = useStore();
  const [overview, setOverview] = useState<OpcBossOverview | null>(null);
  const [spendOpen, setSpendOpen] = useState(false);
  const [approvalsExpanded, setApprovalsExpanded] = useState(true);

  const load = useCallback(async () => {
    try {
      setOverview(await opcApi.getOverview(30));
    } catch {
      // Quietly degrade in offline or restricted workspaces.
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 45_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (!overview) return null;

  const handleResolved = (artifactId: string) => {
    setOverview(prev => {
      if (!prev) return prev;
      const nextPending = prev.pendingArtifacts.filter(a => a.id !== artifactId);
      return {
        ...prev,
        pendingArtifactCount: Math.max(0, prev.pendingArtifactCount - 1),
        pendingArtifacts: nextPending,
      };
    });
  };

  const handleJump = (item: OpcArtifactItem) => {
    dispatch({ type: "select", id: item.botId });
    dispatch({ type: "focusMessage", threadId: item.threadId, messageId: item.reportMessageId });
  };

  return (
    <section aria-label="老板批示台" className="mx-[13px] mb-2 mt-1 space-y-2.5">
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[11.5px] font-medium text-ink-secondary">老板批示台</span>
        <button
          type="button"
          onClick={() => {
            closeInbox();
            dispatch({ type: "showBoss" });
          }}
          className="inline-flex items-center gap-0.5 text-[11.5px] font-medium text-accent hover:underline"
        >
          打开完整老板台 <ArrowUpRight size={12} />
        </button>
      </div>
      <div className="flex gap-2">
        <OpcMetricCard
          icon={CheckCircle2}
          label="待我拍板"
          value={overview.pendingArtifactCount}
          tone={overview.pendingArtifactCount > 0 ? "accent" : "neutral"}
          active={approvalsExpanded && overview.pendingArtifactCount > 0}
          onClick={overview.pendingArtifactCount > 0 ? () => setApprovalsExpanded(v => !v) : undefined}
        />
        <OpcMetricCard
          icon={overview.trippedCircuitBreakerCount > 0 ? AlertTriangle : Activity}
          label="24h 巡检"
          value={overview.trippedCircuitBreakerCount > 0 ? `${overview.trippedCircuitBreakerCount} 熔断` : overview.activeHeartbeatCount}
          tone={overview.trippedCircuitBreakerCount > 0 ? "danger" : "neutral"}
          onClick={() => dispatch({ type: "showRoutines", view: "list" })}
        />
        <OpcMetricCard
          icon={Coins}
          label="30日算力"
          value={overview.spend.available ? formatCny(overview.spend.totalCost) : "—"}
          active={spendOpen}
          onClick={overview.spend.available ? () => setSpendOpen(v => !v) : undefined}
        />
      </div>

      {spendOpen && overview.spend.available && (
        <div
          tabIndex={0}
          role="region"
          aria-label="单 Bot 近 30 日真实算力消耗明细"
          className="max-h-56 overflow-auto rounded-xl bg-card ring-[0.5px] ring-hairline/60"
        >
          <div className="flex items-center justify-between border-b border-hairline/40 px-3 py-2 text-[11.5px] text-ink-secondary">
            <span className="font-medium text-ink">近 {overview.spend.days} 日实际消费透视</span>
            <span className="tabular-nums text-ink-tertiary">
              LLM {formatCny(overview.spend.llmCost)} · 图 {formatCny(overview.spend.imageCost)} · 视 {formatCny(overview.spend.videoCost)} · 乐 {formatCny(overview.spend.musicCost)}
            </span>
          </div>
          {overview.spend.bots.length === 0 ? (
            <p className="px-3 py-4 text-center text-[12px] text-ink-tertiary">暂无单 Bot 消费记录</p>
          ) : (
            <table className="w-full border-collapse text-left text-[12px]">
              <thead className="sticky top-0 bg-card/95 text-[11px] text-ink-tertiary backdrop-blur-sm">
                <tr className="border-b border-hairline/40">
                  <th scope="col" className="px-3 py-1.5 font-medium">员工</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">LLM</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">媒体</th>
                  <th scope="col" className="px-3 py-1.5 text-right font-medium">合计</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline/30">
                {overview.spend.bots.map(row => {
                  const mediaCost = row.imageCost + row.videoCost + row.musicCost;
                  return (
                    <tr key={row.botId} className="hover:bg-raised/40">
                      <th scope="row" className="max-w-[110px] truncate px-3 py-1.5 font-medium text-ink">
                        {row.botName}
                      </th>
                      <td className="px-2 py-1.5 text-right tabular-nums text-ink-secondary">{formatCny(row.llmCost)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-ink-secondary">{formatCny(mediaCost)}</td>
                      <td className="px-3 py-1.5 text-right font-medium tabular-nums text-ink">{formatCny(row.totalCost)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {approvalsExpanded && overview.pendingArtifacts.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between px-0.5 text-[11.5px] text-ink-tertiary">
            <span>待拍板交付物</span>
            <span className="tabular-nums">{overview.pendingArtifacts.length} 项</span>
          </div>
          {overview.pendingArtifacts.slice(0, 4).map(item => (
            <BossApprovalCard
              key={item.id}
              item={item}
              onResolved={handleResolved}
              onJump={handleJump}
            />
          ))}
        </div>
      )}
    </section>
  );
}
