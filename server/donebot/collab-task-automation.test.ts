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
import { handleDoneBotCollabTaskInternal, registerCollabTaskRuntimeHooks, registerMediaPromptLookup } from "./collab-task-internal.ts";
import { getCollabTaskPrefs, resetCollabTaskPrefsForTests, saveCollabTaskPrefs } from "./collab-task-prefs.ts";
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
      opts.onTurnSettled?.();
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
      messages.set(opts.threadId, [
        ...(messages.get(opts.threadId) ?? []),
        { id: "m-bot-1", role: "bot", kind: "text", text: "已为小王创建任务「第3集定妆图」并设置 3 条验收清单。", at: Date.now() } as Message,
      ]);
      opts.onTurnSettled?.();
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

  it("skips stale task_assigned event when the task is already bound locally to a bot", async () => {
    saveTaskBinding({
      teamId,
      teamName: "AI短剧小组",
      taskId,
      taskTitle: "第3集女主定妆图",
      botId: "bot-chief",
      threadId: "t-chief",
    });
    const event: DoneBotClaimedTaskBotEvent = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2",
      team_id: teamId,
      team_name: "AI短剧小组",
      task_id: taskId,
      event_type: "task_assigned",
      detail: makeDetail("todo"),
      creator_name: "老罗",
      assignee_name: "小王",
      created_at: "2026-11-23T02:05:00Z",
    };
    const chiefBot = { id: "bot-chief", name: "多宝", threadId: "t-chief", chiefOfStaff: true, hidden: false } as BotRecord;
    const startTurn = vi.fn();
    const completed: Array<{ body?: string }> = [];
    let claimedOnce = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/task-events/claim")) {
        if (claimedOnce) return mockJsonResponse({ event: null });
        claimedOnce = true;
        return mockJsonResponse({ event });
      }
      if (url.endsWith("/complete")) {
        completed.push({ body: typeof init?.body === "string" ? init.body : undefined });
        return mockJsonResponse({ ok: true });
      }
      return mockJsonResponse({});
    }) as unknown as typeof fetch;

    const worker = createCollabTaskWorker({
      gateway: makeGateway(fetchMock),
      store: { bots: [chiefBot], bot: () => chiefBot },
      startTurn,
      threadBusy: () => false,
    });
    worker.kick();
    await new Promise(resolve => setTimeout(resolve, 60));
    worker.setActive(false);

    expect(startTurn).not.toHaveBeenCalled();
    expect(completed).toHaveLength(1);
    expect(completed[0]!.body).toContain('"status":"done"');
  });

  it("enriches collab_get_team_task recent_thread_attachments with image dimensions, prompt_excerpt, and supports reuse_file_ids partial revision", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "donebot-collab-att-"));
    try {
      const tigerName = "donebot-11111111-1111-4111-8111-111111111111-1.png";
      const snakeNewPath = path.join(dir, "donebot-22222222-2222-4222-8222-222222222222-1.png");
      const songPath = path.join(dir, "donebot-33333333-3333-4333-8333-333333333333-1.mp3");
      const docPath = path.join(dir, "script-v2.md");
      const tigerPath = path.join(dir, tigerName);
      const missingPath = path.join(dir, "missing.png");
      const pngHeader = Buffer.alloc(32);
      pngHeader.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      pngHeader.writeUInt32BE(1024, 16);
      pngHeader.writeUInt32BE(1024, 20);
      await fs.writeFile(tigerPath, pngHeader);
      await fs.writeFile(snakeNewPath, pngHeader);
      await fs.writeFile(songPath, Buffer.from("ID3synthetic-audio-bytes"));
      await fs.writeFile(docPath, "# 第3集修订分镜脚本\n已按意见删除多余旁白并补齐镜头时长。");

      const prevDetail = makeDetail("changes_requested");
      prevDetail.task.latest_submission_batch_id = "batch-v1";
      prevDetail.updates = [
        {
          ...prevDetail.updates[0]!,
          id: 11,
          kind: "submission",
          batch_id: "batch-v1",
          file_id: "file-tiger-v1",
          file_name: tigerName,
          file_mime: "image/png",
          file_size: 32,
        },
      ];

      registerMediaPromptLookup(input => {
        if (input.includes("11111111")) return { jobId: "11111111-1111-4111-8111-111111111111", model: "seedream-5-5", kind: "image", prompt: "皮克斯3D卡通老虎角色图" };
        if (input.includes("22222222")) return { jobId: "22222222-2222-4222-8222-222222222222", model: "seedream-5-5", kind: "image", prompt: "修订版光滑绿蛇（无响尾蛇尾环）" };
        if (input.includes("33333333")) return { jobId: "33333333-3333-4333-8333-333333333333", model: "suno-v6", kind: "music", prompt: "标题:片尾曲 · 风格:轻快管弦乐" };
        return undefined;
      });
      registerCollabTaskRuntimeHooks({
        resolveBotName: () => "多宝",
        listThreadAttachments: () => [
          { path: missingPath, name: "missing.png", mime: "image/png" },
          { path: tigerPath, name: tigerName, mime: "image/png", at: 1700000000000, messageText: "image · seedream-5-5" },
          { path: songPath, name: path.basename(songPath), mime: "audio/mpeg", at: 1700000030000, messageText: "music · suno-v6" },
          { path: docPath, name: "script-v2.md", mime: "text/markdown", at: 1700000045000, messageText: "修订脚本" },
          { path: snakeNewPath, name: path.basename(snakeNewPath), mime: "image/png", at: 1700000060000, messageText: "image · seedream-5-5" },
        ],
      });

      const uploadedNames: string[] = [];
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/task-files/file-tiger-v1")) {
          return new Response(pngHeader, { status: 200, headers: { "content-type": "image/png" } });
        }
        if (url.includes("/files?")) {
          const parsedUrl = new URL(url);
          uploadedNames.push(parsedUrl.searchParams.get("name") || "");
          return mockJsonResponse(prevDetail);
        }
        if (url.endsWith("/submit")) return mockJsonResponse(makeDetail("bot_reviewing"));
        return mockJsonResponse(prevDetail);
      }) as unknown as typeof fetch;

      let status = 0;
      let payload: unknown = null;
      const handled = await handleDoneBotCollabTaskInternal(
        makeGateway(fetchMock),
        "/api/internal/donebot/collab/tasks/detail",
        {} as never,
        (_res, s, v) => { status = s; payload = v; },
        async () => ({ team_id: teamId, task_id: taskId, bot_id: "bot-chief", thread_id: "t-chief" }),
      );
      expect(handled).toBe(true);
      expect(status).toBe(200);
      const body = payload as {
        latest_submission_files?: Array<{ file_id: string; prompt_excerpt?: string }>;
        recent_thread_attachments?: Array<{ path: string; size_bytes: number; dimensions?: { width: number; height: number; aspect_ratio: string }; text_excerpt?: string; media_kind?: string; prompt_excerpt?: string; already_submitted_in_task: boolean; is_latest?: boolean }>;
        attachments_note?: string;
      };
      expect(body.latest_submission_files).toEqual([
        expect.objectContaining({ file_id: "file-tiger-v1", prompt_excerpt: "皮克斯3D卡通老虎角色图" }),
      ]);
      expect(body.recent_thread_attachments).toHaveLength(4);
      expect(body.recent_thread_attachments![0]).toMatchObject({
        path: tigerPath,
        size_bytes: 32,
        dimensions: { width: 1024, height: 1024, aspect_ratio: "1:1" },
        prompt_excerpt: "皮克斯3D卡通老虎角色图",
        already_submitted_in_task: true,
      });
      expect(body.recent_thread_attachments![1]).toMatchObject({
        path: songPath,
        media_kind: "music",
        prompt_excerpt: "标题:片尾曲 · 风格:轻快管弦乐",
        already_submitted_in_task: false,
      });
      expect(body.recent_thread_attachments![2]).toMatchObject({
        path: docPath,
        text_excerpt: expect.stringContaining("第3集修订分镜脚本"),
        already_submitted_in_task: false,
      });
      expect(body.recent_thread_attachments![3]).toMatchObject({
        path: snakeNewPath,
        prompt_excerpt: "修订版光滑绿蛇（无响尾蛇尾环）",
        already_submitted_in_task: false,
        is_latest: true,
      });
      expect(body.attachments_note).toContain("reuse_file_ids");

      // Now submit partial revision reusing file-tiger-v1 + uploading docPath & snakeNewPath
      status = 0;
      payload = null;
      const submitted = await handleDoneBotCollabTaskInternal(
        makeGateway(fetchMock),
        "/api/internal/donebot/collab/tasks/submit",
        {} as never,
        (_res, s, v) => { status = s; payload = v; },
        async () => ({
          team_id: teamId,
          task_id: taskId,
          bot_id: "bot-chief",
          thread_id: "t-chief",
          brief: "保留原老虎图，仅替换修订后的脚本与光滑绿蛇图",
          reuse_file_ids: ["file-tiger-v1"],
          file_paths: [docPath, snakeNewPath],
        }),
      );
      expect(submitted).toBe(true);
      expect(status).toBe(200);
      expect(uploadedNames).toEqual([tigerName, "script-v2.md", path.basename(snakeNewPath)]);
    } finally {
      registerMediaPromptLookup(undefined);
      registerCollabTaskRuntimeHooks({});
      resetCollabTaskPrefsForTests();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("instructs assignee Chief Bot to delegate/create specialists (with SOUL.md & Skill), run first-pass review, and never work directly", async () => {
    resetCollabTaskPrefsForTests();
    const assignedEvent: DoneBotClaimedTaskBotEvent = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3",
      team_id: teamId,
      team_name: "AI短剧小组",
      task_id: taskId,
      event_type: "task_assigned",
      detail: makeDetail("todo"),
      creator_name: "老罗",
      assignee_name: "小王",
      created_at: "2026-11-23T02:10:00Z",
    };
    const promptDefault = buildTaskEventPrompt(assignedEvent, [], {
      chiefAutoSubmitOnApprove: false,
      availableSpecialists: [{ id: "bot-writer", name: "小林", title: "文案策划", description: "擅长剧本和分镜" }],
      targetIsChief: true,
    });
    expect(promptDefault.full).toContain("严禁主协调助手亲自干活");
    expect(promptDefault.full).toContain("create_bot");
    expect(promptDefault.full).toContain("SOUL.md");
    expect(promptDefault.full).toContain("skill_find");
    expect(promptDefault.full).toContain("skill_manage");
    expect(promptDefault.full).toContain("coordinate_bots");
    expect(promptDefault.full).toContain("未开启（默认");
    expect(promptDefault.full).toContain("高成本视频/音乐护栏");
    expect(promptDefault.full).toContain("@小林");

    const promptAutoSubmit = buildTaskEventPrompt(assignedEvent, [], {
      chiefAutoSubmitOnApprove: true,
      availableSpecialists: [],
      targetIsChief: true,
    });
    expect(promptAutoSubmit.full).toContain("已开启（一审通过后可直接代主人自动提交团队验收）");

    // Reviewer Chief Bot second-pass prompt must forbid final approval (done) / human_decision.
    const submittedEvent: DoneBotClaimedTaskBotEvent = {
      ...assignedEvent,
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4",
      event_type: "task_submitted",
      detail: makeDetail("bot_reviewing"),
    };
    const reviewPrompt = buildTaskEventPrompt(submittedEvent, []);
    expect(reviewPrompt.display).toContain("待二审");
    expect(reviewPrompt.full).toContain("严禁调用 mode='human_decision'");
    expect(reviewPrompt.full).toContain("绝对禁止在本轮执行终审通过");

    // Worker creates a dedicated thread on Chief Bot, binds chiefBotId/chiefThreadId, and runs unattended without automationSource='api'.
    const chiefBot = { id: "bot-chief", name: "多宝", threadId: "t-chief-main", chiefOfStaff: true, hidden: false } as BotRecord;
    const specialistBot = { id: "bot-artist", name: "画师", threadId: "t-artist-main", chiefOfStaff: false, hidden: false, title: "视觉设计" } as BotRecord;
    const messages = new Map<string, Message[]>();
    const startTurn = vi.fn(async (_botId: string, _text: string, opts: { onTurnSettled?: () => void }) => {
      opts.onTurnSettled?.();
    });
    const createTask = vi.fn((_botId: string, title: string) => ({ threadId: "t-chief-task-1", title }));
    let claimedOnce = false;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/task-events/claim")) {
        if (claimedOnce) return mockJsonResponse({ event: null });
        claimedOnce = true;
        return mockJsonResponse({ event: assignedEvent });
      }
      return mockJsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const worker = createCollabTaskWorker({
      gateway: makeGateway(fetchMock),
      store: {
        bots: [chiefBot, specialistBot],
        bot: id => [chiefBot, specialistBot].find(b => b.id === id) ?? null,
        createTask: createTask as never,
        appendMessage: (tid, msg) => {
          const entry = { id: `m-${Math.random()}`, at: Date.now(), ...msg } as Message;
          messages.set(tid, [...(messages.get(tid) ?? []), entry]);
          return entry;
        },
        messagesFor: tid => messages.get(tid) ?? [],
      },
      startTurn: startTurn as never,
      threadBusy: () => false,
    });
    worker.kick();
    await new Promise(resolve => setTimeout(resolve, 60));
    worker.setActive(false);

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(startTurn.mock.calls[0]![0]).toBe("bot-chief");
    expect(startTurn.mock.calls[0]![2]).toMatchObject({ threadId: "t-chief-task-1", unattended: true });
    expect((startTurn.mock.calls[0]![2] as Record<string, unknown>).automationSource).toBeUndefined();
    expect(getTaskBinding(taskId)).toMatchObject({
      botId: "bot-chief",
      threadId: "t-chief-task-1",
      chiefBotId: "bot-chief",
      chiefThreadId: "t-chief-task-1",
    });
  });

  it("enforces chief_auto_submit_on_approve guard on submit and blocks automated final approval on review", async () => {
    resetCollabTaskPrefsForTests();
    expect(getCollabTaskPrefs().chief_auto_submit_on_approve).toBe(false);

    saveTaskBinding({
      teamId,
      teamName: "AI短剧小组",
      taskId,
      taskTitle: "第3集女主定妆图",
      botId: "bot-chief",
      threadId: "t-chief-task-1",
      chiefBotId: "bot-chief",
      chiefThreadId: "t-chief-task-1",
    });

    let automated = true;
    registerCollabTaskRuntimeHooks({
      resolveBotName: id => (id === "bot-chief" ? "多宝" : "画师"),
      isChiefBot: id => id === "bot-chief",
      isAutomatedTurn: () => automated,
      listChildThreads: () => [{ botId: "bot-artist", botName: "画师", threadId: "t-artist-work", title: "角色设计" }],
    });

    let taskStatus: DoneBotTeamTaskDetail["task"]["status"] = "in_progress";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/submit")) return mockJsonResponse(makeDetail("bot_reviewing"));
      if (url.endsWith("/bot-review")) return mockJsonResponse(makeDetail("ready_for_review"));
      if (url.endsWith("/review")) return mockJsonResponse(makeDetail("done"));
      return mockJsonResponse(makeDetail(taskStatus));
    }) as unknown as typeof fetch;
    const gw = makeGateway(fetchMock);

    const callInternal = async (reqPath: string, body: Record<string, unknown>) => {
      let status = 0;
      let payload: unknown = null;
      await handleDoneBotCollabTaskInternal(
        gw,
        reqPath,
        {} as never,
        (_res, s, v) => { status = s; payload = v; },
        async () => body,
      );
      return { status, payload: payload as Record<string, unknown> };
    };

    try {
      // 1. Detail exposes task_prefs, turn_context, and delegated_workers.
      const detailRes = await callInternal("/api/internal/donebot/collab/tasks/detail", {
        team_id: teamId, task_id: taskId, bot_id: "bot-chief", thread_id: "t-chief-task-1",
      });
      expect(detailRes.status).toBe(200);
      expect(detailRes.payload.task_prefs).toEqual({ chief_auto_submit_on_approve: false });
      expect(detailRes.payload.turn_context).toEqual({ is_chief_bot: true, is_automated_turn: true });
      expect(detailRes.payload.delegated_workers).toEqual([
        { bot_id: "bot-artist", bot_name: "画师", thread_id: "t-artist-work", title: "角色设计" },
      ]);

      // 2. Specialist sub-bot is blocked from submitting directly in an automated turn on a Chief-orchestrated task.
      const workerSubmit = await callInternal("/api/internal/donebot/collab/tasks/submit", {
        team_id: teamId, task_id: taskId, bot_id: "bot-artist", thread_id: "t-artist-work", brief: "子助手尝试直交",
      });
      expect(workerSubmit.status).toBe(403);
      expect(String(workerSubmit.payload.error)).toContain("主协调助手");

      // 3. Chief Bot automated submit is blocked when chief_auto_submit_on_approve is false and status is in_progress.
      const chiefBlockedSubmit = await callInternal("/api/internal/donebot/collab/tasks/submit", {
        team_id: teamId, task_id: taskId, bot_id: "bot-chief", thread_id: "t-chief-task-1", brief: "首次自动提交",
      });
      expect(chiefBlockedSubmit.status).toBe(403);
      expect(String(chiefBlockedSubmit.payload.error)).toContain("主协调助手代人审批提交");

      // 4. Enabling chief_auto_submit_on_approve allows Chief Bot automated submit after first-pass review.
      saveCollabTaskPrefs({ chief_auto_submit_on_approve: true });
      const chiefAutoSubmit = await callInternal("/api/internal/donebot/collab/tasks/submit", {
        team_id: teamId, task_id: taskId, bot_id: "bot-chief", thread_id: "t-chief-task-1", brief: "一审合格代提交",
      });
      expect(chiefAutoSubmit.status).toBe(200);

      // 5. Turning pref back off still allows automated resubmit during bot_revising, and allows human interactive submit.
      saveCollabTaskPrefs({ chief_auto_submit_on_approve: false });
      taskStatus = "bot_revising";
      const revisingSubmit = await callInternal("/api/internal/donebot/collab/tasks/submit", {
        team_id: teamId, task_id: taskId, bot_id: "bot-chief", thread_id: "t-chief-task-1", brief: "二审驳回返工重提",
      });
      expect(revisingSubmit.status).toBe(200);

      taskStatus = "in_progress";
      automated = false;
      const humanConfirmedSubmit = await callInternal("/api/internal/donebot/collab/tasks/submit", {
        team_id: teamId, task_id: taskId, bot_id: "bot-chief", thread_id: "t-chief-task-1", brief: "主人确认后提交",
      });
      expect(humanConfirmedSubmit.status).toBe(200);

      // 6. Reviewer Chief Bot is BLOCKED from human_decision/approve during automated second-pass review.
      automated = true;
      const blockedFinalApprove = await callInternal("/api/internal/donebot/collab/tasks/review", {
        team_id: teamId, task_id: taskId, bot_id: "bot-chief", thread_id: "t-reviewer-chief",
        mode: "human_decision", decision: "approve", summary: "试图自动终审",
      });
      expect(blockedFinalApprove.status).toBe(403);
      expect(String(blockedFinalApprove.payload.error)).toContain("只能执行二审");

      // 7. Reviewer Chief Bot CAN run bot_review (second-pass pass -> ready_for_review) in automated turns.
      const botSecondPass = await callInternal("/api/internal/donebot/collab/tasks/review", {
        team_id: teamId, task_id: taskId, bot_id: "bot-chief", thread_id: "t-reviewer-chief",
        mode: "bot_review", verdict: "pass", summary: "二审通过，请派发人终审",
      });
      expect(botSecondPass.status).toBe(200);

      // 8. When the human reviewer explicitly instructs approval in interactive chat (automated=false), human_decision succeeds.
      automated = false;
      const humanSpokenApprove = await callInternal("/api/internal/donebot/collab/tasks/review", {
        team_id: teamId, task_id: taskId, bot_id: "bot-chief", thread_id: "t-reviewer-chief",
        mode: "human_decision", decision: "approve", summary: "派发人确认通过",
      });
      expect(humanSpokenApprove.status).toBe(200);
    } finally {
      registerCollabTaskRuntimeHooks({});
      resetCollabTaskPrefsForTests();
    }
  });
});
