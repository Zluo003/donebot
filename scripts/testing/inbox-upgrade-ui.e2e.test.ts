import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

(process.env.DONEBOT_UI_E2E === "1" ? it : it.skip)("pins conversations and reopens read results from Done on desktop and a phone sheet", async () => {
  const child = spawn(process.execPath, ["--experimental-strip-types", "scripts/control-omb.ts", "ui", "launch"], {
    cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { errors += String(chunk); });
  let info: { ui: string; url: string; botId: string; logPath: string };
  try {
    await expect.poll(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(errors);
      try { info = JSON.parse(output); return Boolean(info.ui); } catch { return false; }
    }, { timeout: 180_000 }).toBe(true);
    const api = async (path: string, body?: unknown, method = "POST") => {
      const response = await fetch(info.url + path, body === undefined ? {} : {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await response.json();
      expect(response.ok, JSON.stringify(result)).toBe(true);
      return result;
    };
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<any>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    await expect.poll(() => evaluate('!!document.querySelector(\'textarea[aria-label="Message Pepper"]\')'), { timeout: 30_000 }).toBe(true);
    await ui("type", "--name", "Message Pepper", "--text", "Remember this inbox fixture conversation");
    await ui("press", "--keys", "Enter");
    const settled = await ui("wait-settle", "--timeout", "60");
    const pepper = (await api("/api/bots")).bots.find((bot: any) => bot.id === info.botId);
    await api(`/api/bots/${pepper.id}/tasks/${pepper.threadId}`, { pinned: true, title: "Inbox pinned fixture" }, "PATCH");
    const { bot: reporter } = await api("/api/bots", { name: "Inbox Reporter" });
    const { routine } = await api("/api/routines", {
      name: "Inbox result fixture", prompt: "Produce the inbox fixture result", botId: reporter.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    });
    const { run } = await api(`/api/routines/${routine.id}/run`, {});
    let completed = run;
    await expect.poll(async () => { completed = (await api("/api/routines")).runs.find((one: any) => one.id === run.id); return completed?.status; }, { timeout: 45_000 }).toBe("completed");
    const inbox = () => api("/api/inbox");
    await expect.poll(async () => (await inbox()).rows.some((row: any) => row.kind === "result"), { timeout: 15_000 }).toBe(true);
    const report = (await inbox()).rows.find((row: any) => row.kind === "result");
    expect(report).toBeDefined();
    expect(report.origin.messageId).toBeTruthy();
    const snapshot = await ui("snapshot");
    const entry = Object.entries(snapshot.refs as Record<string, { role: string; name: string }>).find(([, value]) => value.role === "button" && /^Inbox(?:$|,)/.test(value.name));
    expect(entry, snapshot.snapshot).toBeDefined();
    await ui("click", "--ref", "@" + entry![0]);
    await expect.poll(() => evaluate('document.querySelector("[data-inbox-pinned]")?.textContent ?? ""')).toContain("Inbox pinned fixture");
    await expect.poll(() => evaluate(`!!document.querySelector('[data-inbox-row="${report.id}"] button')`)).toBe(true);
    const before = await ui("snapshot");
    await evaluate(`document.querySelector('[data-inbox-row="${report.id}"] button').click()`);
    await expect.poll(async () => (await inbox()).rows.find((row: any) => row.id === report.id)?.tab).toBe("done");
    await expect.poll(() => evaluate(`!!document.querySelector('[data-mid="${report.origin.messageId}"]')`)).toBe(true);
    await expect.poll(() => evaluate('!!document.querySelector("[data-inbox-done-toggle]")')).toBe(true);
    await evaluate('document.querySelector("[data-inbox-done-toggle]").click()');
    await expect.poll(() => evaluate(`!!document.querySelector('[data-inbox-done] [data-inbox-row="${report.id}"]')`)).toBe(true);
    const evidence = join(ROOT, "output/playwright/inbox-upgrade");
    mkdirSync(evidence, { recursive: true });
    await ui("screenshot", "--out", join(evidence, "desktop.png"));
    const desktop = await ui("snapshot");
    await evaluate('document.querySelector("[data-inbox-unpin]").click()');
    await expect.poll(async () => (await api("/api/bots")).bots.find((bot: any) => bot.id === pepper.id).tasks.find((task: any) => task.threadId === pepper.threadId).pinned ?? false).toBe(false);
    await evaluate('const frame = document.createElement("iframe"); frame.id="fixture-phone"; frame.style="position:fixed;inset:0;width:390px;height:100vh;z-index:9999;background:white"; frame.src=location.href; document.body.append(frame); true');
    await expect.poll(() => evaluate('!!document.querySelector("#fixture-phone")?.contentDocument?.querySelector("[data-sidebar-inbox]")'), { timeout: 30_000 }).toBe(true);
    await evaluate('document.querySelector("#fixture-phone").contentDocument.querySelector("[data-sidebar-inbox]").click()');
    await expect.poll(() => evaluate('!!document.querySelector("#fixture-phone").contentDocument.querySelector(\'[data-inbox-panel="sheet"]\')')).toBe(true);
    const geometry = await evaluate('const doc=document.querySelector("#fixture-phone").contentDocument; const panel=doc.querySelector("[data-inbox-panel]"); ({ viewport:doc.documentElement.clientWidth, width:panel.getBoundingClientRect().width, overflow:doc.documentElement.scrollWidth })');
    expect(geometry.width).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.overflow).toBeLessThanOrEqual(geometry.viewport);
    await evaluate('document.querySelector("#fixture-phone").contentDocument.querySelector("[data-inbox-done-toggle]").click()');
    await expect.poll(() => evaluate(`!!document.querySelector("#fixture-phone").contentDocument.querySelector('[data-inbox-done] [data-inbox-row="${report.id}"]')`)).toBe(true);
    await ui("screenshot", "--out", join(evidence, "phone.png"));
    const consoleOutput = await ui("console");
    writeFileSync(join(evidence, "receipt.json"), JSON.stringify({ settled, before, desktop, geometry, report, consoleOutput, logPath: info.logPath }, null, 2));
    expect(JSON.stringify(consoleOutput)).not.toContain('"type":"error"');
    console.log("Inbox UI evidence:", join(evidence, "receipt.json"));
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
  }
}, 240_000);
