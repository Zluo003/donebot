import { describe, expect, it, vi } from "vitest";
import type { DoneBotClaimedBotInvocation } from "../../shared/donebot-collab.ts";
import type { BotRecord, Message } from "../store.ts";
import { collectReplyText, createCollabChatBotWorker, formatChatPrompt } from "./collab-chat-bots.ts";
import type { DoneBotGateway } from "./gateway.ts";

describe("Collab chat bot worker context and reply extraction", () => {
  it("injects full group member list (including silent members) and group bots into the prompt", async () => {
    const groupId = "11111111-1111-4111-8111-111111111111";
    const chatBotId = "22222222-2222-4222-8222-222222222222";
    const invId = "33333333-3333-4333-8333-333333333333";
    const installId = "44444444-4444-4444-8444-444444444444";

    let claimedOnce = false;
    let capturedPrompt = "";
    let postedReply = "";

    const collabCtx = {
      origin: "https://donebot.invalid",
      controllers: new Set<AbortController>(),
      epoch: () => 1,
      checkEpoch: () => {},
      validSession: async () => ({ mode: "jwt", accessToken: "tok", user: { id: "101", email: "laoluo@example.invalid" } }),
      readGatewayJson: async (res: Response) => res.json(),
      fetcher: vi.fn().mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const reqUrl = new URL(String(input));
        if (reqUrl.pathname === "/api/v1/donebot/collab/chat-bots/claim") {
          if (claimedOnce) return Response.json({ code: 0, data: { invocation: null } });
          claimedOnce = true;
          const invocation: DoneBotClaimedBotInvocation = {
            id: invId,
            chat_bot_id: chatBotId,
            scope_type: "group",
            target_id: groupId,
            chat_name: "测试",
            local_bot_id: "bot-duobao",
            bot_name: "多宝",
            message_id: 50,
            recent_messages: [{
              id: 50,
              scope_type: "group",
              target_id: groupId,
              sender_id: 101,
              sender_email: "laoluo@example.invalid",
              sender_nickname: "老罗",
              kind: "text",
              body: "@多宝 认识一下群里的人",
              created_at: "2026-11-23T01:02:00Z",
            }],
          };
          return Response.json({ code: 0, data: { invocation } });
        }
        if (reqUrl.pathname === "/api/v1/donebot/collab/groups") {
          return Response.json({
            code: 0,
            data: [{
              id: groupId,
              name: "测试",
              creator_id: 101,
              members: [
                { user_id: 101, email: "laoluo@example.invalid", nickname: "老罗", joined_at: "2026-11-23T01:00:00Z" },
                { user_id: 202, email: "xiaoluo@example.invalid", nickname: "小罗", remark: "搭档小罗", joined_at: "2026-11-23T01:00:00Z" },
              ],
              created_at: "2026-11-23T01:00:00Z",
              updated_at: "2026-11-23T01:00:00Z",
            }],
          });
        }
        if (reqUrl.pathname === `/api/v1/donebot/collab/chats/group/${groupId}/bots`) {
          return Response.json({
            code: 0,
            data: [{
              id: chatBotId,
              scope_type: "group",
              target_id: groupId,
              owner_user_id: 101,
              owner_email: "laoluo@example.invalid",
              owner_nickname: "老罗",
              installation_id: installId,
              local_bot_id: "bot-duobao",
              bot_name: "多宝",
              bot_title: "全能助手",
              allow_all_members: false,
              allowed_user_ids: [202],
              can_invoke: true,
              created_at: "2026-11-23T01:00:00Z",
            }],
          });
        }
        if (reqUrl.pathname === `/api/v1/donebot/collab/chat-bots/invocations/${invId}/reply`) {
          const parsed = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
          postedReply = parsed.body ?? "";
          return Response.json({ code: 0, data: { ok: true } });
        }
        return Response.json({ code: 0, data: {} });
      }),
    };

    const gateway = {
      collabCtx: () => collabCtx,
      collabIdentity: vi.fn().mockResolvedValue({
        account_id: "101",
        installation_id: installId,
        device_name: "Mac",
        email: "laoluo@example.invalid",
      }),
    } as unknown as DoneBotGateway;

    const bot = { id: "bot-duobao", name: "多宝", hidden: false } as unknown as BotRecord;
    const worker = createCollabChatBotWorker({
      gateway,
      store: { bot: id => (id === bot.id ? bot : null) },
      generateBotText: async (_botId, prompt) => {
        capturedPrompt = prompt;
        return "群里现在有老罗和搭档小罗两位成员！";
      },
    });

    worker.kick();
    for (let i = 0; i < 40 && !postedReply; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    worker.stop();

    expect(capturedPrompt).toContain("当前好友群聊完整成员名单（共 2 人）");
    expect(capturedPrompt).toContain("老罗（群主、你的主人/Bot所有者、当前发言人）");
    expect(capturedPrompt).toContain("搭档小罗（昵称：小罗）（群成员）");
    expect(capturedPrompt).toContain("多宝（你本人，所有者：老罗，简介：全能助手）");
    expect(capturedPrompt).toContain("切勿把主人本机中未加入本群的其他机器人或联系人混成本群成员");
    expect(postedReply).toBe("群里现在有老罗和搭档小罗两位成员！");
  });

  it("distinguishes Bot owner from another authorized caller in prompt", () => {
    const inv: DoneBotClaimedBotInvocation = {
      id: "inv-1",
      chat_bot_id: "cb-1",
      scope_type: "team",
      target_id: "team-1",
      chat_name: "DoneBot 开发",
      local_bot_id: "bot-duobao",
      bot_name: "多宝",
      message_id: 99,
      recent_messages: [{
        id: 99,
        scope_type: "team",
        target_id: "team-1",
        sender_id: 202,
        sender_email: "xiaoluo@example.invalid",
        sender_nickname: "小罗",
        kind: "text",
        body: "@多宝 帮我列一下团队成员",
        created_at: "2026-11-23T01:05:00Z",
      }],
    };
    const { full } = formatChatPrompt(inv, {
      chatName: "DoneBot 开发",
      ownerUserId: 101,
      ownerName: "老罗",
      members: [
        { userId: 101, name: "老罗", roleLabel: "团队所有者" },
        { userId: 202, name: "小罗", roleLabel: "团队成员" },
      ],
      chatBots: [
        { id: "cb-1", name: "多宝", title: "", ownerUserId: 101, ownerName: "老罗" },
      ],
    });
    expect(full).toContain("被已获主人授权的群成员 小罗 通过 @多宝 调用");
    expect(full).toContain("你的主人（Bot 所有者）是：老罗");
    expect(full).toContain("- 老罗（团队所有者、你的主人/Bot所有者）");
    expect(full).toContain("- 小罗（团队成员、当前发言人）");
  });

  it("collectReplyText drops pre-tool preamble messages even with trailing non-text records", () => {
    const lines = [
      { id: "1", role: "bot", kind: "text", text: "我先看一下这个群里有哪些成员。" },
      { id: "2", role: "bot", kind: "activity", text: "" },
      { id: "3", role: "bot", kind: "text", text: "群里目前有老罗和小罗两位成员，大家好！" },
      { id: "4", role: "bot", kind: "burst", text: "" },
    ] as unknown as Message[];
    expect(collectReplyText(lines)).toBe("群里目前有老罗和小罗两位成员，大家好！");
  });
});
