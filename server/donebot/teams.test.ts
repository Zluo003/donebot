import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { DONEBOT_TEAMS_PROTOCOL, negotiatedTeamCapabilities, type DoneBotTeamCommand } from "../../shared/donebot-teams.ts";
import { DoneBotGateway, type DoneBotCredential, type DoneBotCredentialStore } from "./gateway.ts";
import { teamCommandRequest, workspaceSnapshot } from "./teams.ts";
import { FAKE_DONEBOT_CATALOG } from "../testing/fake-donebot-gateway.ts";

const id = randomUUID(), key = randomUUID();
const team = { id, name: "Fixture Studio", role: "member", member_version: 2, created_at: "2026-11-20T01:00:00Z" };
const snapshot = { protocol: DONEBOT_TEAMS_PROTOCOL, capabilities: ["identity", "local_execution"], workspaces: [team] };
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ code: 0, data }), { status, headers: { "content-type": "application/json" } });
async function fixture(custom?: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined, installation = false) {
  const vault: DoneBotCredentialStore & { value: DoneBotCredential | null } = { persistent: false, value: installation ? { mode: "installation", accessToken: "", credential: "synthetic-key", expiresAt: Number.MAX_SAFE_INTEGER, user: { id: "1", email: "owner@example.invalid" }, installationId: key } : null,
    async load() { return this.value; }, async save(value) { this.value = value; } };
  const requests: { path: string; init?: RequestInit }[] = [];
  const gateway = new DoneBotGateway(vault, { fetch: (async (url, init) => {
    const path = new URL(String(url)).pathname; requests.push({ path, init }); const override = custom?.(path, init); if (override) return override;
    if (path.endsWith("/auth/login")) return json({ access_token: "synthetic-jwt", refresh_token: "synthetic-refresh", expires_in: 3600, user: { id: "1", email: "owner@example.invalid" } });
    if (path.endsWith("/installations/claim")) return json({ credential: "synthetic-key" });
    if (path.endsWith("/models")) return new Response(JSON.stringify(FAKE_DONEBOT_CATALOG), { headers: { "content-type": "application/json" } });
    if (path.endsWith("/workspaces")) return json(snapshot);
    return json({ ...team, owner_key: "do-not-render", personal_balance: 999 });
  }) as typeof fetch });
  if (installation) await gateway.restore(); else await gateway.login("owner@example.invalid", "synthetic-password");
  requests.length = 0; return { gateway, requests };
}

it("requires every participant to advertise the same protocol and feature", () => {
  expect(negotiatedTeamCapabilities()).toEqual([]);
  expect(negotiatedTeamCapabilities(snapshot, null)).toEqual([]);
  expect(negotiatedTeamCapabilities(snapshot, { protocol: "other", capabilities: ["identity"] })).toEqual([]);
  expect(negotiatedTeamCapabilities(snapshot, { protocol: DONEBOT_TEAMS_PROTOCOL, capabilities: ["identity"] })).toEqual(["identity"]);
});
it("sanitizes workspace snapshots and disables unsupported execution", () => {
  expect(workspaceSnapshot({ ...snapshot, capabilities: ["identity", "cloud_access", "local_execution", "shared_files", "delegation", "unknown"], secret: "private" }, "1")).toEqual({
    ...snapshot, account_id: "1", capabilities: ["identity", "cloud_access", "local_execution", "shared_files"],
  });
  expect(() => workspaceSnapshot({ ...snapshot, workspaces: [{ ...team, role: "root" }] }, "1")).toThrow();
  expect(workspaceSnapshot({ ...snapshot, capabilities: [] }, "1").workspaces).toEqual([]);
});
it("sends login JWTs and only explicit command fields, never payer or owner credentials", async () => {
  const { gateway, requests } = await fixture();
  expect(await gateway.workspaceSnapshot()).toMatchObject({ account_id: "1", capabilities: ["identity", "local_execution"] });
  expect(await gateway.teamMutate({ action: "create", account_id: "1", name: "Fixture Studio", key })).toEqual(team);
  const request = requests.at(-1)!; expect(request.path).toBe("/api/v1/donebot/teams");
  const headers = new Headers(request.init?.headers); expect(headers.get("authorization")).toBe("Bearer synthetic-jwt"); expect(headers.get("idempotency-key")).toBe(key);
  expect(JSON.parse(String(request.init?.body))).toEqual({ name: "Fixture Studio" });
  await expect(gateway.teamMutate({ action: "create", account_id: "2", name: "Other", key })).rejects.toMatchObject({ code: "account_changed" });
});
it("validates team Cloud plans, mutations, desktop launch links, and local device consent", async () => {
  const instanceId = randomUUID(), planId = randomUUID(), deviceId = randomUUID(), pairToken = `omb_pair_${"b".repeat(43)}`;
  const { gateway, requests } = await fixture(path => {
    if (path.endsWith("/teams/plans")) return json([{ id: planId, name: "Studio", enabled: true, monthly_price: "49", retention_days: 7, runtime: { cpu_millis: 2000, memory_mib: 4096, storage_gib: 10, pids: 256 }, desktop: { cpu_millis: 1000, memory_mib: 2048, storage_gib: 10, pids: 512 }, shared_quota_bytes: 5 * 1024 ** 3, max_file_bytes: 100 * 1024 ** 2 }]);
    if (path.endsWith(`/teams/${id}/cloud`)) return json({ instance: { instance_id: instanceId, desired: "running", actual: "running", generation: 1, error: "", paid_until: "2026-12-20T00:00:00Z", subscription_state: "active", purge_locked: false, auto_renew: true, plan_id: planId, plan_name: "Studio" }, operations: [], connection_available: true });
    if (path.endsWith(`/teams/${id}/cloud/start`)) return json({ instance: { instance_id: instanceId, desired: "running", actual: "pending", generation: 1, error: "", paid_until: "2026-12-20T00:00:00Z", subscription_state: "pending", purge_locked: false, auto_renew: true }, operation: { id: randomUUID(), action: "start", state: "pending", error: "" } });
    if (path.endsWith(`/teams/${id}/desktop-launch`)) return json({ url: `donebot://pair?address=${encodeURIComponent(`https://${instanceId}.cloud.donebot.cn`)}&token=${pairToken}&name=Fixture+Studio` });
    if (path.endsWith(`/teams/${id}/devices`)) return json({ id: deviceId, team_id: id, user_id: 1, email: "owner@example.invalid", role: "owner", installation_id: key, name: "DoneBot", enabled: true, version: 1, member_version: 1, online: true, last_seen: "2026-11-22T00:00:00Z" });
    if (path.endsWith(`/devices/${deviceId}/heartbeat`)) return json({ ok: true });
    if (path.endsWith(`/devices/${deviceId}`)) return json({ ok: true });
    return undefined;
  });
  expect((await gateway.teamPlans())[0]?.name).toBe("Studio");
  expect((await gateway.teamCloud(id)).instance?.instance_id).toBe(instanceId);
  expect((await gateway.teamCloudMutate(id, { account_id: "1", action: "start", key, plan_id: planId })).operation.action).toBe("start");
  expect((await gateway.teamCloudConnect(id, instanceId, "1")).url).toContain(pairToken);
  await expect(gateway.teamCloudConnect(id, randomUUID(), "1")).rejects.toMatchObject({ code: "cloud_connection_invalid" });
  const device = await gateway.teamDeviceMutate(id, { action: "set", account_id: "1", enabled: true });
  expect(device).toMatchObject({ id: deviceId, enabled: true });
  await gateway.teamDeviceMutate(id, { action: "revoke", account_id: "1", device_id: deviceId });
  expect(requests.some(item => item.path === `/api/v1/donebot/teams/${id}/devices/${deviceId}`)).toBe(true);
});
it("does not give runtime installation credentials account or membership management authority", async () => {
  const { gateway, requests } = await fixture(undefined, true);
  await expect(gateway.workspaceSnapshot()).rejects.toMatchObject({ code: "team_login_required" });
  await expect(gateway.teamMutate({ action: "create", account_id: "1", name: "Other", key })).rejects.toMatchObject({ code: "team_login_required" });
  expect(requests).toHaveLength(0);
});
it("retains compatibility with gateways that predate teams", async () => {
  const { gateway } = await fixture(path => path.endsWith("/workspaces") ? json({}, 404) : undefined);
  expect(await gateway.workspaceSnapshot()).toEqual({ account_id: "1", protocol: DONEBOT_TEAMS_PROTOCOL, capabilities: [], workspaces: [] });
});
it("refuses invalid roles, traversal, identity injection and request keys before transport", () => {
  const command = { action: "invite", account_id: "1", team_id: id, email: "a@example.invalid", role: "member" };
  for (const change of [{ role: "owner" }, { team_id: "../../other" }, { payer_id: 42 }, { user_id: 42 }]) expect(() => teamCommandRequest({ ...command, ...change } as DoneBotTeamCommand)).toThrow();
  expect(() => teamCommandRequest({ action: "create", account_id: "1", name: "Other", key: "bad\r\nkey" })).toThrow();
});
