import { z } from "zod";
import { DONEBOT_TEAMS_PROTOCOL, negotiatedTeamCapabilities, type DoneBotTeamCommand, type DoneBotWorkspaceSnapshot } from "../../shared/donebot-teams.ts";

const id = z.uuid().refine(value => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value));
const name = z.string().trim().min(1).max(100).refine(value => !/\p{Cc}/u.test(value));
const role = z.enum(["owner", "admin", "member"]);
const assignable = z.enum(["admin", "member"]);
export const teamIdentity = z.object({ id, name, role, member_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), created_at: z.iso.datetime({ offset: true }) });
export const teamMembers = z.array(z.object({ user_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), email: z.email().max(254), role, version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })).max(10_000);
export const teamInvitation = z.object({ id, email: z.email().max(254), role: assignable, expires_at: z.iso.datetime({ offset: true }), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const account_id = z.string().regex(/^[1-9][0-9]{0,19}$/);
const team_id = id;
export const teamCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), account_id, name, key: id }).strict(),
  z.object({ action: z.literal("accept"), account_id, token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  z.object({ action: z.literal("rename"), account_id, team_id, name }).strict(),
  z.object({ action: z.literal("invite"), account_id, team_id, email: z.email().max(254), role: assignable }).strict(),
  z.object({ action: z.literal("member-role"), account_id, team_id, user_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), role: assignable }).strict(),
  z.object({ action: z.literal("remove-member"), account_id, team_id, user_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ action: z.literal("revoke-invitation"), account_id, team_id, invitation_id: id }).strict(),
]);

export function teamCommandRequest(command: DoneBotTeamCommand): { method: "POST" | "PATCH" | "DELETE"; path: string; body?: unknown; key?: string } {
  const input = teamCommand.parse(command);
  switch (input.action) {
    case "create": return { method: "POST", path: "teams", body: { name: input.name }, key: input.key };
    case "accept": return { method: "POST", path: "teams/invitations/accept", body: { token: input.token } };
    case "rename": return { method: "PATCH", path: `teams/${input.team_id}`, body: { name: input.name } };
    case "invite": return { method: "POST", path: `teams/${input.team_id}/invitations`, body: { email: input.email, role: input.role } };
    case "member-role": return { method: "PATCH", path: `teams/${input.team_id}/members/${input.user_id}`, body: { role: input.role } };
    case "remove-member": return { method: "DELETE", path: `teams/${input.team_id}/members/${input.user_id}` };
    case "revoke-invitation": return { method: "DELETE", path: `teams/${input.team_id}/invitations/${input.invitation_id}` };
  }
}

export function workspaceSnapshot(value: unknown, accountId: string): DoneBotWorkspaceSnapshot {
  const snapshot = z.object({ protocol: z.literal(DONEBOT_TEAMS_PROTOCOL), capabilities: z.array(z.string()).max(50), workspaces: z.array(teamIdentity).max(1000) }).parse(value);
  const capabilities = negotiatedTeamCapabilities({ protocol: DONEBOT_TEAMS_PROTOCOL, capabilities: ["identity"] }, snapshot);
  return { account_id: accountId, protocol: DONEBOT_TEAMS_PROTOCOL, capabilities, workspaces: capabilities.includes("identity") ? snapshot.workspaces : [] };
}
