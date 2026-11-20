import { randomBytes, randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { DoneBotTeamIdentity, DoneBotTeamMember } from "../../shared/donebot-teams.ts";

export class FakeDoneBotTeams {
  enabled = false;
  readonly teams: DoneBotTeamIdentity[] = [];
  readonly members = new Map<string, DoneBotTeamMember[]>();
  handle(path: string, method: string, body: Record<string, unknown>, response: ServerResponse, login: boolean): boolean {
    if (path !== "/api/v1/donebot/workspaces" && !path.startsWith("/api/v1/donebot/teams")) return false;
    const send = (data: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify({ code: status === 200 ? 0 : status, data })); return true; };
    if (!login) return send({}, 401);
    if (path.endsWith("/workspaces")) return send({ protocol: "donebot.teams.v1", capabilities: this.enabled ? ["identity"] : [], workspaces: this.enabled ? this.teams : [] });
    if (!this.enabled) return send({}, 503);
    if (path === "/api/v1/donebot/teams" && method === "POST") {
      const team: DoneBotTeamIdentity = { id: randomUUID(), name: String(body.name), role: "owner", member_version: 1, created_at: new Date().toISOString() };
      this.teams.push(team); this.members.set(team.id, [{ user_id: 1, email: "fixture@example.invalid", role: "owner", version: 1 }, { user_id: 2, email: "member@example.invalid", role: "member", version: 1 }]);
      return send(team);
    }
    const match = /^\/api\/v1\/donebot\/teams\/([^/]+)\/(members|invitations)(?:\/([^/]+))?$/.exec(path);
    if (!match || !this.teams.some(team => team.id === match[1])) return send({}, 404);
    if (match[2] === "members" && method === "GET") return send(this.members.get(match[1]!));
    if (match[2] === "members" && method === "DELETE") {
      if (match[3] === "1") return send({}, 403);
      this.members.set(match[1]!, this.members.get(match[1]!)!.filter(member => member.user_id !== Number(match[3]))); return send({ ok: true });
    }
    if (match[2] === "invitations" && method === "POST") return send({ id: randomUUID(), email: body.email, role: body.role, expires_at: new Date(Date.now() + 86400000).toISOString(), token: randomBytes(32).toString("base64url") });
    return send({}, 404);
  }
}
