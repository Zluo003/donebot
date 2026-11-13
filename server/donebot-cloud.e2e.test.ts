import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { startFakeDoneBotGateway } from "./testing/fake-donebot-gateway.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import type { DoneBotCloudMutationResult, DoneBotCloudSnapshot } from "../shared/donebot-cloud.ts";

it("opens Cloud inside an isolated DoneBot service using account billing and native pairing", async () => {
  const master = await startFakeDoneBotGateway();
  master.cloud.enabled = true;
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, master.origin);
  const request = async <T = unknown>(path: string, body?: unknown, expected = 200): Promise<T> => {
    const response = await fetch(fixture.info.url + path, { method: body === undefined ? "GET" : "POST",
      headers: { origin: fixture.info.url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(expected);
    expect(response.headers.get("cache-control")).toBe("no-store"); return result as T;
  };
  try {
    await request("/api/donebot/cloud", undefined, 401);
    await request("/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-fixture-password" });
    const snapshot = await request<DoneBotCloudSnapshot>("/api/donebot/cloud");
    expect(snapshot).toMatchObject({ account_id: "fixture-user", balance_cents: 0, plan: { monthly_price: "12.500000", retention_days: 7 } });
    const input = { action: "start", account_id: snapshot.account_id, monthly_price: snapshot.plan.monthly_price, key: randomUUID() };
    const failed = await request<DoneBotCloudMutationResult>("/api/donebot/cloud", input, 202);
    expect(failed.operation).toMatchObject({ state: "failed", error: "billing_insufficient_balance" });
    expect(master.cloud.charges).toBe(0);
    master.cloud.balanceCents = 5000; master.cloud.dropNextReply = true;
    const retry = { ...input, id: failed.instance.id, key: randomUUID() };
    await request("/api/donebot/cloud", retry, 502);
    expect(master.cloud.charges).toBe(1);
    const running = await request<DoneBotCloudMutationResult>("/api/donebot/cloud", retry, 202);
    expect(running.instance.actual).toBe("running");
    expect(master.cloud.charges).toBe(1); expect(master.cloud.balanceCents).toBe(3750);
    const posts = master.requests.filter(request => request.idempotencyKey === retry.key);
    expect(posts).toHaveLength(2); expect(posts.every(request => Object.keys(request.body).length === 0)).toBe(true);
    const current = await request("/api/donebot/cloud");
    expect(current).toMatchObject({ balance_cents: 3750, instance: { id: running.instance.id, actual: "running" } });
    const pair = await request<{ url: string }>("/api/donebot/cloud/connect", { id: running.instance.id, account_id: snapshot.account_id });
    expect(pair.url).toMatch(/^donebot:\/\/pair\?/);
    await request("/api/donebot/cloud", { ...retry, action: "stop", key: randomUUID() }, 202);
    const started = await request<DoneBotCloudMutationResult>("/api/donebot/cloud", { ...retry, key: randomUUID() }, 202);
    expect(started.instance.actual).toBe("running"); expect(master.cloud.charges).toBe(1);
    await request("/api/donebot/cloud", { ...retry, account_id: "other-fixture-user" }, 409);
    await request("/api/donebot/cloud", { ...retry, user_id: "other-fixture-user" }, 400);
    await request("/api/donebot/cloud/connect", { id: running.instance.id, account_id: "other-fixture-user" }, 409);
    await request("/api/donebot/cloud", { ...retry, action: "cancel", key: randomUUID() }, 202);
    expect((await request<DoneBotCloudSnapshot>("/api/donebot/cloud")).instance?.subscription_state).toBe("cancelled");
    await request("/api/donebot/logout", {});
    const before = master.requests.length;
    await request("/api/donebot/cloud", undefined, 401);
    await request("/api/donebot/cloud", retry, 401);
    expect(master.requests).toHaveLength(before);
    expect(JSON.stringify(current) + await readFile(fixture.info.logPath, "utf8")).not.toMatch(/fixture-access-token|fixture-refresh-token|fixture-installation-key|synthetic-fixture-password|omb_pair_/);
    const evidence = { fixtureUrl: fixture.info.url, logPath: fixture.info.logPath,
      insufficientBalance: "no charge", uncertainRetry: "same key, one synthetic charge", paidRestart: "no additional charge", accountMismatch: "rejected", nativePairing: "validated URL; bridge separately checked" };
    const directory = join(process.cwd(), ".omb-scratch", "verify-evidence", "donebot-cloud");
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, "result.json"), JSON.stringify(evidence, null, 2) + "\n");
  } finally { await fixture.close(); await master.close(); }
}, hostTimeout(90_000));
