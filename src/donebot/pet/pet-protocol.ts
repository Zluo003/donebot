import type { BotBodyId } from "../../../shared/bot-body";
import type { MascotFaceColor } from "../../../shared/bot-avatar";
import type { OpcBossReportAttachment, OpcBossReportItem } from "../../../shared/donebot-opc";
import type { MausColor, MausState } from "@/lib/mascot";

export type PetVoicePhase =
  | "idle"
  | "wake-standby"
  | "waking"
  | "listening"
  | "sending"
  | "working"
  | "speaking";

export interface PetCoordinatorSnapshot {
  id: string;
  name: string;
  soul?: string;
  color: MausColor;
  mascotBody?: BotBodyId | null;
  mascotFaceColor?: MascotFaceColor | null;
  threadId: string;
  voice?: string;
  busy: boolean;
  unread: boolean;
  hasError: boolean;
  needsAttention: boolean;
}

export interface PetBubbleState {
  id: number;
  text: string;
  kind: "reply" | "report" | "status" | "error";
  reportId?: string;
}

export interface PetVoiceState {
  active: boolean;
  wakeEnabled: boolean;
  phase: PetVoicePhase;
  heard: string;
  error: string | null;
  needsMicSettings?: boolean;
}

export interface PetHostSnapshot {
  coordinator: PetCoordinatorSnapshot | null;
  petState: DesktopPetState | null;
  userTitle: string;
  wakePhrase: string;
  voice: PetVoiceState;
  speaking: boolean;
  sending: boolean;
  bubble: PetBubbleState | null;
  reports: OpcBossReportItem[];
  reportsLoading: boolean;
  ttsReady: boolean;
  speechAvailable: boolean;
  cloudAsrReady?: boolean;
  bargeInEnabled?: boolean;
}

export type PetPopoverCommand =
  | { type: "request-sync" }
  | { type: "send"; text: string }
  | { type: "stop-speaking" }
  | { type: "voice-start" }
  | { type: "voice-stop" }
  | { type: "voice-interrupt" }
  | { type: "refresh-reports" }
  | { type: "report-resolved"; reportId: string }
  | { type: "dismiss-bubble" }
  | { type: "toggle-mute" }
  | { type: "toggle-voice-mode" };

export interface PetHostToPopoverMessage {
  type: "host-sync";
  snapshot: PetHostSnapshot;
}

export interface PetBotCandidate {
  id: string;
  name: string;
  soul?: string;
  color?: string | null;
  mascotBody?: BotBodyId | null;
  mascotFaceColor?: MascotFaceColor | null;
  threadId?: string;
  voice?: string;
  busy?: boolean;
  unread?: boolean;
  hidden?: boolean;
  section?: string | null;
  chiefOfStaff?: boolean;
  defaultBot?: { person?: string | null } | null;
  messages?: Array<{
    kind?: string;
    role?: string;
    tool?: { ok?: boolean; partial?: boolean };
    card?: { answered?: unknown; dismissed?: unknown; expired?: unknown };
  }>;
}

const VALID_COLORS = new Set<string>([
  "green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral", "silver", "chrome",
]);

function safeMausColor(value: string | null | undefined): MausColor {
  return value && VALID_COLORS.has(value) ? (value as MausColor) : "green";
}

function sectionOf(bot: PetBotCandidate): string {
  return typeof bot.section === "string" ? bot.section.trim() : "";
}

/** Resolves the system chief coordinator bot (matching org sync and quick-asks conventions). */
export function resolveChiefCoordinatorBot(bots: PetBotCandidate[]): PetBotCandidate | null {
  const visible = bots.filter((bot) => !bot.hidden);
  if (!visible.length) return null;
  return (
    visible.find((bot) => bot.chiefOfStaff && !sectionOf(bot))
    ?? visible.find((bot) => bot.defaultBot && !bot.defaultBot.person?.trim())
    ?? visible.find((bot) => bot.chiefOfStaff)
    ?? visible[0]
    ?? null
  );
}

export function toCoordinatorSnapshot(bot: PetBotCandidate | null): PetCoordinatorSnapshot | null {
  if (!bot) return null;
  const messages = Array.isArray(bot.messages) ? bot.messages : [];
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const hasError = Boolean(last?.kind === "activity" && last.tool?.ok === false && !last.tool.partial);
  const needsAttention = Boolean(
    last?.kind === "options" && !(last.card?.answered || last.card?.dismissed || last.card?.expired),
  );
  return {
    id: bot.id,
    name: bot.name || "多宝",
    soul: typeof bot.soul === "string" ? bot.soul : undefined,
    color: safeMausColor(bot.color),
    mascotBody: bot.mascotBody ?? null,
    mascotFaceColor: bot.mascotFaceColor ?? null,
    threadId: bot.threadId || bot.id,
    voice: bot.voice || undefined,
    busy: bot.busy === true,
    unread: bot.unread === true,
    hasError,
    needsAttention,
  };
}

/**
 * Resolves how the bot should address the user:
 * 1) ChiefSetup preference in chief bot soul: `Address the user as "老板".`
 * 2) Chinese manual soul hints like `称呼用户为“老板”` / `称呼我为老板` / `叫我老板`
 * 3) Global profile.name from /api/config
 * 4) Fallback: "老板"
 */
export function resolveUserAddressTitle(chiefSoul?: string | null, profileName?: string | null): string {
  const soul = typeof chiefSoul === "string" ? chiefSoul : "";
  if (soul) {
    const jsonMatch = soul.match(/Address the user as ("(?:[^"\\]|\\.)*")\./);
    if (jsonMatch?.[1]) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (typeof parsed === "string" && parsed.trim()) return parsed.trim().slice(0, 20);
      } catch {}
    }
    const cnMatch = soul.match(/(?:请?称呼(?:用户|我)为|请?叫我)\s*[「“"']?([^「」“”"'\n，。,.！？!?;；]{1,16})[」”"']?/);
    if (cnMatch?.[1]?.trim()) return cnMatch[1].trim();
  }
  const fallbackName = typeof profileName === "string" ? profileName.trim() : "";
  if (fallbackName) return fallbackName.slice(0, 20);
  return "老板";
}

export function buildWakePhrase(botName?: string | null): string {
  const name = (botName ?? "").trim() || "多宝";
  return `你好${name}`;
}

export function buildWakeReplyPool(userTitle: string): { idle: readonly string[]; busy: readonly string[] } {
  const title = userTitle.trim() || "老板";
  return {
    idle: [
      `${title}，我在。`,
      `${title}，有什么吩咐。`,
      `${title}，请讲。`,
    ],
    busy: [
      `${title}，我在忙呢，你有什么事啊？`,
      `${title}，我正忙着呢，有什么事？`,
    ],
  };
}

export function pickWakeReply(userTitle: string, busy: boolean, seed = Math.random()): string {
  const pool = buildWakeReplyPool(userTitle);
  const list = busy ? pool.busy : pool.idle;
  const idx = Math.abs(Math.floor(seed * list.length)) % list.length;
  return list[idx]!;
}

/**
 * Matches fixed wake word `你好 <chiefBotName>` (tolerating `您好`, punctuation, spaces,
 * and case differences) and returns any trailing command spoken in the same breath.
 */
export function matchWakeWord(
  rawTranscript: string,
  botName: string,
): { matched: boolean; remainder: string } {
  const transcript = String(rawTranscript ?? "").trim();
  const cleanName = String(botName ?? "").trim();
  if (!transcript || !cleanName) return { matched: false, remainder: "" };

  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Allow optional punctuation/whitespace between every character of the bot name
  // (e.g. "你好，多 宝，帮我查一下" or "你好 Done Bot").
  const nameChars = Array.from(cleanName.replace(/\s+/g, ""));
  const flexName = nameChars.map((ch) => escapeRegex(ch)).join("[\\s,，、.。·-]*");
  const pattern = new RegExp(
    `(?:你|您)\\s*好[\\s,，、.。!！?？啊呀哈哟~～]*${flexName}[\\s,，、.。!！?？:：;；啊呀哈哟~～]*([\\s\\S]*)$`,
    "i",
  );

  const hit = pattern.exec(transcript);
  if (!hit) return { matched: false, remainder: "" };
  const remainder = (hit[1] ?? "").replace(/^[，,。.!！?？:：;；、\s]+/, "").trim();
  return { matched: true, remainder };
}

/** Strips markdown formatting and trims verbose replies down to concise oral briefing sentences. */
export function compactSpokenReply(raw: string, maxChars = 110): string {
  const cleaned = String(raw ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[\s(])([*_])(?=\S)(.+?)(?<=\S)\2(?=$|[\s).,;:!?，。；！？])/g, "$1$3")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";
  if (cleaned.length <= maxChars) return cleaned;

  const slice = cleaned.slice(0, maxChars);
  const sentenceEnd = Math.max(
    slice.lastIndexOf("。"),
    slice.lastIndexOf("！"),
    slice.lastIndexOf("？"),
    slice.lastIndexOf("!"),
    slice.lastIndexOf("?"),
    slice.lastIndexOf("."),
  );
  if (sentenceEnd >= Math.floor(maxChars * 0.35)) {
    return slice.slice(0, sentenceEnd + 1).trim();
  }
  const clauseEnd = Math.max(slice.lastIndexOf("，"), slice.lastIndexOf("；"), slice.lastIndexOf(","));
  if (clauseEnd >= Math.floor(maxChars * 0.5)) {
    return `${slice.slice(0, clauseEnd).trim()}。`;
  }
  return `${slice.trimEnd()}…`;
}

function cleanReportTitle(raw: string): string {
  const cleaned = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "最新汇报";
  return cleaned.length > 26 ? `${cleaned.slice(0, 25)}…` : cleaned;
}

/** Formats deterministic zero-fluff boss report announcements for TTS and brief bubbles. */
export function formatBossReportAnnouncement(
  reports: ReadonlyArray<Pick<OpcBossReportItem, "title" | "workflow">>,
  userTitle = "老板",
): string {
  if (!reports.length) return "";
  const title = userTitle.trim() || "老板";
  if (reports.length === 1) {
    const item = reports[0]!;
    if (item.workflow?.workflowName) {
      const wfName = cleanReportTitle(item.workflow.workflowName);
      const stepName = cleanReportTitle(item.workflow.stepName || "当前步骤");
      return `${title}，${wfName}的${stepName}已经完成了，需要您审批。`;
    }
    return `${title}，${cleanReportTitle(item.title)}已经完成了，需要您审批。`;
  }
  return `${title}，有 ${reports.length} 项工作已经完成了，需要您审批。`;
}

export function resolvePetMascotState(params: {
  coordinator: PetCoordinatorSnapshot | null;
  voicePhase: PetVoicePhase;
  speaking: boolean;
  sending: boolean;
  pendingReportCount: number;
}): MausState {
  const { coordinator, voicePhase, speaking, sending, pendingReportCount } = params;
  if (voicePhase === "waking") return "happy";
  if (voicePhase === "listening") return "listening";
  if (speaking || voicePhase === "speaking") return "humming";
  if (sending || voicePhase === "sending") return "sending";
  if (coordinator?.hasError) return "alerting";
  if (coordinator?.needsAttention) return "curious";
  if (coordinator?.busy || voicePhase === "working") return "working";
  if (pendingReportCount > 0) return "notifying";
  return "idle";
}

export interface PetPreviewTarget {
  attachment: OpcBossReportAttachment;
  reportTitle: string;
}
