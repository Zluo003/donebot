import type {
  OpcArtifactItem,
  OpcBossReportAttachment,
  OpcBossReportItem,
  OpcOrgChartState,
  OpcWorkflowRun,
  OpcWorkflowStepRun,
} from "../../shared/donebot-opc.ts";
import { collectBotArtifacts, type ArtifactThread } from "../bot-artifacts.ts";
import type { BotRecord, Store } from "../store.ts";
import type { DoneBotOpcStore } from "./opc-store.ts";

const STEP_START_SLACK_MS = 3_000;
const STEP_END_SLACK_MS = 15_000;

function threadsForBot(store: Pick<Store, "messagesFor">, bot: BotRecord): ArtifactThread[] {
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

export function collectEnrichedArtifacts(
  store: Pick<Store, "bots" | "messagesFor">,
  opcStore: DoneBotOpcStore,
  targetBotId?: string,
): OpcArtifactItem[] {
  const bots = store.bots.filter(b => !b.hidden && (!targetBotId || b.id === targetBotId));
  const all: OpcArtifactItem[] = [];

  for (const bot of bots) {
    const raw = collectBotArtifacts(bot.id, threadsForBot(store, bot));
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

export function approveWorkflowStepArtifacts(
  store: Pick<Store, "bots" | "messagesFor">,
  opcStore: DoneBotOpcStore,
  run: OpcWorkflowRun,
  upToStepIndex: number,
  now = Date.now(),
): string[] {
  const allArtifacts = collectEnrichedArtifacts(store, opcStore);
  const artifactById = new Map(allArtifacts.map(a => [a.id, a]));
  const ids = collectWorkflowRunArtifactIds(run, upToStepIndex, allArtifacts, now);
  for (const id of ids) {
    const art = artifactById.get(id);
    if (!art || art.reviewStatus === "approved") continue;
    opcStore.setArtifactReview({
      artifactId: art.id,
      botId: art.botId,
      status: "approved",
    });
  }
  return ids;
}

function stripMarkdownInline(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_~>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractReportTitle(markdown: string, fallback: string): string {
  const lines = markdown.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,3}\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      const cleaned = stripMarkdownInline(heading[1]!);
      if (cleaned) return cleaned.slice(0, 80);
    }
    break;
  }
  return fallback.trim() || "正式汇报";
}

export function extractReportSummary(markdown: string, title: string): string {
  const lines = markdown
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith("```") && !/^---+$/.test(l) && !/^\|[-:\s|]+\|$/.test(l));
  const picked: string[] = [];
  for (const line of lines) {
    const cleaned = stripMarkdownInline(line);
    if (!cleaned || cleaned === title) continue;
    if (/^(?:核心结论|结论|摘要|汇报摘要|执行摘要|概要)[:：]?$/.test(cleaned)) continue;
    picked.push(cleaned);
    if (picked.join(" ").length >= 130) break;
  }
  const joined = picked.join(" ").trim();
  if (!joined) return "";
  return joined.length > 140 ? `${joined.slice(0, 139)}…` : joined;
}

function toAttachment(item: OpcArtifactItem): OpcBossReportAttachment {
  return {
    id: item.id,
    name: item.name,
    path: item.path,
    kind: item.kind,
    ...(item.mime ? { mime: item.mime } : {}),
    threadId: item.threadId,
    messageId: item.messageId,
    previewUrl: item.previewUrl,
  };
}

function matchStepArtifacts(
  step: OpcWorkflowStepRun,
  artifacts: readonly OpcArtifactItem[],
  now: number,
): OpcArtifactItem[] {
  if (!step.threadId) return [];
  const start = (step.startedAt ?? 0) - STEP_START_SLACK_MS;
  const end = (step.finishedAt ?? now) + STEP_END_SLACK_MS;
  return artifacts.filter(item => {
    if (item.threadId !== step.threadId || item.botId !== step.botId) return false;
    if (step.startedAt && (item.at < start || item.at > end)) return false;
    return true;
  });
}

export function collectWorkflowRunArtifactIds(
  run: OpcWorkflowRun,
  upToStepIndex: number,
  allArtifacts: readonly OpcArtifactItem[],
  now = Date.now(),
): string[] {
  const ids = new Set<string>();
  const upper = Math.min(upToStepIndex, run.stepResults.length - 1);
  for (let idx = 0; idx <= upper; idx++) {
    const step = run.stepResults[idx];
    if (!step) continue;
    for (const art of matchStepArtifacts(step, allArtifacts, now)) {
      ids.add(art.id);
    }
  }
  return [...ids];
}

export function buildPendingBossReports(params: {
  store: Pick<Store, "bots" | "bot" | "messagesFor">;
  allArtifacts: readonly OpcArtifactItem[];
  workflowRuns: readonly OpcWorkflowRun[];
  orgChart?: OpcOrgChartState | null;
  now?: number;
}): {
  reports: OpcBossReportItem[];
  workflowOwnedArtifactIds: Set<string>;
} {
  const now = params.now ?? Date.now();
  const botById = new Map<string, BotRecord>(params.store.bots.map(b => [b.id, b]));
  const orgNodes = params.orgChart?.nodes ?? {};
  const hasExplicitApprovalNodes = Object.values(orgNodes).some(n => Boolean(n?.requireBossApproval));

  // Track every artifact produced inside any workflow run so intermediate/gated workflow
  // files never duplicate into the standalone artifact approval queue.
  const workflowOwnedArtifactIds = new Set<string>();
  for (const run of params.workflowRuns) {
    for (const step of run.stepResults) {
      for (const art of matchStepArtifacts(step, params.allArtifacts, now)) {
        workflowOwnedArtifactIds.add(art.id);
      }
    }
  }

  const reports: OpcBossReportItem[] = [];

  // 1. Waiting workflow approval gates — one formal report item per waiting gate.
  for (const run of params.workflowRuns) {
    if (run.status !== "waiting_approval") continue;
    const stepIndex = run.currentStepIndex;
    const step = run.stepResults[stepIndex];
    if (!step) continue;
    const bot = botById.get(step.botId);
    const node = orgNodes[step.botId];
    const stepArts = matchStepArtifacts(step, params.allArtifacts, now);
    const runArtifactIds = collectWorkflowRunArtifactIds(run, stepIndex, params.allArtifacts, now);
    const body = step.output?.trim() || "（该步骤已完成，暂无补充说明正文）";
    const fallbackTitle = `${run.workflowName} · ${step.stepName}`;
    const title = extractReportTitle(body, fallbackTitle);
    const summary = extractReportSummary(body, title);
    const reportMessageId = stepArts[0]?.reportMessageId;

    reports.push({
      id: `wf:${run.id}:${stepIndex}`,
      source: "workflow",
      title,
      summary,
      body,
      botId: step.botId,
      botName: bot?.name ?? step.botName,
      botColor: bot?.color ?? "blue",
      ...(bot?.section?.trim() ? { department: bot.section.trim() } : {}),
      ...(node?.roleTitle?.trim() || bot?.title?.trim() ? { roleTitle: node?.roleTitle?.trim() || bot?.title?.trim() } : {}),
      at: step.finishedAt ?? step.startedAt ?? run.startedAt,
      threadId: step.threadId || bot?.threadId || "",
      ...(reportMessageId ? { reportMessageId } : {}),
      attachments: stepArts.map(toAttachment),
      artifactIds: runArtifactIds,
      workflow: {
        runId: run.id,
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        stepIndex,
        totalSteps: run.stepResults.length,
        stepName: step.stepName,
        isLastStep: stepIndex + 1 >= run.stepResults.length,
      },
    });
  }

  // 2. Non-workflow pending deliverables — grouped per report message (1 report = 1 approval click).
  const grouped = new Map<string, OpcArtifactItem[]>();
  for (const item of params.allArtifacts) {
    if (item.reviewStatus !== "pending") continue;
    if (workflowOwnedArtifactIds.has(item.id)) continue;
    if (hasExplicitApprovalNodes && !orgNodes[item.botId]?.requireBossApproval) continue;
    const groupKey = `${item.botId}:${item.threadId}:${item.reportMessageId}`;
    const list = grouped.get(groupKey) ?? [];
    list.push(item);
    grouped.set(groupKey, list);
  }

  for (const items of grouped.values()) {
    const primary = items[0]!;
    const bot = botById.get(primary.botId);
    const node = orgNodes[primary.botId];
    const messages = params.store.messagesFor(primary.threadId);
    const reportMsg = messages.find(m => m.id === primary.reportMessageId)
      ?? messages.find(m => m.id === primary.messageId);
    const rawBody = reportMsg?.text?.trim() ?? "";
    const fallbackTitle = primary.title || primary.threadTitle || primary.name;
    const title = rawBody ? extractReportTitle(rawBody, fallbackTitle) : fallbackTitle;
    const body = rawBody || `**交付文件**：${items.map(i => `\`${i.name}\``).join("、")}`;
    const summary = extractReportSummary(body, title) || `共 ${items.length} 份交付附件等待审阅`;
    const latestAt = Math.max(...items.map(i => i.at));

    reports.push({
      id: `msg:${primary.threadId}:${primary.reportMessageId}`,
      source: "bot_report",
      title,
      summary,
      body,
      botId: primary.botId,
      botName: primary.botName,
      botColor: primary.botColor,
      ...(bot?.section?.trim() ? { department: bot.section.trim() } : {}),
      ...(node?.roleTitle?.trim() || bot?.title?.trim() ? { roleTitle: node?.roleTitle?.trim() || bot?.title?.trim() } : {}),
      at: latestAt,
      threadId: primary.threadId,
      reportMessageId: primary.reportMessageId,
      attachments: items.map(toAttachment),
      artifactIds: items.map(i => i.id),
    });
  }

  reports.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  return { reports, workflowOwnedArtifactIds };
}
