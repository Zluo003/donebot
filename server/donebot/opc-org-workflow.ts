// Org reporting cycle guard adapted from Paperclip (https://github.com/paperclipai/paperclip)
// server/src/lib/agent-records.ts (`assertNoCycle`) — Copyright (c) 2025 Paperclip AI (MIT License).

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type OpcOrgBlueprint,
  type OpcOrgChartState,
  type OpcOrgEnforcementMode,
  type OpcOrgNodeConfig,
  type OpcWorkflowDefinition,
  type OpcWorkflowRun,
  type OpcWorkflowScheduleKind,
  type OpcWorkflowStepRun,
} from "../../shared/donebot-opc.ts";
import {
  normalizeTriggerPosition,
  normalizeWorkflowGraph,
  resolveWorkflowExecutionPlan,
  type OpcWorkflowStepInput,
} from "../../shared/donebot-opc-graph.ts";
import {
  reconcileOrgChartWithBots,
  validateOrgReportsTo,
} from "../../shared/donebot-opc-org-sync.ts";
import {
  buildWorkflowStepPrompt,
  type WorkflowTurnInput,
  type WorkflowTurnOutput,
} from "./opc-workflow-runner.ts";
import { buildOrgPromptForBot, evaluateOrgCoordination } from "./opc-org-policy.ts";
export { resolveWorkflowExecutionPlan } from "../../shared/donebot-opc-graph.ts";
import { writeFileAtomic } from "../atomic.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import type { BotRecord, Store } from "../store.ts";

interface OrgWorkflowFileState {
  version: 1;
  orgChart: OpcOrgChartState;
  workflows: Record<string, OpcWorkflowDefinition>;
  workflowRuns: OpcWorkflowRun[];
}

const MAX_WORKFLOW_RUNS = 60;

function emptyState(): OrgWorkflowFileState {
  return {
    version: 1,
    orgChart: {
      enforcementMode: "free",
      nodes: {},
      updatedAt: 0,
    },
    workflows: {},
    workflowRuns: [],
  };
}

function defaultNode(botId: string): OpcOrgNodeConfig {
  return {
    botId,
    reportsToBotId: null,
    handoffToBotIds: [],
    requireBossApproval: false,
    allowCrossConsult: true,
  };
}

export class DoneBotOrgWorkflowStore {
  private readonly filePath: string;
  private loaded = false;
  private state: OrgWorkflowFileState = emptyState();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.filePath)) return;
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<OrgWorkflowFileState>;
      this.state = {
        version: 1,
        orgChart: {
          enforcementMode: raw.orgChart?.enforcementMode === "enforced" ? "enforced" : "free",
          allowChiefCrossDispatch: Boolean(raw.orgChart?.allowChiefCrossDispatch),
          ...(typeof raw.orgChart?.generalDepartmentName === "string" && raw.orgChart.generalDepartmentName.trim()
            ? { generalDepartmentName: raw.orgChart.generalDepartmentName.trim().slice(0, 60) }
            : {}),
          nodes: raw.orgChart?.nodes && typeof raw.orgChart.nodes === "object" ? raw.orgChart.nodes : {},
          updatedAt: typeof raw.orgChart?.updatedAt === "number" ? raw.orgChart.updatedAt : 0,
        },
        workflows: raw.workflows && typeof raw.workflows === "object" ? raw.workflows : {},
        workflowRuns: Array.isArray(raw.workflowRuns) ? raw.workflowRuns.slice(0, MAX_WORKFLOW_RUNS) : [],
      };
    } catch {
      this.state = emptyState();
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.filePath, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    } catch {
      // Best-effort persistence.
    }
  }

  // --- Org Chart & Reporting Cycle Guard ---

  private syncWithBots(bots: readonly BotRecord[]): OpcOrgChartState {
    const result = reconcileOrgChartWithBots(this.state.orgChart, bots);
    if (result.changed) {
      this.state.orgChart.nodes = result.org.nodes;
      this.state.orgChart.updatedAt = Date.now();
      this.persist();
    }
    return {
      enforcementMode: this.state.orgChart.enforcementMode,
      allowChiefCrossDispatch: Boolean(this.state.orgChart.allowChiefCrossDispatch),
      ...(this.state.orgChart.generalDepartmentName ? { generalDepartmentName: this.state.orgChart.generalDepartmentName } : {}),
      nodes: result.org.nodes,
      updatedAt: this.state.orgChart.updatedAt,
    };
  }

  getOrgChart(bots?: readonly BotRecord[]): OpcOrgChartState {
    this.ensureLoaded();
    if (bots) return this.syncWithBots(bots);
    const nodes: Record<string, OpcOrgNodeConfig> = {};
    for (const [id, node] of Object.entries(this.state.orgChart.nodes)) {
      nodes[id] = { ...defaultNode(id), ...node, handoffToBotIds: [...(node.handoffToBotIds ?? [])] };
    }
    return {
      enforcementMode: this.state.orgChart.enforcementMode,
      allowChiefCrossDispatch: Boolean(this.state.orgChart.allowChiefCrossDispatch),
      ...(this.state.orgChart.generalDepartmentName ? { generalDepartmentName: this.state.orgChart.generalDepartmentName } : {}),
      nodes,
      updatedAt: this.state.orgChart.updatedAt,
    };
  }

  updateOrgSettings(patch: {
    enforcementMode?: OpcOrgEnforcementMode;
    allowChiefCrossDispatch?: boolean;
    generalDepartmentName?: string | null;
  }): OpcOrgChartState {
    this.ensureLoaded();
    if (patch.enforcementMode !== undefined) {
      this.state.orgChart.enforcementMode = patch.enforcementMode === "enforced" ? "enforced" : "free";
    }
    if (patch.allowChiefCrossDispatch !== undefined) {
      this.state.orgChart.allowChiefCrossDispatch = Boolean(patch.allowChiefCrossDispatch);
    }
    if (patch.generalDepartmentName !== undefined) {
      const cleaned = typeof patch.generalDepartmentName === "string" ? patch.generalDepartmentName.trim().slice(0, 60) : "";
      if (cleaned && cleaned !== "通用") this.state.orgChart.generalDepartmentName = cleaned;
      else delete this.state.orgChart.generalDepartmentName;
    }
    this.state.orgChart.updatedAt = Date.now();
    this.persist();
    return this.getOrgChart();
  }

  setEnforcementMode(mode: OpcOrgEnforcementMode): OpcOrgChartState {
    return this.updateOrgSettings({ enforcementMode: mode });
  }

  /** Prevents direct self-reporting or ancestor cycles in the reporting tree. */
  assertNoCycle(botId: string, reportsToBotId: string | null | undefined): void {
    if (!reportsToBotId) return;
    if (reportsToBotId === botId) {
      throw new Error("员工不能向自己汇报，请选择其他上级或直接向老板汇报。");
    }
    this.ensureLoaded();
    const visited = new Set<string>([botId]);
    let cursor: string | null = reportsToBotId;
    while (cursor) {
      if (visited.has(cursor)) {
        throw new Error("不能设置循环汇报关系（所选上级位于当前员工的下属链路中）。");
      }
      visited.add(cursor);
      cursor = this.state.orgChart.nodes[cursor]?.reportsToBotId ?? null;
    }
  }

  upsertOrgNode(
    botId: string,
    patch: Partial<Omit<OpcOrgNodeConfig, "botId">>,
    bots?: readonly BotRecord[],
  ): OpcOrgNodeConfig {
    this.ensureLoaded();
    if (bots) this.syncWithBots(bots);
    const prev = this.state.orgChart.nodes[botId] ?? defaultNode(botId);
    const nextReportsTo = patch.reportsToBotId !== undefined
      ? (patch.reportsToBotId ? patch.reportsToBotId.trim() : null)
      : prev.reportsToBotId;
    if (patch.reportsToBotId !== undefined) {
      const refusal = validateOrgReportsTo(botId, nextReportsTo, this.state.orgChart, bots);
      if (refusal) throw new Error(refusal);
    } else {
      this.assertNoCycle(botId, nextReportsTo);
    }

    const nextHandoffs = patch.handoffToBotIds !== undefined
      ? [...new Set(patch.handoffToBotIds.map(id => id.trim()).filter(id => id && id !== botId))]
      : prev.handoffToBotIds;

    const next: OpcOrgNodeConfig = {
      botId,
      reportsToBotId: nextReportsTo,
      handoffToBotIds: nextHandoffs,
      roleTitle: patch.roleTitle !== undefined ? (patch.roleTitle.trim() || undefined) : prev.roleTitle,
      requireBossApproval: patch.requireBossApproval !== undefined ? Boolean(patch.requireBossApproval) : prev.requireBossApproval,
      allowCrossConsult: patch.allowCrossConsult !== undefined ? Boolean(patch.allowCrossConsult) : (prev.allowCrossConsult ?? true),
    };
    this.state.orgChart.nodes[botId] = next;
    this.state.orgChart.updatedAt = Date.now();
    this.persist();
    return { ...next, handoffToBotIds: [...next.handoffToBotIds] };
  }

  /**
   * Deterministic server-side coordination gate for `POST /api/internal/coordinate-bots`.
   * Returns `null` when allowed, or a clear refusal reason when blocked under `enforced` mode.
   */
  evaluateCoordination(
    senderId: string,
    targetBotIds: readonly string[],
    consult: boolean,
    bots: readonly BotRecord[],
  ): string | null {
    this.ensureLoaded();
    this.syncWithBots(bots);
    return evaluateOrgCoordination(this.state.orgChart, senderId, targetBotIds, consult, bots);
  }

  /** Renders concise fenced Org & Workflow Discipline instructions for LLM system prompt injection. */
  orgPromptForBot(botId: string, bots: readonly BotRecord[]): string | undefined {
    this.ensureLoaded();
    this.syncWithBots(bots);
    return buildOrgPromptForBot(this.state.orgChart, botId, bots);
  }

  exportOrgBlueprint(botIds: readonly string[]): OpcOrgBlueprint | undefined {
    this.ensureLoaded();
    const indexById = new Map(botIds.map((id, idx) => [id, idx]));
    const entries = botIds.map((id, slotIndex) => {
      const node = this.state.orgChart.nodes[id] ?? defaultNode(id);
      return {
        slotIndex,
        reportsToSlot: node.reportsToBotId && indexById.has(node.reportsToBotId)
          ? indexById.get(node.reportsToBotId)!
          : null,
        handoffToSlots: [],
        ...(node.roleTitle ? { roleTitle: node.roleTitle } : {}),
        ...(node.requireBossApproval ? { requireBossApproval: true } : {}),
        ...(node.allowCrossConsult === false ? { allowCrossConsult: false } : {}),
      };
    });
    const hasRelations = entries.some(e =>
      e.reportsToSlot !== null || Boolean(e.roleTitle) || Boolean(e.requireBossApproval),
    );
    if (!hasRelations && this.state.orgChart.enforcementMode === "free") return undefined;
    return {
      enforcementMode: this.state.orgChart.enforcementMode,
      ...(this.state.orgChart.allowChiefCrossDispatch ? { allowChiefCrossDispatch: true } : {}),
      entries,
    };
  }

  importOrgBlueprint(createdBotIds: readonly string[], blueprint?: OpcOrgBlueprint | null): void {
    if (!blueprint || !Array.isArray(blueprint.entries) || createdBotIds.length === 0) return;
    this.ensureLoaded();
    for (const entry of blueprint.entries) {
      const botId = createdBotIds[entry.slotIndex];
      if (!botId) continue;
      const reportsToBotId = entry.reportsToSlot !== null && entry.reportsToSlot !== undefined
        ? (createdBotIds[entry.reportsToSlot] ?? null)
        : null;
      try {
        this.upsertOrgNode(botId, {
          reportsToBotId,
          handoffToBotIds: [],
          roleTitle: entry.roleTitle,
          requireBossApproval: entry.requireBossApproval,
          allowCrossConsult: entry.allowCrossConsult,
        });
      } catch {
        // Ignore malformed external cycle entries cleanly.
      }
    }
    if (blueprint.enforcementMode === "enforced" || blueprint.allowChiefCrossDispatch) {
      this.updateOrgSettings({
        enforcementMode: blueprint.enforcementMode,
        allowChiefCrossDispatch: blueprint.allowChiefCrossDispatch,
      });
    }
  }

  // --- Scheduled / Reusable Multi-Step Workflows ---

  listWorkflows(): OpcWorkflowDefinition[] {
    this.ensureLoaded();
    return Object.values(this.state.workflows).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getWorkflow(id: string): OpcWorkflowDefinition | undefined {
    this.ensureLoaded();
    return this.state.workflows[id];
  }

  createWorkflow(input: {
    name: string;
    description?: string;
    enabled?: boolean;
    scheduleKind?: OpcWorkflowScheduleKind;
    intervalMinutes?: number;
    dailyTime?: string;
    silentWhenOk?: boolean;
    triggerPosition?: { x: number; y: number };
    entryStepIds?: string[];
    steps: OpcWorkflowStepInput[];
    maxConsecutiveFailures?: number;
  }): OpcWorkflowDefinition {
    this.ensureLoaded();
    const now = Date.now();
    const { steps, entryStepIds } = normalizeWorkflowGraph(input.steps, input.entryStepIds, idx => `step-${idx + 1}-${randomUUID().slice(0, 6)}`);
    const triggerPosition = normalizeTriggerPosition(input.triggerPosition);
    const scheduleKind: OpcWorkflowScheduleKind = input.scheduleKind === "interval" || input.scheduleKind === "daily"
      ? input.scheduleKind
      : "manual";
    const wf: OpcWorkflowDefinition = {
      id: randomUUID(),
      name: input.name.trim() || "未命名工作流",
      description: input.description?.trim() ?? "",
      enabled: input.enabled ?? true,
      scheduleKind,
      ...(scheduleKind === "interval" ? { intervalMinutes: Math.max(15, Math.min(10080, Math.round(input.intervalMinutes ?? 60))) } : {}),
      ...(scheduleKind === "daily" ? { dailyTime: /^\d{2}:\d{2}$/.test(input.dailyTime ?? "") ? input.dailyTime : "09:00" } : {}),
      silentWhenOk: Boolean(input.silentWhenOk),
      ...(triggerPosition ? { triggerPosition } : {}),
      ...(entryStepIds !== undefined ? { entryStepIds } : {}),
      steps,
      variables: [],
      maxConsecutiveFailures: Math.max(2, Math.min(10, Math.round(input.maxConsecutiveFailures ?? 3))),
      consecutiveFailures: 0,
      pausedByCircuitBreaker: false,
      createdAt: now,
      updatedAt: now,
    };
    this.state.workflows[wf.id] = wf;
    this.persist();
    return wf;
  }

  updateWorkflow(
    id: string,
    patch: Partial<{
      name: string;
      description: string;
      enabled: boolean;
      scheduleKind: OpcWorkflowScheduleKind;
      intervalMinutes: number;
      dailyTime: string;
      silentWhenOk: boolean;
      triggerPosition: { x: number; y: number };
      entryStepIds: string[];
      steps: OpcWorkflowStepInput[];
      maxConsecutiveFailures: number;
      pausedByCircuitBreaker: boolean;
      consecutiveFailures: number;
      circuitBreakerReason: string | undefined;
      lastRunAt: number;
    }>,
  ): OpcWorkflowDefinition | null {
    this.ensureLoaded();
    const existing = this.state.workflows[id];
    if (!existing) return null;
    const normalized = patch.steps
      ? normalizeWorkflowGraph(patch.steps, patch.entryStepIds !== undefined ? patch.entryStepIds : existing.entryStepIds, idx => `step-${idx + 1}-${randomUUID().slice(0, 6)}`)
      : {
        steps: existing.steps,
        entryStepIds: patch.entryStepIds !== undefined
          ? patch.entryStepIds.filter(sid => existing.steps.some(s => s.id === sid))
          : existing.entryStepIds,
      };
    const triggerPosition = patch.triggerPosition !== undefined
      ? normalizeTriggerPosition(patch.triggerPosition)
      : existing.triggerPosition;
    const scheduleKind = patch.scheduleKind ?? existing.scheduleKind;
    const updated: OpcWorkflowDefinition = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name.trim() || existing.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
      ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}),
      scheduleKind,
      intervalMinutes: scheduleKind === "interval"
        ? Math.max(15, Math.min(10080, Math.round(patch.intervalMinutes ?? existing.intervalMinutes ?? 60)))
        : undefined,
      dailyTime: scheduleKind === "daily"
        ? (/^\d{2}:\d{2}$/.test(patch.dailyTime ?? existing.dailyTime ?? "") ? (patch.dailyTime ?? existing.dailyTime) : "09:00")
        : undefined,
      ...(patch.silentWhenOk !== undefined ? { silentWhenOk: Boolean(patch.silentWhenOk) } : {}),
      ...(triggerPosition ? { triggerPosition } : {}),
      ...(normalized.entryStepIds !== undefined ? { entryStepIds: normalized.entryStepIds } : {}),
      steps: normalized.steps,
      variables: [],
      ...(patch.maxConsecutiveFailures !== undefined ? { maxConsecutiveFailures: Math.max(2, Math.min(10, Math.round(patch.maxConsecutiveFailures))) } : {}),
      ...(patch.pausedByCircuitBreaker !== undefined ? { pausedByCircuitBreaker: patch.pausedByCircuitBreaker } : {}),
      ...(patch.consecutiveFailures !== undefined ? { consecutiveFailures: patch.consecutiveFailures } : {}),
      ...(patch.circuitBreakerReason !== undefined ? { circuitBreakerReason: patch.circuitBreakerReason } : {}),
      ...(patch.lastRunAt !== undefined ? { lastRunAt: patch.lastRunAt } : {}),
      updatedAt: Date.now(),
    };
    this.state.workflows[id] = updated;
    this.persist();
    return updated;
  }

  deleteWorkflow(id: string): boolean {
    this.ensureLoaded();
    if (!this.state.workflows[id]) return false;
    delete this.state.workflows[id];
    this.persist();
    return true;
  }

  listWorkflowRuns(workflowId?: string): OpcWorkflowRun[] {
    this.ensureLoaded();
    const runs = workflowId
      ? this.state.workflowRuns.filter(r => r.workflowId === workflowId)
      : this.state.workflowRuns;
    return runs.slice(0, MAX_WORKFLOW_RUNS);
  }

  getWorkflowRun(runId: string): OpcWorkflowRun | undefined {
    this.ensureLoaded();
    return this.state.workflowRuns.find(r => r.id === runId);
  }

  listWaitingWorkflowRuns(): OpcWorkflowRun[] {
    this.ensureLoaded();
    return this.state.workflowRuns.filter(r => r.status === "waiting_approval");
  }

  saveWorkflowRun(run: OpcWorkflowRun): OpcWorkflowRun {
    this.ensureLoaded();
    const idx = this.state.workflowRuns.findIndex(r => r.id === run.id);
    if (idx >= 0) this.state.workflowRuns[idx] = run;
    else this.state.workflowRuns.unshift(run);
    if (this.state.workflowRuns.length > MAX_WORKFLOW_RUNS) {
      this.state.workflowRuns.length = MAX_WORKFLOW_RUNS;
    }
    this.persist();
    return run;
  }

  isDueForSchedule(wf: OpcWorkflowDefinition, now: number): boolean {
    if (!wf.enabled || wf.pausedByCircuitBreaker || wf.scheduleKind === "manual") return false;
    if (wf.scheduleKind === "interval") {
      const intervalMs = Math.max(15, wf.intervalMinutes ?? 60) * 60_000;
      return !wf.lastRunAt || now - wf.lastRunAt >= intervalMs;
    }
    if (wf.scheduleKind === "daily" && wf.dailyTime) {
      const [hh, mm] = wf.dailyTime.split(":").map(Number);
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) return false;
      const d = new Date(now);
      const targetToday = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0).getTime();
      if (now < targetToday) return false;
      return !wf.lastRunAt || wf.lastRunAt < targetToday;
    }
    return false;
  }
}

export interface DoneBotOrgWorkflowRouteDeps {
  orgStore: DoneBotOrgWorkflowStore;
  store: Store;
  runBotTurn?: (input: WorkflowTurnInput) => Promise<WorkflowTurnOutput>;
  generateBotText?: (botId: string, prompt: string, signal?: AbortSignal) => Promise<string | undefined>;
  startTurn?: (botId: string, text: string, opts?: { threadId?: string; automated?: boolean }) => Promise<unknown>;
  enableScheduler?: boolean;
}

export type DoneBotOrgWorkflowRouteHandler = RouteHandler & {
  triggerWorkflow: (wf: OpcWorkflowDefinition, trigger: "manual" | "schedule", variables?: Record<string, string>) => Promise<OpcWorkflowRun>;
};

export function createDoneBotOrgWorkflowRoutes(deps: DoneBotOrgWorkflowRouteDeps): DoneBotOrgWorkflowRouteHandler {
  const activeRunByWorkflow = new Set<string>();

  async function settleOrReturnRunning(
    execPromise: Promise<OpcWorkflowRun>,
    runId: string,
    fallback: OpcWorkflowRun,
  ): Promise<OpcWorkflowRun> {
    const fast = await Promise.race([
      execPromise,
      new Promise<null>(resolve => setTimeout(() => resolve(null), 800)),
    ]);
    if (fast) return fast;
    return deps.orgStore.getWorkflowRun(runId) ?? fallback;
  }

  async function executeFromStep(
    wf: OpcWorkflowDefinition,
    run: OpcWorkflowRun,
    startIndex: number,
    revisionNote?: string,
  ): Promise<OpcWorkflowRun> {
    if (activeRunByWorkflow.has(wf.id)) return run;
    activeRunByWorkflow.add(wf.id);
    try {
      const plan = resolveWorkflowExecutionPlan(wf);
      const stepById = new Map(wf.steps.map(s => [s.id, s]));
      let current = { ...run, status: "running" as OpcWorkflowRun["status"] };
      deps.orgStore.saveWorkflowRun(current);

      const totalSteps = current.stepResults.length;
      for (let i = startIndex; i < totalSteps; i++) {
        const planned = current.stepResults[i];
        const step = (planned ? stepById.get(planned.stepId) : undefined) ?? plan.orderedSteps[i];
        if (!step) continue;
        const bot = deps.store.bot(step.botId);
        const stepRun: OpcWorkflowStepRun = {
          ...(current.stepResults[i] ?? {
            stepId: step.id,
            stepName: step.name,
            botId: step.botId,
            botName: bot?.name ?? step.botId,
            status: "pending",
          }),
          status: "running",
          startedAt: Date.now(),
          error: undefined,
          ...(revisionNote && i === startIndex ? { revisionNote } : {}),
        };
        current.currentStepIndex = i;
        current.stepResults[i] = stepRun;
        deps.orgStore.saveWorkflowRun(current);

        if (!bot || bot.hidden) {
          stepRun.status = "failed";
          stepRun.error = `步骤负责员工不存在或已归档（${step.botId}）`;
          stepRun.finishedAt = Date.now();
          current.status = "failed";
          current.finishedAt = Date.now();
          deps.orgStore.saveWorkflowRun(current);
          recordWorkflowFailure(wf.id, stepRun.error);
          return current;
        }

        const priorCompleted = current.stepResults.slice(0, i).filter(s => s.status === "completed");
        const directParentIds = plan.parentsByStepId.get(step.id) ?? [];
        const completedPrev = plan.isExplicitGraph
          ? priorCompleted.filter(s => directParentIds.includes(s.stepId))
          : priorCompleted;
        const hasDownstream = plan.isExplicitGraph
          ? plan.orderedSteps.some(other => (plan.parentsByStepId.get(other.id) ?? []).includes(step.id))
          : i < totalSteps - 1;
        const { prompt, peerFrom } = buildWorkflowStepPrompt({
          wf,
          step,
          stepIndex: i,
          totalSteps,
          completedSteps: completedPrev,
          isFinalStep: !hasDownstream,
          revisionNote: i === startIndex ? revisionNote : undefined,
        });

        try {
          let output = "";
          if (deps.runBotTurn) {
            const turnRes = await deps.runBotTurn({
              botId: bot.id,
              prompt,
              threadId: i === startIndex && revisionNote ? stepRun.threadId : undefined,
              workflowTitle: `${wf.name} · ${step.name}`,
              peerFrom,
            });
            if (turnRes.threadId) stepRun.threadId = turnRes.threadId;
            if (!turnRes.ok) {
              throw new Error(turnRes.text || "员工执行该步骤失败。");
            }
            output = turnRes.text.trim();
          } else if (deps.generateBotText) {
            output = (await deps.generateBotText(bot.id, prompt))?.trim() ?? "";
            if (!output) {
              throw new Error("模型未返回有效文本内容。");
            }
          } else if (deps.startTurn) {
            await deps.startTurn(bot.id, prompt, { automated: true });
            output = `已派发至「${bot.name}」会话执行。`;
          } else {
            throw new Error("当前环境暂不支持执行工作流步骤。");
          }

          stepRun.output = output;
          stepRun.finishedAt = Date.now();

          if (step.approvalGate) {
            stepRun.status = "waiting_approval";
            current.status = "waiting_approval";
            deps.orgStore.saveWorkflowRun(current);
            deps.orgStore.updateWorkflow(wf.id, { consecutiveFailures: 0, lastRunAt: Date.now() });
            return current;
          }

          stepRun.status = "completed";
          deps.orgStore.saveWorkflowRun(current);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          stepRun.status = "failed";
          stepRun.error = reason;
          stepRun.finishedAt = Date.now();
          current.status = "failed";
          current.finishedAt = Date.now();
          deps.orgStore.saveWorkflowRun(current);
          recordWorkflowFailure(wf.id, reason);
          return current;
        }
      }

      current.status = "completed";
      current.finishedAt = Date.now();
      deps.orgStore.saveWorkflowRun(current);
      deps.orgStore.updateWorkflow(wf.id, {
        consecutiveFailures: 0,
        pausedByCircuitBreaker: false,
        circuitBreakerReason: undefined,
        lastRunAt: Date.now(),
      });
      return current;
    } finally {
      activeRunByWorkflow.delete(wf.id);
    }
  }

  function recordWorkflowFailure(workflowId: string, reason: string): void {
    const wf = deps.orgStore.getWorkflow(workflowId);
    if (!wf) return;
    const nextFailures = wf.consecutiveFailures + 1;
    const trip = nextFailures >= wf.maxConsecutiveFailures;
    deps.orgStore.updateWorkflow(workflowId, {
      consecutiveFailures: nextFailures,
      lastRunAt: Date.now(),
      ...(trip ? { pausedByCircuitBreaker: true, circuitBreakerReason: `连续失败 ${nextFailures} 次已自动熔断：${reason}` } : {}),
    });
  }

  async function triggerWorkflow(
    wf: OpcWorkflowDefinition,
    trigger: "manual" | "schedule",
    variables: Record<string, string> = {},
  ): Promise<OpcWorkflowRun> {
    const plan = resolveWorkflowExecutionPlan(wf);
    const run: OpcWorkflowRun = {
      id: randomUUID(),
      workflowId: wf.id,
      workflowName: wf.name,
      trigger,
      variables,
      status: "running",
      currentStepIndex: 0,
      stepResults: plan.orderedSteps.map(step => ({
        stepId: step.id,
        stepName: step.name,
        botId: step.botId,
        botName: deps.store.bot(step.botId)?.name ?? step.botId,
        status: "pending",
      })),
      startedAt: Date.now(),
    };
    deps.orgStore.saveWorkflowRun(run);
    const execPromise = executeFromStep(wf, run, 0);
    return trigger === "manual" ? settleOrReturnRunning(execPromise, run.id, run) : execPromise;
  }

  if (deps.enableScheduler !== false) {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const wf of deps.orgStore.listWorkflows()) {
        if (activeRunByWorkflow.has(wf.id)) continue;
        if (!deps.orgStore.isDueForSchedule(wf, now)) continue;
        void triggerWorkflow(wf, "schedule", {}).catch(() => {});
      }
    }, 60_000);
    timer.unref?.();
  }

  const handler: RouteHandler = async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (!path.startsWith("/api/donebot/opc/org") && !path.startsWith("/api/donebot/opc/workflow")) {
      return PASS;
    }
    if (!ownerOrAdmin(auth)) {
      return json(res, 403, { error: "仅工作空间所有者可管理组织架构与固定工作流。" });
    }
    res.setHeader("Cache-Control", "no-store");

    try {
      if (method === "GET" && path === "/api/donebot/opc/org") {
        json(res, 200, deps.orgStore.getOrgChart(deps.store.bots));
        return;
      }

      if (method === "PUT" && path === "/api/donebot/opc/org/mode") {
        const body = await readBody(req) as {
          enforcementMode?: OpcOrgEnforcementMode;
          allowChiefCrossDispatch?: boolean;
          generalDepartmentName?: string | null;
        };
        json(res, 200, deps.orgStore.updateOrgSettings({
          ...(body.enforcementMode !== undefined ? { enforcementMode: body.enforcementMode } : {}),
          ...(body.allowChiefCrossDispatch !== undefined ? { allowChiefCrossDispatch: body.allowChiefCrossDispatch } : {}),
          ...(body.generalDepartmentName !== undefined ? { generalDepartmentName: body.generalDepartmentName } : {}),
        }));
        return;
      }

      const nodeMatch = path.match(/^\/api\/donebot\/opc\/org\/nodes\/([^/]+)$/);
      if (nodeMatch && method === "PUT") {
        const botId = decodeURIComponent(nodeMatch[1]!);
        const body = await readBody(req) as Partial<Omit<OpcOrgNodeConfig, "botId">>;
        const node = deps.orgStore.upsertOrgNode(botId, body, deps.store.bots);
        json(res, 200, { node, org: deps.orgStore.getOrgChart(deps.store.bots) });
        return;
      }

      if (method === "GET" && path === "/api/donebot/opc/workflows") {
        json(res, 200, {
          workflows: deps.orgStore.listWorkflows(),
          runs: deps.orgStore.listWorkflowRuns(),
        });
        return;
      }

      if (method === "POST" && path === "/api/donebot/opc/workflows") {
        const body = await readBody(req) as Parameters<DoneBotOrgWorkflowStore["createWorkflow"]>[0];
        const workflow = deps.orgStore.createWorkflow(body);
        json(res, 201, { workflow });
        return;
      }

      const wfMatch = path.match(/^\/api\/donebot\/opc\/workflows\/([^/]+)$/);
      if (wfMatch && method === "PATCH") {
        const id = decodeURIComponent(wfMatch[1]!);
        const body = await readBody(req) as Parameters<DoneBotOrgWorkflowStore["updateWorkflow"]>[1];
        const workflow = deps.orgStore.updateWorkflow(id, body);
        if (!workflow) {
          json(res, 404, { error: "工作流不存在" });
          return;
        }
        json(res, 200, { workflow });
        return;
      }

      if (wfMatch && method === "DELETE") {
        const id = decodeURIComponent(wfMatch[1]!);
        json(res, 200, { ok: deps.orgStore.deleteWorkflow(id) });
        return;
      }

      const wfRunMatch = path.match(/^\/api\/donebot\/opc\/workflows\/([^/]+)\/run$/);
      if (wfRunMatch && method === "POST") {
        const id = decodeURIComponent(wfRunMatch[1]!);
        const wf = deps.orgStore.getWorkflow(id);
        if (!wf) {
          json(res, 404, { error: "工作流不存在" });
          return;
        }
        if (activeRunByWorkflow.has(wf.id)) {
          json(res, 409, { error: "该工作流正在执行中，请稍候。" });
          return;
        }
        const body = await readBody(req) as { variables?: Record<string, string> };
        const variables: Record<string, string> = {};
        if (body.variables && typeof body.variables === "object") {
          for (const [k, v] of Object.entries(body.variables)) {
            if (typeof v === "string") variables[k] = v;
          }
        }
        const run = await triggerWorkflow(wf, "manual", variables);
        json(res, 200, { run });
        return;
      }

      if (method === "GET" && path === "/api/donebot/opc/workflow-runs") {
        const workflowId = url.searchParams.get("workflowId") || undefined;
        json(res, 200, { runs: deps.orgStore.listWorkflowRuns(workflowId) });
        return;
      }

      const decisionMatch = path.match(/^\/api\/donebot\/opc\/workflow-runs\/([^/]+)\/decision$/);
      if (decisionMatch && method === "POST") {
        const runId = decodeURIComponent(decisionMatch[1]!);
        const run = deps.orgStore.getWorkflowRun(runId);
        if (!run) {
          json(res, 404, { error: "工作流运行记录不存在" });
          return;
        }
        const wf = deps.orgStore.getWorkflow(run.workflowId);
        if (!wf) {
          json(res, 404, { error: "关联的工作流已被删除" });
          return;
        }
        const body = await readBody(req) as { action?: "approve" | "revise" | "cancel"; note?: string };
        const idx = run.currentStepIndex;

        if (body.action === "cancel") {
          const cancelled: OpcWorkflowRun = { ...run, status: "cancelled", finishedAt: Date.now() };
          deps.orgStore.saveWorkflowRun(cancelled);
          json(res, 200, { run: cancelled });
          return;
        }

        if (body.action === "revise") {
          const note = body.note?.trim() || "请按要求重新完善本步骤产出。";
          const next = await settleOrReturnRunning(executeFromStep(wf, run, idx, note), run.id, run);
          json(res, 200, { run: next });
          return;
        }

        if (body.action === "approve") {
          if (run.stepResults[idx]) {
            run.stepResults[idx] = { ...run.stepResults[idx]!, status: "completed", finishedAt: Date.now() };
          }
          if (idx + 1 >= run.stepResults.length) {
            const done: OpcWorkflowRun = { ...run, status: "completed", finishedAt: Date.now() };
            deps.orgStore.saveWorkflowRun(done);
            json(res, 200, { run: done });
            return;
          }
          const next = await settleOrReturnRunning(executeFromStep(wf, run, idx + 1), run.id, run);
          json(res, 200, { run: next });
          return;
        }

        json(res, 400, { error: "无效的审批操作，请使用 approve / revise / cancel。" });
        return;
      }

      return PASS;
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : "操作失败" });
    }
  };

  return Object.assign(handler, { triggerWorkflow });
}
