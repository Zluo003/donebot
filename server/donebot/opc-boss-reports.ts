import type {
  OpcArtifactItem,
  OpcBossReportAttachment,
  OpcBossReportItem,
  OpcOrgChartState,
  OpcWorkflowDefinition,
  OpcWorkflowRun,
  OpcWorkflowStepRun,
} from "../../shared/donebot-opc.ts";
import { collectBotArtifacts, type ArtifactThread } from "../bot-artifacts.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import type { DoneBotOpcStore } from "./opc-store.ts";
import { describeMediaAsset, type MediaAssetMeta } from "./thread-files.ts";

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

const GENERIC_SECTION_HEADING = /^(?:核心结论|结论|摘要|汇报摘要|执行摘要|概要|待确认事项|待确认|下一步|下一步建议|交付附件|交付附件说明|交付物|交付文件|附件|说明|备注|总结|正式汇报|汇报|summary|conclusion|deliverables?|attachments?|next steps?)$/i;
const MEDIA_BADGE_TEXT = /^(?:image|video|music|audio)\s*·\s*[A-Za-z0-9._:/-]+$/i;
const CONVERSATIONAL_CHAT_TEXT = /^(?:我发现|我感觉|我觉得|我想|我要|你还是|你没|你怎么|你刚才|能不能|可以帮|麻烦|请帮|帮我|给我|来一张|再来|再画|再做|再改|换一下|改一下|调整[，,、\s]|把(?:图片|这张|这个|面料|帽子|刚才|上面|下面|它|他|她)|刚才那|刚才的|不要|为什么|怎么还是|怎么没|好了吗|画好了吗|还没)/u;
const OPAQUE_FILENAME = /^(?:(?:image|img|photo|pic|video|vid|audio|music|track|file|output|result|render|asset|generated|gen|artifact|attachment|media|seedream|seedance|suno|gpt[-_]?image|muse|frame|clip|shot|screen|screenshot|capture|tmp|temp)[-_.\s\da-z]*|[a-f\d]{8,}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}|\d{6,})$/i;
const MAX_REPORT_TITLE_CHARS = 28;

export function isMediaBadgeText(text: string): boolean {
  return MEDIA_BADGE_TEXT.test(text.trim());
}

function trimTitleConcise(raw: string, maxChars = MAX_REPORT_TITLE_CHARS): string {
  const cleaned = stripMarkdownInline(raw)
    .replace(/^(?:正式汇报|阶段汇报|工作汇报|汇报主题|汇报|主题|标题)\s*[:：\-—·]\s*/u, "")
    .replace(/^[\s「『【《（("'\-—·:：,，、.。]+|[\s」』】》）)"'\-—·:：,，、.。!！?？;；]+$/g, "")
    .trim();
  if (!cleaned) return "";
  const chars = [...cleaned];
  if (chars.length <= maxChars) return cleaned;
  const slice = chars.slice(0, maxChars).join("");
  const cut = Math.max(
    slice.lastIndexOf("，"),
    slice.lastIndexOf("、"),
    slice.lastIndexOf("；"),
    slice.lastIndexOf("："),
    slice.lastIndexOf(","),
    slice.lastIndexOf(" "),
  );
  if (cut >= Math.floor(maxChars * 0.45)) {
    return slice.slice(0, cut).replace(/[，,、；;：:\s]+$/g, "").trim();
  }
  return `${chars.slice(0, maxChars - 1).join("").trim()}…`;
}

function distillSentenceToTitle(text: string): string {
  const withoutBlocks = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(?:file:\/\/|https?:\/\/|\/(?:Users|home|tmp|var)\/)[^\s<>]+/g, " ");
  const lines = withoutBlocks
    .split(/\r?\n/)
    .map(l => stripMarkdownInline(l))
    .filter(l => l.length > 0 && !isMediaBadgeText(l) && !GENERIC_SECTION_HEADING.test(l));
  if (!lines.length) return "";

  const firstSentence = lines[0]!.split(/[。！？!?\n]/u)[0] ?? "";
  let candidate = firstSentence
    .replace(/^(?:(?:老板|主人|老大|经理|总监|先生|女士|您好|您好|你好|哈喽|嗨|好的|好嘞|收到|明白|没问题|当然|遵命|报告|汇报一下)[，,、!！。.\s]*)+/u, "")
    .replace(/^(?:(?:我|这里|本次|这次|刚才|刚刚)?(?:已经|已)?(?:按(?:照)?(?:您的要求|要求|指示)?|为您|帮你|帮您)?(?:重新)?(?:完成|生成|绘制|画好|画完|制作|整理|输出|产出|导出|渲染|更新|修改|调整|优化|替换|去掉|去除|提交|做好|处理好)(?:了)?)\s*/u, "")
    .replace(/^(?:一[张个份幅段首篇套组]|新的|新生成的|最新(?:生成)?的|这张|这幅|这份|这套)\s*/u, "")
    .replace(/(?:[，,、；;\s]*(?:请(?:您)?(?:查收|审阅|查看|审批|确认|过目|预览|验收)|需要您审批|等待您审批|详见(?:下方|附件).*|已(?:经)?(?:完成|画好|画完|生成|做好|处理好|提交(?:到工作台)?|附上|放在下方|送至工作台).*|供您(?:参考|审阅|查看).*|如有(?:需要|问题).*|如需(?:调整|修改).*|欢迎.*))+$/u, "")
    .replace(/(?:已经|已)(?:画好|画完|生成|完成|做好|处理好|搞定|交付|输出|更新|修改|调整|优化|替换|去掉|去除)(?:了)?$/u, "")
    .trim();

  if (!candidate || candidate.length < 2) return "";
  if (CONVERSATIONAL_CHAT_TEXT.test(candidate)) return "";
  if (/^(?:好的|收到|完成|好了|搞定|请查收|已处理|已完成|已生成|已画好|暂无|无)$/u.test(candidate)) return "";
  return trimTitleConcise(candidate);
}

function distillMediaPromptTitle(meta: MediaAssetMeta | undefined): string {
  const raw = meta?.prompt?.trim() ?? "";
  if (!raw) return "";
  const cleaned = raw
    .replace(/\b(?:masterpiece|best quality|ultra[- ]?detailed|high resolution|photorealistic|hyperrealistic|8k|4k|uhd|hdr|studio lighting|cinematic lighting|octane render|unreal engine)\b/gi, " ")
    .replace(/(?:超清|高清|高画质|最高画质|极致细节|电影级光效|电影灯光|8K|4K|大师级|杰作|保持(?:原图|主体|构图|版型)不变|根据参考图(?:片)?\s*\d*)/giu, " ")
    .replace(/^(?:请|帮我|生成|绘制|画|制作|保留|将|把)\s*(?:一[张个幅段首套])?\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  // Pick the first substantive subject clause (split on sentence/comma boundaries).
  const clauses = cleaned
    .split(/[。！？!?;\n]+/u)
    .flatMap(part => part.split(/[，,]+/u))
    .map(part => part.replace(/^[\s\-—·:：]+|[\s\-—·:：]+$/g, "").trim())
    .filter(part => [...part].length >= 3);
  if (!clauses.length) return "";
  let combined = clauses[0]!;
  if ([...combined].length < 8 && clauses[1] && [...combined].length + [...clauses[1]].length + 1 <= 22) {
    combined = `${combined}·${clauses[1]}`;
  }
  const title = trimTitleConcise(combined, 24);
  if (!title || CONVERSATIONAL_CHAT_TEXT.test(title)) return "";
  return title;
}

function readableAttachmentTitle(items: readonly OpcArtifactItem[]): string {
  for (const item of items) {
    const base = item.name
      .replace(/\.[a-z\d]{1,12}$/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!base || [...base].length < 2) continue;
    if (OPAQUE_FILENAME.test(base.replace(/\s+/g, ""))) continue;
    return trimTitleConcise(base, 26);
  }
  return "";
}

function isUsableFallbackTitle(raw: string | undefined, botName?: string): boolean {
  const clean = raw?.trim() ?? "";
  if (!clean || [...clean].length < 2) return false;
  if (botName && clean === botName.trim()) return false;
  if (isMediaBadgeText(clean)) return false;
  if (CONVERSATIONAL_CHAT_TEXT.test(clean)) return false;
  if (OPAQUE_FILENAME.test(clean.replace(/\.[a-z\d]{1,12}$/i, ""))) return false;
  return true;
}

function genericDeliverableTitle(items: readonly OpcArtifactItem[], meta?: MediaAssetMeta): string {
  const kind = meta?.kind ?? items[0]?.kind;
  const label = kind === "image"
    ? "图片交付汇报"
    : kind === "video"
      ? "视频交付汇报"
      : kind === "music" || kind === "audio"
        ? "音频交付汇报"
        : items.length > 1
          ? "多文件交付汇报"
          : "文档交付汇报";
  return label;
}

export function extractReportTitle(markdown: string, fallback: string): string {
  const lines = markdown.split(/\r?\n/);
  let seenNonEmpty = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    seenNonEmpty += 1;
    if (seenNonEmpty > 6) break;

    const heading = /^#{1,3}\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      const cleaned = stripMarkdownInline(heading[1]!);
      if (cleaned && !GENERIC_SECTION_HEADING.test(cleaned)) {
        return trimTitleConcise(cleaned, 60);
      }
      continue;
    }

    if (seenNonEmpty <= 3) {
      const labelled = /^(?:正式汇报|阶段汇报|工作汇报|汇报主题|主题|标题)\s*[:：]\s*(.+)$/u.exec(stripMarkdownInline(line));
      if (labelled?.[1]) {
        const cleaned = trimTitleConcise(labelled[1], 60);
        if (cleaned && !GENERIC_SECTION_HEADING.test(cleaned)) return cleaned;
      }

      const bracketed = /^【([^】]{2,36})】$/u.exec(stripMarkdownInline(line));
      if (bracketed?.[1]) {
        const cleaned = trimTitleConcise(bracketed[1], 60);
        if (cleaned && !GENERIC_SECTION_HEADING.test(cleaned)) return cleaned;
      }

      const boldOnly = /^\*\*([^*\n]{2,40})\*\*$/.exec(line);
      if (boldOnly?.[1]) {
        const cleaned = stripMarkdownInline(boldOnly[1]);
        if (cleaned && !GENERIC_SECTION_HEADING.test(cleaned) && !/[。！？!?]$/.test(cleaned)) {
          return trimTitleConcise(cleaned, 60);
        }
      }
    }
  }

  const distilled = distillSentenceToTitle(markdown);
  if (distilled) return distilled;

  return fallback.trim() || "正式汇报";
}

function findCompanionBotReply(messages: readonly Message[], reportMsg: Message | undefined, botId: string): Message | undefined {
  if (!reportMsg) return undefined;
  const idx = messages.findIndex(m => m.id === reportMsg.id);
  if (idx < 0) return undefined;
  const isCandidate = (m: Message) =>
    m.id !== reportMsg.id
    && m.role === "bot"
    && m.kind === "text"
    && !m.peerAsk
    && !m.roomRequest
    && (!m.from?.botId || m.from.botId === botId)
    && Boolean(m.text?.trim())
    && !isMediaBadgeText(m.text!.trim());

  // 1. Prefer a substantive bot reply in the same turn.
  if (reportMsg.turnId) {
    for (let i = idx + 1; i < messages.length; i++) {
      const m = messages[i]!;
      if (m.role === "user") break;
      if (m.turnId === reportMsg.turnId && isCandidate(m)) return m;
    }
    for (let i = idx - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === "user") break;
      if (m.turnId === reportMsg.turnId && isCandidate(m)) return m;
    }
  }

  // 2. Otherwise inspect the immediate bot text right after the media message before the next user message.
  for (let i = idx + 1; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "user") break;
    if (m.at - reportMsg.at > 180_000) break;
    if (isCandidate(m)) return m;
  }
  return undefined;
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

function buildWorkflowReportItem(params: {
  run: OpcWorkflowRun;
  stepIndex: number;
  step: OpcWorkflowStepRun;
  bot?: BotRecord;
  roleTitle?: string;
  stepArts: readonly OpcArtifactItem[];
  runArtifactIds: string[];
  approvedAt?: number;
}): OpcBossReportItem {
  const { run, stepIndex, step, bot, roleTitle, stepArts, runArtifactIds, approvedAt } = params;
  const body = step.output?.trim() || "（该步骤已完成，暂无补充说明正文）";
  const fallbackTitle = `${run.workflowName} · ${step.stepName}`;
  const title = step.output?.trim() ? extractReportTitle(step.output.trim(), fallbackTitle) : fallbackTitle;
  const summary = extractReportSummary(body, title);
  const reportMessageId = stepArts[0]?.reportMessageId;

  return {
    id: `wf:${run.id}:${stepIndex}`,
    source: "workflow",
    title,
    summary,
    body,
    botId: step.botId,
    botName: bot?.name ?? step.botName,
    botColor: bot?.color ?? "blue",
    ...(bot?.section?.trim() ? { department: bot.section.trim() } : {}),
    ...(roleTitle ? { roleTitle } : {}),
    at: step.finishedAt ?? step.startedAt ?? run.startedAt,
    ...(approvedAt !== undefined ? { approvedAt } : {}),
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
  };
}

function buildBotReportItem(params: {
  items: readonly OpcArtifactItem[];
  store: Pick<Store, "messagesFor">;
  bot?: BotRecord;
  roleTitle?: string;
  approvedAt?: number;
}): OpcBossReportItem {
  const { items, store, bot, roleTitle, approvedAt } = params;
  const primary = items[0]!;
  const messages = store.messagesFor(primary.threadId);
  const reportMsg = messages.find(m => m.id === primary.reportMessageId)
    ?? messages.find(m => m.id === primary.messageId);
  const rawBody = reportMsg?.text?.trim() ?? "";
  const mediaOnly = !rawBody || isMediaBadgeText(rawBody);
  const companionMsg = mediaOnly ? findCompanionBotReply(messages, reportMsg, primary.botId) : undefined;
  const effectiveText = companionMsg?.text?.trim() || (mediaOnly ? "" : rawBody);
  const mediaMeta = items
    .map(item => describeMediaAsset(item.path) ?? describeMediaAsset(item.name))
    .find((m): m is MediaAssetMeta => Boolean(m));

  // Derive report title strictly from deliverable content (report body -> media prompt -> readable filename -> clean fallback),
  // never blindly copying raw conversational user chat text.
  let title = effectiveText ? extractReportTitle(effectiveText, "") : "";
  if (!title) title = distillMediaPromptTitle(mediaMeta);
  if (!title) title = readableAttachmentTitle(items);
  if (!title && isUsableFallbackTitle(primary.threadTitle, primary.botName)) {
    title = trimTitleConcise(primary.threadTitle);
  }
  if (!title && isUsableFallbackTitle(primary.title, primary.botName)) {
    title = trimTitleConcise(primary.title.replace(/\s*·\s*\d+$/, ""));
  }
  if (!title) title = genericDeliverableTitle(items, mediaMeta);

  const deliverableLine = `**交付文件**：${items.map(i => `\`${i.name}\``).join("、")}`;
  const body = effectiveText
    || (mediaMeta?.prompt
      ? `${mediaMeta.prompt.trim()}\n\n${deliverableLine}`
      : rawBody && !mediaOnly
        ? rawBody
        : deliverableLine);
  const summary = extractReportSummary(effectiveText || (mediaMeta?.prompt ?? ""), title)
    || (rawBody && !isMediaBadgeText(rawBody) ? extractReportSummary(rawBody, title) : "")
    || (approvedAt !== undefined ? `共 ${items.length} 份已通过附件` : `共 ${items.length} 份交付附件等待审阅`);
  const latestAt = Math.max(...items.map(i => i.at));

  return {
    id: `msg:${primary.threadId}:${primary.reportMessageId}`,
    source: "bot_report",
    title,
    summary,
    body,
    botId: primary.botId,
    botName: primary.botName,
    botColor: primary.botColor,
    ...(bot?.section?.trim() ? { department: bot.section.trim() } : {}),
    ...(roleTitle ? { roleTitle } : {}),
    at: latestAt,
    ...(approvedAt !== undefined ? { approvedAt } : {}),
    threadId: primary.threadId,
    reportMessageId: primary.reportMessageId,
    attachments: items.map(toAttachment),
    artifactIds: items.map(i => i.id),
  };
}

export function buildBossReports(params: {
  store: Pick<Store, "bots" | "bot" | "messagesFor">;
  allArtifacts: readonly OpcArtifactItem[];
  workflowRuns: readonly OpcWorkflowRun[];
  workflows?: readonly OpcWorkflowDefinition[];
  orgChart?: OpcOrgChartState | null;
  now?: number;
}): {
  pendingReports: OpcBossReportItem[];
  approvedReports: OpcBossReportItem[];
  workflowOwnedArtifactIds: Set<string>;
} {
  const now = params.now ?? Date.now();
  const botById = new Map<string, BotRecord>(params.store.bots.map(b => [b.id, b]));
  const orgNodes = params.orgChart?.nodes ?? {};
  const hasExplicitApprovalNodes = Object.values(orgNodes).some(n => Boolean(n?.requireBossApproval));
  const workflowById = new Map<string, OpcWorkflowDefinition>((params.workflows ?? []).map(w => [w.id, w]));

  const roleOf = (botId: string): string | undefined => {
    const bot = botById.get(botId);
    return orgNodes[botId]?.roleTitle?.trim() || bot?.title?.trim() || undefined;
  };

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

  const pendingReports: OpcBossReportItem[] = [];
  const approvedReports: OpcBossReportItem[] = [];

  // 1. Workflow approval gates — waiting gates go to pending, approved gates go to archive.
  for (const run of params.workflowRuns) {
    const wfDef = workflowById.get(run.workflowId);
    if (run.status === "waiting_approval") {
      const stepIndex = run.currentStepIndex;
      const step = run.stepResults[stepIndex];
      if (step) {
        pendingReports.push(buildWorkflowReportItem({
          run,
          stepIndex,
          step,
          bot: botById.get(step.botId),
          roleTitle: roleOf(step.botId),
          stepArts: matchStepArtifacts(step, params.allArtifacts, now),
          runArtifactIds: collectWorkflowRunArtifactIds(run, stepIndex, params.allArtifacts, now),
        }));
      }
    }

    run.stepResults.forEach((step, stepIndex) => {
      if (step.status !== "completed") return;
      const defStep = wfDef?.steps.find(s => s.id === step.stepId);
      const wasGated = step.approvedAt !== undefined || Boolean(defStep?.approvalGate);
      if (!wasGated) return;
      const approvedAt = step.approvedAt ?? step.finishedAt ?? step.startedAt ?? run.startedAt;
      approvedReports.push(buildWorkflowReportItem({
        run,
        stepIndex,
        step,
        bot: botById.get(step.botId),
        roleTitle: roleOf(step.botId),
        stepArts: matchStepArtifacts(step, params.allArtifacts, now),
        runArtifactIds: collectWorkflowRunArtifactIds(run, stepIndex, params.allArtifacts, now),
        approvedAt,
      }));
    });
  }

  // 2. Non-workflow deliverables — grouped per report message (1 report = 1 approval click).
  const pendingGrouped = new Map<string, OpcArtifactItem[]>();
  const approvedGrouped = new Map<string, OpcArtifactItem[]>();
  for (const item of params.allArtifacts) {
    if (workflowOwnedArtifactIds.has(item.id)) continue;
    const groupKey = `${item.botId}:${item.threadId}:${item.reportMessageId}`;
    if (item.reviewStatus === "pending") {
      if (hasExplicitApprovalNodes && !orgNodes[item.botId]?.requireBossApproval) continue;
      const list = pendingGrouped.get(groupKey) ?? [];
      list.push(item);
      pendingGrouped.set(groupKey, list);
    } else if (item.reviewStatus === "approved") {
      const list = approvedGrouped.get(groupKey) ?? [];
      list.push(item);
      approvedGrouped.set(groupKey, list);
    }
  }

  for (const items of pendingGrouped.values()) {
    const primary = items[0]!;
    pendingReports.push(buildBotReportItem({
      items,
      store: params.store,
      bot: botById.get(primary.botId),
      roleTitle: roleOf(primary.botId),
    }));
  }

  for (const [groupKey, items] of approvedGrouped.entries()) {
    // Only consider a message's report archived once no sibling artifact in the same message is still pending.
    if (pendingGrouped.has(groupKey)) continue;
    const primary = items[0]!;
    const approvedAt = Math.max(...items.map(i => i.reviewedAt ?? i.at));
    approvedReports.push(buildBotReportItem({
      items,
      store: params.store,
      bot: botById.get(primary.botId),
      roleTitle: roleOf(primary.botId),
      approvedAt,
    }));
  }

  pendingReports.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  approvedReports.sort((a, b) => (b.approvedAt ?? b.at) - (a.approvedAt ?? a.at) || a.id.localeCompare(b.id));
  return { pendingReports, approvedReports, workflowOwnedArtifactIds };
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
  const { pendingReports, workflowOwnedArtifactIds } = buildBossReports(params);
  return { reports: pendingReports, workflowOwnedArtifactIds };
}
