import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../harness/http.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { createDoneBotAccountRoutes } from "./routes.ts";
import { createDoneBotCollabRoutes, handleDoneBotCollabInternal } from "./collab-routes.ts";
import { teamIdentity, teamMembers } from "./teams.ts";
import type { DoneBotGateway } from "./gateway.ts";
import type { BotRecord } from "../store.ts";

function fakeRes() {
  const headers: Record<string, string> = {};
  let status = 0;
  let body: unknown;
  return {
    res: { setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; } } as unknown as ServerResponse,
    json: (_res: ServerResponse, code: number, value: unknown) => { status = code; body = value; },
    get status() { return status; },
    get body() { return body; },
  };
}

describe("DoneBot collab routes and bot tools", () => {
  it("exports a bot with SOUL.md and skills while excluding memory and starter notes", async () => {
    let capturedPayload: Record<string, unknown> | null = null;
    const gateway = {
      collabIdentity: vi.fn().mockResolvedValue({ account_id: "101", installation_id: "11111111-1111-4111-8111-111111111111", device_name: "Alice Mac", email: "alice@example.invalid" }),
      collabSaveBot: vi.fn().mockImplementation(async payload => { capturedPayload = payload; return { id: "22222222-2222-4222-8222-222222222222", ...payload }; }),
    } as unknown as DoneBotGateway;

    const bot = {
      id: "bot-review",
      name: "评审官",
      title: "代码评审",
      description: "检查安全与架构",
      color: "blue",
      soul: "请严格审查安全边界并给出最小改动建议。",
      section: "研发",
      hidden: false,
    } as unknown as BotRecord;

    const handler = createDoneBotCollabRoutes({
      gateway,
      store: { bots: [bot], bot: id => (id === bot.id ? bot : null) },
      collectTeamSkills: () => ({
        ok: true,
        all: true,
        skillsByBot: new Map([[bot.id, [{ name: "security-audit", description: "Audit code", instructions: "---\nname: security-audit\ndescription: Audit code\n---\nCheck auth and input bounds" }]]]),
        skipped: [],
        available: ["security-audit"],
      }),
      defaultSelection: vi.fn(),
      packageImportDeps: vi.fn(),
      broadcast: vi.fn(),
      publicBot: b => b,
    });

    const out = fakeRes();
    await handler({
      req: {} as IncomingMessage,
      res: out.res,
      url: new URL("http://127.0.0.1/api/donebot/collab/bots/share"),
      path: "/api/donebot/collab/bots/share",
      method: "POST",
      auth: { kind: "loopback", scopes: ["admin"] },
      json: out.json,
      readBody: async () => ({
        bot_id: bot.id,
        grants: [{ subject_type: "user", subject_id: "202" }],
      }),
    });

    expect(out.status).toBe(200);
    expect(capturedPayload).toBeTruthy();
    expect(capturedPayload!.has_soul).toBe(true);
    expect(capturedPayload!.skill_count).toBe(1);
    const serialized = JSON.stringify(capturedPayload!.package);
    expect(serialized).toContain("请严格审查安全边界");
    expect(serialized).toContain("security-audit");
    expect(serialized).not.toContain("starterNotes");
    expect(serialized).not.toContain('"memory"');
  });

  it("handles internal list and invoke endpoints for local bot collab tools", async () => {
    const folderId = "33333333-3333-4333-8333-333333333333";
    const gateway = {
      collabFolders: vi.fn().mockResolvedValue({
        owned: [],
        shared_with_me: [{ id: folderId, name: "项目文档", owner_email: "bob@example.invalid", access: "read", online: true }],
      }),
      collabInvokeFolder: vi.fn().mockResolvedValue({ result: { content: [{ type: "text", text: "doc content" }] } }),
    } as unknown as DoneBotGateway;

    const listOut = fakeRes();
    const handledList = await handleDoneBotCollabInternal(gateway, "POST", "/api/internal/donebot/collab/folders", listOut.res, listOut.json, async () => ({}));
    expect(handledList).toBe(true);
    expect(listOut.status).toBe(200);
    expect((listOut.body as { folders: unknown[] }).folders).toHaveLength(1);

    const invokeOut = fakeRes();
    const handledInvoke = await handleDoneBotCollabInternal(gateway, "POST", "/api/internal/donebot/collab/invoke", invokeOut.res, invokeOut.json, async () => ({
      folder_id: folderId,
      action: "read_file",
      path: "readme.md",
    }));
    expect(handledInvoke).toBe(true);
    expect(invokeOut.status).toBe(200);
    expect(gateway.collabInvokeFolder).toHaveBeenCalledWith(folderId, { action: "read_file", path: "readme.md" });

    // Rejects forbidden non-file actions.
    const badOut = fakeRes();
    await handleDoneBotCollabInternal(gateway, "POST", "/api/internal/donebot/collab/invoke", badOut.res, badOut.json, async () => ({
      folder_id: folderId,
      action: "run_command",
      path: "",
    }));
    expect(badOut.status).toBe(400);
  });

  it("does not hang collab POST requests when mounted behind DoneBot account routes", async () => {
    const gateway = {
      collabSendFriendRequest: vi.fn().mockResolvedValue({ status: "pending", request: { id: "req-1" } }),
      collabRelayPoll: vi.fn().mockResolvedValue({ job: null }),
    } as unknown as DoneBotGateway;

    const routes = [
      createDoneBotAccountRoutes(gateway),
      createDoneBotCollabRoutes({
        gateway,
        store: { bots: [], bot: () => null },
        collectTeamSkills: () => ({ ok: true, all: true, skillsByBot: new Map(), skipped: [], available: [] }),
        defaultSelection: vi.fn(),
        packageImportDeps: vi.fn(),
        broadcast: vi.fn(),
        publicBot: b => b,
      }),
    ];

    const req = Readable.from([JSON.stringify({ email: "bob@example.invalid", note: "hello" })]) as unknown as IncomingMessage;
    const out = fakeRes();
    const handled = await dispatchRoutes(routes, {
      req,
      res: out.res,
      url: new URL("http://127.0.0.1/api/donebot/collab/friends/request"),
      path: "/api/donebot/collab/friends/request",
      method: "POST",
      auth: { kind: "loopback", scopes: ["admin"] },
      json: out.json,
      readBody,
    });
    expect(handled).toBe(true);
    expect(out.status).toBe(200);
    expect(gateway.collabSendFriendRequest).toHaveBeenCalledWith("bob@example.invalid", "hello");

    const pollReq = Readable.from(["{}"]) as unknown as IncomingMessage;
    const pollOut = fakeRes();
    const pollHandled = await dispatchRoutes(routes, {
      req: pollReq,
      res: pollOut.res,
      url: new URL("http://127.0.0.1/api/donebot/collab/relay/poll"),
      path: "/api/donebot/collab/relay/poll",
      method: "POST",
      auth: { kind: "loopback", scopes: ["admin"] },
      json: pollOut.json,
      readBody,
    });
    expect(pollHandled).toBe(true);
    expect(pollOut.status).toBe(200);
    expect(gateway.collabRelayPoll).toHaveBeenCalledTimes(1);
  });

  it("updates user profile + local sync (returning local_avatar_url), sets friend remark, proxies chat APIs, and rejects oversized (>100MB) file uploads", async () => {
    const syncLocalProfile = vi.fn();
    const gateway = {
      collabIdentity: vi.fn().mockResolvedValue({ account_id: "101", installation_id: "11111111-1111-4111-8111-111111111111", device_name: "Alice Mac", email: "alice@example.invalid" }),
      collabUpdateProfile: vi.fn().mockResolvedValue({ username: "阿泽", avatar_url: "" }),
      collabSetFriendRemark: vi.fn().mockResolvedValue({ user_id: 202, remark: "产品老王" }),
      collabUploadFile: vi.fn().mockResolvedValue(Response.json({ code: 0, data: { result: { written: true, bytes: 10 } } })),
      collabChatMessages: vi.fn().mockResolvedValue([{ id: 1, scope_type: "friend", target_id: "202", sender_id: 101, sender_email: "alice@example.invalid", kind: "text", body: "你好", created_at: "2026-11-22T00:00:00Z" }]),
      collabSendChatMessage: vi.fn().mockResolvedValue({ id: 2, scope_type: "friend", target_id: "202", sender_id: 101, sender_email: "alice@example.invalid", kind: "text", body: "收到", created_at: "2026-11-22T00:01:00Z" }),
      collabSendChatFile: vi.fn().mockResolvedValue(Response.json({ code: 0, data: { id: 3, kind: "file", file_name: "a.txt" } })),
      collabMarkChatRead: vi.fn().mockResolvedValue({ last_read_id: 2 }),
    } as unknown as DoneBotGateway;

    const handler = createDoneBotCollabRoutes({
      gateway,
      store: { bots: [], bot: () => null },
      collectTeamSkills: () => ({ ok: true, all: true, skillsByBot: new Map(), skipped: [], available: [] }),
      defaultSelection: vi.fn(),
      packageImportDeps: vi.fn(),
      broadcast: vi.fn(),
      publicBot: b => b,
      syncLocalProfile,
    });

    const profileOut = fakeRes();
    await handler({
      req: {} as IncomingMessage,
      res: profileOut.res,
      url: new URL("http://127.0.0.1/api/donebot/collab/profile"),
      path: "/api/donebot/collab/profile",
      method: "PUT",
      auth: { kind: "loopback", scopes: ["admin"] },
      json: profileOut.json,
      readBody: async () => ({ nickname: "阿泽", avatar_url: "" }),
    });
    expect(profileOut.status).toBe(200);
    expect(profileOut.body).toEqual(expect.objectContaining({ nickname: "阿泽", local_avatar_url: "" }));
    expect(gateway.collabUpdateProfile).toHaveBeenCalledWith({ username: "阿泽", avatar_url: "" });
    expect(syncLocalProfile).toHaveBeenCalledWith({ name: "阿泽", avatarUrl: "", email: "alice@example.invalid" });

    const remarkOut = fakeRes();
    await handler({
      req: {} as IncomingMessage,
      res: remarkOut.res,
      url: new URL("http://127.0.0.1/api/donebot/collab/friends/202/remark"),
      path: "/api/donebot/collab/friends/202/remark",
      method: "PUT",
      auth: { kind: "loopback", scopes: ["admin"] },
      json: remarkOut.json,
      readBody: async () => ({ remark: "产品老王" }),
    });
    expect(remarkOut.status).toBe(200);
    expect(gateway.collabSetFriendRemark).toHaveBeenCalledWith(202, "产品老王");

    const listChatOut = fakeRes();
    await handler({
      req: {} as IncomingMessage,
      res: listChatOut.res,
      url: new URL("http://127.0.0.1/api/donebot/collab/chats/friend/202/messages?limit=20"),
      path: "/api/donebot/collab/chats/friend/202/messages",
      method: "GET",
      auth: { kind: "loopback", scopes: ["admin"] },
      json: listChatOut.json,
      readBody,
    });
    expect(listChatOut.status).toBe(200);
    expect(gateway.collabChatMessages).toHaveBeenCalledWith("friend", "202", "limit=20");

    const sendChatOut = fakeRes();
    await handler({
      req: {} as IncomingMessage,
      res: sendChatOut.res,
      url: new URL("http://127.0.0.1/api/donebot/collab/chats/friend/202/messages"),
      path: "/api/donebot/collab/chats/friend/202/messages",
      method: "POST",
      auth: { kind: "loopback", scopes: ["admin"] },
      json: sendChatOut.json,
      readBody: async () => ({ body: "收到" }),
    });
    expect(sendChatOut.status).toBe(200);
    expect(gateway.collabSendChatMessage).toHaveBeenCalledWith("friend", "202", "收到", undefined);

    const tooBigChatOut = fakeRes();
    const tooBigChatReq = Object.assign(Readable.from([]), {
      headers: { "content-length": String(101 * 1024 * 1024), "content-type": "application/octet-stream" },
    }) as unknown as IncomingMessage;
    await handler({
      req: tooBigChatReq,
      res: tooBigChatOut.res,
      url: new URL("http://127.0.0.1/api/donebot/collab/chats/friend/202/files?name=huge.zip"),
      path: "/api/donebot/collab/chats/friend/202/files",
      method: "POST",
      auth: { kind: "loopback", scopes: ["admin"] },
      json: tooBigChatOut.json,
      readBody,
    });
    expect(tooBigChatOut.status).toBe(413);
    expect(gateway.collabSendChatFile).not.toHaveBeenCalled();

    const tooBigOut = fakeRes();
    const tooBigReq = Object.assign(Readable.from([]), {
      headers: { "content-length": String(101 * 1024 * 1024), "content-type": "application/octet-stream" },
    }) as unknown as IncomingMessage;
    await handler({
      req: tooBigReq,
      res: tooBigOut.res,
      url: new URL("http://127.0.0.1/api/donebot/collab/folders/33333333-3333-4333-8333-333333333333/file?path=movie.mp4"),
      path: "/api/donebot/collab/folders/33333333-3333-4333-8333-333333333333/file",
      method: "PUT",
      auth: { kind: "loopback", scopes: ["admin"] },
      json: tooBigOut.json,
      readBody,
    });
    expect(tooBigOut.status).toBe(413);
    expect(gateway.collabUploadFile).not.toHaveBeenCalled();
  });

  it("handles team/group avatars, friend groups, and authorized local chat bots", async () => {
    const teamId = "11111111-1111-4111-8111-111111111111";
    const groupId = "22222222-2222-4222-8222-222222222222";
    const chatBotId = "33333333-3333-4333-8333-333333333333";
    const installId = "44444444-4444-4444-8444-444444444444";

    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const collabCtx = {
      origin: "https://donebot.invalid",
      controllers: new Set<AbortController>(),
      epoch: () => 1,
      checkEpoch: () => {},
      validSession: async () => ({ mode: "jwt", accessToken: "tok", user: { id: "101", email: "alice@example.invalid" } }),
      readGatewayJson: async (res: Response) => res.json(),
      fetcher: vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const reqUrl = new URL(String(input));
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
        calls.push({ method, path: reqUrl.pathname, body });
        if (method === "POST" && reqUrl.pathname === "/api/v1/donebot/collab/groups") {
          return Response.json({ code: 0, data: { id: groupId, name: "周末讨论群", creator_id: 101, members: [] } });
        }
        if (method === "POST" && reqUrl.pathname.endsWith("/bots")) {
          return Response.json({ code: 0, data: { id: chatBotId, bot_name: "写作助手", allow_all_members: false, allowed_user_ids: [202] } });
        }
        if (method === "PUT" && reqUrl.pathname.endsWith("/grants")) {
          return Response.json({ code: 0, data: { id: chatBotId, allow_all_members: true, allowed_user_ids: [] } });
        }
        return Response.json({ code: 0, data: { ok: true } });
      }),
    };

    const gateway = {
      collabCtx: () => collabCtx,
      collabIdentity: vi.fn().mockResolvedValue({
        account_id: "101",
        installation_id: installId,
        device_name: "Alice Mac",
        email: "alice@example.invalid",
      }),
      collabSendChatMessage: vi.fn().mockResolvedValue({
        id: 88,
        scope_type: "group",
        target_id: groupId,
        sender_id: 101,
        sender_email: "alice@example.invalid",
        kind: "text",
        body: "@写作助手 帮我总结",
        triggered_bot_ids: [chatBotId],
        created_at: "2026-11-23T00:00:00Z",
      }),
    } as unknown as DoneBotGateway;

    const bot = {
      id: "bot-writer",
      name: "写作助手",
      title: "中文文案",
      color: "green",
      hidden: false,
    } as unknown as BotRecord;

    const handler = createDoneBotCollabRoutes({
      gateway,
      store: { bots: [bot], bot: id => (id === bot.id ? bot : null) },
      collectTeamSkills: () => ({ ok: true, all: true, skillsByBot: new Map(), skipped: [], available: [] }),
      defaultSelection: vi.fn(),
      packageImportDeps: vi.fn(),
      broadcast: vi.fn(),
      publicBot: b => b,
    });

    const teamAvatarOut = fakeRes();
    await handler({
      req: {} as IncomingMessage,
      res: teamAvatarOut.res,
      url: new URL(`http://127.0.0.1/api/donebot/collab/teams/${teamId}/avatar`),
      path: `/api/donebot/collab/teams/${teamId}/avatar`,
      method: "PUT",
      auth: { kind: "loopback", scopes: ["admin"] },
      json: teamAvatarOut.json,
      readBody: async () => ({ avatar_url: "data:image/jpeg;base64,/9j/4AAQ" }),
    });
    expect(teamAvatarOut.status).toBe(200);

    const createGroupOut = fakeRes();
    await handler({
      req: {} as IncomingMessage,
      res: createGroupOut.res,
      url: new URL("http://127.0.0.1/api/donebot/collab/groups"),
      path: "/api/donebot/collab/groups",
      method: "POST",
      auth: { kind: "loopback", scopes: ["admin"] },
      json: createGroupOut.json,
      readBody: async () => ({ name: "周末讨论群", member_ids: [202] }),
    });
    expect(createGroupOut.status).toBe(200);

    const addBotOut = fakeRes();
    await handler({
      req: {} as IncomingMessage,
      res: addBotOut.res,
      url: new URL(`http://127.0.0.1/api/donebot/collab/chats/group/${groupId}/bots`),
      path: `/api/donebot/collab/chats/group/${groupId}/bots`,
      method: "POST",
      auth: { kind: "loopback", scopes: ["admin"] },
      json: addBotOut.json,
      readBody: async () => ({ bot_id: "bot-writer", allow_all_members: false, allowed_user_ids: [202] }),
    });
    expect(addBotOut.status).toBe(200);
    expect(calls.find(c => c.path.endsWith("/bots"))?.body).toEqual(expect.objectContaining({
      installation_id: installId,
      local_bot_id: "bot-writer",
      bot_name: "写作助手",
      allow_all_members: false,
      allowed_user_ids: [202],
    }));

    const updateGrantOut = fakeRes();
    await handler({
      req: {} as IncomingMessage,
      res: updateGrantOut.res,
      url: new URL(`http://127.0.0.1/api/donebot/collab/chats/group/${groupId}/bots/${chatBotId}/grants`),
      path: `/api/donebot/collab/chats/group/${groupId}/bots/${chatBotId}/grants`,
      method: "PUT",
      auth: { kind: "loopback", scopes: ["admin"] },
      json: updateGrantOut.json,
      readBody: async () => ({ allow_all_members: true, allowed_user_ids: [] }),
    });
    expect(updateGrantOut.status).toBe(200);

    const mentionOut = fakeRes();
    await handler({
      req: {} as IncomingMessage,
      res: mentionOut.res,
      url: new URL(`http://127.0.0.1/api/donebot/collab/chats/group/${groupId}/messages`),
      path: `/api/donebot/collab/chats/group/${groupId}/messages`,
      method: "POST",
      auth: { kind: "loopback", scopes: ["admin"] },
      json: mentionOut.json,
      readBody: async () => ({ body: "@写作助手 帮我总结", mention_bot_ids: [chatBotId] }),
    });
    expect(mentionOut.status).toBe(200);
    expect(gateway.collabSendChatMessage).toHaveBeenCalledWith("group", groupId, "@写作助手 帮我总结", [chatBotId]);

    const parsedIdentity = teamIdentity.parse({
      id: teamId,
      name: "研发组",
      avatar_url: "data:image/jpeg;base64,/9j/4AAQ",
      role: "owner",
      member_version: 1,
      created_at: "2026-11-23T00:00:00Z",
    });
    expect(parsedIdentity.avatar_url).toBe("data:image/jpeg;base64,/9j/4AAQ");

    const parsedMembers = teamMembers.parse([{
      user_id: 202,
      email: "bob@example.invalid",
      nickname: "小罗",
      remark: "设计师小罗",
      avatar_url: "data:image/jpeg;base64,/9j/4AAQ",
      role: "member",
      version: 1,
    }]);
    expect(parsedMembers[0]).toEqual(expect.objectContaining({
      nickname: "小罗",
      remark: "设计师小罗",
      avatar_url: "data:image/jpeg;base64,/9j/4AAQ",
    }));
  });
});
