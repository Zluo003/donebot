// A coordinator that says it handed work off while its turn called no tool, through a real harness server and the fake
// Claude engine: the harness asks it once, in a hidden continuation, to actually dispatch.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../../scripts/control-omb.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { DISPATCH_CORRECTION_ACTIVITY } from "./dispatch-claim-guard.ts";

it("asks a coordinator that claimed a hand-off without a tool call to dispatch for real, once", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-dispatch-claim-"));
  const promptLog = join(scratch, "prompts.jsonl");
  const fixture = await launchVerificationServer({
    FAKE_CLAUDE_REPLIES: JSON.stringify(["好的，已安排造型师出图，完成后向您汇报。", "刚才确实没有派出去，我先确认一下需求。"]),
    FAKE_CLAUDE_REPLY_STATE: join(scratch, "reply-state"),
    FAKE_CLAUDE_TOOL_CALLS: "[]",
    FAKE_CLAUDE_PROMPTS: promptLog,
  });
  const api = async (method: string, path: string, body?: unknown, expected?: number) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    if (expected !== undefined) expect(response.status, JSON.stringify(result)).toBe(expected);
    return { status: response.status, result };
  };
  const prompts = (): string[] => existsSync(promptLog) ? readFileSync(promptLog, "utf8").trim().split("\n").map((line) => {
    const content = JSON.parse(line)?.message?.content;
    return Array.isArray(content) ? content.map((block: { text?: string }) => block.text ?? "").join("\n") : String(content ?? "");
  }) : [];
  try {
    const bots = (await api("GET", "/api/bots?messages=0", undefined, 200)).result.bots as any[];
    let chief = bots.find((bot) => bot.chiefOfStaff && !bot.section);
    if (!chief) {
      chief = (await api("POST", "/api/bots", { name: "多宝" }, 201)).result.bot;
      await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
      chief = ((await api("GET", "/api/bots?messages=0", undefined, 200)).result.bots as any[]).find((bot) => bot.id === chief.id);
    }
    expect(chief?.chiefOfStaff, "the fixture needs a System Coordinator").toBe(true);
    await api("POST", "/api/bots", { name: "造型师" }, 201);

    const transcript = async (): Promise<any[]> => (await api("GET", `/api/threads/${chief.threadId}/messages`, undefined, 200)).result.messages;
    await api("POST", `/api/bots/${chief.id}/messages`, { threadId: chief.threadId, text: "帮我画一张皮克斯风格的卡通女子" }, 202);

    await expect.poll(async () => (await transcript()).some((m) => m.role === "bot" && m.text === "刚才确实没有派出去，我先确认一下需求。"),
      { timeout: 30_000 }).toBe(true);
    const rows = await transcript();
    expect(rows.filter((m) => m.kind === "activity" && m.tool?.name === DISPATCH_CORRECTION_ACTIVITY)).toHaveLength(1);
    expect(rows.filter((m) => m.role === "user" && m.kind === "text").map((m) => m.text)).toEqual(["帮我画一张皮克斯风格的卡通女子"]);
    const sent = prompts();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("coordinate_bots");
    expect(sent[1]).toContain("没有调用任何工具");

    // The correction's own reply makes no claim, and a hidden continuation is never itself corrected: no third turn.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(prompts()).toHaveLength(2);
  } finally {
    await fixture.close();
    await removeTempDir(scratch);
  }
}, 90_000);
