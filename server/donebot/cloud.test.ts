import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { DoneBotGateway, type DoneBotCredential, type DoneBotCredentialStore } from "./gateway.ts";
import { FAKE_DONEBOT_CATALOG } from "../testing/fake-donebot-gateway.ts";
import type { DoneBotCloudMutation } from "../../shared/donebot-cloud.ts";

const id = randomUUID(), opID = randomUUID();
const plan = { enabled: true, monthly_price: "12.500000", retention_days: 7 };
const instance = { id, desired: "running", actual: "running", error: "", paid_until: new Date(Date.now() + 86400000).toISOString(), subscription_state: "active", purge_locked: false };
const operation = { id: opID, action: "start", state: "succeeded", error: "" };
const mutation = (): DoneBotCloudMutation => ({ action: "start", key: randomUUID(), account_id: "1", monthly_price: plan.monthly_price });
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ code: 0, data }), { status, headers: { "content-type": "application/json" } });
async function fixture(override?: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined, installation = false) {
  const vault: DoneBotCredentialStore & { value: DoneBotCredential | null } = { persistent: false, value: null, async load() { return this.value; }, async save(value) { this.value = value; } };
  if (installation) vault.value = { mode: "installation", accessToken: "", credential: "synthetic-installation-secret", expiresAt: Number.MAX_SAFE_INTEGER,
    user: { id: "1", email: "fixture@example.invalid" }, installationId: randomUUID() };
  const requests: { path: string; init?: RequestInit }[] = [];
  const gateway = new DoneBotGateway(vault, { fetch: (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname; requests.push({ path, init });
    const custom = override?.(path, init); if (custom) return custom;
    if (path.endsWith("/auth/login")) return json({ access_token: "synthetic-login-secret", refresh_token: "synthetic-refresh-secret", expires_in: 3600, user: { id: "1", email: "fixture@example.invalid" } });
    if (path.endsWith("/installations/claim")) return json({ credential: "synthetic-installation-secret" });
    if (path.endsWith("/models")) return new Response(JSON.stringify(FAKE_DONEBOT_CATALOG));
    if (path.endsWith("/account")) return json({ balance_cents: "5000", concurrency: 20 });
    if (path.endsWith("/cloud/plan")) return json({ plan, browser_available: true });
    if (path.endsWith("/cloud/instances") && init?.method === "GET") return json([ { ...instance, user_id: 1, node_id: "private-node" } ]);
    if (path.endsWith("/operations")) return json([{ ...operation, lease_token: "private-lease" }]);
    if (path.endsWith("/desktop-launch")) return json({ url: `donebot://pair?address=${encodeURIComponent(`https://${id}.cloud.example.invalid`)}&token=omb_pair_${"a".repeat(43)}` });
    return json({ instance: { ...instance, node_id: "private-node" }, operation: { ...operation, lease_token: "private-lease" } }, 202);
  }) as typeof fetch });
  if (installation) await gateway.restore(); else await gateway.login("fixture@example.invalid", "synthetic-password");
  requests.length = 0;
  return { gateway, requests };
}
it("reads and mutates Cloud with the login JWT while returning only safe account and resource fields", async () => {
  const { gateway, requests } = await fixture();
  const snapshot = await gateway.cloudSnapshot(), input = mutation(), result = await gateway.cloudMutate(input);
  expect(snapshot).toMatchObject({ account_id: "1", balance_cents: "5000", plan, instance, operations: [operation] });
  expect(result).toEqual({ instance, operation });
  expect(JSON.stringify({ snapshot, result })).not.toMatch(/private-node|private-lease|synthetic-.*-secret/);
  expect(requests.every(({ init }) => new Headers(init?.headers).get("authorization") === "Bearer synthetic-login-secret")).toBe(true);
  const submitted = requests.at(-1)!;
  expect(submitted.path).toBe("/api/v1/donebot/cloud/instances"); expect(submitted.init?.body).toBe("{}");
  expect(new Headers(submitted.init?.headers).get("idempotency-key")).toBe(input.key);
});
it("does not let an installation credential obtain account billing or pairing authority", async () => {
  const { gateway, requests } = await fixture(undefined, true);
  for (const action of [() => gateway.cloudSnapshot(), () => gateway.cloudMutate(mutation()), () => gateway.cloudConnect(id, "1")]) {
    await expect(action()).rejects.toMatchObject({ code: "cloud_login_required" });
  }
  expect(requests).toHaveLength(0);
});
it("rejects a stale account and malformed identifiers or keys before dispatching any charge", async () => {
  const { gateway, requests } = await fixture();
  await expect(gateway.cloudMutate({ ...mutation(), account_id: "2" })).rejects.toMatchObject({ code: "account_changed" });
  for (const patch of [{ id: "../../other" }, { id: "" }, { action: "purge" }, { key: undefined }, { key: "x\r\ny" }, { account_id: undefined }, { monthly_price: undefined }]) {
    await expect(gateway.cloudMutate({ ...mutation(), ...patch } as DoneBotCloudMutation)).rejects.toMatchObject({ code: "cloud_operation_invalid" });
  }
  await expect(gateway.cloudConnect(id, "")).rejects.toMatchObject({ code: "cloud_operation_invalid" });
  expect(requests).toHaveLength(0);
});
it("requires a fresh confirmation when the configured monthly price changed", async () => {
  const { gateway, requests } = await fixture();
  await expect(gateway.cloudMutate({ ...mutation(), monthly_price: "1.000000" })).rejects.toMatchObject({ code: "cloud_price_changed" });
  expect(requests.filter(request => request.init?.method === "POST")).toHaveLength(0);
});
it("does not automatically replay a failed mutation and redacts transport or gateway error details", async () => {
  let posts = 0;
  const { gateway } = await fixture((path, init) => path.endsWith("/cloud/instances") && init?.method === "POST" ? (posts++, Promise.reject(new Error("private-upstream-secret"))) : undefined);
  await expect(gateway.cloudMutate(mutation())).rejects.toMatchObject({ code: "cloud_unavailable" });
  expect(posts).toBe(1);
});
it("cancels an old account's request before a price read can dispatch a charge", async () => {
  let release!: (value: Response) => void;
  let signal: AbortSignal | undefined;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  const { gateway, requests } = await fixture((path, init) => {
    if (path.endsWith("/cloud/plan")) { signal = init?.signal ?? undefined; return pending; }
    return undefined;
  });
  const action = gateway.cloudMutate(mutation());
  const rejected = expect(action).rejects.toMatchObject({ code: "account_changed" });
  await vi.waitFor(() => expect(signal).toBeDefined()); await gateway.logout();
  expect(signal!.aborted).toBe(true); release(json({ plan })); await rejected;
  expect(requests.filter(request => request.path.startsWith("/api/v1/donebot/cloud/") && request.init?.method === "POST")).toHaveLength(0);
});
it("rejects malformed state and sanitizes non-finite balance or arbitrary operation diagnostics", async () => {
  const { gateway } = await fixture(path => path.endsWith("/account") ? json({ balance_cents: "NaN" }) : path.endsWith("/operations") ? json([{ ...operation, error: "secret-token=do-not-reflect" }]) : undefined);
  expect(await gateway.cloudSnapshot()).toMatchObject({ balance_cents: null, operations: [{ error: "operation_failed" }] });
  const invalid = await fixture(path => path.endsWith("/cloud/instances") ? json([{ ...instance, id: "../../foreign" }]) : undefined);
  await expect(invalid.gateway.cloudSnapshot()).rejects.toMatchObject({ code: "cloud_snapshot_invalid" });
});
it("accepts only the native Cloud pairing contract and rejects foreign or credential-bearing addresses", async () => {
  const { gateway } = await fixture(); expect((await gateway.cloudConnect(id, "1")).url).toMatch(/^donebot:\/\/pair\?/);
  for (const url of ["https://foreign.invalid/", `donebot://pair?address=${encodeURIComponent(`https://user:secret@${id}.cloud.example.invalid`)}&token=omb_pair_${"a".repeat(43)}`,
    `donebot://pair?address=${encodeURIComponent("https://foreign.invalid")}&token=omb_pair_${"a".repeat(43)}`,
    `donebot://pair?address=${encodeURIComponent(`https://${id}.cloud.example.invalid`)}&token=omb_pair_${"a".repeat(43)}&token=other`]) {
    const invalid = await fixture(path => path.endsWith("/desktop-launch") ? json({ url }) : undefined);
    await expect(invalid.gateway.cloudConnect(id, "1")).rejects.toMatchObject({ code: "cloud_connection_invalid" });
  }
});
