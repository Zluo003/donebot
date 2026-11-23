import type { BotArtifact } from "./artifacts.ts";
import type { MarketBotSpendSummary, MarketEvalSample } from "./donebot-market.ts";

export type OpcArtifactReviewStatus = "pending" | "approved" | "changes_requested";

export interface OpcGoalDeliverable {
  id: string;
  title: string;
  done: boolean;
  artifactId?: string;
}

export interface OpcProjectGoal {
  id: string;
  botId: string;
  title: string;
  objective: string;
  redlines: string[];
  deliverables: OpcGoalDeliverable[];
  status: "active" | "completed" | "archived";
  createdAt: number;
  updatedAt: number;
}

export interface OpcArtifactReviewRecord {
  artifactId: string;
  botId: string;
  status: OpcArtifactReviewStatus;
  note?: string;
  reviewedAt: number;
  deliverableId?: string;
}

export interface OpcArtifactItem extends BotArtifact {
  botId: string;
  botName: string;
  botColor: string;
  version: number;
  reviewStatus: OpcArtifactReviewStatus;
  reviewNote?: string;
  reviewedAt?: number;
  deliverableId?: string;
}

export interface OpcSnapshotSkill {
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
}

export interface OpcConfigSnapshot {
  id: string;
  botId: string;
  label: string;
  source: "manual" | "before_restore" | "before_publish";
  title: string;
  description: string;
  soul: string;
  skills: OpcSnapshotSkill[];
  createdAt: number;
}

export interface OpcEvalCase {
  id: string;
  title: string;
  prompt: string;
  expectation?: string;
  updatedAt: number;
}

export interface OpcEvalRunResult {
  caseId: string;
  title: string;
  prompt: string;
  output: string;
  latencyMs: number;
  model: string;
  status: "ok" | "error";
  error?: string;
}

export interface OpcEvalRun {
  id: string;
  botId: string;
  snapshotLabel?: string;
  createdAt: number;
  results: OpcEvalRunResult[];
}

export interface OpcBotEvalState {
  cases: OpcEvalCase[];
  runs: OpcEvalRun[];
  verifiedSamples: MarketEvalSample[];
}

export type OpcHeartbeatOutcome = "silent_ok" | "action_needed" | "error" | "paused_circuit_breaker";

export interface OpcHeartbeatConfig {
  id: string;
  botId: string;
  botName?: string;
  botColor?: string;
  name: string;
  prompt: string;
  intervalMinutes: number;
  silentWhenOk: boolean;
  enabled: boolean;
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
  pausedByCircuitBreaker: boolean;
  circuitBreakerReason?: string;
  lastRunAt?: number;
  lastOutcome?: OpcHeartbeatOutcome;
  lastSummary?: string;
  lastThreadId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface OpcBotSpendEnriched {
  botId: string;
  botName: string;
  botColor: string;
  totalCost: number;
  llmCost: number;
  imageCost: number;
  videoCost: number;
  musicCost: number;
  eventCount: number;
  lastUsedAt: string;
}

export interface OpcSpendResponse {
  available: boolean;
  days: number;
  totalCost: number;
  llmCost: number;
  imageCost: number;
  videoCost: number;
  musicCost: number;
  bots: OpcBotSpendEnriched[];
  raw?: MarketBotSpendSummary | null;
}

export type OpcOrgEnforcementMode = "free" | "enforced";

export interface OpcOrgNodeConfig {
  botId: string;
  /** `null` means direct report to the human Boss (root). */
  reportsToBotId: string | null;
  /** Directed downstream handoff pipeline targets (e.g. Research -> Writer -> Designer). */
  handoffToBotIds: string[];
  roleTitle?: string;
  /** When enabled, artifacts and final handoffs from this employee enter Boss approval queue. */
  requireBossApproval?: boolean;
  /** Allow lightweight `consult: true` peer consultations across branches when enforced. Defaults to true. */
  allowCrossConsult?: boolean;
}

export interface OpcOrgChartState {
  enforcementMode: OpcOrgEnforcementMode;
  nodes: Record<string, OpcOrgNodeConfig>;
  updatedAt: number;
}

/** Portable slot-based org topology embedded inside Studio Marketplace packages. */
export interface OpcOrgBlueprintEntry {
  slotIndex: number;
  reportsToSlot: number | null;
  handoffToSlots: number[];
  roleTitle?: string;
  requireBossApproval?: boolean;
  allowCrossConsult?: boolean;
}

export interface OpcOrgBlueprint {
  enforcementMode: OpcOrgEnforcementMode;
  entries: OpcOrgBlueprintEntry[];
}

export type OpcWorkflowScheduleKind = "manual" | "interval" | "daily";

export interface OpcWorkflowStep {
  id: string;
  name: string;
  botId: string;
  /** Prompt template supporting `{{variable}}` placeholders and previous-stage context injection. */
  instruction: string;
  /** Pause after this step completes and wait for Boss approval in Boss Console before advancing. */
  approvalGate: boolean;
}

export interface OpcWorkflowDefinition {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  scheduleKind: OpcWorkflowScheduleKind;
  /** Used when scheduleKind === "interval" (e.g. 60, 120, 360). */
  intervalMinutes?: number;
  /** Local HH:mm used when scheduleKind === "daily" (e.g. "09:00"). */
  dailyTime?: string;
  silentWhenOk?: boolean;
  steps: OpcWorkflowStep[];
  /** Auto-detected `{{name}}` template variable names across all step instructions. */
  variables: string[];
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
  pausedByCircuitBreaker: boolean;
  circuitBreakerReason?: string;
  lastRunAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type OpcWorkflowRunStatus = "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

export interface OpcWorkflowStepRun {
  stepId: string;
  stepName: string;
  botId: string;
  botName: string;
  status: "pending" | "running" | "waiting_approval" | "completed" | "failed" | "skipped";
  output?: string;
  error?: string;
  revisionNote?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface OpcWorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  trigger: "manual" | "schedule";
  variables: Record<string, string>;
  status: OpcWorkflowRunStatus;
  currentStepIndex: number;
  stepResults: OpcWorkflowStepRun[];
  startedAt: number;
  finishedAt?: number;
}

export function extractWorkflowVariables(steps: ReadonlyArray<Pick<OpcWorkflowStep, "instruction">>): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const pattern = /\{\{\s*([a-zA-Z0-9_\u4e00-\u9fa5-]+)\s*\}\}/g;
  for (const step of steps) {
    for (const match of step.instruction.matchAll(pattern)) {
      const name = match[1]?.trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        found.push(name);
      }
    }
  }
  return found;
}

export interface OpcBossOverview {
  pendingArtifactCount: number;
  activeHeartbeatCount: number;
  trippedCircuitBreakerCount: number;
  activeGoalCount: number;
  activeWorkflowCount?: number;
  waitingWorkflowCount?: number;
  orgEnforcementMode?: OpcOrgEnforcementMode;
  spend: OpcSpendResponse;
  pendingArtifacts: OpcArtifactItem[];
  waitingWorkflowRuns?: OpcWorkflowRun[];
  heartbeats: OpcHeartbeatConfig[];
}
