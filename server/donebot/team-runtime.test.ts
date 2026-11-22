import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DONEBOT_TEAM_LENDING, teamRuntimeConfiguration, teamRuntimePublicPath, teamRuntimeSession, teamRuntimeSessionLive, teamSharedComputersEnabled } from "./team-runtime.ts";
import { createDoneBotRuntimeHost } from "./runtime-host.ts";
import { resolveRequestAuth } from "../request-auth.ts";
import type { SessionRegistry } from "../sessions.ts";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const teamId = randomUUID(), instanceId = randomUUID(), now = Date.now();
const env = { DONEBOT_TEAM_RUNTIME: "1", DONEBOT_TEAM_ID: teamId, DONEBOT_TEAM_NAME: "Fixture", DONEBOT_TEAM_INSTANCE_ID: instanceId,
  DONEBOT_TEAM_PUBLIC_KEY: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") };
const runtime = teamRuntimeConfiguration(env)!;
function request(patch: Record<string, unknown> = {}, method = "GET", url = "/api/bots") {
  const payload = Buffer.from(JSON.stringify({ protocol: "donebot.teams.v1", team_id: teamId, instance_id: instanceId,
    user_id: "3", email: "member@example.invalid", role: "member", member_version: 2, expires: Math.floor(now / 1000) + 9,
    runtime_hash: createHash("sha256").update(`${method}\n${url}`).digest("hex"), ...patch }));
  return { method, url, headers: { "x-donebot-team-grant": `${payload.toString("base64url")}.${sign(null, payload, privateKey).toString("base64url")}` } } as unknown as IncomingMessage;
}
it("uses the actual member and never mints an owner admin session", () => {
  const req = request(), session = teamRuntimeSession(runtime, req, now)!;
  expect(session).toMatchObject({ userId: "3", email: "member@example.invalid", scopes: ["client"], teamRole: "member", membershipAuthority: "team" });
  const sessions = { renew() { throw Error("Ephemeral grants cannot renew persistent sessions"); } } as unknown as SessionRegistry;
  const options = { sessions, verifiedTeamSession: session, cookieName: "fixture", streamPath: "/api/events", url: new URL("https://fixture.invalid/api/bots") };
  expect(resolveRequestAuth(req, options).auth?.kind).toBe("session");
  expect(resolveRequestAuth({ ...req, method: "DELETE" } as IncomingMessage, { ...options, url: new URL("https://fixture.invalid/api/config") }).auth).toBeNull();
});
it("refuses foreign tenants, wrong instances, invalid roles, expired and unbounded grants", () => {
  for (const patch of [{ team_id: randomUUID() }, { instance_id: randomUUID() }, { role: "root" }, { user_id: "0" }, { member_version: 0 },
    { protocol: "future" }, { expires: Math.floor(now / 1000) - 1 }, { expires: Math.floor(now / 1000) + 60 }]) expect(teamRuntimeSession(runtime, request(patch), now)).toBeNull();
});
it("binds signatures to the exact method, path and query and rejects forged input", () => {
  const req = request({}, "GET", "/api/bots?limit=20");
  expect(teamRuntimeSession(runtime, req, now)).not.toBeNull();
  for (const changed of [{ method: "POST" }, { url: "/api/bots?limit=21" }, { url: "/api/config" },
    { headers: { "x-donebot-team-grant": "invalid.invalid" } }, { headers: { authorization: "Bearer omb_sess_guess" } }]) expect(teamRuntimeSession(runtime, { ...req, ...changed }, now)).toBeNull();
});
it("defaults off, fails closed for incomplete host configuration, and grants shells no read API", () => {
  expect(teamRuntimeConfiguration({})).toBeNull();
  expect(() => teamRuntimeConfiguration({ DONEBOT_TEAM_RUNTIME: "1" })).toThrow();
  for (const path of ["/api/bots", "/api/events", "/api/auth/pairing", "/api/attachments/file", "/api/config"]) expect(teamRuntimePublicPath("GET", path)).toBe(false);
  expect(teamRuntimePublicPath("GET", "/api/health")).toBe(true);
  expect(teamRuntimePublicPath("POST", "/api/internal/tools/call")).toBe(true);
});
it("reports authenticated team member account state without personal gateway credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "donebot-team-host-"));
  const previousCoord = process.env.DONEBOT_TEAM_COORDINATOR_FILE;
  const previousOrigin = process.env.DONEBOT_FIXTURE_ORIGIN;
  process.env.DONEBOT_TEAM_COORDINATOR_FILE = join(dir, "team-coordinator.json");
  process.env.DONEBOT_FIXTURE_ORIGIN = "http://127.0.0.1:18999";
  try {
    const host = createDoneBotRuntimeHost(dir, () => ({}) as never, import.meta.url, runtime);
    const session = teamRuntimeSession(runtime, request({}, "GET", "/api/config"), now)!;
    expect(host.state()).toEqual({ enabled: true, authenticated: true, persistent: true, modelCount: 0 });
    expect(host.state(session)).toEqual({
      enabled: true,
      authenticated: true,
      persistent: true,
      modelCount: 0,
      user: { id: "3", email: "member@example.invalid" },
    });
  } finally {
    if (previousCoord === undefined) delete process.env.DONEBOT_TEAM_COORDINATOR_FILE;
    else process.env.DONEBOT_TEAM_COORDINATOR_FILE = previousCoord;
    if (previousOrigin === undefined) delete process.env.DONEBOT_FIXTURE_ORIGIN;
    else process.env.DONEBOT_FIXTURE_ORIGIN = previousOrigin;
    rmSync(dir, { recursive: true, force: true });
  }
});
it("tracks live team member sessions by latest member_version and gates team folder sharing", () => {
  expect(teamSharedComputersEnabled(null, { DONEBOT_TEAM_EXECUTION_ENABLED: "1" })).toBe(false);
  expect(teamSharedComputersEnabled(runtime, {})).toBe(false);
  expect(teamSharedComputersEnabled(runtime, { DONEBOT_TEAM_EXECUTION_ENABLED: "1" })).toBe(true);
  expect(DONEBOT_TEAM_LENDING.sharedComputers).toBe(true);

  const v2 = teamRuntimeSession(runtime, request({ user_id: "7", member_version: 2 }), now)!;
  expect(teamRuntimeSessionLive(runtime, v2.id)).toBe(true);
  expect(teamRuntimeSessionLive(runtime, `donebot-team:${randomUUID()}:7:2`)).toBe(false);
  expect(teamRuntimeSessionLive(runtime, "not-a-team-session")).toBe(false);

  const v3 = teamRuntimeSession(runtime, request({ user_id: "7", member_version: 3 }), now)!;
  expect(teamRuntimeSessionLive(runtime, v3.id)).toBe(true);
  expect(teamRuntimeSessionLive(runtime, v2.id)).toBe(false);
});
