import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { installFakeBw } from "./testing/install-fake-bw.ts";
import { VaultStore } from "./vault-store.ts";

it.skipIf(process.platform === "win32")("connects a separate fake bw through real routes, reads references without disclosure, survives restart, and disconnects", async () => {
  const key = "bitwarden-fixture-capability";
  const fixture = await launchVerificationServer({ DONEBOT_TEST_INTERNAL_CAPABILITY_KEY: key }, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir, logPath } = fixture.info;
  const credentials = { serverUrl: "https://vault.bitwarden.eu", clientId: "user.fixture", clientSecret: "fake-client-secret-canary", password: "fake-master-canary" };
  const password = "fake-login-password-canary", note = "fake-note-canary";
  const answers: string[] = [];
  const evidence: unknown[] = [];
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200, token?: string, testing = false) => {
    const response = await fetch(url + path, { method, headers: { origin: url, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(testing ? { "x-donebot-test-capability": key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    answers.push(text);
    const result = JSON.parse(text) as any;
    expect(response.status, `${method} ${path}: ${text}`).toBe(status);
    evidence.push({ method, path, status: response.status });
    return result;
  };
  try {
    installFakeBw(dataDir, { ...credentials, email: "bots@example.test", items: [
      { id: "github", name: "GitHub", type: 1, login: { uris: [{ uri: "https://github.com/login" }], username: "fixture", password } },
      { id: "note", name: "Deploy", type: 2, notes: note },
    ] });
    await api("POST", "/api/logins/bitwarden", { ...credentials, password: "fake-wrong" }, 400);
    expect((await api("GET", "/api/vault")).bitwarden).toEqual({ connected: false });
    expect(new VaultStore({ dataDir }).bitwardenCredentials()).toBeNull();
    expect((await api("POST", "/api/logins/bitwarden", credentials)).bitwarden).toMatchObject({ connected: true, items: 2, account: "bots@example.test" });
    const listed = await api("GET", "/api/vault");
    expect(listed.logins).toMatchObject([{ site: "github.com", source: "bitwarden" }]);
    expect(listed.secrets).toMatchObject([{ name: "Deploy", source: "linked", provider: "bitwarden" }]);
    const store = new VaultStore({ dataDir });
    expect(store.bitwardenCredentials()).toEqual(credentials);
    const connectionId = store.bitwardenConnectionId();
    expect(connectionId).toMatch(/^[0-9a-f-]{36}$/u);
    const encrypted = readFileSync(join(dataDir, "logins.json.enc"), "utf8");
    for (const value of [credentials.clientSecret, credentials.password]) expect(encrypted).not.toContain(value);
    await api("PATCH", "/api/logins/bitwarden:github:github.com", {}, 409);
    await api("DELETE", "/api/logins/bitwarden%3Agithub%3Agithub.com", undefined, 409);
    const bot = (await api("POST", "/api/bots", { name: "Bitwarden fixture" }, 201)).bot;
    writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({ [bot.id]: { turns: [{ steps: [
      { tool: "request_credential", arguments: { label: "bw://GitHub/password", reason: "Fixture only", delivery: "ref" } },
    ], reply: "Fixture reference accepted." }] } }));
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Use the fixture login by reference.", "--url", url]);
    expect(await runControlOmb(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30", "--url", url])).toMatchObject({ status: "settled" });
    expect(readFileSync(fixture.fixtureDumpPath, "utf8")).toContain("bw://<item id or name>");
    const claim = await api("POST", "/api/testing/internal-capability", { botId: bot.id, threadId: bot.threadId, kind: "agents" }, 201, undefined, true);
    for (const label of ["Deploy", "bw://GitHub/password", "bw://github/username", "bw://note/notes"]) {
      const answer = await api("POST", "/api/internal/request-credential", { label, reason: "Fixture only", delivery: "ref" }, 200, claim.token);
      expect(answer.text).toMatch(/secret-ref:[0-9a-f]{32}/u);
    }
    await api("POST", "/api/internal/request-credential", { label: "Deploy", reason: "Unauthenticated", delivery: "ref" }, 401);
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const env = verificationServerEnvironment({ DONEBOT_TEST_INTERNAL_CAPABILITY_KEY: key }, dataDir, Number(new URL(url).port));
    const fd = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, verificationServerArgs(env), { cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    await expect.poll(async () => { try { return (await fetch(url + "/api/health")).ok; } catch { return false; } }, { timeout: 25_000 }).toBe(true);
    await expect.poll(async () => (await api("GET", "/api/vault")).bitwarden?.items, { timeout: 15_000 }).toBe(2);
    expect(new VaultStore({ dataDir }).bitwardenConnectionId()).toBe(connectionId);
    expect((await api("DELETE", "/api/logins/bitwarden")).bitwarden).toEqual({ connected: false });
    expect((await api("GET", "/api/vault")).secrets).toEqual([]);
    expect(new VaultStore({ dataDir }).bitwardenCredentials()).toBeNull();
    expect(existsSync(join(dataDir, "tools/bitwarden/account"))).toBe(false);
    const publicText = [...answers, readFileSync(logPath, "utf8"), readFileSync(fixture.fixtureDumpPath, "utf8")].join("\n");
    for (const value of [credentials.clientSecret, credentials.password, password, note]) expect(publicText).not.toContain(value);
  } finally {
    writeFileSync(`${logPath}.bitwarden.json`, JSON.stringify({ evidence }, null, 2));
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath: `${logPath}.bitwarden.json` }));
  }
}, 120_000);
