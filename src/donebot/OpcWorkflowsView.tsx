import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Clock,
  Loader2,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import {
  extractWorkflowVariables,
  type OpcWorkflowDefinition,
  type OpcWorkflowRun,
  type OpcWorkflowScheduleKind,
} from "../../shared/donebot-opc";
import { Switch } from "@/components/SettingsPrimitives";
import { cn } from "@/lib/cn";
import type { Bot } from "@/state/store";
import { opcApi } from "./opc-api";
import { OpcNativeDialog } from "./paperclip-ui";

interface DraftStep {
  id?: string;
  name: string;
  botId: string;
  instruction: string;
  approvalGate: boolean;
}

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
    case "waiting_approval": return { label: "待老板拍板", tone: "text-ink" };
    case "completed": return { label: "已完成", tone: "text-emerald-500" };
    case "failed": return { label: "执行失败", tone: "text-danger" };
    case "cancelled": return { label: "已终止", tone: "text-ink-tertiary" };
    default: return { label: "运行中", tone: "text-accent" };
  }
}

export function OpcWorkflowsView({ bots }: { bots: Bot[] }) {
  const [workflows, setWorkflows] = useState<OpcWorkflowDefinition[]>([]);
  const [runs, setRuns] = useState<OpcWorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  // Create / Edit modal state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scheduleKind, setScheduleKind] = useState<OpcWorkflowScheduleKind>("daily");
  const [dailyTime, setDailyTime] = useState("09:00");
  const [intervalMinutes, setIntervalMinutes] = useState(120);
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  // Run with variables dialog
  const [runModalWf, setRunModalWf] = useState<OpcWorkflowDefinition | null>(null);
  const [varValues, setVarValues] = useState<Record<string, string>>({});

  // Approval revision note by runId
  const [reviseNotes, setReviseNotes] = useState<Record<string, string>>({});
  const [revisingRunId, setRevisingRunId] = useState<string | null>(null);

  const botNameById = useMemo(() => new Map(bots.map(b => [b.id, b.name])), [bots]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await opcApi.listWorkflows();
      setWorkflows(res.workflows);
      setRuns(res.runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取工作流失败。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    const firstBot = bots[0]?.id ?? "";
    const secondBot = bots[1]?.id ?? firstBot;
    setEditingId(null);
    setName("");
    setDescription("");
    setScheduleKind("daily");
    setDailyTime("09:00");
    setIntervalMinutes(120);
    setSteps([
      { name: "信息收集与大纲", botId: firstBot, instruction: "围绕「{{主题}}」整理今日关键信息、切入点与执行大纲。", approvalGate: false },
      { name: "内容与成品输出", botId: secondBot, instruction: "基于上游大纲完成正式交付初稿，给出可发布的完整版本。", approvalGate: true },
    ]);
    setSaveError("");
    setEditorOpen(true);
  };

  const openEdit = (wf: OpcWorkflowDefinition) => {
    setEditingId(wf.id);
    setName(wf.name);
    setDescription(wf.description);
    setScheduleKind(wf.scheduleKind);
    setDailyTime(wf.dailyTime || "09:00");
    setIntervalMinutes(wf.intervalMinutes || 120);
    setSteps(wf.steps.map(s => ({ ...s })));
    setSaveError("");
    setEditorOpen(true);
  };

  const detectedVars = useMemo(() => extractWorkflowVariables(steps), [steps]);

  const handleSave = async () => {
    if (!name.trim()) {
      setSaveError("请填写工作流名称。");
      return;
    }
    const cleanSteps = steps.filter(s => s.botId && s.instruction.trim());
    if (cleanSteps.length === 0) {
      setSaveError("请至少保留 1 个完整步骤（指定员工和执行指令）。");
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        scheduleKind,
        dailyTime: scheduleKind === "daily" ? dailyTime : undefined,
        intervalMinutes: scheduleKind === "interval" ? intervalMinutes : undefined,
        steps: cleanSteps,
      };
      if (editingId) {
        const updated = await opcApi.updateWorkflow(editingId, payload);
        setWorkflows(prev => prev.map(w => (w.id === editingId ? updated : w)));
      } else {
        const created = await opcApi.createWorkflow(payload);
        setWorkflows(prev => [created, ...prev]);
      }
      setEditorOpen(false);
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

  const triggerRun = async (wf: OpcWorkflowDefinition, vars: Record<string, string>) => {
    setBusyId(`run:${wf.id}`);
    setError("");
    try {
      const run = await opcApi.runWorkflow(wf.id, vars);
      setRuns(prev => [run, ...prev.filter(r => r.id !== run.id)]);
      setRunModalWf(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "运行工作流失败。");
    } finally {
      setBusyId(null);
    }
  };

  const handleRunClick = (wf: OpcWorkflowDefinition) => {
    if (wf.variables.length > 0) {
      const initial: Record<string, string> = {};
      for (const v of wf.variables) initial[v] = "";
      setVarValues(initial);
      setRunModalWf(wf);
      return;
    }
    void triggerRun(wf, {});
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

  return (
    <div data-opc-workflows-view="" className="min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-10">
      <div className="mx-auto max-w-[900px] space-y-10">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-hairline/50 pb-5">
          <div>
            <h2 className="text-[22px] font-semibold tracking-tight text-ink">固定与定时工作流</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">
              把重复生产变成多员工固定流水线：定时触发或一键启动，关键环节自动暂停等老板拍板。
            </p>
          </div>
          <button
            type="button"
            disabled={bots.length === 0}
            onClick={openCreate}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-medium text-app transition-opacity hover:opacity-85 disabled:opacity-40"
          >
            <Plus size={14} /> 新建工作流
          </button>
        </div>

        {error && (
          <div role="alert" className="rounded-xl bg-danger/10 px-4 py-3 text-[12.5px] text-danger">
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
              <p className="text-[13.5px] text-ink-secondary">
                还没有固定工作流。例如设定每天 09:00 自动执行「热点选题 → 脚本写手 → 老板拍板 → 视觉出图」，让一人公司按节奏自动运转。
              </p>
              <button
                type="button"
                disabled={bots.length === 0}
                onClick={openCreate}
                className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-full bg-ink/[0.06] px-4 text-[12.5px] font-medium text-ink hover:bg-ink/[0.11] disabled:opacity-40"
              >
                <Plus size={13} /> 创建第一条工作流
              </button>
            </div>
          ) : (
            <div className="divide-y divide-hairline/40 border-b border-hairline/50">
              {workflows.map(wf => (
                <div key={wf.id} className="py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[15px] font-semibold text-ink">{wf.name}</span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] text-ink-secondary">
                          <Clock size={11} /> {scheduleLabel(wf)}
                        </span>
                        {wf.variables.length > 0 && (
                          <span className="text-[11px] text-ink-tertiary">
                            变量：{wf.variables.map(v => `{{${v}}}`).join(" ")}
                          </span>
                        )}
                      </div>
                      {wf.description && (
                        <p className="mt-1 text-[12.5px] text-ink-secondary">{wf.description}</p>
                      )}

                      {/* Visual pipeline chain */}
                      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[12px]">
                        {wf.steps.map((step, idx) => (
                          <span key={step.id} className="inline-flex items-center gap-1.5">
                            <span className="inline-flex items-center gap-1 rounded-lg bg-ink/[0.04] px-2 py-1 text-ink-secondary ring-[0.5px] ring-hairline/50">
                              <span className="tabular-nums text-ink-tertiary">{idx + 1}.</span>
                              <span className="font-medium text-ink">{step.name}</span>
                              <span className="text-[11px] text-ink-tertiary">({botNameById.get(step.botId) ?? "员工"})</span>
                              {step.approvalGate && (
                                <ShieldCheck size={12} className="text-accent" aria-label="需老板拍板" />
                              )}
                            </span>
                            {idx < wf.steps.length - 1 && (
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
                            className="inline-flex items-center gap-1 rounded-full bg-danger/12 px-2.5 py-0.5 text-[11.5px] font-medium text-danger hover:bg-danger/20"
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
                        onClick={() => handleRunClick(wf)}
                        className="inline-flex h-8 items-center gap-1 rounded-full bg-ink/[0.06] px-3 text-[12px] font-medium text-ink hover:bg-ink/[0.11] disabled:opacity-45"
                      >
                        {busyId === `run:${wf.id}` ? <Loader2 size={12.5} className="animate-spin" /> : <Play size={12.5} />}
                        立即运行
                      </button>
                      <button
                        type="button"
                        onClick={() => openEdit(wf)}
                        aria-label={`编辑「${wf.name}」`}
                        className="flex size-8 items-center justify-center rounded-full text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink"
                      >
                        <Pencil size={13.5} />
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
              ))}
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
              {runs.slice(0, 12).map(run => {
                const meta = runStatusMeta(run.status);
                const waiting = run.status === "waiting_approval";
                const currentStep = run.stepResults[run.currentStepIndex];

                return (
                  <article key={run.id} className="py-4 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <span className="text-[14px] font-medium text-ink">{run.workflowName}</span>
                        <span className={cn("text-[12px] font-medium", meta.tone)}>{meta.label}</span>
                        <span className="text-[11.5px] text-ink-tertiary">
                          {run.trigger === "schedule" ? "定时触发" : "手动触发"}
                        </span>
                      </div>
                      <span className="text-[11.5px] tabular-nums text-ink-tertiary">
                        {new Date(run.startedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>

                    <div className="space-y-1.5 pl-1">
                      {run.stepResults.map((sr, idx) => (
                        <details key={`${run.id}:${sr.stepId}`} open={sr.status === "waiting_approval" || sr.status === "failed"} className="text-[12.5px]">
                          <summary className="flex cursor-pointer select-none items-center gap-2 py-0.5 text-ink-secondary hover:text-ink">
                            <span className="tabular-nums text-ink-tertiary">{idx + 1}.</span>
                            <span className="font-medium text-ink">{sr.stepName}</span>
                            <span className="text-[11.5px] text-ink-tertiary">{sr.botName}</span>
                            <span className="ml-auto text-[11px] text-ink-tertiary">
                              {sr.status === "completed" ? "已完成" : sr.status === "waiting_approval" ? "等老板拍板" : sr.status === "running" ? "执行中" : sr.status === "failed" ? "失败" : "待执行"}
                            </span>
                          </summary>
                          {(sr.output || sr.error) && (
                            <div className={cn("mt-1.5 whitespace-pre-wrap rounded-xl px-3.5 py-2.5 text-[12px] leading-relaxed", sr.error ? "bg-danger/10 text-danger" : "bg-ink/[0.03] text-ink-secondary")}>
                              {sr.error || sr.output}
                            </div>
                          )}
                        </details>
                      ))}
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
                            第 {run.currentStepIndex + 1} 步「{currentStep.stepName}」已完成，等待老板拍板推进
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
                              通过并继续
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

      {/* Create / Edit Workflow Native Dialog */}
      <OpcNativeDialog
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        ariaLabel={editingId ? "编辑固定工作流" : "新建固定工作流"}
        className="w-[min(94vw,680px)]"
      >
        <div className="flex items-center justify-between border-b border-hairline/60 px-5 py-4">
          <h3 className="text-[15px] font-semibold text-ink">{editingId ? "编辑固定工作流" : "新建固定工作流"}</h3>
          <button type="button" onClick={() => setEditorOpen(false)} aria-label="关闭" className="rounded-full p-1 text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink">
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-[13px]">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-[12px] text-ink-tertiary">工作流名称</span>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="如：每日小红书爆款流水线"
                className="h-9 w-full rounded-xl border border-hairline/70 bg-inset px-3 text-ink outline-none focus:border-ink/40"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[12px] text-ink-tertiary">触发方式</span>
              <div className="flex gap-2">
                <select
                  value={scheduleKind}
                  onChange={e => setScheduleKind(e.target.value as OpcWorkflowScheduleKind)}
                  className="h-9 flex-1 rounded-xl border border-hairline/70 bg-inset px-2.5 text-ink outline-none focus:border-ink/40"
                >
                  <option value="daily">每天定时</option>
                  <option value="interval">按间隔周期</option>
                  <option value="manual">仅手动触发</option>
                </select>
                {scheduleKind === "daily" && (
                  <input
                    type="time"
                    value={dailyTime}
                    onChange={e => setDailyTime(e.target.value)}
                    className="h-9 w-28 rounded-xl border border-hairline/70 bg-inset px-2.5 text-ink outline-none"
                  />
                )}
                {scheduleKind === "interval" && (
                  <select
                    value={intervalMinutes}
                    onChange={e => setIntervalMinutes(Number(e.target.value))}
                    className="h-9 w-28 rounded-xl border border-hairline/70 bg-inset px-2 text-ink outline-none"
                  >
                    <option value={60}>每 1 小时</option>
                    <option value={120}>每 2 小时</option>
                    <option value={360}>每 6 小时</option>
                    <option value={720}>每 12 小时</option>
                  </select>
                )}
              </div>
            </label>
          </div>

          <label className="block space-y-1">
            <span className="text-[12px] text-ink-tertiary">简短说明（可选）</span>
            <input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="说明这条流水线解决什么固定业务"
              className="h-9 w-full rounded-xl border border-hairline/70 bg-inset px-3 text-ink outline-none focus:border-ink/40"
            />
          </label>

          <div className="space-y-2.5 border-t border-hairline/40 pt-3">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium text-ink-secondary">
                流水线步骤（支持用 <code className="rounded bg-ink/[0.06] px-1">{"{{变量名}}"}</code> 定义运行参数）
              </span>
              <button
                type="button"
                onClick={() => setSteps(prev => [...prev, { name: `步骤 ${prev.length + 1}`, botId: bots[0]?.id ?? "", instruction: "", approvalGate: false }])}
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium text-ink-secondary hover:bg-ink/[0.06] hover:text-ink"
              >
                <Plus size={12.5} /> 加一步
              </button>
            </div>

            {detectedVars.length > 0 && (
              <div className="text-[11.5px] text-ink-tertiary">
                已自动识别运行变量：{detectedVars.map(v => `{{${v}}}`).join("、")}
              </div>
            )}

            <div className="space-y-3">
              {steps.map((step, idx) => (
                <div key={idx} className="space-y-2 rounded-xl bg-ink/[0.03] p-3 ring-[0.5px] ring-hairline/50">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] font-semibold tabular-nums text-ink-tertiary">#{idx + 1}</span>
                    <input
                      value={step.name}
                      onChange={e => setSteps(prev => prev.map((s, i) => (i === idx ? { ...s, name: e.target.value } : s)))}
                      placeholder="步骤名称"
                      className="h-8 min-w-[130px] flex-1 rounded-lg border border-hairline/70 bg-panel px-2.5 text-[12.5px] text-ink outline-none"
                    />
                    <select
                      value={step.botId}
                      onChange={e => setSteps(prev => prev.map((s, i) => (i === idx ? { ...s, botId: e.target.value } : s)))}
                      className="h-8 rounded-lg border border-hairline/70 bg-panel px-2.5 text-[12.5px] text-ink outline-none"
                    >
                      {bots.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                    {steps.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setSteps(prev => prev.filter((_, i) => i !== idx))}
                        aria-label="删除步骤"
                        className="rounded-full p-1 text-ink-tertiary hover:text-danger"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                  <textarea
                    value={step.instruction}
                    onChange={e => setSteps(prev => prev.map((s, i) => (i === idx ? { ...s, instruction: e.target.value } : s)))}
                    rows={2}
                    placeholder="本步骤的执行指令与交付要求（系统会自动附带上游步骤的产出）"
                    className="w-full resize-none rounded-lg border border-hairline/70 bg-panel px-2.5 py-1.5 text-[12.5px] text-ink outline-none"
                  />
                  <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ink-secondary">
                    <input
                      type="checkbox"
                      checked={step.approvalGate}
                      onChange={e => setSteps(prev => prev.map((s, i) => (i === idx ? { ...s, approvalGate: e.target.checked } : s)))}
                      className="size-3.5 rounded accent-ink"
                    />
                    <span>此步完成后暂停，提交老板台拍板通过后再继续下一步</span>
                  </label>
                </div>
              ))}
            </div>
          </div>

          {saveError && <p role="alert" className="text-[12px] text-danger">{saveError}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-hairline/60 px-5 py-3.5">
          <button type="button" onClick={() => setEditorOpen(false)} className="h-8 rounded-full px-3.5 text-[12.5px] text-ink-secondary hover:bg-ink/[0.06]">
            取消
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void handleSave()}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-ink px-4 text-[12.5px] font-medium text-app hover:opacity-85 disabled:opacity-45"
          >
            {saving && <Loader2 size={13} className="animate-spin" />}
            保存工作流
          </button>
        </div>
      </OpcNativeDialog>

      {/* Run with Variables Native Dialog */}
      <OpcNativeDialog
        open={runModalWf !== null}
        onClose={() => setRunModalWf(null)}
        ariaLabel="填写工作流运行参数"
        className="w-[min(92vw,440px)]"
      >
        {runModalWf && (
          <>
            <div className="flex items-center justify-between border-b border-hairline/60 px-5 py-3.5">
              <h3 className="text-[14.5px] font-semibold text-ink">运行「{runModalWf.name}」</h3>
              <button type="button" onClick={() => setRunModalWf(null)} aria-label="关闭" className="rounded-full p-1 text-ink-tertiary hover:bg-ink/[0.06]">
                <X size={15} />
              </button>
            </div>
            <div className="space-y-3 px-5 py-4">
              {runModalWf.variables.map(v => (
                <label key={v} className="block space-y-1">
                  <span className="text-[12px] text-ink-secondary">{v}</span>
                  <input
                    value={varValues[v] ?? ""}
                    onChange={e => setVarValues(prev => ({ ...prev, [v]: e.target.value }))}
                    placeholder={`请输入 ${v}`}
                    className="h-9 w-full rounded-xl border border-hairline/70 bg-inset px-3 text-[13px] text-ink outline-none focus:border-ink/40"
                  />
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2 border-t border-hairline/60 px-5 py-3.5">
              <button type="button" onClick={() => setRunModalWf(null)} className="h-8 rounded-full px-3 text-[12.5px] text-ink-secondary hover:bg-ink/[0.06]">
                取消
              </button>
              <button
                type="button"
                disabled={busyId !== null}
                onClick={() => void triggerRun(runModalWf, varValues)}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-ink px-4 text-[12.5px] font-medium text-app hover:opacity-85 disabled:opacity-45"
              >
                {busyId === `run:${runModalWf.id}` ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                立即启动
              </button>
            </div>
          </>
        )}
      </OpcNativeDialog>
    </div>
  );
}
