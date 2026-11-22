export const DONEBOT_TEAMS_PROTOCOL = "donebot.teams.v1";
export const DONEBOT_TEAM_CAPABILITIES = ["identity", "cloud_access", "local_execution", "delegation", "shared_files"] as const;
export type DoneBotTeamCapability = typeof DONEBOT_TEAM_CAPABILITIES[number];
export type DoneBotTeamRole = "owner" | "admin" | "member";

/** Team snapshots contain no owner credentials, personal balances or personal invoices. */
export interface DoneBotTeamIdentity {
  id: string;
  name: string;
  avatar_url?: string;
  role: DoneBotTeamRole;
  member_version: number;
  created_at: string;
}
export interface DoneBotTeamMember { user_id: number; email: string; nickname?: string; avatar_url?: string; remark?: string; role: DoneBotTeamRole; version: number }
export interface DoneBotTeamInvitation { id: string; email: string; role: "admin" | "member"; expires_at: string; token: string }
export interface DoneBotTeamResources { cpu_millis: number; memory_mib: number; storage_gib: number; pids: number }
export interface DoneBotTeamPlan {
  id: string;
  name: string;
  enabled: boolean;
  monthly_price: string;
  retention_days: number;
  runtime: DoneBotTeamResources;
  desktop: DoneBotTeamResources;
  shared_quota_bytes: number;
  max_file_bytes: number;
}
export interface DoneBotTeamCloudState {
  instance_id: string;
  desired: string;
  actual: string;
  generation: number;
  error: string;
  paid_until: string | null;
  subscription_state: string;
  purge_locked: boolean;
  auto_renew: boolean;
  plan_id?: string;
  plan_name?: string;
}
export interface DoneBotTeamCloudOperation { id: string; instance_id?: string; action: string; generation?: number; state: string; error: string }
export interface DoneBotTeamCloudSnapshot {
  account_id: string;
  instance: DoneBotTeamCloudState | null;
  operations: DoneBotTeamCloudOperation[];
  connection_available: boolean;
}
export type DoneBotTeamCloudAction = "start" | "stop" | "cancel" | "keep";
export interface DoneBotTeamCloudMutation {
  account_id: string;
  action: DoneBotTeamCloudAction;
  key: string;
  plan_id?: string;
}
export interface DoneBotTeamDevice {
  id: string;
  team_id?: string;
  user_id: number;
  email: string;
  role?: DoneBotTeamRole;
  installation_id?: string;
  name: string;
  enabled: boolean;
  version: number;
  member_version?: number;
  online: boolean;
  last_seen: string | null;
  revoked_at?: string | null;
}
export interface DoneBotTeamDevicesSnapshot {
  account_id: string;
  installation_id: string;
  local_device_id?: string | null;
  devices: DoneBotTeamDevice[];
}
export type DoneBotTeamDeviceCommand = { account_id: string } & (
  | { action: "set"; enabled: boolean }
  | { action: "revoke"; device_id: string }
);
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
