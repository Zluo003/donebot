import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../../scripts/control-omb.ts";
import { DEVS_REPORTS_FILE } from "../host/devs-reports.ts";
import { startFakeDoneBotGateway } from "../testing/fake-donebot-gateway.ts";
import { hostTimeout } from "../testing/host-timeout.ts";

it("disables upstream @devs reporting and omits report_bug in DoneBot mode", async () => {
  const hits: Array<{ method?: string; url?: string }> = [];
  const bugServer: Server = createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: "unexpected" }));
  });
  await new Promise<void>((resolve) => bugServer.listen(0, "127.0.0.1", resolve));
  const gateway = await startFakeDoneBotGateway();
  const bugUrl = `http://127.0.0.1:${(bugServer.address() as AddressInfo).port}/api/bug-reports`;
  const fixture = await launchVerificationServer(
    { ...process.env, DONEBOT_BUG_REPORT_URL: bugUrl, DONEBOT_DEVS_STATUS_MS: "500" },
    undefined,
    undefined,
    undefined,
    undefined,
    { scripted: true },
    [],
    undefined,
    undefined,
    gateway.origin,
  );
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { origin: fixture.info.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json();
    expect(response.status, JSON.stringify(value)).toBeLessThan(300);
    return value;
  };
  const control = (...args: string[]): Promise<any> => runControlOmb([...args, "--url", fixture.info.url]);
  try {
    await api("POST", "/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-fixture-password" });
    const { bot } = await control("new-bot", "--name", "多宝");
    await control("set-model", "--bot", bot.id, "--instance", "donebot", "--model", "deepseek-flash");
    gateway.setPlan([], "普通回复，不触发上报。");
    const sent = await control("send", "--bot", bot.id, "--text", "@devs 图片加载失败");
    expect((await control("wait", "--bot", bot.id, "--timeout", "30")).status).toBe("settled");
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(hits).toEqual([]);
    expect(existsSync(join(fixture.info.dataDir, DEVS_REPORTS_FILE))).toBe(false);

    const completions = gateway.requests.filter((request) => request.path === "/v1/chat/completions");
    expect(completions.length).toBeGreaterThan(0);
    for (const completion of completions) {
      const body = completion.body as { tools?: Array<{ function?: { name?: string }; name?: string }> };
      const toolNames = (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? "");
      expect(toolNames).not.toContain("report_bug");
      expect(JSON.stringify(completion.body)).not.toContain("this message tags @devs");
    }

    const { bots } = await api("GET", "/api/bots");
    const createdBot = (bots as Array<{ id: string; mainThreadId?: string; threadId?: string }>).find((entry) => entry.id === bot.id);
    const threadId = sent.threadId ?? createdBot?.mainThreadId ?? createdBot?.threadId;
    expect(threadId).toBeTruthy();
    const { messages } = await api("GET", `/api/threads/${threadId}/messages?limit=50`);
    expect(messages.some((row: any) => Boolean(row.bugReport))).toBe(false);
    expect(messages.some((row: any) => String(row.tool?.name ?? "").includes("Sent to the DoneBot team"))).toBe(false);
  } finally {
    await fixture.close();
    await gateway.close();
    await new Promise<void>((resolve) => bugServer.close(() => resolve()));
  }
}, hostTimeout(120_000));
