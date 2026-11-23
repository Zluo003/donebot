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

export interface OpcBossOverview {
  pendingArtifactCount: number;
  activeHeartbeatCount: number;
  trippedCircuitBreakerCount: number;
  activeGoalCount: number;
  spend: OpcSpendResponse;
  pendingArtifacts: OpcArtifactItem[];
  heartbeats: OpcHeartbeatConfig[];
}
