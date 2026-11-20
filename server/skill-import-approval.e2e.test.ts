import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { cloudPairingSignature } from "./cloud-home.ts";
import { verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const KEY = "skill-import-approval-fixture";
let dataDir = "", base = "", logPath = "";
let child: ChildProcess | undefined;
let childEnv: NodeJS.ProcessEnv = {}, childArgs: string[] = [], ownerToken = "";
const skillMd = (name: string) => `---\nname: ${name}\ndescription: Checks ${name} reports.\n---\nRead references/checks.md.\n`;

async function api(method: string, path: string, body?: unknown, token?: string) {
  const response = await fetch(base + path, { method, headers: { origin: base, "content-type": "application/json",
    ...((token || ownerToken) ? { authorization: `Bearer ${token || ownerToken}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}
async function setup(mode = "auto") {
  const created = await api("POST", "/api/bots", { name: "Import fixture", section: "Studio", approvalMode: mode });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot;
  const response = await fetch(base + "/api/testing/internal-capability", { method: "POST",
    headers: { "content-type": "application/json", "x-donebot-test-capability": KEY },
    body: JSON.stringify({ botId: bot.id, threadId: bot.threadId, kind: "agents", skillAuthoring: true }) });
  expect(response.status).toBe(201);
  return { bot, token: (await response.json() as { token: string }).token };
}
const cards = async (bot: any) => (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages.filter((line: any) => line.card?.skillRequest).map((line: any) => line.card);
const inventory = async (bot: any) => (await api("GET", `/api/bots/${bot.id}/skills`)).body.skills;
async function heldImport(bot: any, token: string, name: string, route = "stage", extra: Record<string, unknown> = {}) {
  const ready = join(dataDir, `${name}.ready`), gate = join(dataDir, `${name}.gate`);
  rmSync(ready, { force: true });
  rmSync(gate, { force: true });
  const result = api("POST", `/api/internal/skills/${route}`, { fromBotId: bot.id, action: "import", source: `https://github.com/fixture/${name}/tree/main/skill`, ...extra }, token);
  await expect.poll(() => existsSync(ready), { timeout: 10_000 }).toBe(true);
  return { result, release: () => writeFileSync(gate, "release") };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "donebot-skill-approval-"));
  mkdirSync(join(dataDir, "tmp"));
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ language: "en", features: { skillsLibrary: false },
    instances: { claude: { driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") } } } }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const env = childEnv = verificationServerEnvironment({ DONEBOT_TEST_INTERNAL_CAPABILITY_KEY: KEY }, dataDir, port);
  const names = ["review", "setting", "revoked", "cancelled", "room", "disabled", "legacy-setting"];
  const repos = Object.fromEntries(names.map(name => [`fixture/${name}`, { "skill/SKILL.md": skillMd(name), "skill/references/checks.md": "Verify source totals.\n", "skill/scripts/check.js": "throw new Error('must never execute');\n" }]));
  const prelude = `import { fakeGitHub } from ${JSON.stringify(pathToFileURL(join(ROOT, "server/testing/fake-github.ts")).href)};
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const fake = fakeGitHub(${JSON.stringify(repos)}), real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1') return real(input, init);
  if (url.hostname !== 'api.github.com' && url.hostname !== 'raw.githubusercontent.com') return new Response('offline fixture', { status: 503 });
  const name = url.pathname.split('/')[3];
  if (url.hostname === 'api.github.com' && url.pathname.includes('/commits/')) {
    writeFileSync(${JSON.stringify(dataDir)} + '/' + name + '.ready', 'ready');
    try { while (!existsSync(${JSON.stringify(dataDir)} + '/' + name + '.gate')) await delay(10, undefined, { signal: init?.signal }); }
    catch (error) { writeFileSync(${JSON.stringify(dataDir)} + '/' + name + '.aborted', 'aborted'); throw error; }
  }
  return fake.fetch(input, init);
};`;
  logPath = join(tmpdir(), `donebot-skill-approval-${Date.now()}.log`);
  const log = openSync(logPath, "a", 0o600);
  childArgs = ["--import", `data:text/javascript,${encodeURIComponent(prelude)}`, ...verificationServerArgs(env)];
  child = spawn(process.execPath, childArgs, { cwd: ROOT, env, stdio: ["ignore", log, log] });
  closeSync(log);
  await vi.waitFor(async () => {
    if (child?.exitCode !== null) throw new Error(readFileSync(logPath, "utf8"));
    expect((await api("GET", "/api/health")).body.app).toBe("donebot");
  }, { timeout: 30_000, interval: 150 });
}, 40_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  if (dataDir) await removeTempDir(dataDir);
  console.log(`Skill import approval evidence: ${logPath}`);
});

it("retains local Ask direct-apply receipts after fetching and can Undo the imported skill", async () => {
  const { bot, token } = await setup();
  const held = await heldImport(bot, token, "review");
  expect((await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" })).status).toBe(200);
  held.release();
  expect(await held.result).toMatchObject({ status: 201, body: { state: "applied", name: "review" } });
  expect(await inventory(bot)).toMatchObject([{ name: "review", enabled: true }]);
  const [card] = await cards(bot);
  expect(card.skillRequest).toMatchObject({ preview: skillMd("review"), references: [{ path: "references/checks.md", content: "Verify source totals.\n" }] });
  expect(card.subtitle).toContain("scripts/check.js");
  expect(card).toMatchObject({ answered: "allow", autoApplied: true });
  expect(existsSync(join(dataDir, "workspaces", bot.id, ".agents/skills/review/scripts/check.js"))).toBe(false);
  expect((await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: card.requestId })).status).toBe(200);
  expect(await inventory(bot)).toEqual([]);
});

it("rechecks authoring after either import route fetches and never installs after it is disabled", async () => {
  for (const [name, route] of [["setting", "stage"], ["legacy-setting", "import"]]) {
    await api("PATCH", "/api/config", { features: { skillAuthoring: true } });
    const { bot, token } = await setup();
    const held = await heldImport(bot, token, name!, route, { preview: false });
    await api("PATCH", "/api/config", { features: { skillAuthoring: false } });
    held.release();
    expect(await held.result).toMatchObject({ status: 403, body: { error: expect.stringContaining("not enabled") } });
    expect(await inventory(bot)).toEqual([]);
    expect(await cards(bot)).toEqual([]);
  }
  await api("PATCH", "/api/config", { features: { skillAuthoring: true } });
});

it("rechecks managed target authority after fetching", async () => {
  const { bot, token } = await setup();
  await api("PATCH", `/api/bots/${bot.id}`, { chiefOfStaff: true });
  const target = (await setup()).bot;
  const held = await heldImport(bot, token, "revoked", "stage", { bot_id: target.id });
  await api("PATCH", `/api/bots/${target.id}`, { section: "Other" });
  held.release();
  expect((await held.result).status).toBe(403);
  expect(await inventory(target)).toEqual([]);
  expect(await cards(bot)).toEqual([]);
});

it("aborts the upstream fetch on an ended turn without a card or library write", async () => {
  const { bot, token } = await setup();
  const held = await heldImport(bot, token, "cancelled");
  await api("POST", `/api/bots/${bot.id}/interrupt`);
  await expect.poll(() => existsSync(join(dataDir, "cancelled.aborted")), { timeout: 10_000 }).toBe(true);
  expect((await held.result).status).toBe(401);
  expect(await inventory(bot)).toEqual([]);
  expect(await cards(bot)).toEqual([]);
});

it("retains the full-folder import path with scripts disabled", async () => {
  const { bot, token } = await setup();
  const held = await heldImport(bot, token, "disabled", "import", { preview: false });
  held.release();
  expect(await held.result).toMatchObject({ status: 201, body: { enabled: false, installed: { name: "disabled" } } });
  expect(await inventory(bot)).toMatchObject([{ name: "disabled", enabled: false }]);
  expect(readFileSync(join(dataDir, "workspaces", bot.id, "skills/disabled/scripts/check.js"), "utf8")).toContain("must never execute");
  expect(await cards(bot)).toEqual([]);
});

it("keeps Cloud guest imports pending, rechecks card capacity and requires the reviewed bytes", async () => {
  const pair = await api("POST", "/api/auth/pairing", { label: "Guest fixture", scopes: ["client"] });
  expect(pair.status).toBe(200);
  const guest = (await api("POST", "/api/auth/pair", { code: pair.body.code })).body.token;
  const bots: any[] = [];
  for (const name of ["Capacity", "Review"]) {
    const { bot } = await setup("ask");
    const task = await api("POST", `/api/bots/${bot.id}/tasks`, { title: name }, guest);
    expect(task.status, JSON.stringify(task.body)).toBe(201);
    bots.push({ ...bot, threadId: task.body.task.threadId });
  }
  await waitForExit(child, { signal: "SIGTERM" });
  const secret = randomBytes(32).toString("base64url");
  Object.assign(childEnv, { DONEBOT_CLOUD_ROLE: "home", DONEBOT_CLOUD_MACHINE_ID: "d40cd1e8-5aa7-4f10-a644-6e28a22a835f",
    DONEBOT_CLOUD_BOOTSTRAP_SECRET: secret, DONEBOT_CLOUD_ADMIN_URL: "https://cloud.example.test", DONEBOT_PUBLIC_URL: "https://skill-cloud.example.test" });
  const log = openSync(logPath, "a", 0o600);
  child = spawn(process.execPath, childArgs, { cwd: ROOT, env: childEnv, stdio: ["ignore", log, log] });
  closeSync(log);
  await expect.poll(async () => { try { return (await api("GET", "/api/health")).body.app; } catch { return "starting"; } }, { timeout: 30_000 }).toBe("donebot");
  const body = JSON.stringify({ label: "DoneBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(base + "/api/cloud/pairing", { method: "POST", headers: { "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}` }, body });
  const granted = await response.json() as { code: string };
  ownerToken = (await api("POST", "/api/auth/pair", { code: granted.code })).body.token;
  expect(ownerToken).toBeTruthy();
  for (const [index, bot] of bots.entries()) {
    const minted = await fetch(base + "/api/testing/internal-capability", { method: "POST", headers: { "content-type": "application/json", "x-donebot-test-capability": KEY },
      body: JSON.stringify({ botId: bot.id, threadId: bot.threadId, kind: "agents", skillAuthoring: true }) });
    expect(minted.status).toBe(201);
    const token = (await minted.json() as { token: string }).token;
    const held = await heldImport(bot, token, index === 0 ? "room" : "review");
    if (index === 0) {
      for (let i = 0; i < 8; i++) {
        const staged = await api("POST", "/api/internal/skills/stage", { action: "create", source: "conversation", skill_md: skillMd(`pending-${i}`) }, token);
        expect(staged, JSON.stringify(staged.body)).toMatchObject({ status: 201, body: { state: "pending" } });
      }
      held.release();
      expect((await held.result).status).toBe(429);
      expect(await cards(bot)).toHaveLength(8);
      expect(await inventory(bot)).toEqual([]);
    } else {
      held.release();
      expect(await held.result).toMatchObject({ status: 201, body: { state: "pending", name: "review" } });
      expect(await inventory(bot)).toEqual([]);
      const [card] = await cards(bot);
      expect(card.skillRequest).toMatchObject({ preview: skillMd("review"), references: [{ path: "references/checks.md", content: "Verify source totals.\n" }] });
      expect((await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: card.requestId, behavior: "allow", reviewedSha256: "0".repeat(64) })).status).toBe(409);
      expect(await inventory(bot)).toEqual([]);
      expect((await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: card.requestId, behavior: "allow", reviewedSha256: card.skillRequest.sha256 })).status).toBe(200);
      expect(await inventory(bot)).toMatchObject([{ name: "review", enabled: true }]);
    }
  }
}, 60_000);
