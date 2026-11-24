import { z } from "zod";
import type {
  OpcArtifactItem,
  OpcBossOverview,
  OpcEvalRunResult,
  OpcHeartbeatConfig,
  OpcSpendResponse,
} from "../../shared/donebot-opc.ts";
import { admitSkillFiles } from "../../shared/skill-files.ts";
import { collectBotArtifacts, type ArtifactThread } from "../bot-artifacts.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import type { StoredSkillFiles } from "../skill-side-files.ts";
import type { SkillListing } from "../skills.ts";
import type { BotRecord, Store } from "../store.ts";
import { DoneBotGatewayError, type DoneBotGateway } from "./gateway.ts";
import { createDoneBotMarketClient } from "./market-gateway.ts";
import { DoneBotOpcStore } from "./opc-store.ts";
import type { DoneBotOrgWorkflowStore } from "./opc-org-workflow.ts";
import { runPaperclipEvalMatrix } from "./paperclip-eval-kernel.ts";
import { evaluateRewakeThrottle, type RecentRunSample } from "./paperclip-rewake-throttle.ts";

const goalUpsertSchema = z.object({
  id: z.string().trim().max(80).optional(),
  botId: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(160),
  objective: z.string().trim().max(2000).default(""),
  redlines: z.array(z.string().trim().max(300)).max(20).default([]),
  deliverables: z.array(z.object({
    id: z.string().trim().max(80).optional(),
    title: z.string().trim().min(1).max(200),
    done: z.boolean().default(false),
    artifactId: z.string().trim().max(128).optional(),
  })).max(40).default([]),
  status: z.enum(["active", "completed", "archived"]).optional(),
}).strict();

const deliverablePatchSchema = z.object({
  done: z.boolean(),
  artifactId: z.string().trim().max(128).optional(),
}).strict();

const artifactReviewSchema = z.object({
  botId: z.string().trim().min(1).max(128),
  status: z.enum(["pending", "approved", "changes_requested"]),
  note: z.string().trim().max(2000).optional(),
  deliverableId: z.string().trim().max(80).optional(),
  threadId: z.string().trim().max(128).optional(),
  artifactTitle: z.string().trim().max(200).optional(),
  dispatchRevision: z.boolean().default(true),
}).strict();

const snapshotCreateSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  source: z.enum(["manual", "before_restore", "before_publish"]).default("manual"),
}).strict();

const evalCasesSaveSchema = z.object({
  cases: z.array(z.object({
    id: z.string().trim().max(80).optional(),
    title: z.string().trim().min(1).max(100),
    prompt: z.string().trim().min(1).max(1500),
    expectation: z.string().trim().max(600).optional(),
  })).max(5),
}).strict();

const evalRunSchema = z.object({
  snapshotLabel: z.string().trim().max(120).optional(),
  caseIds: z.array(z.string().trim().min(1).max(80)).max(5).optional(),
}).strict();

const heartbeatCreateSchema = z.object({
  botId: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(4).max(2000),
  intervalMinutes: z.number().int().min(5).max(10080).default(60),
  silentWhenOk: z.boolean().default(true),
  enabled: z.boolean().default(true),
  maxConsecutiveFailures: z.number().int().min(2).max(10).default(3),
}).strict();

const heartbeatPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  prompt: z.string().trim().min(4).max(2000).optional(),
  intervalMinutes: z.number().int().min(5).max(10080).optional(),
  silentWhenOk: z.boolean().optional(),
  enabled: z.boolean().optional(),
  maxConsecutiveFailures: z.number().int().min(2).max(10).optional(),
}).strict();

const resetBreakerSchema = z.object({
  reenable: z.boolean().default(true),
}).strict();

export interface DoneBotOpcRouteDeps {
  opcStore: DoneBotOpcStore;
  orgStore?: DoneBotOrgWorkflowStore;
  gateway: DoneBotGateway;
  store: Store;
  listBotSkills(botId: string): SkillListing[];
  readBotSkill(botId: string, name: string): string | null;
  readBotSkillFiles?(botId: string, name: string): StoredSkillFiles;
  installBotSkill(botId: string, source: string, files: readonly { path: string; content: string }[]): SkillListing | { error: string };
  setBotSkillEnabled(botId: string, name: string, enabled: boolean): SkillListing | { error: string };
  removeBotSkill(botId: string, name: string): unknown;
  generateBotText(botId: string, prompt: string, signal?: AbortSignal): Promise<string | undefined>;
  startTurn(botId: string, text: string, opts?: { threadId?: string; unattended?: boolean }): unknown;
  broadcast(frame: unknown): void;
  publicBot(bot: BotRecord): unknown;
  startScheduler?: boolean;
}

function visibleBots(store: Store): BotRecord[] {
  return store.bots.filter(b => !b.hidden);
}

function threadsForBot(store: Store, bot: BotRecord): ArtifactThread[] {
  const out: ArtifactThread[] = [];
  const seen = new Set<string>();
  const add = (threadId: string | undefined, title: string, internal = false) => {
    if (!threadId || seen.has(threadId)) return;
    seen.add(threadId);
    out.push({
      threadId,
      title,
      ownerBotId: bot.id,
      internal,
      messages: store.messagesFor(threadId),
    });
  };
  for (const task of bot.tasks ?? []) {
    if (task.archivedAt !== undefined) continue;
    add(task.threadId, task.title || bot.name, Boolean(task.openedBy));
  }
  add(bot.threadId, bot.name, false);
  return out;
}

function enrichArtifacts(store: Store, opcStore: DoneBotOpcStore, targetBotId?: string): OpcArtifactItem[] {
  const bots = targetBotId
    ? visibleBots(store).filter(b => b.id === targetBotId)
    : visibleBots(store);
  const all: OpcArtifactItem[] = [];

  for (const bot of bots) {
    const raw = collectBotArtifacts(bot.id, threadsForBot(store, bot));
    // Compute chronological version numbers (v1, v2...) per base title & kind.
    const groups = new Map<string, typeof raw>();
    for (const item of raw) {
      const baseTitle = item.title.replace(/\s*·\s*\d+$/, "");
      const key = `${baseTitle}:${item.kind}`;
      const list = groups.get(key) ?? [];
      list.push(item);
      groups.set(key, list);
    }
    const versionById = new Map<string, number>();
    for (const list of groups.values()) {
      const oldestFirst = [...list].sort((a, b) => a.at - b.at);
      oldestFirst.forEach((item, idx) => versionById.set(item.id, idx + 1));
    }

    for (const item of raw) {
      const review = opcStore.getArtifactReview(item.id);
      all.push({
        ...item,
        botId: bot.id,
        botName: bot.name,
        botColor: bot.color,
        version: versionById.get(item.id) ?? 1,
        reviewStatus: review?.status ?? "pending",
        ...(review?.note ? { reviewNote: review.note } : {}),
        ...(review?.reviewedAt ? { reviewedAt: review.reviewedAt } : {}),
        ...(review?.deliverableId ? { deliverableId: review.deliverableId } : {}),
      });
    }
  }

  return all.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

function captureBotSnapshot(deps: DoneBotOpcRouteDeps, bot: BotRecord) {
  const listed = deps.listBotSkills(bot.id);
  const skills = listed.map(sk => {
    const rawFiles = deps.readBotSkillFiles?.(bot.id, sk.name);
    const admitted = Array.isArray(rawFiles) && rawFiles.length > 0 ? admitSkillFiles(rawFiles).files : [];
    return {
      name: sk.name,
      description: sk.description ?? "",
      instructions: deps.readBotSkill(bot.id, sk.name) ?? "",
      enabled: Boolean(sk.enabled),
      ...(admitted.length > 0 ? { files: admitted } : {}),
    };
  }).filter(sk => sk.instructions.length > 0);
  return {
    botId: bot.id,
    title: bot.title ?? "",
    description: bot.description ?? "",
    soul: bot.soul ?? "",
    skills,
  };
}

function buildHeartbeatInstruction(hb: OpcHeartbeatConfig, goalPrompt?: string): string {
  const silentRule = hb.silentWhenOk
    ? `重要规则：本次为后台静默巡检。如果没有发现需要老板注意的异常、高价值线索或待拍板事项，请直接以 "[SILENT_OK]" 开头并附一句 20 字以内的简报（系统将静默记账不打扰老板）。如果确实需要老板介入，请不要输出 "[SILENT_OK]"，直接给出清晰结论与建议行动。`
    : `请直接给出本次巡检的简明结论与下一步建议。`;
  return [
    `【后台定时巡检 · ${hb.name}】`,
    ...(goalPrompt ? [goalPrompt] : []),
    `巡检任务：${hb.prompt}`,
    silentRule,
  ].join("\n\n");
}

export function createDoneBotOpcRoutes(deps: DoneBotOpcRouteDeps): RouteHandler & { stopScheduler(): void } {
  const marketClient = createDoneBotMarketClient(() => deps.gateway.collabCtx());
  const runningHeartbeats = new Set<string>();
  const recentSilentRuns = new Map<string, { samples: RecentRunSample[]; progressIds: Set<string> }>();

  const loadSpend = async (days: number): Promise<OpcSpendResponse> => {
    const empty: OpcSpendResponse = {
      available: false,
      days,
      totalCost: 0,
      llmCost: 0,
      imageCost: 0,
      videoCost: 0,
      musicCost: 0,
      bots: [],
      raw: null,
    };
    try {
      const raw = await marketClient.getSpendSummary(days);
      const botMap = new Map(deps.store.bots.map(b => [b.id, b]));
      return {
        available: true,
        days: raw.days,
        totalCost: raw.total_cost,
        llmCost: raw.llm_cost,
        imageCost: raw.image_cost,
        videoCost: raw.video_cost,
        musicCost: raw.music_cost,
        bots: (raw.bots ?? []).map(row => {
          const found = botMap.get(row.bot_id);
          return {
            botId: row.bot_id,
            botName: found?.name ?? `已移除 Bot (${row.bot_id.slice(0, 6)})`,
            botColor: found?.color ?? "blue",
            totalCost: row.total_cost,
            llmCost: row.llm_cost,
            imageCost: row.image_cost,
            videoCost: row.video_cost,
            musicCost: row.music_cost,
            eventCount: row.event_count,
            lastUsedAt: row.last_used_at,
          };
        }),
        raw,
      };
    } catch {
      return empty;
    }
  };

  const executeHeartbeat = async (hbId: string, manual: boolean): Promise<{ ok: boolean; heartbeat: OpcHeartbeatConfig | null; error?: string }> => {
    const hb = deps.opcStore.getHeartbeat(hbId);
    if (!hb) return { ok: false, heartbeat: null, error: "未找到该巡检任务。" };
    if (runningHeartbeats.has(hbId)) {
      return { ok: false, heartbeat: hb, error: "该巡检任务正在执行中。" };
    }
    if (!manual && hb.pausedByCircuitBreaker) {
      return { ok: false, heartbeat: hb, error: hb.circuitBreakerReason || "已触发连续失败熔断保护。" };
    }
    const bot = deps.store.bot(hb.botId);
    if (!bot || bot.hidden) {
      const updated = deps.opcStore.recordHeartbeatOutcome(hb.id, {
        kind: "error",
        summary: "目标 Bot 不存在或已隐藏。",
        errorDetail: "bot_not_found",
      });
      return { ok: false, heartbeat: updated, error: "目标 Bot 不存在或已隐藏。" };
    }

    // Apply Paperclip's no-progress rewake throttle to automatic runs so silent loops cool down cleanly.
    if (!manual) {
      const hist = recentSilentRuns.get(hb.id);
      if (hist) {
        const decision = evaluateRewakeThrottle({
          now: new Date(),
          recentTerminalRuns: hist.samples,
          runIdsWithProgress: hist.progressIds,
          hasNewInputSinceLastRun: false,
        });
        if (decision.blocked) {
          return { ok: true, heartbeat: hb };
        }
      }
    }

    runningHeartbeats.add(hbId);
    try {
      const goalPrompt = deps.opcStore.goalPromptForBot(bot.id);
      const instruction = buildHeartbeatInstruction(hb, goalPrompt);
      const output = await deps.generateBotText(bot.id, instruction);
      const trimmed = (output ?? "").trim();
      if (!trimmed) {
        const updated = deps.opcStore.recordHeartbeatOutcome(hb.id, {
          kind: "error",
          summary: "模型未返回有效巡检内容。",
          errorDetail: "empty_response",
        });
        return { ok: false, heartbeat: updated, error: "模型未返回有效巡检内容。" };
      }

      const isSilentOk = hb.silentWhenOk && /^\[?SILENT_OK\]?/i.test(trimmed);
      const runId = `hbrun_${Date.now()}`;
      const hist = recentSilentRuns.get(hb.id) ?? { samples: [], progressIds: new Set<string>() };
      hist.samples.unshift({ id: runId, status: "succeeded", finishedAt: new Date() });
      hist.samples = hist.samples.slice(0, 8);

      if (isSilentOk) {
        const cleanSummary = trimmed.replace(/^\[?SILENT_OK\]?[\s:：-]*/i, "").trim() || "状态正常，无需介入。";
        recentSilentRuns.set(hb.id, hist);
        const updated = deps.opcStore.recordHeartbeatOutcome(hb.id, {
          kind: "silent_ok",
          summary: cleanSummary,
        });
        return { ok: true, heartbeat: updated };
      }

      hist.progressIds.add(runId);
      recentSilentRuns.set(hb.id, hist);
      // Surface actionable alert into the Bot's conversation thread.
      const noticePrompt = `【24h 巡检发现待关注事项 · ${hb.name}】\n巡检简报：\n${trimmed}\n\n请简洁整理向老板汇报，并给出可直接确认的下一步动作。`;
      try {
        await Promise.resolve(deps.startTurn(bot.id, noticePrompt, { threadId: bot.threadId, unattended: true }));
      } catch {
        // Recording the actionable summary still succeeds even if thread is busy.
      }
      const updated = deps.opcStore.recordHeartbeatOutcome(hb.id, {
        kind: "action_needed",
        summary: trimmed.slice(0, 400),
        threadId: bot.threadId,
      });
      return { ok: true, heartbeat: updated };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const updated = deps.opcStore.recordHeartbeatOutcome(hb.id, {
        kind: "error",
        summary: `巡检执行异常：${msg.slice(0, 300)}`,
        errorDetail: msg,
      });
      return { ok: false, heartbeat: updated, error: msg };
    } finally {
      runningHeartbeats.delete(hbId);
    }
  };

  let schedulerTimer: ReturnType<typeof setInterval> | null = null;
  if (deps.startScheduler !== false && process.env.NODE_ENV !== "test") {
    schedulerTimer = setInterval(() => {
      const now = Date.now();
      for (const hb of deps.opcStore.listHeartbeats()) {
        if (!hb.enabled || hb.pausedByCircuitBreaker) continue;
        const intervalMs = hb.intervalMinutes * 60_000;
        if (hb.lastRunAt && now - hb.lastRunAt < intervalMs) continue;
        void executeHeartbeat(hb.id, false);
      }
    }, 60_000);
    schedulerTimer.unref?.();
  }

  const decorateHeartbeat = (hb: OpcHeartbeatConfig): OpcHeartbeatConfig => {
    const bot = deps.store.bot(hb.botId);
    return {
      ...hb,
      botName: bot?.name ?? hb.botName ?? "未知 Bot",
      botColor: bot?.color ?? hb.botColor ?? "blue",
    };
  };

  const handler: RouteHandler = async ({ req, res, url, path: reqPath, method, auth, json, readBody }) => {
    if (!reqPath.startsWith("/api/donebot/opc/") || reqPath.startsWith("/api/donebot/opc/org") || reqPath.startsWith("/api/donebot/opc/workflow")) return PASS;
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "仅工作空间所有者可使用工作室管理功能。" });
    res.setHeader("Cache-Control", "no-store");

    try {
      // --- Boss Overview & Spend ---
      if (method === "GET" && reqPath === "/api/donebot/opc/overview") {
        const daysRaw = Number(url.searchParams.get("days") ?? "30");
        const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(365, Math.round(daysRaw)) : 30;
        const allArtifacts = enrichArtifacts(deps.store, deps.opcStore);
        const pendingArtifacts = allArtifacts.filter(a => a.reviewStatus === "pending");
        const heartbeats = deps.opcStore.listHeartbeats().map(decorateHeartbeat);
        const goals = deps.opcStore.listGoals().filter(g => g.status === "active");
        const workflows = deps.orgStore?.listWorkflows() ?? [];
        const waitingWorkflowRuns = deps.orgStore?.listWaitingWorkflowRuns() ?? [];
        const trippedWorkflowCount = workflows.filter(w => w.pausedByCircuitBreaker).length;
        const spend = await loadSpend(days);
        const overview: OpcBossOverview = {
          pendingArtifactCount: pendingArtifacts.length,
          activeHeartbeatCount: heartbeats.filter(h => h.enabled && !h.pausedByCircuitBreaker).length,
          trippedCircuitBreakerCount: heartbeats.filter(h => h.pausedByCircuitBreaker).length + trippedWorkflowCount,
          activeGoalCount: goals.length,
          activeWorkflowCount: workflows.filter(w => w.enabled && !w.pausedByCircuitBreaker).length,
          waitingWorkflowCount: waitingWorkflowRuns.length,
          orgEnforcementMode: deps.orgStore?.getOrgChart().enforcementMode ?? "free",
          spend,
          pendingArtifacts: pendingArtifacts.slice(0, 24),
          waitingWorkflowRuns: waitingWorkflowRuns.slice(0, 12),
          heartbeats,
        };
        return json(res, 200, overview);
      }

      if (method === "GET" && reqPath === "/api/donebot/opc/spend") {
        const daysRaw = Number(url.searchParams.get("days") ?? "30");
        const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(365, Math.round(daysRaw)) : 30;
        return json(res, 200, await loadSpend(days));
      }

      // --- Goals ---
      if (method === "GET" && reqPath === "/api/donebot/opc/goals") {
        const botId = url.searchParams.get("botId")?.trim() || undefined;
        return json(res, 200, { goals: deps.opcStore.listGoals(botId) });
      }

      // --- Artifacts ---
      if (method === "GET" && reqPath === "/api/donebot/opc/artifacts") {
        const botId = url.searchParams.get("botId")?.trim() || undefined;
        const statusFilter = url.searchParams.get("status")?.trim() || undefined;
        let items = enrichArtifacts(deps.store, deps.opcStore, botId);
        if (statusFilter && ["pending", "approved", "changes_requested"].includes(statusFilter)) {
          items = items.filter(i => i.reviewStatus === statusFilter);
        }
        return json(res, 200, { items });
      }

      // --- Bot Snapshots ---
      const snapListMatch = reqPath.match(/^\/api\/donebot\/opc\/bots\/([^/]+)\/snapshots$/);
      if (method === "GET" && snapListMatch) {
        const botId = decodeURIComponent(snapListMatch[1]!);
        return json(res, 200, { snapshots: deps.opcStore.listSnapshots(botId) });
      }

      // --- Bot Evals ---
      const evalGetMatch = reqPath.match(/^\/api\/donebot\/opc\/bots\/([^/]+)\/evals$/);
      if (method === "GET" && evalGetMatch) {
        const botId = decodeURIComponent(evalGetMatch[1]!);
        return json(res, 200, {
          cases: deps.opcStore.listEvalCases(botId),
          runs: deps.opcStore.listEvalRuns(botId),
          verifiedSamples: deps.opcStore.verifiedEvalSamplesForBot(botId),
        });
      }

      // --- Heartbeats ---
      if (method === "GET" && reqPath === "/api/donebot/opc/heartbeats") {
        const botId = url.searchParams.get("botId")?.trim() || undefined;
        return json(res, 200, { heartbeats: deps.opcStore.listHeartbeats(botId).map(decorateHeartbeat) });
      }

      // --- Mutations ---
      if (method === "DELETE") {
        const goalDel = reqPath.match(/^\/api\/donebot\/opc\/goals\/([^/]+)$/);
        if (goalDel) {
          const ok = deps.opcStore.deleteGoal(decodeURIComponent(goalDel[1]!));
          return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "目标卡不存在。" });
        }
        const snapDel = reqPath.match(/^\/api\/donebot\/opc\/bots\/([^/]+)\/snapshots\/([^/]+)$/);
        if (snapDel) {
          const ok = deps.opcStore.deleteSnapshot(decodeURIComponent(snapDel[1]!), decodeURIComponent(snapDel[2]!));
          return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "版本快照不存在。" });
        }
        const hbDel = reqPath.match(/^\/api\/donebot\/opc\/heartbeats\/([^/]+)$/);
        if (hbDel) {
          const ok = deps.opcStore.deleteHeartbeat(decodeURIComponent(hbDel[1]!));
          return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "巡检任务不存在。" });
        }
        return PASS;
      }

      if (method !== "POST" && method !== "PUT" && method !== "PATCH") return PASS;
      const ownedMutation = reqPath.startsWith("/api/donebot/opc/goals")
        || reqPath.startsWith("/api/donebot/opc/artifacts")
        || reqPath.startsWith("/api/donebot/opc/bots/")
        || reqPath.startsWith("/api/donebot/opc/heartbeats");
      if (!ownedMutation) return PASS;
      const body = await readBody(req, 1024 * 1024);

      if (method === "PUT" && reqPath === "/api/donebot/opc/goals") {
        const parsed = goalUpsertSchema.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "请填写有效的项目目标标题与内容。" });
        const bot = deps.store.bot(parsed.data.botId);
        if (!bot || bot.hidden) return json(res, 404, { error: "未找到对应 Bot。" });
        const goal = deps.opcStore.upsertGoal(parsed.data);
        return json(res, 200, { goal });
      }

      const delivPatch = reqPath.match(/^\/api\/donebot\/opc\/goals\/([^/]+)\/deliverables\/([^/]+)$/);
      if (method === "PATCH" && delivPatch) {
        const parsed = deliverablePatchSchema.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "参数无效。" });
        const goal = deps.opcStore.toggleDeliverable(
          decodeURIComponent(delivPatch[1]!),
          decodeURIComponent(delivPatch[2]!),
          parsed.data.done,
          parsed.data.artifactId,
        );
        if (!goal) return json(res, 404, { error: "未找到对应的交付项。" });
        return json(res, 200, { goal });
      }

      const artifactReviewMatch = reqPath.match(/^\/api\/donebot\/opc\/artifacts\/([^/]+)\/review$/);
      if (method === "POST" && artifactReviewMatch) {
        const parsed = artifactReviewSchema.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "审批参数无效。" });
        const artifactId = decodeURIComponent(artifactReviewMatch[1]!);
        const bot = deps.store.bot(parsed.data.botId);
        if (!bot || bot.hidden) return json(res, 404, { error: "未找到对应 Bot。" });

        const record = deps.opcStore.setArtifactReview({
          artifactId,
          botId: bot.id,
          status: parsed.data.status,
          note: parsed.data.note,
          deliverableId: parsed.data.deliverableId,
        });

        let dispatched = false;
        if (parsed.data.status === "changes_requested" && parsed.data.dispatchRevision) {
          const titleLabel = parsed.data.artifactTitle?.trim() || "最新交付物";
          const noteLine = parsed.data.note?.trim()
            ? `老板批注修改意见：\n${parsed.data.note.trim()}`
            : "请重新检查质量并输出优化后的新版本。";
          const revisionPrompt = `【交付物打回修改 · ${titleLabel}】\n${noteLine}\n\n请直接据此完成修改并交付新版成品。`;
          try {
            await Promise.resolve(deps.startTurn(bot.id, revisionPrompt, {
              threadId: parsed.data.threadId || bot.threadId,
            }));
            dispatched = true;
          } catch {
            // Review record is already saved even if thread is currently busy.
          }
        }
        return json(res, 200, { ok: true, review: record, dispatched });
      }

      if (method === "POST" && snapListMatch) {
        const botId = decodeURIComponent(snapListMatch[1]!);
        const bot = deps.store.bot(botId);
        if (!bot || bot.hidden) return json(res, 404, { error: "未找到对应 Bot。" });
        const parsed = snapshotCreateSchema.safeParse(body ?? {});
        if (!parsed.success) return json(res, 400, { error: "快照参数无效。" });
        const captured = captureBotSnapshot(deps, bot);
        const label = parsed.data.label || `快照 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
        const snapshot = deps.opcStore.addSnapshot({
          ...captured,
          label,
          source: parsed.data.source,
        });
        return json(res, 200, { snapshot });
      }

      const snapRestoreMatch = reqPath.match(/^\/api\/donebot\/opc\/bots\/([^/]+)\/snapshots\/([^/]+)\/restore$/);
      if (method === "POST" && snapRestoreMatch) {
        const botId = decodeURIComponent(snapRestoreMatch[1]!);
        const snapshotId = decodeURIComponent(snapRestoreMatch[2]!);
        const bot = deps.store.bot(botId);
        if (!bot || bot.hidden) return json(res, 404, { error: "未找到对应 Bot。" });
        const target = deps.opcStore.getSnapshot(botId, snapshotId);
        if (!target) return json(res, 404, { error: "未找到指定的版本快照。" });

        // Safety net (Paperclip revision pattern): preserve current state before restoring.
        const backup = deps.opcStore.addSnapshot({
          ...captureBotSnapshot(deps, bot),
          label: `回滚前自动备份（恢复至「${target.label}」）`,
          source: "before_restore",
        });

        deps.store.patchBot(bot.id, {
          soul: target.soul,
          title: target.title,
          description: target.description,
        });

        const currentSkills = new Set(deps.listBotSkills(bot.id).map(sk => sk.name));
        const targetSkillNames = new Set(target.skills.map(sk => sk.name));
        for (const existingName of currentSkills) {
          if (!targetSkillNames.has(existingName)) {
            try { deps.removeBotSkill(bot.id, existingName); } catch { /* best-effort */ }
          }
        }
        for (const sk of target.skills) {
          if (currentSkills.has(sk.name)) {
            try { deps.removeBotSkill(bot.id, sk.name); } catch { /* best-effort */ }
          }
          const installed = deps.installBotSkill(bot.id, `snapshot:${target.id}`, [
            { path: "SKILL.md", content: sk.instructions },
            ...(sk.files ?? []).map(file => ({ path: file.path, content: file.content })),
          ]);
          if (!("error" in installed)) {
            deps.setBotSkillEnabled(bot.id, installed.name, sk.enabled);
          }
        }

        const refreshed = deps.store.bot(bot.id) ?? bot;
        deps.broadcast({ kind: "bot", bot: deps.publicBot(refreshed) });
        return json(res, 200, { ok: true, bot: deps.publicBot(refreshed), backup });
      }

      const evalCasesPut = reqPath.match(/^\/api\/donebot\/opc\/bots\/([^/]+)\/evals\/cases$/);
      if (method === "PUT" && evalCasesPut) {
        const botId = decodeURIComponent(evalCasesPut[1]!);
        const bot = deps.store.bot(botId);
        if (!bot || bot.hidden) return json(res, 404, { error: "未找到对应 Bot。" });
        const parsed = evalCasesSaveSchema.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "最多保存 5 条有效试岗题目。" });
        const cases = deps.opcStore.saveEvalCases(botId, parsed.data.cases);
        return json(res, 200, { cases });
      }

      const evalRunPost = reqPath.match(/^\/api\/donebot\/opc\/bots\/([^/]+)\/evals\/run$/);
      if (method === "POST" && evalRunPost) {
        const botId = decodeURIComponent(evalRunPost[1]!);
        const bot = deps.store.bot(botId);
        if (!bot || bot.hidden) return json(res, 404, { error: "未找到对应 Bot。" });
        const parsed = evalRunSchema.safeParse(body ?? {});
        if (!parsed.success) return json(res, 400, { error: "试岗参数无效。" });

        let cases = deps.opcStore.listEvalCases(botId);
        if (parsed.data.caseIds?.length) {
          const allow = new Set(parsed.data.caseIds);
          cases = cases.filter(c => allow.has(c.id));
        }
        if (cases.length === 0) {
          return json(res, 400, { error: "请先添加至少 1 条黄金试岗题后再运行评测。" });
        }

        const modelName = bot.modelSelection?.model ?? "donebot";
        const matrix = await runPaperclipEvalMatrix({
          scenarios: cases.map(c => ({ id: c.id, input: c })),
          candidates: [{ id: bot.id, config: { model: modelName } }],
          execute: async ({ scenario }) => {
            const started = Date.now();
            try {
              const prompt = `【能力实验室 · 真题试岗】\n请严格按照你的 SOUL 角色设定与已启用技能完成以下真实任务请求，不要解释规则，直接交付成品：\n\n${scenario.input.prompt}`;
              const raw = await deps.generateBotText(bot.id, prompt);
              const output = (raw ?? "").trim();
              if (!output) {
                return { output: "", latencyMs: Date.now() - started, status: "error" as const, error: "模型未返回文本内容。" };
              }
              return { output: output.slice(0, 12_000), latencyMs: Date.now() - started, status: "ok" as const };
            } catch (err) {
              return {
                output: "",
                latencyMs: Date.now() - started,
                status: "error" as const,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          },
          score: ({ scenario, output }): OpcEvalRunResult => ({
            caseId: scenario.input.id,
            title: scenario.input.title,
            prompt: scenario.input.prompt,
            output: output.output,
            latencyMs: output.latencyMs,
            model: modelName,
            status: output.status,
            ...(output.error ? { error: output.error } : {}),
          }),
        });

        const run = deps.opcStore.addEvalRun({
          botId,
          snapshotLabel: parsed.data.snapshotLabel || `当前配置 · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`,
          results: matrix.map(item => item.score),
        });
        return json(res, 200, {
          run,
          verifiedSamples: deps.opcStore.verifiedEvalSamplesForBot(botId),
        });
      }

      if (method === "POST" && reqPath === "/api/donebot/opc/heartbeats") {
        const parsed = heartbeatCreateSchema.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "请填写有效的巡检名称、任务内容与周期。" });
        const bot = deps.store.bot(parsed.data.botId);
        if (!bot || bot.hidden) return json(res, 404, { error: "未找到对应 Bot。" });
        const heartbeat = deps.opcStore.createHeartbeat(parsed.data);
        return json(res, 200, { heartbeat: decorateHeartbeat(heartbeat) });
      }

      const hbPatchMatch = reqPath.match(/^\/api\/donebot\/opc\/heartbeats\/([^/]+)$/);
      if (method === "PATCH" && hbPatchMatch) {
        const parsed = heartbeatPatchSchema.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "巡检配置参数无效。" });
        const heartbeat = deps.opcStore.updateHeartbeat(decodeURIComponent(hbPatchMatch[1]!), parsed.data);
        if (!heartbeat) return json(res, 404, { error: "巡检任务不存在。" });
        return json(res, 200, { heartbeat: decorateHeartbeat(heartbeat) });
      }

      const hbRunMatch = reqPath.match(/^\/api\/donebot\/opc\/heartbeats\/([^/]+)\/run$/);
      if (method === "POST" && hbRunMatch) {
        const result = await executeHeartbeat(decodeURIComponent(hbRunMatch[1]!), true);
        if (!result.heartbeat) return json(res, 404, { error: result.error ?? "巡检任务不存在。" });
        return json(res, 200, {
          ok: result.ok,
          heartbeat: decorateHeartbeat(result.heartbeat),
          ...(result.error ? { error: result.error } : {}),
        });
      }

      const hbResetMatch = reqPath.match(/^\/api\/donebot\/opc\/heartbeats\/([^/]+)\/reset-breaker$/);
      if (method === "POST" && hbResetMatch) {
        const parsed = resetBreakerSchema.safeParse(body ?? {});
        const heartbeat = deps.opcStore.resetCircuitBreaker(
          decodeURIComponent(hbResetMatch[1]!),
          parsed.success ? parsed.data.reenable : true,
        );
        if (!heartbeat) return json(res, 404, { error: "巡检任务不存在。" });
        recentSilentRuns.delete(heartbeat.id);
        return json(res, 200, { heartbeat: decorateHeartbeat(heartbeat) });
      }

      return PASS;
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof DoneBotGatewayError) {
        return json(res, error.status, { error: error.message, code: error.code });
      }
      return json(res, 500, { error: error instanceof Error ? error.message : "工作室服务请求失败。" });
    }
  };

  return Object.assign(handler, {
    stopScheduler() {
      if (schedulerTimer) {
        clearInterval(schedulerTimer);
        schedulerTimer = null;
      }
    },
  });
}
