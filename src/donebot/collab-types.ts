import type {
  CollabAccess,
  DoneBotChatSummary,
  DoneBotCollabActivity,
  DoneBotCollabBotsSnapshot,
  DoneBotCollabFoldersSnapshot,
  DoneBotCollabSource,
  DoneBotFriendsSnapshot,
  DoneBotIncomingTeamInvitation,
  DoneBotLocalSharedFolder,
} from "../../shared/donebot-collab";
import type { DoneBotTeamIdentity, DoneBotTeamMember, DoneBotTeamRole } from "../../shared/donebot-teams";

export interface LocalBotSummary {
  id: string;
  name: string;
  title: string;
  description: string;
  color?: string;
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
  team_capabilities: string[];
  team_members: Record<string, DoneBotTeamMember[]>;
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
    return error.message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "").trim();
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
