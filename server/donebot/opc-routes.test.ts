import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotRecord, Store } from "../store.ts";
import type { DoneBotGateway } from "./gateway.ts";
import { DoneBotMarketInstallStore, attachMarketHeaders, MARKET_BOT_ID_HEADER, MARKET_INSTALL_HEADER } from "./market-installs.ts";
import { createDoneBotOpcRoutes } from "./opc-routes.ts";
import { createDoneBotOrgWorkflowRoutes, DoneBotOrgWorkflowStore } from "./opc-org-workflow.ts";
import { BOSS_FORMAL_REPORT_RULE } from "./opc-org-policy.ts";
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
  auth: unknown = { kind: "loopback", scopes: ["admin"] },
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
    auth,
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
    const skillContents = new Map<string, { description: string; instructions: string; enabled: boolean; files?: Array<{ path: string; content: string }> }>([
      ["copywriting", {
        description: "爆款写作",
        instructions: "# Copywriting\n写出吸睛开头。",
        enabled: true,
        files: [
          { path: "scripts/format.py", content: "print('formatted')\n" },
          { path: "references/hooks.md", content: "# Hooks\n先给反常识结论。\n" },
        ],
      }],
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
      readBotSkillFiles: (_b, name) => skillContents.get(name)?.files ?? [],
      installBotSkill: (_b, _src, files) => {
        const md = files[0]?.content ?? "";
        const name = md.includes("Copywriting") ? "copywriting" : "restored";
        skillContents.set(name, {
          description: "",
          instructions: md,
          enabled: true,
          files: files.slice(1).map(f => ({ path: f.path, content: String(f.content) })),
        });
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

    // 3. Snapshots & Rollback (with auto before_restore safety snapshot & bundled skill support files)
    const snapRes = await callRoute(handler, "POST", "/api/donebot/opc/bots/bot-1/snapshots", { label: "稳定版 v1" });
    expect(snapRes.status).toBe(200);
    const snapPayload = snapRes.payload as { snapshot: { id: string; skills: Array<{ name: string; files?: Array<{ path: string; content: string }> }> } };
    const snapId = snapPayload.snapshot.id;
    expect(snapPayload.snapshot.skills[0]?.files?.map(f => f.path)).toEqual(["references/hooks.md", "scripts/format.py"]);
    bot.soul = "改坏了的新版 SOUL";
    skillContents.set("copywriting", { description: "改坏", instructions: "# Copywriting\n改坏了", enabled: true, files: [] });
    const restoreRes = await callRoute(handler, "POST", `/api/donebot/opc/bots/bot-1/snapshots/${snapId}/restore`, {});
    expect(restoreRes.status).toBe(200);
    expect(botSoul).toBe("你是资深自媒体主编，严格输出爆款标题与结构化大纲。");
    expect(skillContents.get("copywriting")?.files?.map(f => f.path)).toEqual(["references/hooks.md", "scripts/format.py"]);
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

  it("unifies workflow gates and multi-file reports into single-click Boss formal reports and injects global formal reporting rules", async () => {
    const dir = makeTempDir();
    const opcStore = new DoneBotOpcStore(join(dir, "opc.json"));
    const orgStore = new DoneBotOrgWorkflowStore(join(dir, "org.json"));

    const bot: BotRecord = {
      id: "bot-1",
      name: "船长",
      title: "独立站负责人",
      section: "独立站",
      color: "purple",
      threadId: "thread-wf",
      tasks: [{ threadId: "thread-wf", title: "独立站周报", createdAt: 1000 } as NonNullable<BotRecord["tasks"]>[number]],
      modelSelection: { instanceId: "donebot", model: "deepseek-chat" },
    } as BotRecord;

    const now = Date.now();
    const messages = [
      { id: "m-req", role: "user", kind: "text", text: "请汇总本周独立站复盘并提交老板审批", at: now - 5_000 },
      {
        id: "m-wf",
        role: "bot",
        kind: "text",
        text: "# 独立站第 47 周经营复盘\n\n## 核心结论\n\n本周 GMV 增长 28%，建议通过下周投放加码。",
        at: now - 1_000,
        requestMessageId: "m-req",
        attachments: [
          { kind: "file", path: "/tmp/weekly-report.md", name: "weekly-report.md", mime: "text/markdown" },
          { kind: "image", path: "/tmp/gmv-chart.png", name: "gmv-chart.png", mime: "image/png" },
        ],
      },
    ];

    const store = {
      bots: [bot],
      bot: (id: string) => (id === bot.id ? bot : undefined),
      messagesFor: () => messages,
    } as unknown as Store;

    // 1. Global Boss formal reporting rule is always injected even before configuring org nodes.
    const defaultPrompt = orgStore.orgPromptForBot(bot.id, [bot]);
    expect(defaultPrompt).toContain(BOSS_FORMAL_REPORT_RULE);

    // 2. Create a gated workflow run whose step produced the two attachments above.
    const wf = orgStore.createWorkflow({
      name: "独立站周报流程",
      steps: [{ name: "汇总复盘", botId: bot.id, instruction: "整理本周数据", approvalGate: true }],
    });
    const run = orgStore.saveWorkflowRun({
      id: "run-1",
      workflowId: wf.id,
      workflowName: wf.name,
      trigger: "manual",
      variables: {},
      status: "waiting_approval",
      currentStepIndex: 0,
      stepResults: [{
        stepId: wf.steps[0]!.id,
        stepName: "汇总复盘",
        botId: bot.id,
        botName: bot.name,
        threadId: "thread-wf",
        status: "waiting_approval",
        output: "# 独立站第 47 周经营复盘\n\n## 核心结论\n\n本周 GMV 增长 28%，建议通过下周投放加码。",
        startedAt: now - 4_000,
        finishedAt: now - 500,
      }],
      startedAt: now - 4_000,
    });

    const gateway = {
      collabCtx: () => ({
        origin: "https://donebot.cn",
        epoch: () => 1,
        checkEpoch: () => {},
        controllers: new Set(),
        validSession: async () => ({ mode: "user" as const, accessToken: "jwt-123" }),
        fetcher: async () => new Response(JSON.stringify({ code: 0, data: { days: 30, total_cost: 0, llm_cost: 0, image_cost: 0, video_cost: 0, music_cost: 0, bots: [] } }), { status: 200 }),
        readGatewayJson: async (r: Response) => r.json(),
      }),
    } as unknown as DoneBotGateway;

    const opcHandler = createDoneBotOpcRoutes({
      opcStore,
      orgStore,
      gateway,
      store,
      listBotSkills: () => [],
      readBotSkill: () => null,
      installBotSkill: () => ({ name: "x", enabled: true }) as never,
      setBotSkillEnabled: () => ({ name: "x", enabled: true }) as never,
      removeBotSkill: () => {},
      generateBotText: async () => "",
      startTurn: vi.fn(),
      broadcast: vi.fn(),
      publicBot: (b) => b,
      startScheduler: false,
    });
    const wfHandler = createDoneBotOrgWorkflowRoutes({ orgStore, opcStore, store, enableScheduler: false });

    // Overview bundles the workflow gate + both attachments into ONE report (no duplicate artifact items).
    const before = await callRoute(opcHandler, "GET", "/api/donebot/opc/overview?days=30");
    expect(before.status).toBe(200);
    const beforeData = before.payload as { pendingReportCount: number; pendingArtifactCount: number; pendingReports: Array<{ id: string; source: string; title: string; attachments: Array<{ name: string }>; artifactIds: string[] }> };
    expect(beforeData.pendingReportCount).toBe(1);
    expect(beforeData.pendingArtifactCount).toBe(0);
    expect(beforeData.pendingReports[0]?.source).toBe("workflow");
    expect(beforeData.pendingReports[0]?.title).toBe("独立站第 47 周经营复盘");
    expect(beforeData.pendingReports[0]?.attachments.map(a => a.name).sort()).toEqual(["gmv-chart.png", "weekly-report.md"]);

    // Single approve on the workflow decision approves both the workflow gate and all attached artifacts atomically.
    const decide = await callRoute(wfHandler as unknown as ReturnType<typeof createDoneBotOpcRoutes>, "POST", `/api/donebot/opc/workflow-runs/${run.id}/decision`, { action: "approve" });
    expect(decide.status).toBe(200);

    const after = await callRoute(opcHandler, "GET", "/api/donebot/opc/overview?days=30");
    const afterData = after.payload as {
      pendingReportCount: number;
      pendingArtifactCount: number;
      approvedReportCount: number;
      approvedReports: Array<{ title: string; approvedAt?: number; attachments: Array<{ name: string }> }>;
    };
    expect(afterData.pendingReportCount).toBe(0);
    expect(afterData.pendingArtifactCount).toBe(0);
    expect(afterData.approvedReportCount).toBe(1);
    expect(afterData.approvedReports[0]?.title).toBe("独立站第 47 周经营复盘");
    expect(afterData.approvedReports[0]?.approvedAt).toBeTypeOf("number");
    expect(afterData.approvedReports[0]?.attachments.map(a => a.name).sort()).toEqual(["gmv-chart.png", "weekly-report.md"]);

    // Standalone multi-file bot report (outside workflow) also bundles into 1 item and resolves in 1 click via /reports/review.
    const msg2At = now + 60_000;
    messages.push({
      id: "m-standalone",
      role: "bot",
      kind: "text",
      text: "# 品牌视觉升级方案\n\n## 核心结论\n\n已完成主视觉与规范手册两份交付物。",
      at: msg2At,
      requestMessageId: "m-req",
      attachments: [
        { kind: "file", path: "/tmp/brand-guide.md", name: "brand-guide.md", mime: "text/markdown" },
        { kind: "image", path: "/tmp/kv.png", name: "kv.png", mime: "image/png" },
      ],
    });

    const standaloneOv = await callRoute(opcHandler, "GET", "/api/donebot/opc/overview?days=30");
    const standaloneData = standaloneOv.payload as { pendingReportCount: number; pendingReports: Array<{ id: string; source: string; title: string; artifactIds: string[]; attachments: Array<{ name: string }> }> };
    expect(standaloneData.pendingReportCount).toBe(1);
    expect(standaloneData.pendingReports[0]?.source).toBe("bot_report");
    expect(standaloneData.pendingReports[0]?.title).toBe("品牌视觉升级方案");
    expect(standaloneData.pendingReports[0]?.artifactIds).toHaveLength(2);

    // Ensure distinct approval timestamp so reverse chronological ordering is deterministic.
    await new Promise(resolve => setTimeout(resolve, 10));
    const batchApprove = await callRoute(opcHandler, "POST", "/api/donebot/opc/reports/review", {
      botId: bot.id,
      status: "approved",
      artifactIds: standaloneData.pendingReports[0]!.artifactIds,
      threadId: "thread-wf",
      reportTitle: "品牌视觉升级方案",
    });
    expect(batchApprove.status).toBe(200);
    expect((batchApprove.payload as { reviewedCount: number }).reviewedCount).toBe(2);

    const finalOv = await callRoute(opcHandler, "GET", "/api/donebot/opc/overview?days=30");
    const finalData = finalOv.payload as {
      pendingReportCount: number;
      approvedReportCount: number;
      approvedReports: Array<{ title: string }>;
    };
    expect(finalData.pendingReportCount).toBe(0);
    expect(finalData.approvedReportCount).toBe(2);
    expect(finalData.approvedReports.map(r => r.title)).toEqual([
      "品牌视觉升级方案",
      "独立站第 47 周经营复盘",
    ]);

    opcHandler.stopScheduler();
  });

  it("allows verified personal mobile owner sessions on bounded Boss Desk routes while rejecting other client sessions and team runtime", async () => {
    const dir = makeTempDir();
    const opcStore = new DoneBotOpcStore(join(dir, "opc-state.json"));
    const orgStore = new DoneBotOrgWorkflowStore(join(dir, "opc-org.json"));
    const bot = { id: "bot-m", name: "小助理", color: "blue", threadId: "t-m", tasks: [{ threadId: "t-m", title: "汇报" }] } as unknown as BotRecord;
    const store = {
      bots: [bot],
      bot: (id: string) => (id === bot.id ? bot : undefined),
      messagesFor: () => [],
      updateBot: () => {},
    } as unknown as Store;
    const gateway = { collabCtx: () => null } as unknown as DoneBotGateway;
    const opcHandler = createDoneBotOpcRoutes({
      opcStore, orgStore, gateway, store,
      listBotSkills: () => [], readBotSkill: () => null, installBotSkill: () => ({ name: "x", enabled: true }) as never,
      setBotSkillEnabled: () => ({ name: "x", enabled: true }) as never, removeBotSkill: () => {},
      generateBotText: async () => "", startTurn: vi.fn(), broadcast: vi.fn(), publicBot: b => b, startScheduler: false,
    });
    const wfHandler = createDoneBotOrgWorkflowRoutes({
      orgStore, opcStore, store, runBotTurn: vi.fn(async () => ({ output: "", threadId: "t-m" })), startScheduler: false,
    });

    const mobileOwnerAuth = { kind: "session", via: "bearer", scopes: ["client"], session: { id: "mobile-" + "a".repeat(64) } };
    const regularClientAuth = { kind: "session", via: "bearer", scopes: ["client"], session: { id: "team-member-session-1" } };

    // Personal mobile owner can read Boss overview, but cannot touch goals/heartbeats/org
    expect((await callRoute(opcHandler, "GET", "/api/donebot/opc/overview?days=30", undefined, mobileOwnerAuth)).status).toBe(200);
    expect((await callRoute(opcHandler, "GET", "/api/donebot/opc/goals", undefined, mobileOwnerAuth)).status).toBe(403);
    expect((await callRoute(opcHandler, "GET", "/api/donebot/opc/heartbeats", undefined, mobileOwnerAuth)).status).toBe(403);
    expect((await callRoute(wfHandler, "GET", "/api/donebot/opc/org", undefined, mobileOwnerAuth)).status).toBe(403);
    // Workflow decision route passes auth gate (returns 404 for unknown run instead of 403)
    expect((await callRoute(wfHandler, "POST", "/api/donebot/opc/workflow-runs/missing-run/decision", { action: "approve" }, mobileOwnerAuth)).status).toBe(404);

    // Regular client session is always 403 on Boss Desk
    expect((await callRoute(opcHandler, "GET", "/api/donebot/opc/overview?days=30", undefined, regularClientAuth)).status).toBe(403);
    expect((await callRoute(wfHandler, "POST", "/api/donebot/opc/workflow-runs/missing-run/decision", { action: "approve" }, regularClientAuth)).status).toBe(403);

    // Under team runtime, even a mobile-* client session is 403
    const prev = process.env.DONEBOT_TEAM_RUNTIME;
    process.env.DONEBOT_TEAM_RUNTIME = "1";
    try {
      expect((await callRoute(opcHandler, "GET", "/api/donebot/opc/overview?days=30", undefined, mobileOwnerAuth)).status).toBe(403);
      expect((await callRoute(wfHandler, "POST", "/api/donebot/opc/workflow-runs/missing-run/decision", { action: "approve" }, mobileOwnerAuth)).status).toBe(403);
    } finally {
      if (prev === undefined) delete process.env.DONEBOT_TEAM_RUNTIME;
      else process.env.DONEBOT_TEAM_RUNTIME = prev;
    }

    opcHandler.stopScheduler();
  });
});
