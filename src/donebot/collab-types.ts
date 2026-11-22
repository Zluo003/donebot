import type {
  CollabAccess,
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
  };
  friends: DoneBotFriendsSnapshot;
  folders: DoneBotCollabFoldersSnapshot;
  bots: DoneBotCollabBotsSnapshot;
  teams: DoneBotTeamIdentity[];
  team_capabilities: string[];
  team_members: Record<string, DoneBotTeamMember[]>;
  incoming_team_invitations: DoneBotIncomingTeamInvitation[];
  local_bots: LocalBotSummary[];
}

export interface GrantCandidate {
  subject_type: "user" | "team";
  subject_id: string;
  label: string;
  hint: string;
}

export type LocalCollabFolder = DoneBotLocalSharedFolder;
export type LocalCollabActivity = DoneBotCollabActivity;

export const COLLAB_BUTTON = "ui-button inline-flex items-center justify-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50";

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
  const seenUsers = new Map<number, { email: string; tags: string[] }>();
  for (const friend of overview.friends.friends) {
    seenUsers.set(friend.user_id, { email: friend.email, tags: ["好友"] });
  }
  const myId = Number(overview.identity.account_id);
  for (const team of overview.teams) {
    for (const member of overview.team_members[team.id] ?? []) {
      if (member.user_id === myId) continue;
      const existing = seenUsers.get(member.user_id);
      if (existing) existing.tags.push(team.name);
      else seenUsers.set(member.user_id, { email: member.email, tags: [team.name] });
    }
  }
  for (const [uid, info] of [...seenUsers.entries()].sort((a, b) => a[1].email.localeCompare(b[1].email))) {
    list.push({
      subject_type: "user",
      subject_id: String(uid),
      label: info.email,
      hint: info.tags.join(" · "),
    });
  }
  return list;
}
