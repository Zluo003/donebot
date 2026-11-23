// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DoneBotTeamChannel,
  DoneBotTeamTask,
  DoneBotTeamTaskDetail,
} from "../../shared/donebot-collab";
import type { CollabOverview } from "./collab-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  api: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  dispatch: vi.fn(),
  openBot: vi.fn(),
  appendComposerDraft: vi.fn(),
  storeState: {
    hydrated: true,
    activeView: "collab" as "chat" | "collab",
    bots: [
      { id: "bot-duobao", name: "多宝", threadId: "t-main", hidden: false, chiefOfStaff: true },
      { id: "bot-designer", name: "画师小美", threadId: "t-designer", hidden: false, chiefOfStaff: false },
    ],
    config: {
      donebot: { enabled: true, authenticated: true, user: { id: "101", email: "boss@example.invalid" } },
      profile: { name: "老罗", email: "boss@example.invalid" },
    },
  },
}));

vi.mock("@/state/api", () => ({ api: fixture.api }));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: fixture.storeState, dispatch: fixture.dispatch }),
}));
vi.mock("@/state/thread-navigation", () => ({
  openBot: fixture.openBot,
}));
vi.mock("@/lib/drafts", () => ({
  appendComposerDraft: fixture.appendComposerDraft,
}));
vi.mock("@/components/DesktopCapabilities", () => ({
  useCaptionChrome: () => ({ dragProps: {} }),
}));

const { refreshCollabOverview, resetCollabStore, setCollabSelection } = await import("./collab-store");
const { CollabWorkspacePage } = await import("./CollabWorkspacePage");

const teamId = "11111111-1111-4111-8111-111111111111";
const installId = "22222222-2222-4222-8222-222222222222";
const defaultChId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const storyboardChId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const taskId1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

function makeChannels(): DoneBotTeamChannel[] {
  return [
    {
      id: defaultChId,
      team_id: teamId,
      name: "大厅",
      description: "团队全员日常同步",
      is_default: true,
      is_private: false,
      chat_scope_type: "team",
      chat_target_id: teamId,
      created_by: 101,
      member_ids: [],
      created_at: "2026-11-23T01:00:00Z",
      updated_at: "2026-11-23T01:00:00Z",
    },
    {
      id: storyboardChId,
      team_id: teamId,
      name: "第1-5集分镜",
      description: "AI短剧分镜与样片",
      is_default: false,
      is_private: false,
      chat_scope_type: "channel",
      chat_target_id: storyboardChId,
      created_by: 101,
      member_ids: [],
      created_at: "2026-11-23T01:05:00Z",
      updated_at: "2026-11-23T01:05:00Z",
    },
  ];
}

function makeOverview(channels = makeChannels()): CollabOverview {
  return {
    identity: {
      account_id: "101",
      installation_id: installId,
      device_name: "Mac",
      email: "boss@example.invalid",
      nickname: "老罗",
    },
    friends: { friends: [], incoming_requests: [], outgoing_requests: [] },
    folders: { owned: [], shared_with_me: [] },
    bots: { owned: [], shared_with_me: [] },
    teams: [{
      id: teamId,
      name: "AI短剧小组",
      role: "owner",
      member_version: 1,
      created_at: "2026-11-22T00:00:00Z",
    }],
    groups: [],
    chat_bots: { [`team:${teamId}`]: [] },
    team_capabilities: [],
    team_members: {
      [teamId]: [
        { user_id: 101, email: "boss@example.invalid", nickname: "老罗", role: "owner", version: 1 },
        { user_id: 202, email: "wang@example.invalid", nickname: "小王", role: "member", version: 1 },
      ],
    },
    team_channels: { [teamId]: channels },
    team_member_profiles: {
      [teamId]: [{ user_id: 202, job_title: "分镜美术", updated_at: "2026-11-23T01:00:00Z" }],
    },
    team_task_counts: [{
      team_id: teamId,
      open_total: 1,
      assigned_to_me: 0,
      review_by_me: 1,
      changes_requested_to_me: 0,
    }],
    incoming_team_invitations: [],
    chat_summaries: [
      {
        scope_type: "channel",
        target_id: storyboardChId,
        last_message_id: 12,
        last_kind: "text",
        last_body: "第3集定妆图今天能出吗？",
        last_sender_id: 202,
        last_sender_name: "小王",
        last_created_at: "2026-11-23T02:00:00Z",
        unread_count: 2,
      },
    ],
    local_bots: [],
  };
}

function makeTask(status: DoneBotTeamTask["status"] = "in_review"): DoneBotTeamTask {
  return {
    id: taskId1,
    team_id: teamId,
    channel_id: storyboardChId,
    channel_name: "第1-5集分镜",
    title: "第3集女主定妆图",
    description: "需与第1集服装保持一致",
    acceptance_criteria: ["共 3 张 9:16 竖图", "古风红衣人设一致"],
    status,
    priority: "high",
    creator_id: 101,
    assignee_id: 202,
    reviewer_id: 101,
    collaborator_ids: [],
    due_at: "2026-12-01T15:59:59Z",
    auto_review_enabled: true,
    max_auto_revisions: 2,
    auto_revision_count: 1,
    assignee_auto_resubmit: true,
    latest_bot_review: status === "ready_for_review" ? {
      verdict: "pass",
      summary: "3 张定妆图比例均为 9:16，人设一致，建议主人确认表情张力。",
      passed_items: ["3 张 9:16 竖图齐全", "无文字乱码"],
      attention_items: ["第 2 张眼神偏柔和，请拍板"],
      bot_name: "多宝主协调",
    } : undefined,
    update_count: 1,
    deliverable_count: 1,
    created_at: "2026-11-23T01:00:00Z",
    updated_at: "2026-11-23T02:00:00Z",
  };
}

function makeTaskDetail(status: DoneBotTeamTask["status"] = "in_review"): DoneBotTeamTaskDetail {
  return {
    task: makeTask(status),
    updates: [
      {
        id: 1,
        task_id: taskId1,
        actor_id: 202,
        actor_email: "wang@example.invalid",
        actor_nickname: "小王",
        kind: "submission",
        body: "第一版定妆图请验收",
        file_id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
        file_name: "heroine_v1.png",
        file_mime: "image/png",
        file_size: 4096,
        created_at: "2026-11-23T02:00:00Z",
      },
      ...(status === "changes_requested" ? [{
        id: 2,
        task_id: taskId1,
        actor_id: 101,
        actor_email: "boss@example.invalid",
        actor_nickname: "老罗",
        kind: "request_changes" as const,
        body: "衣服领口偏暗，请调亮",
        created_at: "2026-11-23T02:10:00Z",
      }] : []),
    ],
  };
}

async function flush() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

describe("CollabTeamWorkspace multi-channel & human task review", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) {
      await act(async () => { root?.unmount(); });
      root = null;
    }
    host?.remove();
    host = null;
    resetCollabStore();
    fixture.api.mockReset();
    fixture.dispatch.mockReset();
    fixture.openBot.mockReset();
    fixture.appendComposerDraft.mockReset();
  });

  function mount() {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    return root;
  }

  it("switches team channels, converts a chat message into a task, reviews it, and hands off to local bot", async () => {
    let currentDetail = makeTaskDetail("in_review");
    let currentTasks = [currentDetail.task];
    const overview = makeOverview();

    fixture.api.mockImplementation(async (path, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (path === "/api/donebot/collab/overview") return overview;
      if (path.startsWith(`/api/donebot/collab/chats/team/${teamId}/messages`)) {
        return [{
          id: 10,
          scope_type: "team",
          target_id: teamId,
          sender_id: 202,
          sender_kind: "user",
          sender_email: "wang@example.invalid",
          sender_nickname: "小王",
          kind: "text",
          body: "周五前把主图三版方案做出来吧",
          created_at: "2026-11-23T01:30:00Z",
        }];
      }
      if (path.startsWith(`/api/donebot/collab/chats/channel/${storyboardChId}/messages`)) {
        return [{
          id: 12,
          scope_type: "channel",
          target_id: storyboardChId,
          sender_id: 202,
          sender_kind: "user",
          sender_email: "wang@example.invalid",
          sender_nickname: "小王",
          kind: "text",
          body: "第3集定妆图今天能出吗？",
          created_at: "2026-11-23T02:00:00Z",
        }];
      }
      if (path.endsWith("/read")) return { last_read_id: 12 };
      if (path.startsWith(`/api/donebot/collab/teams/${teamId}/tasks?`)) return currentTasks;
      if (path === `/api/donebot/collab/teams/${teamId}/tasks` && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { title: string };
        const created = { ...makeTask("todo"), id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", title: body.title };
        currentTasks = [created, ...currentTasks];
        currentDetail = { task: created, updates: [] };
        return created;
      }
      if (path.startsWith(`/api/donebot/collab/teams/${teamId}/tasks/`) && method === "GET") {
        return currentDetail;
      }
      if (path.endsWith("/review") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { decision: string };
        currentDetail = makeTaskDetail(body.decision === "approve" ? "done" : "changes_requested");
        currentTasks = [currentDetail.task];
        return currentDetail;
      }
      if (path === `/api/donebot/collab/teams/${teamId}/members/202/profile` && method === "PUT") {
        return { user_id: 202, job_title: "主美导演", updated_at: "2026-11-23T03:00:00Z" };
      }
      return [];
    });

    const r = mount();
    await act(async () => {
      await refreshCollabOverview();
      setCollabSelection({ kind: "team", teamId });
      r.render(createElement(CollabWorkspacePage));
    });
    await flush();

    // Verify channel bar renders both #大厅 and #第1-5集分镜, and job title badge appears on message sender.
    expect(host!.textContent).toContain("大厅");
    expect(host!.textContent).toContain("第1-5集分镜");
    expect(host!.textContent).toContain("分镜美术");

    // Switch to sub-channel #第1-5集分镜.
    const chBtn = host!.querySelector<HTMLButtonElement>(`[data-collab-channel-pill="${storyboardChId}"]`);
    expect(chBtn).not.toBeNull();
    await act(async () => { chBtn!.click(); });
    await flush();
    expect(host!.textContent).toContain("第3集定妆图今天能出吗？");

    // Convert message into task.
    const convertBtn = host!.querySelector<HTMLButtonElement>(`[data-collab-msg-to-task="12"]`);
    expect(convertBtn).not.toBeNull();
    await act(async () => { convertBtn!.click(); });
    await flush();
    const submitTaskBtn = host!.querySelector<HTMLButtonElement>("[data-collab-task-submit]");
    expect(submitTaskBtn).not.toBeNull();
    await act(async () => { submitTaskBtn!.click(); });
    await flush();

    // Automatically switched to 任务分工 view and posted POST /tasks.
    expect(fixture.api).toHaveBeenCalledWith(
      `/api/donebot/collab/teams/${teamId}/tasks`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(host!.querySelector("[data-collab-team-tasks]")).not.toBeNull();

    // Open original in_review task and click 退回修改 -> fill reason -> confirm.
    currentDetail = makeTaskDetail("in_review");
    const taskCard = host!.querySelector<HTMLButtonElement>(`[data-collab-task-card="${taskId1}"]`);
    expect(taskCard).not.toBeNull();
    await act(async () => { taskCard!.click(); });
    await flush();

    const rejectOpenBtn = host!.querySelector<HTMLButtonElement>("[data-collab-task-open-reject]");
    expect(rejectOpenBtn).not.toBeNull();
    await act(async () => { rejectOpenBtn!.click(); });
    await flush();

    const reviewInput = host!.querySelector<HTMLTextAreaElement>("[data-collab-task-review-input]");
    expect(reviewInput).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(reviewInput, "衣服领口偏暗，请调亮");
      reviewInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const confirmReviewBtn = host!.querySelector<HTMLButtonElement>("[data-collab-task-review-confirm]");
    await act(async () => { confirmReviewBtn!.click(); });
    await flush();

    expect(fixture.api).toHaveBeenCalledWith(
      `/api/donebot/collab/teams/${teamId}/tasks/${taskId1}/review`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(host!.textContent).toContain("待修改");

    // Assigner/reviewer (老罗, 101) must NOT see execution buttons on a task assigned to 小王 (202).
    expect(host!.querySelector("[data-collab-task-start]")).toBeNull();
    expect(host!.querySelector("[data-collab-task-open-submit]")).toBeNull();
    expect(host!.querySelector("[data-collab-task-handoff-bot]")).toBeNull();
    expect(host!.querySelector("[data-collab-task-passive-status]")?.textContent).toContain("已退回给 小王 修改");

    // Switch task assignee to current user (101) and re-open detail -> execution buttons + auto-send handoff appear.
    currentDetail = { ...currentDetail, task: { ...currentDetail.task, assignee_id: 101 } };
    const closeBtn = host!.querySelector<HTMLButtonElement>('button[aria-label="关闭任务详情"]');
    await act(async () => { closeBtn!.click(); });
    await flush();
    const reopenRow = host!.querySelector<HTMLButtonElement>(`[data-collab-task-card="${taskId1}"]`);
    await act(async () => { reopenRow!.click(); });
    await flush();

    const handoffBtn = host!.querySelector<HTMLButtonElement>("[data-collab-task-handoff-bot]");
    expect(handoffBtn).not.toBeNull();
    expect(host!.querySelector("[data-collab-task-open-submit]")).not.toBeNull();
    await act(async () => { handoffBtn!.click(); });
    await flush();
    const pickBotBtn = host!.querySelector<HTMLButtonElement>('[data-collab-handoff-bot-pick="bot-duobao"]');
    expect(pickBotBtn).not.toBeNull();
    await act(async () => { pickBotBtn!.click(); });
    await flush();

    expect(fixture.appendComposerDraft).not.toHaveBeenCalled();
    expect(fixture.api).toHaveBeenCalledWith(
      "/api/donebot/collab/task-bindings",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fixture.openBot).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showChat" });
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "send",
      botId: "bot-duobao",
      threadId: "t-main",
      text: expect.stringContaining("严禁你亲自下场干活"),
    }));
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "send",
      text: expect.stringContaining("衣服领口偏暗，请调亮"),
    }));
  });

  it("defaults task status filter to 全部状态 using custom dropdown, shows bot review card, and auto-refreshes", async () => {
    vi.useFakeTimers();
    try {
      const overview = makeOverview();
      let currentDetail = makeTaskDetail("bot_reviewing");
      let currentTasks = [currentDetail.task];
      const requestedTaskUrls: string[] = [];

      let chiefAutoSubmit = false;
      fixture.api.mockImplementation(async (path, init) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/api/donebot/collab/task-prefs" && method === "GET") {
          return { chief_auto_submit_on_approve: chiefAutoSubmit };
        }
        if (path === "/api/donebot/collab/task-prefs" && method === "PATCH") {
          const parsed = JSON.parse(String(init?.body ?? "{}")) as { chief_auto_submit_on_approve?: boolean };
          if (typeof parsed.chief_auto_submit_on_approve === "boolean") chiefAutoSubmit = parsed.chief_auto_submit_on_approve;
          return { chief_auto_submit_on_approve: chiefAutoSubmit };
        }
        if (path === "/api/donebot/collab/overview") return overview;
        if (path.startsWith(`/api/donebot/collab/teams/${teamId}/tasks?`)) {
          requestedTaskUrls.push(path);
          return currentTasks;
        }
        if (path.startsWith(`/api/donebot/collab/teams/${teamId}/tasks/`) && method === "GET") {
          return currentDetail;
        }
        if (path.endsWith("/review") && method === "POST") {
          currentDetail = makeTaskDetail("done");
          currentTasks = [currentDetail.task];
          return currentDetail;
        }
        if (path === `/api/donebot/collab/teams/${teamId}/tasks/dispatch-via-bot` && method === "POST") {
          return {
            bot_id: "bot-duobao",
            bot_name: "多宝",
            thread_id: "t-main",
            ok: true,
            reply: "已为小王创建任务「第4集预告图」并附上 3 条验收清单。",
            pending_card: false,
          };
        }
        return [];
      });

      const r = mount();
      await act(async () => {
        await refreshCollabOverview();
        setCollabSelection({ kind: "team", teamId });
        r.render(createElement(CollabWorkspacePage));
      });
      await act(async () => { await Promise.resolve(); });

      // Switch directly to 任务分工 tab.
      const tasksTab = host!.querySelector<HTMLButtonElement>('[data-collab-team-view-tab="tasks"]');
      expect(tasksTab).not.toBeNull();
      await act(async () => { tasksTab!.click(); });
      await act(async () => { await Promise.resolve(); });

      // Zero native <select> elements; default status filter is 全部状态 (status=all).
      expect(host!.querySelectorAll("select")).toHaveLength(0);
      expect(requestedTaskUrls[0]).toContain("status=all");
      const statusTrigger = host!.querySelector<HTMLButtonElement>("[data-collab-task-status-filter]");
      expect(statusTrigger).not.toBeNull();
      expect(statusTrigger!.textContent).toContain("全部状态");

      // Open custom status dropdown and choose 待终审拍板.
      await act(async () => { statusTrigger!.click(); });
      const readyOpt = document.body.querySelector<HTMLButtonElement>('[data-collab-select-option="ready_for_review"]');
      expect(readyOpt).not.toBeNull();
      await act(async () => { readyOpt!.click(); });
      await act(async () => { await Promise.resolve(); });
      expect(requestedTaskUrls.some(u => u.includes("status=ready_for_review"))).toBe(true);

      // Simulate backend Bot finishing first-pass review -> auto-refresh picks up ready_for_review without hammering /overview!
      const overviewCallsBefore = fixture.api.mock.calls.filter(([p]) => p === "/api/donebot/collab/overview").length;
      currentDetail = makeTaskDetail("ready_for_review");
      currentTasks = [currentDetail.task];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      expect(host!.textContent).toContain("二审通过，待你终审");
      const overviewCallsAfter = fixture.api.mock.calls.filter(([p]) => p === "/api/donebot/collab/overview").length;
      expect(overviewCallsAfter).toBe(overviewCallsBefore);

      // Toggle Chief Bot auto-submit preference directly from the task toolbar.
      const autoSubmitToggle = host!.querySelector<HTMLButtonElement>("[data-collab-chief-auto-submit]");
      expect(autoSubmitToggle).not.toBeNull();
      expect(autoSubmitToggle!.getAttribute("aria-checked")).toBe("false");
      await act(async () => { autoSubmitToggle!.click(); });
      await act(async () => { await Promise.resolve(); });
      expect(fixture.api).toHaveBeenCalledWith(
        "/api/donebot/collab/task-prefs",
        expect.objectContaining({ method: "PATCH" }),
      );
      expect(autoSubmitToggle!.getAttribute("aria-checked")).toBe("true");

      // Open task detail -> shows Bot review opinion card and allows human approve.
      const card = host!.querySelector<HTMLButtonElement>(`[data-collab-task-card="${taskId1}"]`);
      expect(card).not.toBeNull();
      await act(async () => { card!.click(); });
      await act(async () => { await Promise.resolve(); });

      expect(host!.querySelector('[data-collab-task-bot-review="pass"]')).not.toBeNull();
      expect(host!.textContent).toContain("多宝主协调");
      expect(host!.textContent).toContain("第 2 张眼神偏柔和，请拍板");
      expect(host!.querySelector("[data-collab-task-open-approve]")).not.toBeNull();

      // Redundant inline dispatch bar is no longer shown above the task list.
      expect(host!.querySelector("[data-collab-ai-dispatch-bar]")).toBeNull();

      // Clicking 派发任务 opens directly in 主协调助手派发 mode (no manual form first) and dispatches via Chief Bot.
      const newTaskBtn = host!.querySelector<HTMLButtonElement>("[data-collab-new-task]");
      expect(newTaskBtn).not.toBeNull();
      await act(async () => { newTaskBtn!.click(); });
      expect(host!.querySelector("[data-collab-ai-dispatch-panel]")).not.toBeNull();
      expect(host!.querySelector("[data-collab-task-title-input]")).toBeNull();

      const dialogTextarea = host!.querySelector<HTMLTextAreaElement>("[data-collab-ai-dispatch-textarea]");
      expect(dialogTextarea).not.toBeNull();
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(dialogTextarea, "让小王明天前出第4集预告图");
        dialogTextarea!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const dialogSubmitBtn = host!.querySelector<HTMLButtonElement>("[data-collab-ai-dispatch-dialog-submit]");
      expect(dialogSubmitBtn).not.toBeNull();
      await act(async () => { dialogSubmitBtn!.click(); });
      await act(async () => { await Promise.resolve(); });
      expect(fixture.api).toHaveBeenCalledWith(
        `/api/donebot/collab/teams/${teamId}/tasks/dispatch-via-bot`,
        expect.objectContaining({ method: "POST" }),
      );
      expect(host!.querySelector("[data-collab-ai-dispatch-receipt]")?.textContent).toContain("已为小王创建任务");

      // Can still switch to 手动填表 tab when needed.
      const manualTab = host!.querySelector<HTMLButtonElement>('[data-collab-task-mode="manual"]');
      expect(manualTab).not.toBeNull();
      await act(async () => { manualTab!.click(); });
      expect(host!.querySelector("[data-collab-task-title-input]")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
