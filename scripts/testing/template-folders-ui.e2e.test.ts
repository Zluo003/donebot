import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parsePackageDocument } from "../../shared/package-format.ts";
import { writeShareFolder } from "../../shared/share-folder.ts";
import { startBrokerFake } from "../../server/testing/broker-fake.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { request } from "../mcp-server.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.DONEBOT_UI_E2E === "1";

(enabled ? it : it.skip)("previews a selected template folder and requires an explicit private GitHub account in the real renderer", async () => {
  const broker = await startBrokerFake();
  let child: ChildProcess | undefined;
  const owner = await broker.install();
  broker.account(owner.userId, "github", "personal");
  broker.account(owner.userId, "github", "work");
  broker.account("not-this-user", "github", "FOREIGN_ACCOUNT");
  const pkg = parsePackageDocument({ format: "openmaus.package", version: 2, package: {
    id: "folder-helper", release: "1.0.0", name: "Folder helper", tagline: "Review files.", summary: "A folder template.", category: "Testing", author: { name: "Fixture" }, license: "MIT", outcomes: ["Review."], setupMinutes: 2,
    requirements: { apps: [], capabilities: [] }, team: { name: "Folder helper" },
    agents: [{ key: "helper", name: "Folder helper", appearance: { color: "blue" }, skills: ["report"] }],
    skills: { version: 1, entries: [{ name: "report", description: "Report steps.", instructions: "---\nname: report\ndescription: Report steps.\n---\nRead scripts/report.py.\n", files: [{ path: "scripts/report.py", content: "print('FOLDER_SCRIPT_MUST_NOT_RUN')\n" }] }] },
  } });
  try {
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
    const before = await request("/api/bots", {}, info!.url);
    await click("Open templates");
    await click("Import");
    await click("Use a connected GitHub account (private repositories)");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain('option "work"');
    expect(await snapshot()).not.toContain("FOREIGN_ACCOUNT");
    expect(await evaluate("document.querySelector('[role=dialog] select').value")).toBe("");
    await ui("type", "--name", "GitHub team URL", "--text", "https://github.com/fixture/private");
    expect(await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent === 'Load').disabled")).toBe(true);
    await evaluate(`(() => {
      const select = document.querySelector('[role=dialog] select');
      select.focus();
      const value = [...select.options].find(option => option.text === 'work').value;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await expect.poll(() => evaluate("document.querySelector('[role=dialog] select').value"), { timeout: 5_000 }).not.toBe("");
    const artifact = join(ROOT, "output/playwright/template-folders");
    mkdirSync(artifact, { recursive: true });
    await ui("screenshot", "--out", join(artifact, "github-accounts.png"));
    const files = writeShareFolder(pkg, "bot");
    await evaluate(`(() => {
      const input = document.querySelector('input[webkitdirectory]');
      const transfer = new DataTransfer();
      for (const [path, content] of Object.entries(${JSON.stringify(files)})) {
        const file = new File([content], path.split('/').at(-1));
        Object.defineProperty(file, 'webkitRelativePath', { value: 'helper/' + path });
        transfer.items.add(file);
      }
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Supporting skill files (1)");
    expect(await request("/api/bots", {}, info!.url)).toEqual(before);
    await ui("screenshot", "--out", join(artifact, "folder-preview.png"));
    await click("Add team");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Added Folder helper");
    const added = (await request("/api/bots", {}, info!.url)).bots.find((bot: { name: string }) => bot.name === "Folder helper");
    expect((await request(`/api/bots/${added.id}/skills`, {}, info!.url)).skills).toMatchObject([{ name: "report", enabled: false }]);
    const receipt = { ok: true, fixture: info!, folderPreviewBeforeWrites: true, explicitAccountSelection: true, skillsDisabled: true, artifacts: artifact };
    writeFileSync(`${info!.logPath}.template-folders-ui.json`, JSON.stringify(receipt, null, 2));
    console.info(JSON.stringify(receipt));
  } finally { await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }); await broker.close(); }
}, 240_000);
