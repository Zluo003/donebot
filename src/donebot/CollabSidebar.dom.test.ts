// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollabOverview } from "./collab-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  api: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  dispatch: vi.fn(),
  storeState: {
    hydrated: true,
    activeView: "chat" as "chat" | "collab",
    appSettingsOpen: false,
    pluginsOpen: false,
    shortcutsOpen: false,
    config: {
      donebot: { enabled: true, authenticated: true, user: { id: "101", email: "alice@example.invalid" } },
      profile: { name: "老罗", email: "alice@example.invalid" },
    },
  },
}));

vi.mock("@/state/api", () => ({ api: fixture.api }));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: fixture.storeState, dispatch: fixture.dispatch }),
}));
vi.mock("@/components/DesktopCapabilities", () => ({
  useCaptionChrome: () => ({ dragProps: {} }),
}));

const {
  COLLAB_DESKTOP_NOTIFY_BOT_ID,
  COLLAB_DESKTOP_NOTIFY_THREAD_ID,
  isCollabEligible,
  refreshCollabOverview,
  resetCollabStore,
  useCollabStore,
} = await import("./collab-store");
const { CollabSidebarList, CollabSidebarSwitch } = await import("./CollabSidebar");
const { CollabWorkspacePage } = await import("./CollabWorkspacePage");
const { CollabSyncHost, CollabToastHost } = await import("./CollabNotifications");
const { CollabProfileDialog } = await import("./CollabAvatar");

const teamId = "11111111-1111-4111-8111-111111111111";
const installId = "22222222-2222-4222-8222-222222222222";
const sharedFolderId = "33333333-3333-4333-8333-333333333333";
const sharedBotId = "44444444-4444-4444-8444-444444444444";
const incomingReqId = "55555555-5555-4555-8555-555555555555";
const incomingInvId = "66666666-6666-4666-8666-666666666666";

function makeOverview(opts: { incomingFriend?: boolean; incomingTeam?: boolean } = {}): CollabOverview {
  return {
    identity: {
      account_id: "101",
      installation_id: installId,
      device_name: "Alice Mac",
      email: "alice@example.invalid",
      nickname: "老罗",
      avatar_url: "data:image/jpeg;base64,/9j/4AAQ",
    },
    friends: {
      friends: [{ user_id: 202, email: "bob@example.invalid", created_at: "2026-11-22T00:00:00Z" }],
      incoming_requests: opts.incomingFriend === false ? [] : [{
        id: incomingReqId,
        requester_id: 303,
        requester_email: "dave@example.invalid",
        recipient_id: 101,
        recipient_email: "alice@example.invalid",
        note: "一起做项目",
        status: "pending",
        created_at: "2026-11-22T00:00:00Z",
      }],
      outgoing_requests: [],
    },
    folders: {
      owned: [],
      shared_with_me: [{
        id: sharedFolderId,
        owner_user_id: 202,
        owner_email: "bob@example.invalid",
        device_name: "Bob PC",
        name: "设计资源",
        access: "read",
        online: true,
        sources: [{ kind: "friend" }, { kind: "team", team_id: teamId, team_name: "产品研发组" }],
        updated_at: "2026-11-22T00:00:00Z",
      }],
    },
    bots: {
      owned: [],
      shared_with_me: [{
        id: sharedBotId,
        owner_user_id: 202,
        owner_email: "bob@example.invalid",
        name: "代码审查官",
        title: "严格把关代码质量",
        description: "擅长评审",
        skill_count: 3,
        has_soul: true,
        sources: [{ kind: "friend" }],
        updated_at: "2026-11-22T00:00:00Z",
      }],
    },
    teams: [{ id: teamId, name: "产品研发组", role: "owner", member_version: 1, created_at: "2026-11-22T00:00:00Z" }],
    team_capabilities: ["identity", "collaboration"],
    team_members: {
      [teamId]: [
        { user_id: 101, email: "alice@example.invalid", role: "owner", version: 1 },
        { user_id: 202, email: "bob@example.invalid", role: "member", version: 1 },
      ],
    },
    incoming_team_invitations: opts.incomingTeam === false ? [] : [{
      id: incomingInvId,
      team_id: "77777777-7777-4777-8777-777777777777",
      team_name: "市场组",
      role: "member",
      invited_by_email: "eve@example.invalid",
      expires_at: "2026-11-29T00:00:00Z",
    }],
    chat_summaries: [],
    local_bots: [{
      id: "bot-writer",
      name: "写作助手",
      title: "中文文案",
      description: "擅长产品文档",
      has_soul: true,
      skill_count: 2,
    }],
  };
}

function Harness() {
  const { sidebarTab } = useCollabStore();
  return createElement("div", null,
    createElement(CollabSyncHost),
    createElement(CollabSidebarSwitch, { compact: false }),
    sidebarTab === "collab" ? createElement(CollabSidebarList, { query: "", icons: false }) : createElement("div", { "data-bots-pane": "" }, "Bots"),
    fixture.storeState.activeView === "collab" ? createElement(CollabWorkspacePage) : null,
    createElement(CollabToastHost),
  );
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderHarness() {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => { root!.render(createElement(Harness)); });
  await act(async () => { await Promise.resolve(); });
}

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  container?.remove();
  container = null;
  sessionStorage.clear();
  delete (window as { ogb?: unknown }).ogb;
  resetCollabStore();
  fixture.api.mockReset();
  fixture.dispatch.mockReset();
  fixture.storeState.activeView = "chat";
  fixture.storeState.appSettingsOpen = false;
  fixture.storeState.pluginsOpen = false;
  fixture.storeState.shortcutsOpen = false;
});

describe("Collab sidebar switcher, chat workspace, right drawer, and modals", () => {
  it("shows only Friends & Teams in sidebar, supports friend chat, native right drawer folder browsing without hidden files, and + modal dialogs", async () => {
    const showDesktop = vi.fn().mockResolvedValue(true);
    (window as { ogb?: unknown }).ogb = {
      desktopNotifications: { show: showDesktop, onOpen: () => () => {} },
    };

    fixture.dispatch.mockImplementation((action: { type: string }) => {
      if (action.type === "showCollab") fixture.storeState.activeView = "collab";
      if (action.type === "showChat") fixture.storeState.activeView = "chat";
    });

    const overview = makeOverview();
    fixture.api.mockImplementation(async (path, init) => {
      if (path === "/api/donebot/collab/overview") return overview;
      if (path.startsWith("/api/donebot/collab/chats/friend/202/messages") && !init?.method) {
        return [{
          id: 11,
          scope_type: "friend",
          target_id: "202",
          sender_id: 202,
          sender_email: "bob@example.invalid",
          kind: "text",
          body: "你好，设计稿发你了",
          created_at: "2026-11-22T10:00:00Z",
        }];
      }
      if (path === "/api/donebot/collab/chats/friend/202/messages" && init?.method === "POST") {
        return {
          id: 12,
          scope_type: "friend",
          target_id: "202",
          sender_id: 101,
          sender_email: "alice@example.invalid",
          kind: "text",
          body: "收到，我马上看",
          created_at: "2026-11-22T10:01:00Z",
        };
      }
      if (path.startsWith("/api/donebot/collab/chats/")) return [];
      if (path === `/api/donebot/collab/teams/${teamId}/invitations`) return [];
      if (path === `/api/donebot/collab/folders/${sharedFolderId}/invoke`) {
        return {
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({
                entries: [
                  { name: "spec.md", type: "file", size: 99 },
                  { name: "assets", type: "directory" },
                  { name: ".DS_Store", type: "file", size: 4096 },
                  { name: ".git", type: "directory" },
                ],
              }),
            }],
          },
        };
      }
      if (path === `/api/donebot/collab/bots/${sharedBotId}/install`) {
        return { ok: true, bots: [{ name: "代码审查官" }], skills: 3 };
      }
      return { ok: true };
    });

    await renderHarness();

    // Switch pill displays 机器人 and 好友与团队 with pending badge = 2.
    expect(container!.querySelector('[data-collab-switch-option="bots"]')?.textContent).toBe("机器人");
    const collabOption = container!.querySelector<HTMLButtonElement>('[data-collab-switch-option="collab"]')!;
    expect(collabOption.textContent).toContain("好友与团队");
    expect(container!.querySelector('[data-collab-pending-badge="2"]')?.textContent).toBe("2");

    // Persistent toast & desktop notification fired for incoming requests.
    const toastRegion = container!.querySelector("[data-collab-toast-region]")!;
    expect(toastRegion.textContent).toContain("dave@example.invalid 请求添加你为好友");
    expect(showDesktop).toHaveBeenCalledWith(expect.objectContaining({
      botId: COLLAB_DESKTOP_NOTIFY_BOT_ID,
      threadId: COLLAB_DESKTOP_NOTIFY_THREAD_ID,
      title: "新的好友申请",
    }));

    // Switch sidebar to 好友与团队: sidebar has ONLY Friends & Teams (no top nav items for 消息与申请 / 共享文件夹 / 共享 Bot).
    await act(async () => { collabOption.click(); });
    await renderHarness();
    const sidebarList = container!.querySelector('[data-collab-sidebar-list="full"]')!;
    expect(sidebarList.querySelector("[data-collab-nav]")).toBeNull();
    expect(sidebarList.textContent).not.toContain("消息与申请");
    expect(sidebarList.textContent).not.toContain("共享 Bot");
    expect(sidebarList.textContent).toContain("bob@example.invalid");
    expect(sidebarList.textContent).toContain("产品研发组");

    // Friend chat auto-opened with messages & right inspector drawer!
    expect(container!.querySelector('[data-collab-chat="friend:202"]')).not.toBeNull();
    expect(container!.textContent).toContain("你好，设计稿发你了");

    // Send a chat message.
    const chatInput = container!.querySelector<HTMLTextAreaElement>("[data-collab-chat-input]")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(chatInput, "收到，我马上看");
      chatInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const sendBtn = container!.querySelector<HTMLButtonElement>("[data-collab-chat-send]")!;
    await act(async () => { sendBtn.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(fixture.api).toHaveBeenCalledWith("/api/donebot/collab/chats/friend/202/messages", {
      method: "POST",
      body: JSON.stringify({ body: "收到，我马上看" }),
    });
    expect(container!.textContent).toContain("收到，我马上看");

    // Right drawer「文件夹」tab drills into shared folder browser and hides dotfiles & dotdirs.
    const foldersTab = container!.querySelector<HTMLButtonElement>('[data-collab-right-tab="folders"]')!;
    await act(async () => { foldersTab.click(); });
    const browseBtn = container!.querySelector<HTMLButtonElement>(`[data-collab-right-browse-folder="${sharedFolderId}"]`)!;
    await act(async () => { browseBtn.click(); });
    await act(async () => { await Promise.resolve(); });
    const browserPane = container!.querySelector(`[data-collab-right-folder-browser="${sharedFolderId}"]`)!;
    expect(browserPane.textContent).toContain("spec.md");
    expect(browserPane.textContent).toContain("assets");
    expect(browserPane.textContent).not.toContain(".DS_Store");
    expect(browserPane.textContent).not.toContain(".git");

    // Clicking + on Friends opens the native <dialog> AddFriendDialog.
    const addFriendBtn = container!.querySelector<HTMLButtonElement>("[data-collab-add-friend]")!;
    await act(async () => { addFriendBtn.click(); });
    await renderHarness();
    expect(container!.textContent).toContain("添加好友");
    expect(container!.querySelector('input[name="friend_email"]')).not.toBeNull();

    // Select a team in sidebar -> team chat + right drawer shows team members & invite button.
    const teamBtn = container!.querySelector<HTMLButtonElement>(`[data-collab-team-row="${teamId}"]`)!;
    await act(async () => { teamBtn.click(); });
    await renderHarness();
    expect(container!.querySelector(`[data-collab-chat="team:${teamId}"]`)).not.toBeNull();
    expect(container!.querySelector("[data-collab-right-invite-member]")).not.toBeNull();

    // Switch back to 机器人 returns right pane to chat.
    const botsOption = container!.querySelector<HTMLButtonElement>('[data-collab-switch-option="bots"]')!;
    await act(async () => { botsOption.click(); });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showChat" });
  });

  it("suppresses toast overlay while a modal dialog is open and supports one-click accept from toast", async () => {
    let accepted = false;
    fixture.api.mockImplementation(async (path) => {
      if (path === "/api/donebot/collab/overview") {
        return makeOverview({ incomingFriend: !accepted, incomingTeam: false });
      }
      if (path === `/api/donebot/collab/friends/requests/${incomingReqId}/accept`) {
        accepted = true;
        return { user_id: 303 };
      }
      return { ok: true };
    });

    fixture.storeState.appSettingsOpen = true;
    await renderHarness();
    expect(container!.querySelector(`[data-collab-toast="friend-req:${incomingReqId}"]`)).toBeNull();

    fixture.storeState.appSettingsOpen = false;
    await renderHarness();
    const toast = container!.querySelector(`[data-collab-toast="friend-req:${incomingReqId}"]`)!;
    expect(toast).not.toBeNull();

    const acceptBtn = [...toast.querySelectorAll("button")].find(b => b.textContent?.includes("同意"))!;
    await act(async () => { acceptBtn.click(); });
    await act(async () => { await refreshCollabOverview({ silent: true }); });
    await renderHarness();

    expect(fixture.api).toHaveBeenCalledWith(`/api/donebot/collab/friends/requests/${incomingReqId}/accept`, { method: "POST", body: "{}" });
    expect(container!.querySelector(`[data-collab-toast="friend-req:${incomingReqId}"]`)).toBeNull();
    expect(container!.querySelector("[data-collab-pending-badge]")).toBeNull();
  });

  it("hides 好友与团队 switch in Personal Cloud (remoteClient, cloudManaged, cloudHome)", async () => {
    expect(isCollabEligible({ donebot: { enabled: true, authenticated: true, modelCount: 1, persistent: true } } as never)).toBe(true);
    expect(isCollabEligible({ donebot: { enabled: true, authenticated: true, cloudManaged: true, modelCount: 1, persistent: true } } as never)).toBe(false);
    expect(isCollabEligible({ cloudHome: true, donebot: { enabled: true, authenticated: true, modelCount: 1, persistent: true } } as never)).toBe(false);

    (window as { ogb?: unknown }).ogb = { remoteClient: { active: true } };
    expect(isCollabEligible({ donebot: { enabled: true, authenticated: true, modelCount: 1, persistent: true } } as never)).toBe(false);

    await renderHarness();
    expect(container!.querySelector("[data-collab-sidebar-switch]")).toBeNull();
  });

  it("displays friend remark > nickname > email and saves inline friend remark in right panel", async () => {
    fixture.dispatch.mockImplementation((action: { type: string }) => {
      if (action.type === "showCollab") fixture.storeState.activeView = "collab";
    });
    const overview = makeOverview({ incomingFriend: false, incomingTeam: false });
    overview.friends.friends[0] = {
      ...overview.friends.friends[0]!,
      nickname: "小博",
      remark: "设计师老博",
      avatar_url: "data:image/jpeg;base64,/9j/4AAQ",
    };
    fixture.api.mockImplementation(async (path) => {
      if (path === "/api/donebot/collab/overview") return overview;
      if (path.startsWith("/api/donebot/collab/chats/")) return [];
      if (path === "/api/donebot/collab/friends/202/remark") return { user_id: 202, remark: "前端架构师" };
      return { ok: true };
    });

    await renderHarness();
    const collabOption = container!.querySelector<HTMLButtonElement>('[data-collab-switch-option="collab"]')!;
    await act(async () => { collabOption.click(); });
    await renderHarness();

    const friendRow = container!.querySelector<HTMLButtonElement>('[data-collab-friend-row="202"]')!;
    expect(friendRow.textContent).toContain("设计师老博");
    expect(friendRow.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/4AAQ");

    await act(async () => { friendRow.click(); });
    await renderHarness();
    expect(container!.querySelector("[data-collab-chat-head-pill]")?.textContent).toContain("设计师老博");

    const titleBtn = container!.querySelector<HTMLButtonElement>("[data-collab-inline-title]")!;
    await act(async () => { titleBtn.click(); });
    const input = container!.querySelector<HTMLInputElement>("[data-collab-inline-title-input]")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "前端架构师");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(fixture.api).toHaveBeenCalledWith("/api/donebot/collab/friends/202/remark", {
      method: "PUT",
      body: JSON.stringify({ remark: "前端架构师" }),
    });
  });

  it("syncs local_avatar_url into app config profile on CollabProfileDialog save without clobbering bottom-left avatar", async () => {
    fixture.api.mockImplementation(async (path, init) => {
      if (path === "/api/donebot/collab/profile" && init?.method === "PUT") {
        return {
          email: "alice@example.invalid",
          nickname: "老罗",
          avatar_url: "data:image/jpeg;base64,/9j/4AAQ",
          local_avatar_url: "/api/attachments/synced-dog.jpg",
        };
      }
      return { ok: true };
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(CollabProfileDialog, {
        open: true,
        onClose: () => {},
        email: "alice@example.invalid",
        initialNickname: "老罗",
        initialAvatarUrl: "data:image/jpeg;base64,/9j/4AAQ",
      }));
    });

    const form = container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "configStatus",
      config: expect.objectContaining({
        profile: expect.objectContaining({
          name: "老罗",
          avatarUrl: "/api/attachments/synced-dog.jpg",
        }),
      }),
    }));
  });
});
