import { afterEach, describe, expect, it } from "vitest";
import type { OpcArtifactItem } from "../../shared/donebot-opc.ts";
import type { BotRecord, Message } from "../store.ts";
import { buildBossReports, extractReportTitle } from "./opc-boss-reports.ts";
import { registerMediaThreadSource } from "./thread-files.ts";

function makeBot(): BotRecord {
  return {
    id: "chief-1",
    name: "多宝",
    title: "系统总协调",
    color: "orange",
    threadId: "thread-main",
    busy: false,
    unread: false,
    notifications: true,
    modelSelection: { instanceId: "donebot", model: "claude-sonnet-5-5" },
    tasks: [],
  } as unknown as BotRecord;
}

function makeArtifact(overrides: Partial<OpcArtifactItem> = {}): OpcArtifactItem {
  return {
    id: "art-1",
    title: "我发现你还是没有派活啊你自己画吧",
    name: "seedream-5-5-8f3c2a1b.png",
    path: "/tmp/seedream-5-5-8f3c2a1b.png",
    kind: "image",
    mime: "image/png",
    at: 1_700_000_010_000,
    threadId: "thread-main",
    threadTitle: "多宝",
    messageId: "m-media",
    reportMessageId: "m-media",
    previewUrl: "/api/threads/thread-main/messages/m-media/file?preview=1&path=%2Ftmp%2Fseedream-5-5-8f3c2a1b.png",
    botId: "chief-1",
    botName: "多宝",
    botColor: "orange",
    version: 1,
    reviewStatus: "pending",
    ...overrides,
  };
}

afterEach(() => {
  registerMediaThreadSource(undefined);
});

describe("OPC boss report title extraction & distillation", () => {
  it("extracts explicit Markdown headings, skipping generic section headers", () => {
    expect(extractReportTitle("# 品牌视觉升级方案\n\n## 核心结论\n已完成交付。", "兜底")).toBe("品牌视觉升级方案");
    expect(extractReportTitle("## 核心结论\n## Q4 增长复盘报告\n核心指标达成。", "兜底")).toBe("Q4 增长复盘报告");
    expect(extractReportTitle("**皮克斯3D卡通女子设计稿**\n已完成渲染。", "兜底")).toBe("皮克斯3D卡通女子设计稿");
    expect(extractReportTitle("正式汇报：民国纸铺道具资产设计\n包含 6 张设定图。", "兜底")).toBe("民国纸铺道具资产设计");
  });

  it("distills concise content titles from plain-text bot replies instead of using raw user chat complaints", () => {
    const bot = makeBot();
    const messages: Message[] = [
      { id: "m-u1", role: "user", kind: "text", text: "我发现你还是没有派活啊你自己画吧", at: 1_700_000_000_000 },
      {
        id: "m-media",
        role: "bot",
        kind: "text",
        text: "image · seedream-5-5",
        turnId: "turn-1",
        at: 1_700_000_010_000,
        attachments: [{ kind: "image", path: "/tmp/seedream-5-5-8f3c2a1b.png", name: "seedream-5-5-8f3c2a1b.png", mime: "image/png" }],
      },
      {
        id: "m-reply",
        role: "bot",
        kind: "text",
        text: "老板，皮克斯3D风格卡通女子图已经画好了，请您查收。",
        turnId: "turn-1",
        at: 1_700_000_012_000,
      },
    ];

    const { pendingReports } = buildBossReports({
      store: { bots: [bot], bot: () => bot, messagesFor: () => messages },
      allArtifacts: [makeArtifact()],
      workflowRuns: [],
    });

    expect(pendingReports).toHaveLength(1);
    expect(pendingReports[0]!.title).toBe("皮克斯3D风格卡通女子图");
    expect(pendingReports[0]!.title).not.toContain("我发现你还是没有派活");
    expect(pendingReports[0]!.summary).toContain("皮克斯3D风格卡通女子图");
  });

  it("distills title and summary from media generation prompt when report message is only a model badge", () => {
    registerMediaThreadSource({
      describeMedia: (target) => target.includes("hat-print")
        ? {
            jobId: "job-hat-1",
            kind: "image",
            model: "seedream-5-5",
            prompt: "高清，根据参考图1，碎花印花面料渔夫帽，去除顶部灰边，自然棚拍光效",
          }
        : undefined,
      listThreadMedia: () => [],
    });

    const bot = makeBot();
    const messages: Message[] = [
      { id: "m-u1", role: "user", kind: "text", text: "把这张生成的印花面料的帽子顶部的灰边去掉", at: 1_700_000_000_000 },
      {
        id: "m-media",
        role: "bot",
        kind: "text",
        text: "image · seedream-5-5",
        at: 1_700_000_010_000,
      },
    ];

    const { pendingReports } = buildBossReports({
      store: { bots: [bot], bot: () => bot, messagesFor: () => messages },
      allArtifacts: [
        makeArtifact({
          title: "把这张生成的印花面料的帽子顶部的灰边去掉",
          name: "hat-print-9911.png",
          path: "/tmp/hat-print-9911.png",
        }),
      ],
      workflowRuns: [],
    });

    expect(pendingReports).toHaveLength(1);
    expect(pendingReports[0]!.title).toBe("碎花印花面料渔夫帽");
    expect(pendingReports[0]!.title).not.toContain("把这张");
    expect(pendingReports[0]!.summary).toContain("碎花印花面料渔夫帽");
  });

  it("falls back to readable attachment filename or generic deliverable label instead of conversational user chat", () => {
    const bot = makeBot();
    const messages: Message[] = [
      { id: "m-u1", role: "user", kind: "text", text: "来一张上下灰边都不要的", at: 1_700_000_000_000 },
      { id: "m-media", role: "bot", kind: "text", text: "image · seedream-5-5", at: 1_700_000_010_000 },
    ];

    const opaque = buildBossReports({
      store: { bots: [bot], bot: () => bot, messagesFor: () => messages },
      allArtifacts: [makeArtifact({ title: "来一张上下灰边都不要的", name: "seedream-5-5-998877.png" })],
      workflowRuns: [],
    });
    expect(opaque.pendingReports[0]!.title).toBe("图片交付汇报");

    const readable = buildBossReports({
      store: { bots: [bot], bot: () => bot, messagesFor: () => messages },
      allArtifacts: [makeArtifact({ title: "来一张上下灰边都不要的", name: "秋季女帽印花样稿.png" })],
      workflowRuns: [],
    });
    expect(readable.pendingReports[0]!.title).toBe("秋季女帽印花样稿");
  });

  it("collects non-approval deliverables, completed non-gated workflows, and structured text reports into briefingReports with read receipts", () => {
    const gatedBot = { ...makeBot(), id: "bot-gated", name: "导演", threadId: "t-gated", section: "影视部" } as BotRecord;
    const freeBot = { ...makeBot(), id: "bot-free", name: "表匠", threadId: "t-free", section: "数据组" } as BotRecord;
    const messagesByThread: Record<string, Message[]> = {
      "t-gated": [
        { id: "m-g1", role: "bot", kind: "text", text: "# 定稿分镜包\n请老板审批。", at: 10_000 },
      ],
      "t-free": [
        { id: "m-f1", role: "bot", kind: "text", text: "好的，这就处理。", at: 11_000 },
        { id: "m-f2", role: "bot", kind: "text", text: "正式汇报：11 月运营验收报告\n核心指标全部达标，转化率提升 18%，详细对比数据见正文。", at: 12_000 },
        { id: "m-f3", role: "bot", kind: "text", text: "# 竞品月度复盘\n\n## 核心发现\n\n- 头部竞品加大了短视频矩阵投入，单月发布量同比增长 42%。\n- 客单价集中在 199-299 元区间，复购率依赖私域运营。\n\n## 建议行动\n\n下月优先测试 3 组对比测评脚本并持续跟进转化表现。", at: 13_000 },
        { id: "m-f4", role: "bot", kind: "text", text: "验收表格已生成并附上。", at: 14_000 },
      ],
    };

    const result = buildBossReports({
      store: {
        bots: [gatedBot, freeBot],
        bot: (id) => (id === gatedBot.id ? gatedBot : id === freeBot.id ? freeBot : null),
        messagesFor: (tid) => messagesByThread[tid] ?? [],
      },
      allArtifacts: [
        makeArtifact({ id: "art-gated", botId: gatedBot.id, botName: gatedBot.name, threadId: "t-gated", messageId: "m-g1", reportMessageId: "m-g1", at: 10_000 }),
        makeArtifact({ id: "art-free", botId: freeBot.id, botName: freeBot.name, threadId: "t-free", messageId: "m-f4", reportMessageId: "m-f4", name: "验收台账.xlsx", kind: "document", at: 14_000 }),
      ],
      workflowRuns: [
        {
          id: "run-nogate",
          workflowId: "wf-daily",
          workflowName: "每日早报汇总",
          trigger: "schedule",
          variables: {},
          status: "completed",
          currentStepIndex: 0,
          stepResults: [{
            stepId: "s1",
            stepName: "汇总输出",
            botId: freeBot.id,
            botName: freeBot.name,
            status: "completed",
            output: "# 每日行业早报\n今日 3 条重点动态已整理。",
            startedAt: 15_000,
            finishedAt: 16_000,
          }],
          startedAt: 15_000,
          finishedAt: 16_000,
        },
      ],
      orgChart: {
        enforcementMode: "enforced",
        nodes: {
          "bot-gated": { botId: "bot-gated", reportsToBotId: null, handoffToBotIds: [], requireBossApproval: true },
          "bot-free": { botId: "bot-free", reportsToBotId: null, handoffToBotIds: [], requireBossApproval: false },
        },
        updatedAt: 1,
      },
      readAtByReportId: (id) => (id === "msg:t-free:m-f2" ? 99_000 : undefined),
    });

    // Only gated bot's deliverable enters approval queue.
    expect(result.pendingReports).toHaveLength(1);
    expect(result.pendingReports[0]!.botId).toBe("bot-gated");
    expect(result.pendingReports[0]!.approvalRequired).toBe(true);

    // Non-approval deliverables + completed non-gated workflow + structured text reports enter briefingReports (not short chat).
    const titles = result.briefingReports.map(r => r.title);
    expect(titles).toContain("每日行业早报");
    expect(titles).toContain("11 月运营验收报告");
    expect(titles).toContain("竞品月度复盘");
    expect(titles).toContain("验收表格");
    expect(result.briefingReports.some(r => r.body.includes("好的，这就处理"))).toBe(false);
    expect(result.briefingReports.every(r => r.approvalRequired === false)).toBe(true);

    const readItem = result.briefingReports.find(r => r.id === "msg:t-free:m-f2");
    expect(readItem?.readAt).toBe(99_000);
  });
});
