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
});
