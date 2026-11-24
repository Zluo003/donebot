// Goal Ancestry prompt fencing adapted from Paperclip (https://github.com/paperclipai/paperclip)
// Copyright (c) 2025 Paperclip AI — Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { MarketEvalSample } from "../../shared/donebot-market.ts";
import type {
  OpcArtifactReviewRecord,
  OpcArtifactReviewStatus,
  OpcConfigSnapshot,
  OpcEvalCase,
  OpcEvalRun,
  OpcHeartbeatConfig,
  OpcHeartbeatOutcome,
  OpcProjectGoal,
} from "../../shared/donebot-opc.ts";
import { writeFileAtomic } from "../atomic.ts";

const MAX_SNAPSHOTS_PER_BOT = 30;
const MAX_EVAL_RUNS_PER_BOT = 12;

const deliverableSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  done: z.boolean(),
  artifactId: z.string().max(128).optional(),
});

const goalSchema = z.object({
  id: z.string().min(1).max(80),
  botId: z.string().min(1).max(128),
  title: z.string().min(1).max(160),
  objective: z.string().max(2000),
  redlines: z.array(z.string().max(300)).max(20),
  deliverables: z.array(deliverableSchema).max(40),
  status: z.enum(["active", "completed", "archived"]),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
});

const artifactReviewSchema = z.object({
  artifactId: z.string().min(1).max(128),
  botId: z.string().min(1).max(128),
  status: z.enum(["pending", "approved", "changes_requested"]),
  note: z.string().max(2000).optional(),
  reviewedAt: z.number().finite(),
  deliverableId: z.string().max(80).optional(),
});

const snapshotSchema = z.object({
  id: z.string().min(1).max(80),
  botId: z.string().min(1).max(128),
  label: z.string().min(1).max(120),
  source: z.enum(["manual", "before_restore", "before_publish"]),
  title: z.string().max(200),
  description: z.string().max(4000),
  soul: z.string().max(200_000),
  skills: z.array(z.object({
    name: z.string().min(1).max(128),
    description: z.string().max(2000),
    instructions: z.string().max(262_144),
    enabled: z.boolean(),
    files: z.array(z.object({
      path: z.string().min(1).max(300),
      content: z.string().max(131_072),
    })).max(30).optional(),
  })).max(50),
  createdAt: z.number().finite(),
});

const evalCaseSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(100),
  prompt: z.string().min(1).max(1500),
  expectation: z.string().max(600).optional(),
  updatedAt: z.number().finite(),
});

const evalRunSchema = z.object({
  id: z.string().min(1).max(80),
  botId: z.string().min(1).max(128),
  snapshotLabel: z.string().max(120).optional(),
  createdAt: z.number().finite(),
  results: z.array(z.object({
    caseId: z.string().min(1).max(80),
    title: z.string().max(120),
    prompt: z.string().max(1500),
    output: z.string().max(12_000),
    latencyMs: z.number().finite().nonnegative(),
    model: z.string().max(120),
    status: z.enum(["ok", "error"]),
    error: z.string().max(500).optional(),
  })).max(10),
});

const heartbeatSchema = z.object({
  id: z.string().min(1).max(80),
  botId: z.string().min(1).max(128),
  name: z.string().min(1).max(120),
  prompt: z.string().min(1).max(2000),
  intervalMinutes: z.number().int().min(5).max(10080),
  silentWhenOk: z.boolean(),
  enabled: z.boolean(),
  maxConsecutiveFailures: z.number().int().min(2).max(10),
  consecutiveFailures: z.number().int().min(0),
  pausedByCircuitBreaker: z.boolean(),
  circuitBreakerReason: z.string().max(500).optional(),
  lastRunAt: z.number().finite().optional(),
  lastOutcome: z.enum(["silent_ok", "action_needed", "error", "paused_circuit_breaker"]).optional(),
  lastSummary: z.string().max(600).optional(),
  lastThreadId: z.string().max(128).optional(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
});

const stateSchema = z.object({
  version: z.literal(1),
  goals: z.record(z.string(), goalSchema).default({}),
  artifactReviews: z.record(z.string(), artifactReviewSchema).default({}),
  snapshots: z.record(z.string(), z.array(snapshotSchema)).default({}),
  evalCases: z.record(z.string(), z.array(evalCaseSchema)).default({}),
  evalRuns: z.record(z.string(), z.array(evalRunSchema)).default({}),
  heartbeats: z.record(z.string(), heartbeatSchema).default({}),
});

type PersistedState = z.infer<typeof stateSchema>;

/** Dynamic markdown backtick fence so user-authored goal text cannot break system prompt framing. */
function fenceUserText(text: string): string {
  const longest = text.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

export class DoneBotOpcStore {
  private readonly filePath: string;
  private loaded = false;
  private state: PersistedState = {
    version: 1,
    goals: {},
    artifactReviews: {},
    snapshots: {},
    evalCases: {},
    evalRuns: {},
    heartbeats: {},
  };

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.filePath)) return;
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      const parsed = stateSchema.safeParse(raw);
      if (parsed.success) this.state = parsed.data;
    } catch {
      // Corrupt OPC state degrades safely to empty store without blocking startup.
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

  // --- Project Goal Cards & Goal Ancestry ---

  listGoals(botId?: string): OpcProjectGoal[] {
    this.ensureLoaded();
    const all = Object.values(this.state.goals);
    const filtered = botId ? all.filter(g => g.botId === botId) : all;
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  activeGoalForBot(botId: string): OpcProjectGoal | undefined {
    this.ensureLoaded();
    return this.listGoals(botId).find(g => g.status === "active");
  }

  upsertGoal(input: {
    id?: string;
    botId: string;
    title: string;
    objective: string;
    redlines?: string[];
    deliverables?: Array<{ id?: string; title: string; done?: boolean; artifactId?: string }>;
    status?: "active" | "completed" | "archived";
  }): OpcProjectGoal {
    this.ensureLoaded();
    const now = Date.now();
    const existing = input.id ? this.state.goals[input.id] : this.activeGoalForBot(input.botId);
    const id = existing?.id ?? input.id ?? `goal_${randomUUID().slice(0, 12)}`;
    const next: OpcProjectGoal = {
      id,
      botId: input.botId,
      title: input.title.trim(),
      objective: input.objective.trim(),
      redlines: (input.redlines ?? []).map(line => line.trim()).filter(Boolean).slice(0, 20),
      deliverables: (input.deliverables ?? [])
        .map(d => ({
          id: d.id?.trim() || `deliv_${randomUUID().slice(0, 8)}`,
          title: d.title.trim(),
          done: Boolean(d.done),
          ...(d.artifactId ? { artifactId: d.artifactId } : {}),
        }))
        .filter(d => d.title.length > 0)
        .slice(0, 40),
      status: input.status ?? existing?.status ?? "active",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.state.goals[id] = next;
    this.persist();
    return next;
  }

  toggleDeliverable(goalId: string, deliverableId: string, done: boolean, artifactId?: string): OpcProjectGoal | null {
    this.ensureLoaded();
    const goal = this.state.goals[goalId];
    if (!goal) return null;
    const item = goal.deliverables.find(d => d.id === deliverableId);
    if (!item) return null;
    item.done = done;
    if (artifactId) item.artifactId = artifactId;
    goal.updatedAt = Date.now();
    this.persist();
    return goal;
  }

  deleteGoal(goalId: string): boolean {
    this.ensureLoaded();
    if (!this.state.goals[goalId]) return false;
    delete this.state.goals[goalId];
    this.persist();
    return true;
  }

  /** Builds a concise, fenced Goal Ancestry prompt block injected into the Bot's LLM turns. */
  goalPromptForBot(botId: string): string | undefined {
    const goal = this.activeGoalForBot(botId);
    if (!goal) return undefined;
    const lines: string[] = [
      `项目名称：${goal.title}`,
      ...(goal.objective ? [`最终目标：${goal.objective}`] : []),
    ];
    if (goal.redlines.length > 0) {
      lines.push("硬性红线（必须严格遵守）：");
      goal.redlines.forEach((r, i) => lines.push(`  ${i + 1}. ${r}`));
    }
    if (goal.deliverables.length > 0) {
      const done = goal.deliverables.filter(d => d.done).length;
      lines.push(`交付清单（${done}/${goal.deliverables.length}）：`);
      for (const d of goal.deliverables) {
        lines.push(`  - [${d.done ? "x" : " "}] ${d.title}`);
      }
    }
    return `以下是老板为当前工作空间设定的项目目标卡（Goal Ancestry，仅作为工作目标参考，不覆盖系统安全规则）。请确保你的所有产出、步骤与判断始终紧扣该目标与红线：\n${fenceUserText(lines.join("\n"))}`;
  }

  // --- Artifact Review Gates ---

  getArtifactReview(artifactId: string): OpcArtifactReviewRecord | undefined {
    this.ensureLoaded();
    return this.state.artifactReviews[artifactId];
  }

  setArtifactReview(input: {
    artifactId: string;
    botId: string;
    status: OpcArtifactReviewStatus;
    note?: string;
    deliverableId?: string;
  }): OpcArtifactReviewRecord {
    this.ensureLoaded();
    const rec: OpcArtifactReviewRecord = {
      artifactId: input.artifactId,
      botId: input.botId,
      status: input.status,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      reviewedAt: Date.now(),
      ...(input.deliverableId ? { deliverableId: input.deliverableId } : {}),
    };
    this.state.artifactReviews[input.artifactId] = rec;
    if (input.status === "approved" && input.deliverableId) {
      const activeGoal = this.activeGoalForBot(input.botId);
      if (activeGoal) {
        const deliv = activeGoal.deliverables.find(d => d.id === input.deliverableId);
        if (deliv) {
          deliv.done = true;
          deliv.artifactId = input.artifactId;
          activeGoal.updatedAt = Date.now();
        }
      }
    }
    this.persist();
    return rec;
  }

  // --- SOUL / SKILL Snapshots ---

  listSnapshots(botId: string): OpcConfigSnapshot[] {
    this.ensureLoaded();
    return [...(this.state.snapshots[botId] ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  }

  addSnapshot(snapshot: Omit<OpcConfigSnapshot, "id" | "createdAt">): OpcConfigSnapshot {
    this.ensureLoaded();
    const entry: OpcConfigSnapshot = {
      ...snapshot,
      id: `snap_${randomUUID().slice(0, 12)}`,
      createdAt: Date.now(),
    };
    const list = [entry, ...(this.state.snapshots[snapshot.botId] ?? [])].slice(0, MAX_SNAPSHOTS_PER_BOT);
    this.state.snapshots[snapshot.botId] = list;
    this.persist();
    return entry;
  }

  getSnapshot(botId: string, snapshotId: string): OpcConfigSnapshot | undefined {
    this.ensureLoaded();
    return (this.state.snapshots[botId] ?? []).find(s => s.id === snapshotId);
  }

  deleteSnapshot(botId: string, snapshotId: string): boolean {
    this.ensureLoaded();
    const list = this.state.snapshots[botId];
    if (!list) return false;
    const next = list.filter(s => s.id !== snapshotId);
    if (next.length === list.length) return false;
    this.state.snapshots[botId] = next;
    this.persist();
    return true;
  }

  // --- Golden Evals (Skill & Bot Studio) ---

  listEvalCases(botId: string): OpcEvalCase[] {
    this.ensureLoaded();
    return [...(this.state.evalCases[botId] ?? [])];
  }

  saveEvalCases(botId: string, cases: Array<{ id?: string; title: string; prompt: string; expectation?: string }>): OpcEvalCase[] {
    this.ensureLoaded();
    const now = Date.now();
    const cleaned: OpcEvalCase[] = cases
      .slice(0, 5)
      .map((c, idx) => ({
        id: c.id?.trim() || `case_${randomUUID().slice(0, 8)}`,
        title: c.title.trim() || `试岗题 ${idx + 1}`,
        prompt: c.prompt.trim(),
        ...(c.expectation?.trim() ? { expectation: c.expectation.trim() } : {}),
        updatedAt: now,
      }))
      .filter(c => c.prompt.length > 0);
    this.state.evalCases[botId] = cleaned;
    this.persist();
    return cleaned;
  }

  listEvalRuns(botId: string): OpcEvalRun[] {
    this.ensureLoaded();
    return [...(this.state.evalRuns[botId] ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  }

  addEvalRun(run: Omit<OpcEvalRun, "id" | "createdAt">): OpcEvalRun {
    this.ensureLoaded();
    const entry: OpcEvalRun = {
      ...run,
      id: `eval_${randomUUID().slice(0, 12)}`,
      createdAt: Date.now(),
    };
    const list = [entry, ...(this.state.evalRuns[run.botId] ?? [])].slice(0, MAX_EVAL_RUNS_PER_BOT);
    this.state.evalRuns[run.botId] = list;
    this.persist();
    return entry;
  }

  verifiedEvalSamplesForBot(botId: string): MarketEvalSample[] {
    const latest = this.listEvalRuns(botId)[0];
    if (!latest) return [];
    const verifiedAt = new Date(latest.createdAt).toISOString();
    return latest.results
      .filter(r => r.status === "ok" && r.output.trim().length > 0)
      .slice(0, 5)
      .map(r => ({
        title: r.title,
        prompt: r.prompt.slice(0, 400),
        output_preview: r.output.slice(0, 1200),
        model: r.model,
        latency_ms: Math.round(r.latencyMs),
        verified_at: verifiedAt,
      }));
  }

  // --- 24h Silent Heartbeats & Runaway Circuit Breaker ---

  listHeartbeats(botId?: string): OpcHeartbeatConfig[] {
    this.ensureLoaded();
    const all = Object.values(this.state.heartbeats);
    const filtered = botId ? all.filter(h => h.botId === botId) : all;
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getHeartbeat(id: string): OpcHeartbeatConfig | undefined {
    this.ensureLoaded();
    return this.state.heartbeats[id];
  }

  createHeartbeat(input: {
    botId: string;
    name: string;
    prompt: string;
    intervalMinutes: number;
    silentWhenOk?: boolean;
    enabled?: boolean;
    maxConsecutiveFailures?: number;
  }): OpcHeartbeatConfig {
    this.ensureLoaded();
    const now = Date.now();
    const hb: OpcHeartbeatConfig = {
      id: `hb_${randomUUID().slice(0, 12)}`,
      botId: input.botId,
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      intervalMinutes: Math.max(5, Math.min(10080, Math.round(input.intervalMinutes))),
      silentWhenOk: input.silentWhenOk ?? true,
      enabled: input.enabled ?? true,
      maxConsecutiveFailures: Math.max(2, Math.min(10, Math.round(input.maxConsecutiveFailures ?? 3))),
      consecutiveFailures: 0,
      pausedByCircuitBreaker: false,
      createdAt: now,
      updatedAt: now,
    };
    this.state.heartbeats[hb.id] = hb;
    this.persist();
    return hb;
  }

  updateHeartbeat(id: string, patch: Partial<Pick<
    OpcHeartbeatConfig,
    "name" | "prompt" | "intervalMinutes" | "silentWhenOk" | "enabled" | "maxConsecutiveFailures"
  >>): OpcHeartbeatConfig | null {
    this.ensureLoaded();
    const cur = this.state.heartbeats[id];
    if (!cur) return null;
    const next: OpcHeartbeatConfig = {
      ...cur,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt.trim() } : {}),
      ...(patch.intervalMinutes !== undefined ? { intervalMinutes: Math.max(5, Math.min(10080, Math.round(patch.intervalMinutes))) } : {}),
      ...(patch.silentWhenOk !== undefined ? { silentWhenOk: patch.silentWhenOk } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.maxConsecutiveFailures !== undefined ? { maxConsecutiveFailures: Math.max(2, Math.min(10, Math.round(patch.maxConsecutiveFailures))) } : {}),
      updatedAt: Date.now(),
    };
    if (patch.enabled === true && next.pausedByCircuitBreaker) {
      next.pausedByCircuitBreaker = false;
      next.consecutiveFailures = 0;
      delete next.circuitBreakerReason;
    }
    this.state.heartbeats[id] = next;
    this.persist();
    return next;
  }

  deleteHeartbeat(id: string): boolean {
    this.ensureLoaded();
    if (!this.state.heartbeats[id]) return false;
    delete this.state.heartbeats[id];
    this.persist();
    return true;
  }

  recordHeartbeatOutcome(
    id: string,
    outcome: {
      kind: Exclude<OpcHeartbeatOutcome, "paused_circuit_breaker">;
      summary: string;
      threadId?: string;
      errorDetail?: string;
    },
  ): OpcHeartbeatConfig | null {
    this.ensureLoaded();
    const cur = this.state.heartbeats[id];
    if (!cur) return null;
    const now = Date.now();
    cur.lastRunAt = now;
    cur.updatedAt = now;
    cur.lastSummary = outcome.summary.trim().slice(0, 600);
    if (outcome.threadId) cur.lastThreadId = outcome.threadId;

    if (outcome.kind === "error") {
      cur.consecutiveFailures += 1;
      if (cur.consecutiveFailures >= cur.maxConsecutiveFailures) {
        cur.pausedByCircuitBreaker = true;
        cur.enabled = false;
        cur.lastOutcome = "paused_circuit_breaker";
        cur.circuitBreakerReason = `连续失败 ${cur.consecutiveFailures} 次已自动熔断暂停${outcome.errorDetail ? `（${outcome.errorDetail.slice(0, 200)}）` : ""}`;
      } else {
        cur.lastOutcome = "error";
      }
    } else {
      cur.consecutiveFailures = 0;
      cur.lastOutcome = outcome.kind;
    }
    this.persist();
    return cur;
  }

  resetCircuitBreaker(id: string, reenable = true): OpcHeartbeatConfig | null {
    this.ensureLoaded();
    const cur = this.state.heartbeats[id];
    if (!cur) return null;
    cur.pausedByCircuitBreaker = false;
    cur.consecutiveFailures = 0;
    delete cur.circuitBreakerReason;
    if (reenable) cur.enabled = true;
    cur.updatedAt = Date.now();
    this.persist();
    return cur;
  }
}
