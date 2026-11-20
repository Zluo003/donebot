import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { runControlOmb } from "../scripts/control-omb.ts";
import type { RoutineRun } from "./routines.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";

it("filters before execution, continues after restart, fences duplicate deliveries and starts fresh after deletion", async () => {
  const fixture = await launchRestartableServer({ scripted: true });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.url}${path}`, { method, headers: { origin: fixture.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000) });
    const value = await response.json();
    expect(response.ok, `${method} ${path}: ${JSON.stringify(value)}`).toBe(true);
    return value as any;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.url]) as Promise<any>;
  const runs = async (): Promise<RoutineRun[]> => (await api("GET", "/api/routines")).runs;
  const completed = async (id: string) => {
    await expect.poll(async () => (await runs()).find(run => run.id === id)?.status, { timeout: 30_000 }).toBe("completed");
    return (await runs()).find(run => run.id === id)!;
  };
  try {
    const { bot } = await cli("new-bot", "--name", "Event reviewer");
    writeFileSync(fixture.planPath, JSON.stringify({ [bot.id]: { script: [
      { key: "first", match: ["event-first"], reply: "First event result retained." },
      { key: "second", match: ["event-second"], expectContextIncludes: ["First event result retained."], reply: "Continued with the first result." },
      { key: "third", match: ["event-third"], reply: "Fresh event conversation." },
      { key: "off", match: ["event-off"], reply: "Independent event conversation." },
      { key: "manual", match: ["manual-marker"], reply: "Manual unfiltered test." },
    ] } }));
    const created = await api("POST", "/api/webhooks", { name: "Accepted main events", prompt: "Review the event.", botId: bot.id,
      sameConversation: true, payloadFilter: { action: "accepted", "base.ref": "main" } });
    const send = async (id: string, action = "accepted") => {
      const response = await fetch(created.credential.url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": id },
        body: JSON.stringify({ marker: id, action, base: { ref: "MAIN" } }), signal: AbortSignal.timeout(5_000) });
      expect(response.status).toBe(202);
      return await response.json() as { runId: string; ignored?: boolean; duplicate?: boolean };
    };
    expect(await send("event-ignored", "rejected")).toMatchObject({ ignored: true });
    expect(await runs()).toHaveLength(0);
    expect((await api("GET", "/api/webhooks")).attempts).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "ignored" })]));
    const firstReceipt = await send("event-first");
    const first = await completed(firstReceipt.runId);
    await fixture.stop();
    await fixture.start();
    expect(await send("event-first")).toMatchObject({ duplicate: true, runId: first.id });
    const second = await completed((await send("event-second")).runId);
    expect(second.threadId).toBe(first.threadId);
    const messages = (await api("GET", `/api/threads/${second.threadId}/messages?limit=200`)).messages;
    expect(messages.some((message: any) => message.text?.includes("First event result retained."))).toBe(true);
    expect(messages.some((message: any) => message.text?.includes("Continued with the first result."))).toBe(true);
    await api("DELETE", `/api/bots/${bot.id}/tasks/${second.threadId}`);
    const third = await completed((await send("event-third")).runId);
    expect(third.threadId).not.toBe(second.threadId);
    await api("PATCH", `/api/webhooks/${created.webhook.id}`, { sameConversation: false });
    const off = await completed((await send("event-off")).runId);
    expect(off.threadId).not.toBe(third.threadId);
    const manual = await api("POST", `/api/webhooks/${created.webhook.id}/test`, { payload: { action: "rejected", marker: "manual-marker" } });
    await completed(manual.runId);
    const evidence = readFileSync(`${fixture.planPath}.evidence.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(evidence.filter(turn => turn.botId === bot.id).map(turn => turn.planKey)).toEqual(["first", "second", "third", "off", "manual"]);
    expect((await runs()).filter(run => run.webhookId === created.webhook.id)).toHaveLength(5);
    writeFileSync(`${fixture.logPath}.continuity.json`, JSON.stringify({ first, second, third, off, evidence }, null, 2));
    console.info(JSON.stringify({ logPath: fixture.logPath, evidencePath: `${fixture.logPath}.continuity.json` }));
  } finally { await fixture.close(); }
}, 120_000);
