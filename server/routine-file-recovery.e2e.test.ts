import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { runControlOmb } from "../scripts/control-omb.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";

it("preserves unreadable routines, refuses mutations and resumes once after the file is repaired", async () => {
  const fixture = await launchRestartableServer({ scripted: true });
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.url}${path}`, {
      method, headers: { origin: fixture.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const result = await request(method, path, body);
    expect(result.status, JSON.stringify(result.body)).toBeLessThan(300);
    return result.body;
  };
  const file = join(fixture.dataDir, "routines.json");
  const sentinel = "fixture-private-unreadable-9be4b6b6";
  const broken = `{"routines":[{"prompt":"${sentinel}"`;
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "Recovery reviewer", "--url", fixture.url]) as any;
    writeFileSync(fixture.planPath, JSON.stringify({ [bot.id]: { script: [
      { key: "recovered", match: ["recovery-check-once"], reply: "The repaired routine ran once." },
    ] } }));
    const input = { name: "Recovery check", prompt: "recovery-check-once", botId: bot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } };
    const { routine } = await api("POST", "/api/routines", input);
    await fixture.stop();
    const original = readFileSync(file, "utf8");
    writeFileSync(file, broken);
    await fixture.start();
    expect(await api("GET", "/api/config")).toMatchObject({ routinesUnreadable: true });
    const rejected = await request("POST", "/api/routines", input);
    expect(rejected).toMatchObject({ status: 503, body: { error: "Saved routines could not be read. Repair routines.json before changing them." } });
    expect(readFileSync(file, "utf8")).toBe(broken);
    const copies = readdirSync(fixture.dataDir).filter(name => name.startsWith("routines.json.unreadable-"));
    expect(copies).toHaveLength(1);
    const aside = join(fixture.dataDir, copies[0]);
    expect(readFileSync(aside, "utf8")).toBe(broken);
    if (process.platform !== "win32") expect(statSync(aside).mode & 0o777).toBe(0o600);
    writeFileSync(file, original);
    await expect.poll(async () => (await api("GET", "/api/config")).routinesUnreadable, { timeout: 75_000, interval: 500 }).not.toBe(true);
    expect((await api("GET", "/api/routines")).routines).toEqual(expect.arrayContaining([expect.objectContaining({ id: routine.id, enabled: false })]));
    const { run } = await api("POST", `/api/routines/${routine.id}/run`);
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((item: any) => item.id === run.id)?.status, { timeout: 30_000 }).toBe("completed");
    await fixture.stop();
    await fixture.start();
    expect((await api("GET", "/api/routines")).runs.filter((item: any) => item.routineId === routine.id)).toHaveLength(1);
    const evidence = readFileSync(`${fixture.planPath}.evidence.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(evidence.filter(turn => turn.botId === bot.id).map(turn => turn.planKey)).toEqual(["recovered"]);
    expect(readFileSync(fixture.logPath, "utf8")).not.toContain(sentinel);
    writeFileSync(`${fixture.logPath}.routine-file.json`, JSON.stringify({ routineId: routine.id, runId: run.id, rejected, recovered: true, evidence }, null, 2));
    console.info(JSON.stringify({ logPath: fixture.logPath, evidencePath: `${fixture.logPath}.routine-file.json` }));
  } finally { await fixture.close(); }
}, 150_000);
