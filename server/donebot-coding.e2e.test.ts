import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { startFakeDoneBotGateway } from "./testing/fake-donebot-gateway.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("switches coding execution and billing in an existing conversation with an external project folder", async () => {
  const gateway = await startFakeDoneBotGateway();
  const project = await realpath(await mkdtemp(join(tmpdir(), "donebot-external-project-")));
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, ["donebotCoding"], undefined, undefined, gateway.origin);
  const evidence: unknown[] = [{ fixture: fixture.info, externalProject: project }];
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(expected);
    evidence.push({ method, path, status: response.status });
    return result as any;
  };
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    evidence.push({ args, result }); return result;
  };
  try {
    await api("POST", "/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-fixture-password" });
    const { instances } = await api("GET", "/api/instances?fresh=1");
    const managed = instances.filter((instance: any) => instance.instanceId.startsWith("donebot-"));
    expect(managed).toHaveLength(6);
    for (const instance of managed) {
      expect(instance.readOnly).not.toBe(true); expect(instance.install).toBeTruthy();
      expect(instance.access).toBe(instance.instanceId.endsWith("-subscription") ? "subscription" : "api");
    }
    const codex = managed.find((instance: any) => instance.instanceId === "donebot-codex");
    const claude = managed.find((instance: any) => instance.instanceId === "donebot-claude");
    const subscription = managed.find((instance: any) => instance.instanceId === "donebot-claude-subscription");
    expect(codex.snapshot.state).toBe("available"); expect(claude.snapshot.authenticated).toBe(true);
    expect(subscription.snapshot.authenticated).toBe(true);
    expect(subscription.authentication?.method).toBe("paste-code");
    expect(managed.find((instance: any) => instance.instanceId === "donebot-codex-subscription").authentication?.method).toBe("browser-pkce");
    const selection = (instance: any) => ({ instanceId: instance.instanceId, model: instance.models.default });
    const { bot } = await api("POST", "/api/bots", { name: "Coding fixture", modelSelection: selection(claude), settings: { cwd: project } }, 201);
    const direct = async (text: string) => {
      await control(["send", "--bot", bot.id, "--task", bot.threadId, "--text", text]);
      expect((await control(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30"])).status).toBe("settled");
    };
    await writeFile(join(project, "existing.txt"), "external project sentinel\n");
    await direct("Reply: gateway coding fixture.");
    const first = JSON.parse(await readFile(fixture.fixtureDumpPath, "utf8"));
    expect(first.cwd).toBe(project);
    expect(first.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(first.env.ANTHROPIC_API_KEY).toBeTruthy();
    expect(JSON.stringify(first)).not.toMatch(/fixture-installation-key|fixture-access-token/);
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { modelSelection: selection(subscription) });
    await direct("Reply: subscription coding fixture.");
    const second = JSON.parse(await readFile(fixture.fixtureDumpPath, "utf8"));
    expect(second.cwd).toBe(project); expect(second.env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
    expect(second.env.ANTHROPIC_API_KEY).toBeUndefined(); expect(second.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(second.env.CLAUDE_CONFIG_DIR).not.toBe(first.env.CLAUDE_CONFIG_DIR);
    expect(second.argv).not.toContain("--resume");
    expect(second.pid).not.toBe(first.pid);
    const existing = managed.find((instance: any) => instance.instanceId === "donebot-claude-existing");
    expect(existing.capabilities.effortLevels).toBeUndefined(); expect(existing.authentication).toBeUndefined();
    const configDir = join(fixture.info.dataDir, ".claude");
    await mkdir(configDir, { recursive: true });
    const configFile = join(configDir, "settings.json");
    const cliSettings = JSON.stringify({ model: "user-selected-model", env: { ANTHROPIC_BASE_URL: "https://existing.invalid", ANTHROPIC_AUTH_TOKEN: "synthetic-existing-token" } });
    await writeFile(configFile, cliSettings);
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { modelSelection: selection(existing) });
    await direct("Reply: existing CLI configuration fixture.");
    const preserved = JSON.parse(await readFile(fixture.fixtureDumpPath, "utf8"));
    expect(preserved.cwd).toBe(project); expect(preserved.argv).not.toContain("--model"); expect(preserved.argv).not.toContain("--effort");
    expect(preserved.argv).toContain("user,project,local");
    expect(preserved.env.ANTHROPIC_BASE_URL).toBeUndefined(); expect(preserved.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(preserved.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(await readFile(configFile, "utf8")).toBe(cliSettings);
    await api("POST", "/api/instances/donebot-claude-existing/install", {}, 403);
    await api("POST", "/api/instances/donebot-claude-existing/auth/sign-out", {}, 403);
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { modelSelection: selection(codex) });
    await direct("Reply: Codex coding fixture.");
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { modelSelection: selection(claude) });
    await direct("Reply: gateway again.");
    const messages = await control(["messages", "--bot", bot.id, "--task", bot.threadId, "--limit", "30"]);
    expect(JSON.stringify(messages)).toContain("subscription coding fixture");
    expect(JSON.stringify(messages)).toContain("Codex coding fixture");
    const { bot: worker } = await api("POST", "/api/bots", { name: "Coding worker", modelSelection: selection(codex), settings: { cwd: project, approvalMode: "full" } }, 201);
    const { bot: chief } = await api("POST", "/api/bots", { name: "Coding coordinator", modelSelection: { instanceId: "donebot", model: "gpt-6.1-sol" }, settings: { chiefOfStaff: true, approvalMode: "full", cwd: project } }, 201);
    gateway.setModelPlan("gpt-6.1-sol", [{ name: "coordinate_bots", arguments: { bot_ids: [worker.id], message: "Inspect the existing project and report completion." } }], "Waiting for the coding worker.", "Coding worker result received.");
    await control(["send", "--bot", chief.id, "--task", chief.threadId, "--text", "Delegate this project check to the coding worker."]);
    expect((await control(["wait", "--bot", chief.id, "--task", chief.threadId, "--timeout", "30"])).status).toBe("settled");
    expect(readHandoffs(fixture.info.dataDir).find(node => node.botId === worker.id)).toMatchObject({ status: "completed", reported: true });
    await api("POST", "/api/instances/donebot-claude/refresh-models", {});
    await api("POST", "/api/instances/claude-endpoint", {}, 403);
    await api("POST", "/api/instances/donebot-claude/auth/start", {}, 403);
    await api("PATCH", "/api/instances/donebot-claude/settings", { config: { endpoint: "https://evil.invalid" } }, 403);
    expect(await readFile(join(project, "existing.txt"), "utf8")).toBe("external project sentinel\n");
    expect(await readFile(fixture.info.logPath, "utf8")).not.toMatch(/fixture-installation-key|fixture-access-token|synthetic-fixture-password/);
  } finally {
    const evidenceDir = join(process.cwd(), ".omb-scratch", "verify-evidence", "donebot-coding");
    await mkdir(evidenceDir, { recursive: true }); await writeFile(join(evidenceDir, "result.json"), JSON.stringify(evidence, null, 2) + "\n");
    await fixture.close(); await gateway.close(); await rm(project, { recursive: true, force: true });
  }
}, hostTimeout(120_000));
