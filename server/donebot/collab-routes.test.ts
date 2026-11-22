import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../harness/http.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { createDoneBotAccountRoutes } from "./routes.ts";
import { createDoneBotCollabRoutes, handleDoneBotCollabInternal } from "./collab-routes.ts";
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
});
