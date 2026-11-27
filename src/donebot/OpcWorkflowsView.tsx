import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Check,
  Clock,
  GitBranch,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { OpcWorkflowDefinition, OpcWorkflowRun } from "../../shared/donebot-opc";
import { resolveWorkflowExecutionPlan } from "../../shared/donebot-opc-graph";
import { Switch } from "@/components/SettingsPrimitives";
import { cn } from "@/lib/cn";
import { useStore, type Bot } from "@/state/store";
import { opcApi } from "./opc-api";
import { OpcWorkflowCanvasEditor, type WorkflowCanvasPayload } from "./OpcWorkflowCanvasEditor";

function scheduleLabel(wf: OpcWorkflowDefinition): string {
  if (wf.scheduleKind === "daily") return `每天 ${wf.dailyTime || "09:00"}`;
  if (wf.scheduleKind === "interval") {
    const m = wf.intervalMinutes ?? 60;
    return m % 60 === 0 ? `每 ${m / 60} 小时` : `每 ${m} 分钟`;
  }
  return "手动触发";
}

function runStatusMeta(status: OpcWorkflowRun["status"]): { label: string; tone: string } {
  switch (status) {
    case "waiting_approval": return { label: "待审批", tone: "text-ink" };
    case "completed": return { label: "已完成", tone: "text-emerald-500" };
    case "failed": return { label: "执行失败", tone: "text-danger" };
    case "cancelled": return { label: "已终止", tone: "text-ink-tertiary" };
    default: return { label: "运行中", tone: "text-accent" };
  }
}

export function OpcWorkflowsView({ bots }: { bots: Bot[] }) {
  const { dispatch } = useStore();
  const [workflows, setWorkflows] = useState<OpcWorkflowDefinition[]>([]);
  const [runs, setRuns] = useState<OpcWorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  // Full-workspace infinite-canvas editor mode
  const [editorMode, setEditorMode] = useState<"list" | "canvas">("list");
  const [editingWf, setEditingWf] = useState<OpcWorkflowDefinition | null>(null);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  // Approval revision note by runId
  const [reviseNotes, setReviseNotes] = useState<Record<string, string>>({});
  const [revisingRunId, setRevisingRunId] = useState<string | null>(null);

  const botNameById = useMemo(() => new Map(bots.map(b => [b.id, b.name])), [bots]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const res = await opcApi.listWorkflows();
      setWorkflows(res.workflows);
      setRuns(res.runs);
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : "读取工作流失败。");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hasRunning = useMemo(() => runs.some(r => r.status === "running"), [runs]);
  useEffect(() => {
    if (!hasRunning) return;
    const timer = window.setInterval(() => {
      void load(true);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [hasRunning, load]);

  const openCreateCanvas = () => {
    setEditingWf(null);
    setSaveError("");
    setEditorMode("canvas");
  };

  const openEditCanvas = (wf: OpcWorkflowDefinition) => {
    setEditingWf(wf);
    setSaveError("");
    setEditorMode("canvas");
  };

  const triggerRun = useCallback(async (wf: OpcWorkflowDefinition) => {
    setBusyId(`run:${wf.id}`);
    setError("");
    try {
      const run = await opcApi.runWorkflow(wf.id, {});
      setRuns(prev => [run, ...prev.filter(r => r.id !== run.id)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "运行工作流失败。");
    } finally {
      setBusyId(null);
    }
  }, []);

  const handleCanvasSave = async (payload: WorkflowCanvasPayload, runAfterSave: boolean) => {
    setSaving(true);
    setSaveError("");
    try {
      let saved: OpcWorkflowDefinition;
      if (editingWf) {
        saved = await opcApi.updateWorkflow(editingWf.id, payload);
        setWorkflows(prev => prev.map(w => (w.id === editingWf.id ? saved : w)));
      } else {
        saved = await opcApi.createWorkflow(payload);
        setWorkflows(prev => [saved, ...prev]);
      }
      setEditorMode("list");
      setEditingWf(null);
      if (runAfterSave) {
        void triggerRun(saved);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "保存失败。");
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (wf: OpcWorkflowDefinition) => {
    setBusyId(`toggle:${wf.id}`);
    try {
      const updated = await opcApi.updateWorkflow(wf.id, { enabled: !wf.enabled });
      setWorkflows(prev => prev.map(w => (w.id === wf.id ? updated : w)));
    } finally {
      setBusyId(null);
    }
  };

  const handleResetBreaker = async (wf: OpcWorkflowDefinition) => {
    setBusyId(`reset:${wf.id}`);
    try {
      const updated = await opcApi.updateWorkflow(wf.id, {
        pausedByCircuitBreaker: false,
        consecutiveFailures: 0,
        circuitBreakerReason: undefined,
        enabled: true,
      });
      setWorkflows(prev => prev.map(w => (w.id === wf.id ? updated : w)));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (wf: OpcWorkflowDefinition) => {
    setBusyId(`del:${wf.id}`);
    try {
      await opcApi.deleteWorkflow(wf.id);
      setWorkflows(prev => prev.filter(w => w.id !== wf.id));
    } finally {
      setBusyId(null);
    }
  };

  const handleDecision = async (runId: string, action: "approve" | "revise" | "cancel") => {
    setBusyId(`dec:${runId}`);
    setError("");
    try {
      const next = await opcApi.decideWorkflowRun(runId, {
        action,
        ...(action === "revise" ? { note: reviseNotes[runId] ?? "" } : {}),
      });
      setRuns(prev => prev.map(r => (r.id === runId ? next : r)));
      setRevisingRunId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "处理审批失败。");
    } finally {
      setBusyId(null);
    }
  };

  if (editorMode === "canvas") {
    return (
      <OpcWorkflowCanvasEditor
        key={editingWf?.id ?? "new"}
        bots={bots}
        workflow={editingWf}
        saving={saving}
        error={saveError}
        onCancel={() => {
          setEditorMode("list");
          setEditingWf(null);
          setSaveError("");
        }}
        onSave={handleCanvasSave}
      />
    );
  }

  return (
    <div data-opc-workflows-view="" className="min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-10">
      <div className="mx-auto max-w-[900px] space-y-10">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-hairline/50 pb-5">
          <div>
            <h2 className="text-[22px] font-semibold tracking-tight text-ink">固定与定时工作流</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">
              跨部门固定工作流优先于组织架构约束直接执行；可在画布连线编排，或直接让主协调 Bot 对话创建。
            </p>
          </div>
          <button
            type="button"
            disabled={bots.length === 0}
            onClick={openCreateCanvas}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-medium text-app transition-opacity hover:opacity-85 disabled:opacity-40"
          >
            <Plus size={14} /> 新建工作流
          </button>
        </div>

        {error && (
          <div role="alert" className="rounded-xl bg-danger/10 px-4 py-3 text-[13px] text-danger">
            {error}
          </div>
        )}

        {/* Workflow definitions */}
        <section aria-label="已配置的工作流">
          {loading ? (
            <div className="flex items-center gap-2 py-10 text-[13px] text-ink-tertiary">
              <Loader2 size={15} className="animate-spin" /> 正在加载工作流…
            </div>
          ) : workflows.length === 0 ? (
            <div className="py-6">
              <p className="text-[14px] text-ink-secondary">
                还没有固定工作流。点击下方按钮打开画布，把「触发器 → 选题员工 → 写手员工 → 人工审批 → 视觉出图」连成自动流水线。
              </p>
              <button
                type="button"
                disabled={bots.length === 0}
                onClick={openCreateCanvas}
                className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-full bg-ink/[0.06] px-4 text-[13px] font-medium text-ink hover:bg-ink/[0.11] disabled:opacity-40"
              >
                <Plus size={13} /> 打开画布创建第一条工作流
              </button>
            </div>
          ) : (
            <div className="divide-y divide-hairline/40 border-b border-hairline/50">
              {workflows.map(wf => {
                const ordered = resolveWorkflowExecutionPlan(wf).orderedSteps;
                return (
                  <div key={wf.id} className="py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[15px] font-semibold text-ink">{wf.name}</span>
                          <span className="inline-flex items-center gap-1 rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] text-ink-secondary">
                            <Clock size={11} /> {scheduleLabel(wf)}
                          </span>
                        </div>
                        {wf.description && (
                          <p className="mt-1 text-[13px] text-ink-secondary">{wf.description}</p>
                        )}

                        {/* Ordered DAG pipeline preview */}
                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[12px]">
                          {ordered.map((step, idx) => (
                            <span key={step.id} className="inline-flex items-center gap-1.5">
                              <span className="inline-flex items-center gap-1 rounded-lg bg-ink/[0.04] px-2 py-1 text-ink-secondary ring-[0.5px] ring-hairline/50">
                                <span className="tabular-nums text-ink-tertiary">{idx + 1}.</span>
                                <span className="font-medium text-ink">{step.name}</span>
                                <span className="text-[11px] text-ink-tertiary">({botNameById.get(step.botId) ?? "员工"})</span>
                                {step.approvalGate && (
                                  <ShieldCheck size={12} className="text-accent" aria-label="需人工审批" />
                                )}
                              </span>
                              {idx < ordered.length - 1 && (
                                <ArrowRight size={12} className="text-ink-tertiary/60" aria-hidden="true" />
                              )}
                            </span>
                          ))}
                        </div>

                        {wf.pausedByCircuitBreaker && (
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-danger">
                            <AlertTriangle size={13} />
                            <span>{wf.circuitBreakerReason || "连续失败已触发自动熔断"}</span>
                            <button
                              type="button"
                              disabled={busyId !== null}
                              onClick={() => void handleResetBreaker(wf)}
                              className="inline-flex items-center gap-1 rounded-full bg-danger/12 px-2.5 py-0.5 text-[12px] font-medium text-danger hover:bg-danger/20"
                            >
                              <RotateCcw size={11} /> 解除熔断
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => void triggerRun(wf)}
                          className="inline-flex h-8 items-center gap-1 rounded-full bg-ink/[0.06] px-3 text-[12px] font-medium text-ink hover:bg-ink/[0.11] disabled:opacity-45"
                        >
                          {busyId === `run:${wf.id}` ? <Loader2 size={12.5} className="animate-spin" /> : <Play size={12.5} />}
                          立即运行
                        </button>
                        <button
                          type="button"
                          onClick={() => openEditCanvas(wf)}
                          aria-label={`画布编辑「${wf.name}」`}
                          title="打开无限画布编辑节点与连线"
                          className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[12px] text-ink-secondary hover:bg-ink/[0.06] hover:text-ink"
                        >
                          <GitBranch size={13} /> 画布
                        </button>
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => void handleDelete(wf)}
                          aria-label={`删除「${wf.name}」`}
                          className="flex size-8 items-center justify-center rounded-full text-ink-tertiary hover:bg-danger/10 hover:text-danger"
                        >
                          <Trash2 size={13.5} />
                        </button>
                        <Switch
                          checked={wf.enabled && !wf.pausedByCircuitBreaker}
                          disabled={busyId === `toggle:${wf.id}` || wf.pausedByCircuitBreaker}
                          aria-label={`启停「${wf.name}」`}
                          onClick={() => void handleToggle(wf)}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Recent Runs & Approval Gates */}
        {runs.length > 0 && (
          <section aria-label="近期运行记录" className="space-y-3">
            <div className="flex items-baseline justify-between border-b border-hairline/50 pb-3">
              <h3 className="text-[13px] font-semibold tracking-wide text-ink">近期运行轨迹</h3>
              <span className="text-[12px] tabular-nums text-ink-tertiary">最近 {runs.length} 次</span>
            </div>

            <div className="divide-y divide-hairline/40">
              {runs.slice(0, 12).map((run, runIdx) => {
                const meta = runStatusMeta(run.status);
                const waiting = run.status === "waiting_approval";
                const currentStep = run.stepResults[run.currentStepIndex];
                const isLastStep = run.currentStepIndex + 1 >= run.stepResults.length;

                return (
                  <article key={run.id} className="py-4 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <span className="text-[14px] font-medium text-ink">{run.workflowName}</span>
                        <span className={cn("inline-flex items-center gap-1 text-[12px] font-medium", meta.tone)}>
                          {run.status === "running" && <Loader2 size={12} className="animate-spin" />}
                          {meta.label}
                        </span>
                        <span className="text-[12px] text-ink-tertiary">
                          {run.trigger === "schedule" ? "定时触发" : "手动触发"}
                        </span>
                      </div>
                      <span className="text-[12px] tabular-nums text-ink-tertiary">
                        {new Date(run.startedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>

                    <div className="space-y-1.5 pl-1">
                      {run.stepResults.map((sr, idx) => {
                        const isFinal = idx === run.stepResults.length - 1;
                        const defaultOpen = sr.status === "waiting_approval"
                          || sr.status === "failed"
                          || (runIdx === 0 && isFinal && Boolean(sr.output));
                        return (
                          <details key={`${run.id}:${sr.stepId}`} open={defaultOpen} className="text-[13px]">
                            <summary className="flex cursor-pointer select-none items-center gap-2 py-0.5 text-ink-secondary hover:text-ink">
                              <span className="tabular-nums text-ink-tertiary">{idx + 1}.</span>
                              <span className="font-medium text-ink">{sr.stepName}</span>
                              <span className="text-[12px] text-ink-tertiary">{sr.botName}</span>
                              <div className="ml-auto flex items-center gap-2.5">
                                {(sr.status === "completed" || sr.status === "waiting_approval" || sr.status === "running") && (
                                  <button
                                    type="button"
                                    onClick={e => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      dispatch({ type: "select", id: sr.botId });
                                    }}
                                    className="inline-flex items-center gap-0.5 text-[11px] font-medium text-accent hover:underline"
                                  >
                                    查看对话 <ArrowUpRight size={11} />
                                  </button>
                                )}
                                <span className="text-[11px] text-ink-tertiary">
                                  {sr.status === "completed" ? "已完成" : sr.status === "waiting_approval" ? "待审批" : sr.status === "running" ? "对话执行中…" : sr.status === "failed" ? "失败" : "待执行"}
                                </span>
                              </div>
                            </summary>
                            {(sr.output || sr.error) && (
                              <div className={cn("mt-1.5 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl px-3.5 py-2.5 text-[12px] leading-relaxed", sr.error ? "bg-danger/10 text-danger" : "bg-ink/[0.03] text-ink-secondary")}>
                                {sr.error || sr.output}
                              </div>
                            )}
                          </details>
                        );
                      })}
                    </div>

                    {waiting && currentStep && (
                      <div className="space-y-2 rounded-xl bg-ink/[0.03] p-3">
                        {revisingRunId === run.id && (
                          <textarea
                            value={reviseNotes[run.id] ?? ""}
                            onChange={e => setReviseNotes(prev => ({ ...prev, [run.id]: e.target.value }))}
                            rows={2}
                            placeholder={`写一句给「${currentStep.botName}」的返工意见…`}
                            className="w-full resize-none rounded-lg border border-hairline/70 bg-panel px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-ink/40"
                          />
                        )}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-[12px] text-ink-secondary">
                            第 {run.currentStepIndex + 1} 步「{currentStep.stepName}」已产出结果，等待审批
                          </span>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={busyId !== null}
                              onClick={() => void handleDecision(run.id, "cancel")}
                              className="h-7 rounded-full px-2.5 text-[12px] text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink"
                            >
                              终止
                            </button>
                            <button
                              type="button"
                              disabled={busyId !== null}
                              onClick={() => {
                                if (revisingRunId !== run.id) {
                                  setRevisingRunId(run.id);
                                  return;
                                }
                                void handleDecision(run.id, "revise");
                              }}
                              className="inline-flex h-7 items-center gap-1 rounded-full bg-ink/[0.06] px-3 text-[12px] font-medium text-ink hover:bg-ink/[0.11]"
                            >
                              <RotateCcw size={12} /> {revisingRunId === run.id ? "发送返工" : "打回返工"}
                            </button>
                            <button
                              type="button"
                              disabled={busyId !== null}
                              onClick={() => void handleDecision(run.id, "approve")}
                              className="inline-flex h-7 items-center gap-1 rounded-full bg-ink px-3 text-[12px] font-medium text-app hover:opacity-85"
                            >
                              {busyId === `dec:${run.id}` ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                              {isLastStep ? "批准定稿" : "通过并继续"}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
