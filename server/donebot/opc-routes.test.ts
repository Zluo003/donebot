import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotRecord, Store } from "../store.ts";
import type { DoneBotGateway } from "./gateway.ts";
import { DoneBotMarketInstallStore, attachMarketHeaders, MARKET_BOT_ID_HEADER, MARKET_INSTALL_HEADER } from "./market-installs.ts";
import { createDoneBotOpcRoutes } from "./opc-routes.ts";
import { DoneBotOpcStore } from "./opc-store.ts";
import { evaluateRewakeThrottle } from "./paperclip-rewake-throttle.ts";

const tempDirs: string[] = [];
function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "donebot-opc-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function callRoute(
  handler: ReturnType<typeof createDoneBotOpcRoutes>,
  method: string,
  path: string,
  body?: unknown,
) {
  let status = 0;
  let payload: unknown;
  const headers: Record<string, string> = {};
  const url = new URL(`http://127.0.0.1${path}`);
  const result = await handler({
    req: {} as IncomingMessage,
    res: {
      headersSent: false,
      setHeader(name: string, val: string) { headers[name] = val; },
      destroy() {},
    } as unknown as ServerResponse,
    url,
    path: url.pathname,
    method,
    auth: { kind: "loopback", scopes: ["admin"] },
    json(_res: unknown, code: number, value: unknown) { status = code; payload = value; },
    readBody: async () => body ?? {},
  } as unknown as Parameters<typeof handler>[0]);
  return { result, status, payload };
}

describe("OPC Store, Studio Attribution & Routes", () => {
  it("attaches both X-DoneBot-Market-Install and X-DoneBot-Bot-Id headers and supports multi-bot studio bindings", () => {
    const dir = makeTempDir();
    const installs = new DoneBotMarketInstallStore(join(dir, "installs.json"));
    const exp = new Date(Date.now() + 86400_000).toISOString();
    installs.setMany([
      { botId: "bot-a", installId: "inst-1", listingId: "list-studio", releaseId: "rel-1", version: 1, installToken: "tok_studio_0123456789abcdef", expiresAt: exp, installedAt: 100 },
      { botId: "bot-b", installId: "inst-1", listingId: "list-studio", releaseId: "rel-1", version: 1, installToken: "tok_studio_0123456789abcdef", expiresAt: exp, installedAt: 100 },
    ]);
    expect(installs.getActiveToken("bot-a")).toBe("tok_studio_0123456789abcdef");
    expect(installs.getActiveToken("bot-b")).toBe("tok_studio_0123456789abcdef");
    const pub = installs.publicByListing(new Set(["bot-a", "bot-b"]));
    expect(pub["list-studio"]?.bot_ids).toEqual(["bot-a", "bot-b"]);

    const init = attachMarketHeaders({ method: "POST" }, { installToken: "tok_studio_0123456789abcdef", botId: "bot-a" });
    const headers = new Headers(init.headers);
    expect(headers.get(MARKET_INSTALL_HEADER)).toBe("tok_studio_0123456789abcdef");
    expect(headers.get(MARKET_BOT_ID_HEADER)).toBe("bot-a");
  });

  it("applies Paperclip rewake throttle on consecutive no-progress runs", () => {
    const now = new Date("2026-11-24T02:00:00Z");
    const decision = evaluateRewakeThrottle({
      now,
      recentTerminalRuns: [
        { id: "r2", status: "succeeded", finishedAt: new Date("2026-11-24T01:59:30Z") },
        { id: "r1", status: "succeeded", finishedAt: new Date("2026-11-24T01:55:00Z") },
      ],
      runIdsWithProgress: new Set(),
      hasNewInputSinceLastRun: false,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) expect(decision.noProgressStreak).toBe(2);
  });

  it("handles Goals + Goal Ancestry prompt fencing, Artifacts review dispatch, Snapshots rollback, Golden Evals, and Silent Heartbeat circuit breaker", async () => {
    const dir = makeTempDir();
    const opcStore = new DoneBotOpcStore(join(dir, "opc.json"));

    let botSoul = "你是资深自媒体主编，严格输出爆款标题与结构化大纲。";
    const skillContents = new Map<string, { description: string; instructions: string; enabled: boolean }>([
      ["copywriting", { description: "爆款写作", instructions: "# Copywriting\n写出吸睛开头。", enabled: true }],
    ]);
    const bot: BotRecord = {
      id: "bot-1",
      name: "主编小墨",
      title: "内容总监",
      description: "负责自媒体内容",
      color: "blue",
      soul: botSoul,
      threadId: "thread-1",
      tasks: [{ threadId: "thread-1", title: "本周选题", createdAt: 1000 } as NonNullable<BotRecord["tasks"]>[number]],
      modelSelection: { instanceId: "donebot", model: "deepseek-chat" },
    } as BotRecord;

    const messages = [
      { id: "m1", role: "user", kind: "text", text: "请生成一张小红书封面图", at: 1000 },
      {
        id: "m2",
        role: "bot",
        kind: "text",
        text: "封面图已生成",
        at: 2000,
        requestMessageId: "m1",
        attachments: [{ kind: "image", path: "/tmp/cover-v1.png", name: "cover-v1.png", mime: "image/png" }],
      },
    ];

    const store = {
      bots: [bot],
      bot: (id: string) => (id === bot.id ? bot : undefined),
      patchBot: (_id: string, patch: Partial<BotRecord>) => {
        if (patch.soul !== undefined) { bot.soul = patch.soul; botSoul = patch.soul; }
        if (patch.title !== undefined) bot.title = patch.title;
        if (patch.description !== undefined) bot.description = patch.description;
      },
      messagesFor: () => messages,
    } as unknown as Store;

    const startTurn = vi.fn();
    let genMode: "eval" | "silent" | "action" | "error" = "eval";
    const generateBotText = vi.fn(async (_botId: string, prompt: string) => {
      if (genMode === "error") throw new Error("upstream 502");
      if (genMode === "silent") return "[SILENT_OK] 竞品今日无更新";
      if (genMode === "action") return "发现竞品发布新品，建议立即跟进评测";
      return `实测回复（针对：${prompt.slice(-16)}）`;
    });

    const gateway = {
      collabCtx: () => ({
        origin: "https://donebot.cn",
        epoch: () => 1,
        checkEpoch: () => {},
        controllers: new Set(),
        validSession: async () => ({ mode: "user" as const, accessToken: "jwt-123" }),
        fetcher: async () => new Response(JSON.stringify({
          code: 0,
          data: {
            days: 30,
            total_cost: 8.5,
            llm_cost: 6.0,
            image_cost: 2.5,
            video_cost: 0,
            music_cost: 0,
            bots: [{ bot_id: "bot-1", total_cost: 8.5, llm_cost: 6.0, image_cost: 2.5, video_cost: 0, music_cost: 0, event_count: 4, last_used_at: "2026-11-24T01:00:00Z" }],
          },
        }), { status: 200, headers: { "content-type": "application/json" } }),
        readGatewayJson: async (r: Response) => r.json(),
      }),
    } as unknown as DoneBotGateway;

    const handler = createDoneBotOpcRoutes({
      opcStore,
      gateway,
      store,
      listBotSkills: () => [...skillContents.entries()].map(([name, s]) => ({ name, description: s.description, enabled: s.enabled }) as never),
      readBotSkill: (_b, name) => skillContents.get(name)?.instructions ?? null,
      installBotSkill: (_b, _src, files) => {
        const md = files[0]?.content ?? "";
        const name = md.includes("Copywriting") ? "copywriting" : "restored";
        skillContents.set(name, { description: "", instructions: md, enabled: true });
        return { name, enabled: true } as never;
      },
      setBotSkillEnabled: (_b, name, enabled) => {
        const cur = skillContents.get(name);
        if (cur) cur.enabled = enabled;
        return { name, enabled } as never;
      },
      removeBotSkill: (_b, name) => { skillContents.delete(name); },
      generateBotText,
      startTurn,
      broadcast: vi.fn(),
      publicBot: (b) => b,
      startScheduler: false,
    });

    // 1. Project Goal Card & Goal Ancestry prompt fencing
    const goalRes = await callRoute(handler, "PUT", "/api/donebot/opc/goals", {
      botId: "bot-1",
      title: "12月小红书增长冲刺",
      objective: "本周产出 5 篇干货图文并配齐 1:1 封面",
      redlines: ["禁止出现 ``` 水印或竞品敏感词"],
      deliverables: [{ title: "首篇封面定稿", done: false }],
    });
    expect(goalRes.status).toBe(200);
    const goalPrompt = opcStore.goalPromptForBot("bot-1");
    expect(goalPrompt).toContain("12月小红书增长冲刺");
    expect(goalPrompt).toContain("````text"); // Dynamic backtick fence protects against ``` in redlines!

    // 2. Artifacts Gallery + Boss Review Gate + Revision Dispatch
    const artRes = await callRoute(handler, "GET", "/api/donebot/opc/artifacts?botId=bot-1");
    expect(artRes.status).toBe(200);
    const items = (artRes.payload as { items: Array<{ id: string; reviewStatus: string; version: number }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.reviewStatus).toBe("pending");
    expect(items[0]?.version).toBe(1);

    const revRes = await callRoute(handler, "POST", `/api/donebot/opc/artifacts/${items[0]!.id}/review`, {
      botId: "bot-1",
      status: "changes_requested",
      note: "字号放大一点，背景更克制",
      artifactTitle: "小红书封面图",
    });
    expect(revRes.status).toBe(200);
    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(startTurn.mock.calls[0]?.[1]).toContain("字号放大一点，背景更克制");

    // 3. Snapshots & Rollback (with auto before_restore safety snapshot)
    const snapRes = await callRoute(handler, "POST", "/api/donebot/opc/bots/bot-1/snapshots", { label: "稳定版 v1" });
    expect(snapRes.status).toBe(200);
    const snapId = (snapRes.payload as { snapshot: { id: string } }).snapshot.id;
    bot.soul = "改坏了的新版 SOUL";
    const restoreRes = await callRoute(handler, "POST", `/api/donebot/opc/bots/bot-1/snapshots/${snapId}/restore`, {});
    expect(restoreRes.status).toBe(200);
    expect(botSoul).toBe("你是资深自媒体主编，严格输出爆款标题与结构化大纲。");
    expect(opcStore.listSnapshots("bot-1").length).toBe(2); // original + before_restore backup

    // 4. Skill Studio Golden Evals (via Paperclip eval-kernel)
    const saveCases = await callRoute(handler, "PUT", "/api/donebot/opc/bots/bot-1/evals/cases", {
      cases: [{ title: "标题起稿", prompt: "为 OPC 一人公司写 3 个小红书爆款标题" }],
    });
    expect(saveCases.status).toBe(200);
    const runEval = await callRoute(handler, "POST", "/api/donebot/opc/bots/bot-1/evals/run", {});
    expect(runEval.status).toBe(200);
    const evalPayload = runEval.payload as { run: { results: Array<{ status: string }> }; verifiedSamples: unknown[] };
    expect(evalPayload.run.results[0]?.status).toBe("ok");
    expect(evalPayload.verifiedSamples).toHaveLength(1);

    // 5. Silent Heartbeat + Runaway Consecutive-Failure Circuit Breaker (NO budget alerts)
    const hbCreate = await callRoute(handler, "POST", "/api/donebot/opc/heartbeats", {
      botId: "bot-1",
      name: "竞品动态巡检",
      prompt: "检查目标竞品是否有新动作",
      intervalMinutes: 60,
      silentWhenOk: true,
      maxConsecutiveFailures: 2,
    });
    expect(hbCreate.status).toBe(200);
    const hbId = (hbCreate.payload as { heartbeat: { id: string } }).heartbeat.id;

    genMode = "silent";
    const silentRun = await callRoute(handler, "POST", `/api/donebot/opc/heartbeats/${hbId}/run`, {});
    expect((silentRun.payload as { heartbeat: { lastOutcome: string } }).heartbeat.lastOutcome).toBe("silent_ok");
    expect(startTurn).toHaveBeenCalledTimes(1); // Did NOT spam chat!

    genMode = "action";
    const actionRun = await callRoute(handler, "POST", `/api/donebot/opc/heartbeats/${hbId}/run`, {});
    expect((actionRun.payload as { heartbeat: { lastOutcome: string } }).heartbeat.lastOutcome).toBe("action_needed");
    expect(startTurn).toHaveBeenCalledTimes(2); // Surfaced actionable report!

    genMode = "error";
    await callRoute(handler, "POST", `/api/donebot/opc/heartbeats/${hbId}/run`, {});
    const tripped = await callRoute(handler, "POST", `/api/donebot/opc/heartbeats/${hbId}/run`, {});
    const hbTripped = (tripped.payload as { heartbeat: { pausedByCircuitBreaker: boolean; enabled: boolean; lastOutcome: string } }).heartbeat;
    expect(hbTripped.pausedByCircuitBreaker).toBe(true);
    expect(hbTripped.enabled).toBe(false);
    expect(hbTripped.lastOutcome).toBe("paused_circuit_breaker");

    const reset = await callRoute(handler, "POST", `/api/donebot/opc/heartbeats/${hbId}/reset-breaker`, { reenable: true });
    expect((reset.payload as { heartbeat: { pausedByCircuitBreaker: boolean; enabled: boolean } }).heartbeat.pausedByCircuitBreaker).toBe(false);
    expect((reset.payload as { heartbeat: { pausedByCircuitBreaker: boolean; enabled: boolean } }).heartbeat.enabled).toBe(true);

    // 6. Boss Overview & Real Per-Bot Spend Summary
    const ov = await callRoute(handler, "GET", "/api/donebot/opc/overview?days=30");
    expect(ov.status).toBe(200);
    const ovData = ov.payload as { activeGoalCount: number; spend: { available: boolean; totalCost: number; bots: Array<{ botName: string }> } };
    expect(ovData.activeGoalCount).toBe(1);
    expect(ovData.spend.available).toBe(true);
    expect(ovData.spend.totalCost).toBe(8.5);
    expect(ovData.spend.bots[0]?.botName).toBe("主编小墨");

    handler.stopScheduler();
  });
});
