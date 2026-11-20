import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { launchVerificationServer } from "./control-omb.ts";
import { FAKE_DONEBOT_CATALOG, startFakeDoneBotGateway } from "../server/testing/fake-donebot-gateway.ts";

const gateway = await startFakeDoneBotGateway(FAKE_DONEBOT_CATALOG, undefined, "1");
const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin);
const results: Record<string, unknown> = { personalLog: fixture.info.logPath };
try {
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { origin: fixture.info.url, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, 200, `${method} ${path}: ${await response.clone().text()}`); return response.json();
  };
  await api("POST", "/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-password" });
  assert.deepEqual((await api("GET", "/api/donebot/workspaces")).capabilities, []);
  gateway.teams.enabled = true;
  const team = await api("POST", "/api/donebot/teams", { action: "create", account_id: "1", name: "Fixture team", key: randomUUID() });
  assert.equal((await api("GET", "/api/donebot/workspaces")).workspaces[0].id, team.id);
  assert.equal((await api("GET", `/api/donebot/teams/${team.id}/members`)).length, 2);
  await api("POST", "/api/donebot/teams", { action: "remove-member", account_id: "1", team_id: team.id, user_id: 2 });
  assert.equal((await api("GET", `/api/donebot/teams/${team.id}/members`)).length, 1);
  const injected = await fetch(fixture.info.url + "/api/donebot/teams", { method: "POST", headers: { "content-type": "application/json", origin: fixture.info.url }, body: JSON.stringify({ action: "create", account_id: "1", name: "x", key: randomUUID(), payer_id: 2 }) });
  assert.equal(injected.status, 400); results.identity = "passed";

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const config = { id: team.id, name: team.name, instanceId: randomUUID(), publicKey: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64") };
  const runtime = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin, undefined, undefined, undefined, config);
  results.runtimeLog = runtime.info.logPath;
  try {
    const call = async (path: string, role = "member", method = "GET", patch = {}) => {
      const payload = Buffer.from(JSON.stringify({ protocol: "donebot.teams.v1", team_id: config.id, instance_id: config.instanceId, user_id: "3", email: "member@example.invalid", role, member_version: 1, expires: Math.floor(Date.now() / 1000) + 9,
        runtime_hash: createHash("sha256").update(`${method}\n${path}`).digest("hex"), ...patch }));
      return fetch(runtime.info.url + path, { method, headers: { "x-donebot-team-grant": `${payload.toString("base64url")}.${sign(null, payload, privateKey).toString("base64url")}` } });
    };
    for (const path of ["/api/bots", "/api/config", "/api/auth/session"]) assert.equal((await fetch(runtime.info.url + path)).status, 401);
    assert.equal((await fetch(runtime.info.url + "/api/auth/pairing", { method: "POST" })).status, 401);
    const session = await (await call("/api/auth/session")).json();
    assert.deepEqual(session.scopes, ["client"]); assert.equal(session.team.id, team.id); assert.equal(session.email, "member@example.invalid");
    assert.equal((await call("/api/bots")).status, 200);
    assert.equal((await call("/api/config", "member", "PATCH")).status, 403);
    assert.equal((await call("/api/bots", "member", "GET", { team_id: randomUUID() })).status, 401);
    assert.equal((await call("/api/donebot/account", "owner")).status, 403);
    assert.deepEqual(await (await call("/api/auth/stream-ticket", "member", "POST")).json(), { ticket: null });
    results.runtime = "passed";
  } finally { await runtime.close(); }
  writeFileSync(fixture.info.logPath + ".teams.json", JSON.stringify(results, null, 2));
  console.info(JSON.stringify(results));
} finally { await fixture.close(); await gateway.close(); }
