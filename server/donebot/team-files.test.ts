import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createDoneBotTeamFiles, donebotTeamFileLimits } from "./team-files.ts";
import { teamRuntimeConfiguration, teamRuntimeSession } from "./team-runtime.ts";
import type { RequestAuth } from "../request-auth.ts";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const team = { DONEBOT_TEAM_RUNTIME: "1", DONEBOT_TEAM_ID: randomUUID(), DONEBOT_TEAM_NAME: "Fixture", DONEBOT_TEAM_INSTANCE_ID: randomUUID(),
  DONEBOT_TEAM_PUBLIC_KEY: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") };
const runtime = teamRuntimeConfiguration(team)!;
const limits = { DONEBOT_TEAM_FILES_ENABLED: "1", DONEBOT_TEAM_SHARED_QUOTA_BYTES: "2048", DONEBOT_TEAM_MAX_FILE_BYTES: "512" };

it("defaults off and refuses missing, invalid or excessive trusted limits", () => {
  expect(donebotTeamFileLimits(null, limits)).toBeNull(); expect(donebotTeamFileLimits(runtime, {})).toBeNull();
  expect(donebotTeamFileLimits(runtime, limits)).toEqual({ cap: 2048, uploadMax: 512 });
  for (const patch of [{ DONEBOT_TEAM_MAX_FILE_BYTES: "2049" }, { DONEBOT_TEAM_SHARED_QUOTA_BYTES: "0" }, { DONEBOT_TEAM_MAX_FILE_BYTES: "" },
    { DONEBOT_TEAM_SHARED_QUOTA_BYTES: "9007199254740992" }, { DONEBOT_TEAM_MAX_FILE_BYTES: "1.5" }]) expect(() => donebotTeamFileLimits(runtime, { ...limits, ...patch })).toThrow();
});

it("derives ownership and role only from a grant verified for this runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "donebot-team-files-actor-"));
  try {
    const host = createDoneBotTeamFiles(runtime, root, limits);
    const auth = (role: string) => {
      const payload = Buffer.from(JSON.stringify({ protocol: "donebot.teams.v1", team_id: team.DONEBOT_TEAM_ID, instance_id: team.DONEBOT_TEAM_INSTANCE_ID,
        user_id: "3", email: "member@example.invalid", role, member_version: 1, expires: Math.floor(Date.now() / 1000) + 9,
        runtime_hash: createHash("sha256").update("GET\n/api/team-files").digest("hex") }));
      const session = teamRuntimeSession(runtime, { method: "GET", url: "/api/team-files", headers: { "x-donebot-team-grant": `${payload.toString("base64url")}.${sign(null, payload, privateKey).toString("base64url")}` } })!;
      return { kind: "session", session, scopes: session.scopes, via: "bearer" } as RequestAuth;
    };
    const member = auth("member"), owner = auth("owner"), admin = auth("admin");
    expect(host.actor(member)).toMatchObject({ admin: false });
    expect(host.actor(owner)).toMatchObject({ admin: true }); expect(host.actor(admin)).toMatchObject({ admin: true });
    expect(host.actor({ kind: "loopback", scopes: ["admin", "client"] })).toBeNull();
    expect(host.actor({ ...member, session: { ...(member as Extract<RequestAuth, { kind: "session" }>).session, teamRole: "owner" } } as RequestAuth)).toBeNull();
    const foreign = teamRuntimeConfiguration({ ...team, DONEBOT_TEAM_ID: randomUUID() })!;
    expect(createDoneBotTeamFiles(foreign, root, limits).actor(owner)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
