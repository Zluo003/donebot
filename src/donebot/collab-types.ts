import type {
  CollabAccess,
  DoneBotChatSummary,
  DoneBotCollabActivity,
  DoneBotCollabBotsSnapshot,
  DoneBotCollabChatBot,
  DoneBotCollabFoldersSnapshot,
  DoneBotCollabGroup,
  DoneBotCollabSource,
  DoneBotFriendsSnapshot,
  DoneBotIncomingTeamInvitation,
  DoneBotLocalSharedFolder,
  DoneBotTeamChannel,
  DoneBotTeamMemberProfile,
  DoneBotTeamTaskCounts,
  DoneBotTeamTaskPriority,
  DoneBotTeamTaskStatus,
} from "../../shared/donebot-collab";
import type { DoneBotTeamIdentity, DoneBotTeamMember, DoneBotTeamRole } from "../../shared/donebot-teams";

export interface LocalBotSummary {
  id: string;
  name: string;
  title: string;
  description: string;
  color?: string;
  avatar_url?: string;
  avatar_crop?: string;
  avatar_zoom?: number;
  avatar_focus_x?: number;
  avatar_focus_y?: number;
  mascot_body?: string;
  mascot_face_color?: string;
  mascot_expression?: string;
  has_soul: boolean;
  skill_count: number;
}

export interface CollabOverview {
  identity: {
    account_id: string;
    installation_id: string;
    device_name: string;
    email: string;
    nickname?: string;
    avatar_url?: string;
  };
  friends: DoneBotFriendsSnapshot;
  folders: DoneBotCollabFoldersSnapshot;
  bots: DoneBotCollabBotsSnapshot;
  teams: DoneBotTeamIdentity[];
  groups?: DoneBotCollabGroup[];
  chat_bots?: Record<string, DoneBotCollabChatBot[]>;
  team_capabilities: string[];
  team_members: Record<string, DoneBotTeamMember[]>;
  team_channels?: Record<string, DoneBotTeamChannel[]>;
  team_member_profiles?: Record<string, DoneBotTeamMemberProfile[]>;
  team_task_counts?: DoneBotTeamTaskCounts[];
  incoming_team_invitations: DoneBotIncomingTeamInvitation[];
  chat_summaries?: DoneBotChatSummary[];
  local_bots: LocalBotSummary[];
}

export interface GrantCandidate {
  subject_type: "user" | "team";
  subject_id: string;
  label: string;
  hint: string;
  avatarUrl?: string;
  email?: string;
}

export type LocalCollabFolder = DoneBotLocalSharedFolder;
export type LocalCollabActivity = DoneBotCollabActivity;

export const COLLAB_BUTTON = "ui-button inline-flex items-center justify-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50";
export const COLLAB_CARD = "rounded-2xl bg-card/85 ring-1 ring-inset ring-ink/[0.07]";
export const COLLAB_HERO = "rounded-2xl bg-gradient-to-br from-raised/90 via-card/90 to-card/60 ring-1 ring-inset ring-ink/[0.08]";
export const COLLAB_INPUT = "w-full rounded-xl bg-inset/90 px-3.5 py-2 text-[13px] text-ink ring-1 ring-inset ring-ink/[0.09] placeholder:text-ink-tertiary transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50";

export const TEAM_ROLES: Record<DoneBotTeamRole, string> = { owner: "所有者", admin: "管理员", member: "成员" };

export const TEAM_ROLE_PILL: Record<DoneBotTeamRole, string> = {
  owner: "bg-accent/14 text-accent-text ring-accent/25",
  admin: "bg-ink/[0.08] text-ink ring-ink/15",
  member: "bg-ink/[0.05] text-ink-secondary ring-ink/10",
};

export const TASK_STATUS_LABEL: Record<DoneBotTeamTaskStatus, string> = {
  todo: "待开始",
  in_progress: "进行中",
  in_review: "待验收",
  bot_reviewing: "助手二审中",
  bot_revising: "Bot 自动返工",
  ready_for_review: "待终审确认",
  changes_requested: "待修改",
  blocked: "已阻塞",
  done: "已完成",
};

export const TASK_STATUS_PILL: Record<DoneBotTeamTaskStatus, string> = {
  todo: "bg-ink/[0.06] text-ink-secondary ring-ink/12",
  in_progress: "bg-accent/14 text-accent-text ring-accent/25",
  in_review: "bg-amber-500/14 text-amber-500 ring-amber-500/25",
  bot_reviewing: "bg-sky-500/14 text-sky-500 ring-sky-500/25",
  bot_revising: "bg-purple-500/14 text-purple-400 ring-purple-500/25",
  ready_for_review: "bg-amber-500/18 text-amber-500 ring-amber-500/35",
  changes_requested: "bg-orange-500/15 text-orange-500 ring-orange-500/30",
  blocked: "bg-danger/12 text-danger ring-danger/25",
  done: "bg-success/14 text-success ring-success/25",
};

export const TASK_STATUS_DOT: Record<DoneBotTeamTaskStatus, string> = {
  todo: "bg-ink-tertiary",
  in_progress: "bg-accent",
  in_review: "bg-amber-500",
  bot_reviewing: "bg-sky-500",
  bot_revising: "bg-purple-400",
  ready_for_review: "bg-amber-500",
  changes_requested: "bg-orange-500",
  blocked: "bg-danger",
  done: "bg-success",
};

export const TASK_PRIORITY_LABEL: Record<DoneBotTeamTaskPriority, string> = {
  low: "低",
  normal: "普通",
  high: "高",
  urgent: "紧急",
};

export const TASK_PRIORITY_DOT: Record<DoneBotTeamTaskPriority, string> = {
  low: "bg-ink-tertiary",
  normal: "bg-accent",
  high: "bg-amber-500",
  urgent: "bg-danger",
};

export function teamJobTitleMap(overview: CollabOverview | null | undefined, teamId: string): Record<number, string> {
  const map: Record<number, string> = {};
  for (const profile of overview?.team_member_profiles?.[teamId] ?? []) {
    if (profile.job_title?.trim()) map[profile.user_id] = profile.job_title.trim();
  }
  return map;
}

export function formatShortDueDate(iso?: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return sameYear
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

export function isTaskOverdue(dueAt?: string | null, status?: DoneBotTeamTaskStatus): boolean {
  if (!dueAt || status === "done") return false;
  const ts = Date.parse(dueAt);
  return !Number.isNaN(ts) && ts < Date.now();
}

export function toDateInputValue(iso?: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function initialGlyph(label: string): string {
  const clean = label.trim();
  return clean ? Array.from(clean)[0]!.toUpperCase() : "D";
}

export function displayPersonName(person: {
  remark?: string | null;
  nickname?: string | null;
  email?: string | null;
}): string {
  const remark = person.remark?.trim();
  if (remark) return remark;
  const nickname = person.nickname?.trim();
  if (nickname) return nickname;
  return person.email?.trim() || "未命名用户";
}

export function personSecondaryLabel(person: {
  remark?: string | null;
  nickname?: string | null;
  email?: string | null;
}): string {
  const remark = person.remark?.trim();
  const nickname = person.nickname?.trim();
  const email = person.email?.trim() || "";
  if (remark) {
    if (nickname && nickname !== remark) return email ? `昵称 ${nickname} · ${email}` : `昵称 ${nickname}`;
    return email;
  }
  if (nickname && email && nickname !== email) return email;
  return "";
}

export function formatFileSize(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

export function formatChatTime(iso?: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return sameYear
    ? `${date.getMonth() + 1}/${date.getDate()}`
    : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

export function cleanError(error: unknown, fallback = "操作未完成，请稍后重试。"): string {
  if (error instanceof Error && error.message.trim()) {
    const cleaned = error.message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "").trim();
    if (/^(?:fetch failed|failed to fetch|load failed|networkerror\b.*)$/i.test(cleaned)) {
      return "暂时无法连接到协作服务，请检查网络或稍候几秒重试。";
    }
    return cleaned;
  }
  return fallback;
}

export function accessLabel(access: CollabAccess): string {
  return access === "write" ? "可编辑" : "只读";
}

export function sourceText(sources: readonly DoneBotCollabSource[]): string {
  if (!sources.length) return "协作共享";
  return sources.map(src => (src.kind === "friend" ? "好友" : src.team_name ? `团队 · ${src.team_name}` : "团队成员")).join(" · ");
}

export function buildGrantCandidates(overview: CollabOverview): GrantCandidate[] {
  const list: GrantCandidate[] = [];
  for (const team of overview.teams) {
    const count = overview.team_members[team.id]?.length;
    list.push({
      subject_type: "team",
      subject_id: team.id,
      label: team.name,
      hint: count ? `整个团队（${count} 人）` : "整个团队",
    });
  }
  const seenUsers = new Map<number, {
    label: string;
    email: string;
    avatarUrl?: string;
    tags: string[];
  }>();
  for (const friend of overview.friends.friends) {
    seenUsers.set(friend.user_id, {
      label: displayPersonName(friend),
      email: friend.email,
      avatarUrl: friend.avatar_url,
      tags: ["好友"],
    });
  }
  const myId = Number(overview.identity.account_id);
  for (const team of overview.teams) {
    for (const member of overview.team_members[team.id] ?? []) {
      if (member.user_id === myId) continue;
      const existing = seenUsers.get(member.user_id);
      if (existing) {
        existing.tags.push(team.name);
        if (!existing.avatarUrl && member.avatar_url) existing.avatarUrl = member.avatar_url;
      } else {
        seenUsers.set(member.user_id, {
          label: displayPersonName(member),
          email: member.email,
          avatarUrl: member.avatar_url,
          tags: [team.name],
        });
      }
    }
  }
  for (const [uid, info] of [...seenUsers.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label))) {
    const hintParts = info.label !== info.email ? [info.email, ...info.tags] : info.tags;
    list.push({
      subject_type: "user",
      subject_id: String(uid),
      label: info.label,
      hint: hintParts.join(" · "),
      avatarUrl: info.avatarUrl,
      email: info.email,
    });
  }
  return list;
}
