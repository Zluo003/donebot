import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  FlaskConical,
  History,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { OpcBotEvalState, OpcConfigSnapshot } from "../../shared/donebot-opc";
import { cn } from "@/lib/cn";
import { useStore, type Bot } from "@/state/store";
import { opcApi } from "./opc-api";
import { buildLineDiff } from "./paperclip-line-diff";
import { OpcNativeDialog } from "./paperclip-ui";

type StudioTab = "snapshots" | "evals";

export function OpcSkillStudioModal({
  bot,
  open,
  onClose,
}: {
  bot: Bot;
  open: boolean;
  onClose: () => void;
}) {
  const { dispatch } = useStore();
  const titleId = useId();
  const [tab, setTab] = useState<StudioTab>("snapshots");
  const [snapshots, setSnapshots] = useState<OpcConfigSnapshot[]>([]);
  const [selectedSnapId, setSelectedSnapId] = useState<string | null>(null);
  const [snapLabel, setSnapLabel] = useState("");
  const [evalState, setEvalState] = useState<OpcBotEvalState>({ cases: [], runs: [], verifiedSamples: [] });
  const [draftCases, setDraftCases] = useState<Array<{ id?: string; title: string; prompt: string }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const loadAll = useCallback(async () => {
    setError("");
    try {
      const [snaps, evals] = await Promise.all([
        opcApi.listSnapshots(bot.id),
        opcApi.getEvals(bot.id),
      ]);
      setSnapshots(snaps);
      setSelectedSnapId(prev => (prev && snaps.some(s => s.id === prev) ? prev : snaps[0]?.id ?? null));
      setEvalState(evals);
      setDraftCases(
        evals.cases.length > 0
          ? evals.cases.map(c => ({ id: c.id, title: c.title, prompt: c.prompt }))
          : [{ title: "代表性真题 1", prompt: "" }],
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载能力实验室失败。");
    }
  }, [bot.id]);

  useEffect(() => {
    if (open) void loadAll();
  }, [open, loadAll]);

  const selectedSnap = useMemo(
    () => snapshots.find(s => s.id === selectedSnapId) ?? null,
    [snapshots, selectedSnapId],
  );

  const soulDiff = useMemo(() => {
    if (!selectedSnap) return [];
    return buildLineDiff(selectedSnap.soul, bot.soul ?? "");
  }, [selectedSnap, bot.soul]);

  const handleCreateSnapshot = async () => {
    setBusy("create-snap");
    setError("");
    setNotice("");
    try {
      const created = await opcApi.createSnapshot(bot.id, snapLabel.trim() || undefined);
      setSnapLabel("");
      setSnapshots(prev => [created, ...prev]);
      setSelectedSnapId(created.id);
      setNotice(`已保存快照「${created.label}」`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存快照失败。");
    } finally {
      setBusy(null);
    }
  };

  const handleRestoreSnapshot = async (snap: OpcConfigSnapshot) => {
    setBusy(`restore:${snap.id}`);
    setError("");
    setNotice("");
    try {
      await opcApi.restoreSnapshot(bot.id, snap.id);
      await loadAll();
      setNotice(`已安全回滚至「${snap.label}」（回滚前状态已自动备份）`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "回滚快照失败。");
    } finally {
      setBusy(null);
    }
  };

  const handleDeleteSnapshot = async (snap: OpcConfigSnapshot) => {
    setBusy(`del:${snap.id}`);
    try {
      await opcApi.deleteSnapshot(bot.id, snap.id);
      setSnapshots(prev => prev.filter(s => s.id !== snap.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除快照失败。");
    } finally {
      setBusy(null);
    }
  };

  const handleSaveCasesAndRun = async (runAfterSave: boolean) => {
    const valid = draftCases
      .map((c, idx) => ({ id: c.id, title: c.title.trim() || `试岗题 ${idx + 1}`, prompt: c.prompt.trim() }))
      .filter(c => c.prompt.length > 0);
    if (valid.length === 0) {
      setError("请至少填写 1 条测试提示词。");
      return;
    }
    setBusy(runAfterSave ? "run-eval" : "save-cases");
    setError("");
    setNotice("");
    try {
      const saved = await opcApi.saveEvalCases(bot.id, valid);
      setEvalState(prev => ({ ...prev, cases: saved }));
      setDraftCases(saved.map(c => ({ id: c.id, title: c.title, prompt: c.prompt })));
      if (runAfterSave) {
        const res = await opcApi.runEvals(bot.id);
        setEvalState(prev => ({
          ...prev,
          runs: [res.run, ...prev.runs],
          verifiedSamples: res.verifiedSamples,
        }));
        setNotice(`已完成 ${res.run.results.length} 条真题试岗评测，已生成广场「实测认证」样例。`);
      } else {
        setNotice("黄金测试题已保存。");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(null);
    }
  };

  const latestRun = evalState.runs[0] ?? null;
  const previousRun = evalState.runs[1] ?? null;

  return (
    <OpcNativeDialog
      open={open}
      onClose={onClose}
      ariaLabelledBy={titleId}
      className="w-[min(94vw,860px)]"
    >
      <div className="flex items-center justify-between border-b border-hairline/60 px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <FlaskConical size={17} className="shrink-0 text-accent" aria-hidden="true" />
          <div className="min-w-0">
            <h1 id={titleId} className="truncate text-[15px] font-semibold text-ink">
              能力实验室 · {bot.name}
            </h1>
            <p className="text-[12px] text-ink-tertiary">
              SOUL 与技能版本快照防翻车 · 真题试岗实测对比
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭能力实验室"
          className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex items-center justify-between border-b border-hairline/50 px-5">
        <div className="flex items-center gap-1" role="tablist">
          {([
            { id: "snapshots", label: "版本快照与回滚", icon: History },
            { id: "evals", label: "真题试岗（Evals）", icon: FlaskConical },
          ] as const).map(item => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={cn(
                "inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
                tab === item.id ? "border-accent text-ink" : "border-transparent text-ink-secondary hover:text-ink",
              )}
            >
              <item.icon size={13.5} aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </div>

        {evalState.verifiedSamples.length > 0 && (
          <button
            type="button"
            onClick={() => {
              onClose();
              dispatch({ type: "showMarket", publishBotId: bot.id });
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent/12 px-2.5 py-1 text-[12px] font-medium text-accent transition-colors hover:bg-accent/20"
          >
            <Upload size={12.5} /> 带实测认证发到广场
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-3.5">
        {notice && (
          <div className="flex items-center gap-2 rounded-xl bg-emerald-500/10 px-3.5 py-2 text-[13px] text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 size={14} className="shrink-0" />
            <span>{notice}</span>
          </div>
        )}
        {error && (
          <div role="alert" className="rounded-xl bg-danger/10 px-3.5 py-2 text-[13px] text-danger">
            {error}
          </div>
        )}

        {tab === "snapshots" ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={snapLabel}
                onChange={(e) => setSnapLabel(e.target.value)}
                placeholder="给当前 SOUL + Skills 起个版本标签（如：v1.2 稳定版）"
                className="min-w-0 flex-1 rounded-xl border border-hairline/70 bg-card px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
              />
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void handleCreateSnapshot()}
                className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-[13px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
              >
                {busy === "create-snap" ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                保存当前快照
              </button>
            </div>

            {snapshots.length === 0 ? (
              <div className="rounded-xl bg-card/70 px-4 py-10 text-center text-[13px] text-ink-secondary">
                还没有保存过配置快照。每次大改 SOUL.md 或技能前先存一个快照，改坏随时一键回滚。
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-[240px_1fr]">
                <div className="space-y-1.5">
                  {snapshots.map(snap => {
                    const active = snap.id === selectedSnap?.id;
                    return (
                      <div
                        key={snap.id}
                        className={cn(
                          "group flex items-start justify-between gap-2 rounded-xl px-3 py-2.5 transition-colors",
                          active ? "bg-raised ring-[0.5px] ring-accent/50" : "bg-card/70 hover:bg-raised/60",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedSnapId(snap.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="truncate text-[13px] font-medium text-ink">{snap.label}</div>
                          <div className="mt-0.5 text-[11px] tabular-nums text-ink-tertiary">
                            {new Date(snap.createdAt).toLocaleString("zh-CN", { hour12: false })} · {snap.skills.length} 技能
                          </div>
                        </button>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void handleDeleteSnapshot(snap)}
                          aria-label={`删除快照「${snap.label}」`}
                          className="rounded p-1 text-ink-tertiary opacity-0 transition-opacity hover:bg-danger/10 hover:text-danger group-hover:opacity-100 focus-visible:opacity-100"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    );
                  })}
                </div>

                {selectedSnap && (
                  <div className="flex min-w-0 flex-col gap-3 rounded-xl bg-card p-3.5 ring-[0.5px] ring-hairline/60">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-[13px] font-medium text-ink">
                          快照「{selectedSnap.label}」vs 当前 SOUL.md
                        </div>
                        <div className="text-[12px] text-ink-tertiary">
                          {(() => {
                            const supportCount = selectedSnap.skills.reduce((sum, sk) => sum + (sk.files?.length ?? 0), 0);
                            return `包含 ${selectedSnap.skills.length} 个 Skill${supportCount > 0 ? `（含 ${supportCount} 个附属文件）` : ""} · 回滚前将自动保存当前状态备份`;
                          })()}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void handleRestoreSnapshot(selectedSnap)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-control disabled:opacity-50"
                      >
                        {busy === `restore:${selectedSnap.id}` ? <Loader2 size={12.5} className="animate-spin" /> : <RotateCcw size={12.5} />}
                        恢复此版本
                      </button>
                    </div>

                    <div className="max-h-72 overflow-auto rounded-lg bg-app p-2 font-mono text-[12px] leading-relaxed">
                      {soulDiff.every(r => r.kind === "context") ? (
                        <div className="py-6 text-center font-sans text-[12px] text-ink-tertiary">
                          当前 SOUL.md 与该快照完全一致。
                        </div>
                      ) : (
                        soulDiff.map((row, idx) => (
                          <div
                            key={idx}
                            className={cn(
                              "flex gap-2 whitespace-pre-wrap break-words px-1.5",
                              row.kind === "added" && "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
                              row.kind === "removed" && "bg-danger/12 text-danger",
                              row.kind === "context" && "text-ink-secondary",
                            )}
                          >
                            <span className="w-7 shrink-0 select-none text-right tabular-nums text-ink-tertiary/70">
                              {row.oldLineNumber ?? ""}
                            </span>
                            <span className="w-7 shrink-0 select-none text-right tabular-nums text-ink-tertiary/70">
                              {row.newLineNumber ?? ""}
                            </span>
                            <span className="w-3 shrink-0 select-none">
                              {row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "}
                            </span>
                            <span className="min-w-0 flex-1">{row.text || " "}</span>
                          </div>
                        ))
                      )}
                    </div>

                    {selectedSnap.skills.length > 0 && (
                      <div className="space-y-1.5 border-t border-hairline/40 pt-2.5">
                        <div className="text-[12px] font-medium text-ink-secondary">
                          快照包含的技能（{selectedSnap.skills.length}）
                        </div>
                        <div className="space-y-1">
                          {selectedSnap.skills.map(sk => {
                            const supportFiles = sk.files ?? [];
                            return (
                              <details
                                key={sk.name}
                                className="group rounded-lg bg-app/70 px-2.5 py-1.5 text-[12px]"
                              >
                                <summary className="flex cursor-pointer list-none items-center gap-1.5 text-ink [&::-webkit-details-marker]:hidden">
                                  <ChevronRight
                                    size={12}
                                    aria-hidden="true"
                                    className="shrink-0 text-ink-tertiary transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none"
                                  />
                                  <span className="font-mono font-medium">{sk.name}</span>
                                  <span className="text-ink-tertiary">
                                    {sk.enabled ? "启用" : "停用"}
                                    {supportFiles.length > 0 ? ` · ${supportFiles.length} 个附属文件` : ""}
                                  </span>
                                </summary>
                                <div className="mt-1.5 space-y-1.5 border-t border-hairline/40 pt-1.5 pl-4">
                                  {supportFiles.length > 0 && (
                                    <div className="flex flex-wrap gap-1">
                                      {supportFiles.map(file => (
                                        <span
                                          key={file.path}
                                          className="rounded bg-card px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary ring-[0.5px] ring-hairline/60"
                                        >
                                          {file.path}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-ink-secondary">
                                    {sk.instructions}
                                  </pre>
                                </div>
                              </details>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-ink">黄金试岗题（1–5 条）</span>
                {draftCases.length < 5 && (
                  <button
                    type="button"
                    onClick={() => setDraftCases(prev => [...prev, { title: `代表性真题 ${prev.length + 1}`, prompt: "" }])}
                    className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline"
                  >
                    <Plus size={13} /> 添加题目
                  </button>
                )}
              </div>

              {draftCases.map((c, idx) => (
                <div key={idx} className="rounded-xl bg-card p-3 ring-[0.5px] ring-hairline/60 space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={c.title}
                      onChange={(e) => setDraftCases(prev => prev.map((x, i) => (i === idx ? { ...x, title: e.target.value } : x)))}
                      placeholder={`题目 ${idx + 1} 标题`}
                      className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink outline-none placeholder:text-ink-tertiary"
                    />
                    {draftCases.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setDraftCases(prev => prev.filter((_, i) => i !== idx))}
                        className="rounded p-1 text-ink-tertiary hover:bg-danger/10 hover:text-danger"
                        aria-label="移除该试岗题"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                  <textarea
                    rows={2}
                    value={c.prompt}
                    onChange={(e) => setDraftCases(prev => prev.map((x, i) => (i === idx ? { ...x, prompt: e.target.value } : x)))}
                    placeholder="输入一句最能检验该 Bot 真实交付水准的任务指令…"
                    className="w-full resize-none rounded-lg border border-hairline/60 bg-app/70 px-2.5 py-2 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
                  />
                </div>
              ))}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void handleSaveCasesAndRun(false)}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-raised px-3.5 py-2 text-[13px] font-medium text-ink hover:bg-control disabled:opacity-50"
                >
                  {busy === "save-cases" ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                  仅保存题目
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void handleSaveCasesAndRun(true)}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
                >
                  {busy === "run-eval" ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                  {busy === "run-eval" ? "正在真题试岗…" : "立即运行试岗评测"}
                </button>
              </div>
            </div>

            {latestRun && (
              <div className="space-y-2.5 border-t border-hairline/50 pt-4">
                <div className="flex items-center justify-between text-[12px] text-ink-secondary">
                  <span className="font-medium text-ink">
                    最新实测结果（{latestRun.snapshotLabel}）
                  </span>
                  {previousRun && <span className="text-ink-tertiary">右侧自动对照上一次试岗</span>}
                </div>
                {latestRun.results.map(res => {
                  const prevRes = previousRun?.results.find(r => r.caseId === res.caseId || r.prompt === res.prompt);
                  return (
                    <div key={res.caseId} className="rounded-xl bg-card p-3.5 ring-[0.5px] ring-hairline/60 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[13px] font-medium text-ink">{res.title}</span>
                        <span className="font-mono text-[11px] tabular-nums text-ink-tertiary">
                          {res.model} · {(res.latencyMs / 1000).toFixed(1)}s
                        </span>
                      </div>
                      <div className={cn("grid gap-2.5", prevRes ? "md:grid-cols-2" : "grid-cols-1")}>
                        <div className="rounded-lg bg-app/80 p-2.5">
                          <div className="mb-1 text-[11px] font-medium text-accent">本次输出</div>
                          <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-ink">
                            {res.status === "ok" ? res.output : `执行失败：${res.error || "未知错误"}`}
                          </pre>
                        </div>
                        {prevRes && (
                          <div className="rounded-lg bg-app/50 p-2.5">
                            <div className="mb-1 text-[11px] font-medium text-ink-tertiary">
                              上次对照（{(prevRes.latencyMs / 1000).toFixed(1)}s）
                            </div>
                            <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-ink-secondary">
                              {prevRes.status === "ok" ? prevRes.output : `执行失败：${prevRes.error || "未知错误"}`}
                            </pre>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </OpcNativeDialog>
  );
}
