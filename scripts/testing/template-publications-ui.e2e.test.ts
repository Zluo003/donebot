import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { GITHUB_TOOLS } from "../../server/share-github-repo.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { startBrokerFake } from "../../server/testing/broker-fake.ts";
import { fakeGithubRepo } from "../../server/testing/fake-composio-github.ts";
import { runControlOmb } from "../control-omb.ts";
import { request } from "../mcp-server.ts";
import { agentBrowser, sessionEnv, type UiHandle } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.DONEBOT_UI_E2E === "1";

(enabled ? it : it.skip)("reviews exact files in the Share UI, publishes once, and offers only status queries after response loss", async () => {
  const github = fakeGithubRepo({ owner: "fixture", repo: "templates" });
  const broker = await startBrokerFake({ mcpAnswer(_user, params) {
    const tool = (params.arguments as { tools?: Array<{ tool_slug: string }> })?.tools?.[0];
    return tool && Object.values(GITHUB_TOOLS).includes(tool.tool_slug as never) ? github.answer(params) : undefined;
  } });
  let child: ChildProcess | undefined;
  try {
    const owner = await broker.install();
    broker.account(owner.userId, "github", "personal");
    broker.account(owner.userId, "github", "work");
    broker.account("foreign-person", "github", "FOREIGN_ACCOUNT");
    let stdout = "", stderr = "";
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-omb.ts"), "ui", "launch", "--entry", "templates"], {
      cwd: ROOT, env: { ...process.env, DONEBOT_COMPOSIO_BROKER_URL: broker.url, DONEBOT_COMPOSIO_BROKER_TOKEN: owner.token }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", error => { stderr += error.message; });
    let info: { ui: string; url: string; logPath: string };
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info.ui); } catch { return false; }
    }, { timeout: 180_000, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const click = (name: string) => ui("click", "--name", name);
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const document = { format: "openmaus.package", version: 2, package: {
      id: "review-helper", release: "1.0.0", name: "Publication fixture", tagline: "Synthetic template.", summary: "Review files.", category: "Testing", author: { name: "Fixture" }, license: "MIT", outcomes: ["Review."], setupMinutes: 2,
      requirements: { apps: [], capabilities: [] }, team: { name: "Publication fixture" },
      agents: [{ key: "helper", name: "Publication helper", appearance: { color: "blue" }, skills: ["report"] }],
      skills: { version: 1, entries: [{ name: "report", description: "Report.", instructions: "---\nname: report\ndescription: Report.\n---\nRead scripts/report.py.\n", files: [{ path: "scripts/report.py", content: "raise RuntimeError('PUBLICATION_SCRIPT_MUST_NOT_RUN')\r\n" }] }] },
    } };
    await request("/api/teams/import", { method: "POST", body: JSON.stringify(document) }, info!.url);
    const open = async () => {
      await click("Open templates"); await click("Share"); await click("Share the Publication fixture department");
      await expect.poll(snapshot, { timeout: 10_000 }).toContain("What's in the file");
      await click("Publish to GitHub");
      await expect.poll(snapshot, { timeout: 10_000 }).toContain('option "work"');
    };
    await open();
    expect(await snapshot()).not.toContain("FOREIGN_ACCOUNT");
    expect(await evaluate("document.querySelector('[aria-labelledby=template-repo-title] select').value")).toBe("");
    const prepare = async () => {
      await evaluate(`(() => { const select = document.querySelector('[aria-labelledby=template-repo-title] select');
        const value = [...select.options].find(option => option.text === 'work').value;
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value);
        select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      await ui("type", "--name", "Repository", "--text", "fixture/templates");
      await click("Review publication");
      await expect.poll(snapshot, { timeout: 10_000 }).toContain("Awaiting your confirmation");
    };
    await prepare();
    expect(github.calls).toHaveLength(0);
    await evaluate("[...document.querySelectorAll('[aria-labelledby=template-repo-title] summary')].find(summary => summary.textContent === 'Review template contents').focus(); true");
    await ui("press", "--keys", "Enter");
    expect(await snapshot()).toContain("PUBLICATION_SCRIPT_MUST_NOT_RUN");
    await evaluate("[...document.querySelectorAll('[aria-labelledby=template-repo-title] summary')].find(summary => summary.textContent === 'Review template contents').focus(); true");
    await ui("press", "--keys", "Enter");
    const artifact = join(ROOT, "output/playwright/template-publications"); mkdirSync(artifact, { recursive: true });
    const browser = JSON.parse(readFileSync(info!.ui, "utf8")) as UiHandle;
    const layouts: unknown[] = [];
    for (const [width, skin] of [[1280, "daylight"], [390, "midnight"]] as const) {
      await agentBrowser(browser.binary, sessionEnv(browser), ["set", "viewport", String(width), "900"]);
      await evaluate(`document.documentElement.dataset.skin = '${skin}'; true`);
      const layout = await evaluate(`(() => { const dialog = document.querySelector('[aria-labelledby=template-repo-title]'); const r = dialog.getBoundingClientRect(); return { left: r.left, right: r.right, scroll: dialog.scrollWidth, width: r.width, viewport: innerWidth }; })()`);
      expect(layout.left).toBeGreaterThanOrEqual(0); expect(layout.right).toBeLessThanOrEqual(width);
      expect(layout.scroll).toBeLessThanOrEqual(layout.width);
      layouts.push(layout);
      await ui("screenshot", "--out", join(artifact, `${skin}-${width}.png`));
    }
    await click("Confirm publication");
    await expect.poll(() => evaluate("document.querySelector('[aria-labelledby=template-repo-title] [role=status]')?.textContent"), { timeout: 15_000 }).toBe('Published');
    expect(github.pulls).toHaveLength(1);
    const calls = github.calls.length;
    await click("Query status");
    expect(github.calls).toHaveLength(calls);
    await expect.poll(() => evaluate("document.querySelector('[aria-labelledby=template-repo-title] header button').disabled"), { timeout: 5_000 }).toBe(false);
    await ui("press", "--keys", "Escape");
    await expect.poll(() => evaluate("document.querySelector('[aria-labelledby=template-repo-title]') === null")).toBe(true);
    expect(await evaluate("document.activeElement?.getAttribute('aria-labelledby')")).toBe("share-team-title");
    await ui("press", "--keys", "Escape");
    await expect.poll(() => evaluate("document.querySelector('[aria-labelledby=share-team-title]') === null")).toBe(true);
    await ui("press", "--keys", "Escape");
    await expect.poll(() => evaluate("document.querySelector('[role=dialog]') === null")).toBe(true);
    await open();
    await prepare();
    await evaluate(`(() => { const original = window.fetch.bind(window); let dropped = false; window.fetch = async (...args) => {
      const response = await original(...args);
      if (!dropped && String(args[0]).includes('/publications/') && String(args[0]).endsWith('/publish') && args[1]?.method === 'POST') { dropped = true; throw new TypeError('synthetic lost response'); }
      return response;
    }; return true; })()`);
    await click("Confirm publication");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("The response was interrupted");
    expect(await evaluate("[...document.querySelectorAll('[aria-labelledby=template-repo-title] button')].some(button => button.textContent === 'Confirm publication')")).toBe(false);
    const after = github.calls.length;
    await click("Query status");
    await expect.poll(() => evaluate("document.querySelector('[aria-labelledby=template-repo-title] [role=status]')?.textContent"), { timeout: 10_000 }).toBe('Published');
    expect(github.calls).toHaveLength(after);
    expect(github.pulls).toHaveLength(2);
    const receipt = { ok: true, fixture: info!, layouts, confirmationRequired: true, responseLossQueryOnly: true, screenshots: artifact };
    writeFileSync(`${info!.logPath}.template-publications-ui.json`, JSON.stringify(receipt, null, 2)); console.info(JSON.stringify(receipt));
  } finally { await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }); await broker.close(); }
}, 240_000);
