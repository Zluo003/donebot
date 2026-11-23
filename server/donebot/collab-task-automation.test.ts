import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DoneBotClaimedTaskBotEvent, DoneBotTeamTaskDetail } from "../../shared/donebot-collab.ts";
import {
  getTaskBinding,
  getTaskBindingByThread,
  removeTaskBinding,
  resetTaskBindingsForTests,
  saveTaskBinding,
} from "./collab-task-bindings.ts";
import { handleDoneBotCollabTaskInternal, registerCollabTaskRuntimeHooks } from "./collab-task-internal.ts";
import { dispatchTeamTaskViaChiefBot } from "./collab-task-dispatch.ts";
import { buildTaskEventPrompt, createCollabTaskWorker } from "./collab-task-worker.ts";
import type { DoneBotGateway } from "./gateway.ts";
import type { BotRecord, Message } from "../store.ts";

const teamId = "11111111-1111-4111-8111-111111111111";
const taskId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

function mockJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: 0, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeDetail(status: DoneBotTeamTaskDetail["task"]["status"] = "in_review"): DoneBotTeamTaskDetail {
  return {
    task: {
      id: taskId,
      team_id: teamId,
      title: "第3集女主定妆图",
      description: "需要古风红衣三视图",
      acceptance_criteria: ["共 3 张 9:16 竖图", "服饰统一无文字乱码"],
      status,
      priority: "high",
      creator_id: 101,
      assignee_id: 202,
      reviewer_id: 101,
      collaborator_ids: [],
      auto_review_enabled: true,
      max_auto_revisions: 2,
      auto_revision_count: 1,
      assignee_auto_resubmit: true,
      update_count: 1,
      deliverable_count: 1,
      created_at: "2026-11-23T01:00:00Z",
      updated_at: "2026-11-23T02:00:00Z",
    },
    updates: [
      {
        id: 1,
        task_id: taskId,
        actor_id: 202,
        actor_email: "wang@example.invalid",
        actor_nickname: "小王",
        actor_kind: "bot",
        actor_bot_name: "美术助手",
        kind: "submission",
        body: "已生成 3 张 9:16 定妆图",
        created_at: "2026-11-23T02:00:00Z",
      },
    ],
  };
}

function makeGateway(fetchFn: typeof fetch): DoneBotGateway {
  return {
    collabCtx: () => ({
      origin: "https://gateway.invalid",
      fetcher: fetchFn,
      controllers: new Set<AbortController>(),
      epoch: () => 1,
      checkEpoch: () => {},
      validSession: async () => ({
        mode: "user",
        accessToken: "test-token",
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 60_000,
        user: { id: "101", email: "boss@example.invalid" },
      }),
      readGatewayJson: async (res: Response) => res.json(),
    }),
    workspaceSnapshot: vi.fn(async () => ({
      account_id: "101",
      protocol: "donebot.teams.v1",
      capabilities: [],
      workspaces: [{ id: teamId, name: "AI短剧小组", role: "owner", member_version: 1, created_at: "2026-11-23T00:00:00Z" }],
    })),
    teamMembers: vi.fn(async () => [
      { user_id: 101, email: "boss@example.invalid", nickname: "老罗", role: "owner", version: 1 },
      { user_id: 202, email: "wang@example.invalid", nickname: "小王", role: "member", version: 1 },
    ]),
  } as unknown as DoneBotGateway;
}

describe("team task bot automation", () => {
  afterEach(() => {
    resetTaskBindingsForTests();
    registerCollabTaskRuntimeHooks({});
    vi.restoreAllMocks();
  });

  it("saves, looks up by thread, and removes local task bindings", () => {
    saveTaskBinding({
      teamId,
      teamName: "AI短剧小组",
      taskId,
      taskTitle: "第3集女主定妆图",
      botId: "bot-art",
      threadId: "thread-art-1",
    });
    expect(getTaskBinding(taskId)?.botId).toBe("bot-art");
    expect(getTaskBindingByThread("bot-art", "thread-art-1")?.taskId).toBe(taskId);
    removeTaskBinding(taskId);
    expect(getTaskBinding(taskId)).toBeUndefined();
  });

  it("resolves bound task from bot thread during submit and uploads multi-file batch", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "donebot-task-submit-"));
    const file1 = path.join(tmpDir, "shot1.txt");
    const file2 = path.join(tmpDir, "shot2.txt");
    await fs.writeFile(file1, "first deliverable");
    await fs.writeFile(file2, "second deliverable");

    saveTaskBinding({
      teamId,
      teamName: "AI短剧小组",
      taskId,
      taskTitle: "第3集女主定妆图",
      botId: "bot-art",
      threadId: "thread-art-1",
    });

    const kicked = vi.fn();
    registerCollabTaskRuntimeHooks({
      resolveBotName: id => (id === "bot-art" ? "分镜美术助手" : "主协调助手"),
      kickTaskWorker: kicked,
    });

    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (url.includes("/files?")) return mockJsonResponse(makeDetail("in_progress"));
      if (url.endsWith("/submit")) return mockJsonResponse(makeDetail("bot_reviewing"));
      return mockJsonResponse({});
    }) as unknown as typeof fetch;

    let responseStatus = 0;
    let responsePayload: unknown = null;
    const ok = await handleDoneBotCollabTaskInternal(
      makeGateway(fetchMock),
      "/api/internal/donebot/collab/tasks/submit",
      {} as never,
      (_res, status, value) => {
        responseStatus = status;
        responsePayload = value;
      },
      async () => ({
        brief: "已完成两版文案与分镜说明",
        file_paths: [file1, file2],
        bot_id: "bot-art",
        thread_id: "thread-art-1",
      }),
    );

    await fs.rm(tmpDir, { recursive: true, force: true });

    expect(ok).toBe(true);
    expect(responseStatus).toBe(200);
    expect((responsePayload as { submitted?: boolean }).submitted).toBe(true);
    expect((responsePayload as { uploaded_files?: string[] }).uploaded_files).toHaveLength(2);

    const fileUploads = calls.filter(c => c.url.includes("/files?"));
    expect(fileUploads).toHaveLength(2);
    expect(fileUploads[0]!.url).toContain("finalize=0");
    expect(fileUploads[0]!.url).toContain("actor_kind=bot");
    expect(fileUploads[0]!.url).toContain(encodeURIComponent("分镜美术助手"));

    const submitCall = calls.find(c => c.url.endsWith("/submit"));
    expect(submitCall).toBeDefined();
    const submitJson = JSON.parse(submitCall!.body!) as { batch_id?: string; actor_kind?: string; actor_bot_name?: string };
    expect(submitJson.batch_id).toBeTruthy();
    expect(submitJson.actor_kind).toBe("bot");
    expect(submitJson.actor_bot_name).toBe("分镜美术助手");
    expect(kicked).toHaveBeenCalledTimes(1);
  });

  it("routes bot_review and human_decision via internal review endpoint", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: typeof init?.body === "string" ? init.body : undefined });
      return mockJsonResponse(makeDetail("ready_for_review"));
    }) as unknown as typeof fetch;

    registerCollabTaskRuntimeHooks({ resolveBotName: () => "多宝主协调" });

    let status = 0;
    const handled = await handleDoneBotCollabTaskInternal(
      makeGateway(fetchMock),
      "/api/internal/donebot/collab/tasks/review",
      {} as never,
      (_res, s) => { status = s; },
      async () => ({
        team_id: teamId,
        task_id: taskId,
        mode: "bot_review",
        verdict: "pass",
        summary: "3 张竖图规格与人物服饰一致",
        passed_items: ["3 张 9:16 竖图齐全"],
        attention_items: ["建议确认第 2 张表情张力"],
        bot_id: "bot-chief",
      }),
    );

    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(calls[0]!.url).toContain(`/donebot/teams/${teamId}/tasks/${taskId}/bot-review`);
    const parsed = JSON.parse(calls[0]!.body!) as { verdict: string; bot_name: string };
    expect(parsed.verdict).toBe("pass");
    expect(parsed.bot_name).toBe("多宝主协调");
  });

  it("builds video-cost guardrail prompt and routes bot rejection back to bound thread", async () => {
    saveTaskBinding({
      teamId,
      teamName: "AI短剧小组",
      taskId,
      taskTitle: "第3集女主定妆图",
      botId: "bot-art",
      threadId: "thread-art-99",
    });

    const event: DoneBotClaimedTaskBotEvent = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
      team_id: teamId,
      team_name: "AI短剧小组",
      task_id: taskId,
      event_type: "task_bot_rejected",
      payload: {
        round: 1,
        max_rounds: 2,
        reviewer_bot_name: "多宝主协调",
        summary: "第 3 张画面比例错误",
        failed_criteria: ["共 3 张 9:16 竖图"],
        actionable_fixes: ["将第 3 张重绘为 9:16 竖图"],
        auto_resubmit: true,
      },
      detail: makeDetail("bot_revising"),
      creator_name: "老罗",
      assignee_name: "小王",
      reviewer_name: "老罗",
      created_at: "2026-11-23T02:05:00Z",
    };

    const { full } = buildTaskEventPrompt(event, []);
    expect(full).toContain("第 1/2 轮自动返工");
    expect(full).toContain("高成本视频/音乐护栏");
    expect(full).toContain("collab_submit_team_task");

    const chiefBot = { id: "bot-chief", name: "多宝", threadId: "t-chief", chiefOfStaff: true, hidden: false } as BotRecord;
    const artBot = { id: "bot-art", name: "美术助手", threadId: "t-art-default", chiefOfStaff: false, hidden: false } as BotRecord;
    const messages = new Map<string, Message[]>();
    const startTurn = vi.fn(async (_botId, _text, opts) => {
      opts.onSettled?.({ text: "已修改并重提", ok: true });
    });

    const completed: Array<{ url: string; body?: string }> = [];
    let claimedOnce = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/task-events/claim")) {
        if (claimedOnce) return mockJsonResponse({ event: null });
        claimedOnce = true;
        return mockJsonResponse({ event });
      }
      if (url.includes("/task-events/") && url.endsWith("/complete")) {
        completed.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
        return mockJsonResponse({ ok: true });
      }
      return mockJsonResponse({});
    }) as unknown as typeof fetch;

    const worker = createCollabTaskWorker({
      gateway: makeGateway(fetchMock),
      store: {
        bots: [chiefBot, artBot],
        bot: id => [chiefBot, artBot].find(b => b.id === id) ?? null,
        taskByThread: (botId, tid) => (botId === "bot-art" && tid === "thread-art-99" ? ({ threadId: tid } as never) : undefined),
        appendMessage: (tid, msg) => {
          const entry = { ...msg, id: `m-${Date.now()}`, at: Date.now() } as Message;
          messages.set(tid, [...(messages.get(tid) ?? []), entry]);
          return entry;
        },
        messagesFor: tid => messages.get(tid) ?? [],
      },
      startTurn,
      threadBusy: () => false,
    });

    worker.kick();
    await new Promise(resolve => setTimeout(resolve, 60));
    worker.setActive(false);

    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(startTurn.mock.calls[0]![0]).toBe("bot-art");
    expect(startTurn.mock.calls[0]![2]).toMatchObject({ threadId: "thread-art-99", unattended: true });
    expect(completed).toHaveLength(1);
    expect(completed[0]!.body).toContain('"status":"done"');
  });

  it("dispatches natural-language team task request directly through the Chief Bot", async () => {
    const chiefBot = { id: "bot-chief", name: "多宝", threadId: "t-chief", chiefOfStaff: true, hidden: false } as BotRecord;
    const helperBot = { id: "bot-art", name: "美术助手", threadId: "t-art", chiefOfStaff: false, hidden: false } as BotRecord;
    const messages = new Map<string, Message[]>();
    const kicked = vi.fn();
    const startTurn = vi.fn(async (_botId, _text, opts) => {
      opts.onSettled?.({ ok: true, text: "已为小王创建任务「第3集定妆图」并设置 3 条验收清单。" });
    });

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/channels")) return mockJsonResponse([{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", name: "分镜组", is_private: false }]);
      if (url.endsWith("/member-profiles")) return mockJsonResponse([{ user_id: 202, job_title: "分镜美术" }]);
      return mockJsonResponse({});
    }) as unknown as typeof fetch;

    const gateway = makeGateway(fetchMock);
    (gateway as unknown as { collabIdentity: () => Promise<{ account_id: string; email: string }> }).collabIdentity = async () => ({
      account_id: "101",
      email: "boss@example.invalid",
    });

    const result = await dispatchTeamTaskViaChiefBot(
      {
        gateway,
        store: {
          bots: [helperBot, chiefBot],
          bot: id => [helperBot, chiefBot].find(b => b.id === id) ?? null,
          appendMessage: (tid, msg) => {
            const entry = { ...msg, id: `m-${Date.now()}`, at: Date.now() } as Message;
            messages.set(tid, [...(messages.get(tid) ?? []), entry]);
            return entry;
          },
          messagesFor: tid => messages.get(tid) ?? [],
        },
        startTurn,
        threadBusy: () => false,
        kickTaskWorker: kicked,
      },
      teamId,
      { prompt: "让小王明天前做 3 张女主定妆图" },
    );

    expect(result.bot_id).toBe("bot-chief");
    expect(result.bot_name).toBe("多宝");
    expect(result.reply).toContain("已为小王创建任务");
    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(startTurn.mock.calls[0]![0]).toBe("bot-chief");
    expect(startTurn.mock.calls[0]![1]).toContain("分镜美术");
    expect(startTurn.mock.calls[0]![1]).toContain("collab_create_team_task");
    expect(kicked).toHaveBeenCalledTimes(1);
  });
});
