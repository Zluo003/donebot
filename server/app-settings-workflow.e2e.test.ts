import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("changes settings through actual injected MCP calls, shows a receipt, handles conflicts and preserves saved values on restart", async () => {
  const key = "app-settings-fixture";
  const fixture = await launchVerificationServer({ DONEBOT_TEST_INTERNAL_CAPABILITY_KEY: key }, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir, logPath } = fixture.info;
  const planPath = join(dataDir, "room-plan.json");
  const evidencePath = `${logPath}.settings.json`;
  const evidence: unknown[] = [];
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200, token?: string, testing = false) => {
    const response = await fetch(url + path, { method, headers: { origin: url, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(testing ? { "x-donebot-test-capability": key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as any;
    evidence.push({ method, path, status: response.status, result });
    expect(response.status, `${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const providerTurns = () => existsSync(`${planPath}.evidence.jsonl`) ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const plans: Record<string, { turns: any[] }> = {};
  const messages = async (id: string) => (await api("GET", `/api/threads/${id}/messages?limit=100`)).messages as any[];
  const run = async (bot: any, text: string, calls: Array<{ arguments: object; expectError?: boolean }>) => {
    const before = providerTurns().length;
    (plans[bot.id] ??= { turns: [] }).turns.push({ steps: calls.map(call => ({ tool: "app_settings", ...call })), reply: text });
    writeFileSync(planPath, JSON.stringify(plans));
    await cli("send", "--bot", bot.id, "--task", bot.threadId, "--text", text);
    expect((await cli("wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "25")).status).toBe("settled");
    expect(providerTurns()).toHaveLength(before + 1);
    const steps = providerTurns().at(-1).evidence.filter((row: any) => row.step);
    expect(steps).toHaveLength(calls.length);
    steps.forEach((row: any, index: number) => expect(Boolean(row.response.error || row.response.result?.isError)).toBe(Boolean(calls[index]!.expectError)));
  };
  try {
    await api("POST", "/api/internal/app-settings", { action: "places" }, 401);
    const created = (await cli("new-bot", "--name", "Settings fixture", "--section", "Studio")).bot;
    const bot = (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === created.id);
    await api("PUT", "/api/config", { computerName: "Before", language: "en" });
    await run(bot, "Find device name and set it to Office Mac.", [
      { arguments: { action: "find", query: "设备名称" } },
      { arguments: { action: "get", id: "general.deviceName" } },
      { arguments: { action: "set", id: "general.deviceName", value: "Office Mac" } },
      { arguments: { action: "set", id: "models.pricing", value: "0" }, expectError: true },
      { arguments: { action: "get", id: "openai.key" }, expectError: true },
    ]);
    expect((await api("GET", "/api/config")).computerName).toBe("Office Mac");
    const [changed] = (await messages(bot.threadId)).filter(row => row.card?.appSettingRequest);
    expect(changed.card).toMatchObject({ autoApplied: true, answered: "allow", appSettingRequest: { before: "Before", after: "Office Mac", settingId: "general.deviceName" } });
    await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: changed.card.requestId });
    expect((await api("GET", "/api/config")).computerName).toBe("Before");
    await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: changed.card.requestId });
    await run(bot, "Set the name to Requested.", [{ arguments: { action: "set", id: "general.deviceName", value: "Requested" } }]);
    const latest = (await messages(bot.threadId)).filter(row => row.card?.appSettingRequest).at(-1).card;
    await api("PUT", "/api/config", { computerName: "Manual" });
    expect((await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: latest.requestId }, 409)).code).toBe("changed-since");
    const capability = await api("POST", "/api/testing/internal-capability", { botId: bot.id, threadId: bot.threadId, kind: "agents" }, 201, undefined, true);
    // A synthetic capability has no current human request provenance.
    await api("POST", "/api/internal/app-settings", { action: "set", id: "general.deviceName", value: "Unattended" }, 403, capability.token);
    await api("POST", "/api/internal/app-settings", { action: "get", id: "general.deviceName", scope: "team" }, 400, capability.token);
    const other = (await cli("new-bot", "--name", "Other fixture", "--section", "Elsewhere")).bot;
    await api("POST", "/api/internal/app-settings", { action: "get", id: "general.deviceName", fromBotId: other.id }, 403, capability.token);
    await run(bot, "Set the name to Persisted.", [{ arguments: { action: "set", id: "general.deviceName", value: "Persisted" } }]);
    const persistedCard = (await messages(bot.threadId)).filter(row => row.card?.appSettingRequest).at(-1).card;
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const env = verificationServerEnvironment({}, dataDir, Number(new URL(url).port));
    const fd = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, verificationServerArgs(env), { cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    await expect.poll(async () => { try { return (await fetch(url + "/api/health")).ok; } catch { return false; } }, { timeout: 20_000 }).toBe(true);
    expect((await api("GET", "/api/config")).computerName).toBe("Persisted");
    expect((await messages(bot.threadId)).filter(row => row.card?.appSettingRequest)).toHaveLength(3);
    await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: persistedCard.requestId }, 409);
    expect((await api("GET", "/api/config")).computerName).toBe("Persisted");
  } finally {
    writeFileSync(evidencePath, JSON.stringify({ url, logPath, evidence, providerTurns: providerTurns() }, null, 2));
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath }));
  }
}, 120_000);
