import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { teamRoleScopes, type CloudTeam } from "../cloud-team.ts";
import type { SessionRecord } from "../sessions.ts";
import { DONEBOT_TEAMS_PROTOCOL } from "../../shared/donebot-teams.ts";

const uuid = z.uuid();
const claim = z.object({
  protocol: z.literal(DONEBOT_TEAMS_PROTOCOL), instance_id: uuid, team_id: uuid,
  user_id: z.string().regex(/^[1-9][0-9]{0,19}$/), email: z.email().max(254),
  role: z.enum(["owner", "admin", "member"]), member_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expires: z.number().int().positive(), runtime_hash: z.string().regex(/^[a-f0-9]{64}$/),
});

/** The host pins the gateway's public key and team at container creation; no member credential changes this trust root. */
export interface DoneBotTeamRuntime {
  team: CloudTeam;
  instanceId: string;
  publicKey: KeyObject;
}
export function teamRuntimeConfiguration(env: NodeJS.ProcessEnv): DoneBotTeamRuntime | null {
  if (env.DONEBOT_TEAM_RUNTIME !== "1") return null;
  const teamId = uuid.parse(env.DONEBOT_TEAM_ID), instanceId = uuid.parse(env.DONEBOT_TEAM_INSTANCE_ID);
  const name = z.string().trim().min(1).max(100).parse(env.DONEBOT_TEAM_NAME);
  const bytes = Buffer.from(env.DONEBOT_TEAM_PUBLIC_KEY ?? "", "base64");
  if (bytes.length !== 32) throw new Error("Team runtime requires a pinned Ed25519 gateway public key");
  return { team: { id: teamId, name }, instanceId, publicKey: createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes]), type: "spki", format: "der" }) };
}

/** Each grant authenticates one method and URI for at most ten seconds; the gateway also fences open streams on revocation. */
export function teamRuntimeSession(runtime: DoneBotTeamRuntime, req: Pick<IncomingMessage, "headers" | "method" | "url">, now = Date.now()): SessionRecord | null {
  const encoded = req.headers["x-donebot-team-grant"];
  if (typeof encoded !== "string" || encoded.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const [payload, signature] = encoded.split(".");
  try {
    const bytes = Buffer.from(payload!, "base64url");
    if (!verify(null, bytes, runtime.publicKey, Buffer.from(signature!, "base64url"))) return null;
    const parsed = claim.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed.success) return null;
    const value = parsed.data, expiresAt = value.expires * 1000;
    if (value.team_id !== runtime.team.id || value.instance_id !== runtime.instanceId || expiresAt <= now || expiresAt > now + 10_000 ||
        value.runtime_hash !== createHash("sha256").update(`${req.method ?? "GET"}\n${req.url ?? "/"}`).digest("hex")) return null;
    return { id: `donebot-team:${value.team_id}:${value.user_id}:${value.member_version}`, label: value.email, scopes: teamRoleScopes(value.role),
      tokenHash: "", createdAt: now, lastSeenAt: now, expiresAt, userId: value.user_id, email: value.email,
      membershipAuthority: "team", teamRole: value.role, memberCheckedAt: now };
  } catch { return null; }
}

/** Team shells cannot read shared HTTP data using loopback trust; internal routes still require their own turn capabilities. */
export function teamRuntimePublicPath(method: string, path: string): boolean {
  return method === "GET" && path === "/api/health" || path.startsWith("/api/internal/");
}
