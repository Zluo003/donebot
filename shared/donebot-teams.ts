export const DONEBOT_TEAMS_PROTOCOL = "donebot.teams.v1";
export const DONEBOT_TEAM_CAPABILITIES = ["identity", "cloud_access", "local_execution", "delegation", "shared_files"] as const;
export type DoneBotTeamCapability = typeof DONEBOT_TEAM_CAPABILITIES[number];
export type DoneBotTeamRole = "owner" | "admin" | "member";

/** Team snapshots contain no owner credentials, personal balances or personal invoices. */
export interface DoneBotTeamIdentity {
  id: string;
  name: string;
  role: DoneBotTeamRole;
  member_version: number;
  created_at: string;
}
export interface DoneBotTeamMember { user_id: number; email: string; role: DoneBotTeamRole; version: number }
export interface DoneBotTeamInvitation { id: string; email: string; role: "admin" | "member"; expires_at: string; token: string }
export interface DoneBotWorkspaceSnapshot {
  account_id: string;
  protocol: typeof DONEBOT_TEAMS_PROTOCOL;
  capabilities: DoneBotTeamCapability[];
  workspaces: DoneBotTeamIdentity[];
}
export type DoneBotTeamCommand = { account_id: string } & (
  | { action: "create"; name: string; key: string }
  | { action: "accept"; token: string }
  | { action: "rename"; team_id: string; name: string }
  | { action: "invite"; team_id: string; email: string; role: "admin" | "member" }
  | { action: "member-role"; team_id: string; user_id: number; role: "admin" | "member" }
  | { action: "remove-member"; team_id: string; user_id: number }
  | { action: "revoke-invitation"; team_id: string; invitation_id: string }
);

/** All participants must declare the same protocol and capability before a feature is offered. */
export function negotiatedTeamCapabilities(...participants: Array<{ protocol: string; capabilities: readonly string[] } | null | undefined>): DoneBotTeamCapability[] {
  if (!participants.length || participants.some(participant => participant?.protocol !== DONEBOT_TEAMS_PROTOCOL)) return [];
  return DONEBOT_TEAM_CAPABILITIES.filter(capability => participants.every(participant => participant!.capabilities.includes(capability)));
}
