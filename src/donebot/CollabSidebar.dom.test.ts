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
const {
  CollabBotBadge,
  CollabProfileDialog,
  resolveCollabBotBadgeFromChatBot,
  resolveCollabBotBadgeFromMessage,
} = await import("./CollabAvatar");
const { MASCOT_BODIES } = await import("../../shared/mascot-bodies");

const teamId = "11111111-1111-4111-8111-111111111111";
const installId = "22222222-2222-4222-8222-222222222222";
const sharedFolderId = "33333333-3333-4333-8333-333333333333";
const sharedBotId = "44444444-4444-4444-8444-444444444444";
const incomingReqId = "55555555-5555-4555-8555-555555555555";
const incomingInvId = "66666666-6666-4666-8666-666666666666";
const groupId = "88888888-8888-4888-8888-888888888888";
const chatBot1Id = "99999999-9999-4999-8999-999999999991";
const chatBot2Id = "99999999-9999-4999-8999-999999999992";

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
      friends: [{ user_id: 202, email: "bob@example.invalid", nickname: "小罗", created_at: "2026-11-22T00:00:00Z" }],
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
    teams: [{
      id: teamId,
      name: "产品研发组",
      role: "owner",
      member_version: 1,
      avatar_url: "data:image/jpeg;base64,TEAMICON",
      created_at: "2026-11-22T00:00:00Z",
    }],
    groups: [{
      id: groupId,
      name: "设计协作群",
      avatar_url: "data:image/jpeg;base64,GROUPICON",
      creator_id: 101,
      members: [
        { user_id: 101, email: "alice@example.invalid", nickname: "老罗", avatar_url: "data:image/jpeg;base64,/9j/4AAQ", joined_at: "2026-11-22T00:00:00Z" },
        { user_id: 202, email: "bob@example.invalid", nickname: "小罗", joined_at: "2026-11-22T00:00:00Z" },
      ],
      created_at: "2026-11-22T00:00:00Z",
      updated_at: "2026-11-22T00:00:00Z",
    }],
    chat_bots: {
      [`group:${groupId}`]: [
        {
          id: chatBot1Id,
          scope_type: "group",
          target_id: groupId,
          owner_user_id: 101,
          owner_email: "alice@example.invalid",
          owner_nickname: "老罗",
          installation_id: installId,
          local_bot_id: "bot-writer",
          bot_name: "写作助手",
          bot_color: "green",
          bot_title: "中文文案",
          allow_all_members: false,
          allowed_user_ids: [202],
          can_invoke: true,
          created_at: "2026-11-22T00:00:00Z",
        },
        {
          id: chatBot2Id,
          scope_type: "group",
          target_id: groupId,
          owner_user_id: 202,
          owner_email: "bob@example.invalid",
          owner_nickname: "小罗",
          installation_id: "77777777-7777-4777-8777-777777777777",
          local_bot_id: "bot-bob",
          bot_name: "私有设计助手",
          bot_color: "purple",
          allow_all_members: false,
          allowed_user_ids: [],
          can_invoke: false,
          created_at: "2026-11-22T00:00:00Z",
        },
      ],
    },
    team_capabilities: ["identity", "collaboration"],
    team_members: {
      [teamId]: [
        { user_id: 101, email: "alice@example.invalid", nickname: "老罗", avatar_url: "data:image/jpeg;base64,/9j/4AAQ", role: "owner", version: 1 },
        { user_id: 202, email: "bob@example.invalid", nickname: "小罗", role: "member", version: 1 },
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
      color: "green",
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

    // Switch sidebar to 好友与团队: teams on top, groups middle, friends below; no top nav clutter.
    await act(async () => { collabOption.click(); });
    await renderHarness();
    const sidebarList = container!.querySelector('[data-collab-sidebar-list="full"]')!;
    expect(sidebarList.querySelector("[data-collab-nav]")).toBeNull();
    expect(sidebarList.textContent).not.toContain("消息与申请");
    expect(sidebarList.textContent).not.toContain("共享 Bot");
    const sections = [...sidebarList.querySelectorAll("[data-collab-section]")].map(el => el.getAttribute("data-collab-section"));
    expect(sections).toEqual(["teams", "groups", "friends"]);
    expect(sidebarList.textContent).toContain("小罗");
    expect(sidebarList.textContent).toContain("产品研发组");
    expect(sidebarList.textContent).toContain("设计协作群");

    // Team auto-selected first with custom avatar, member nicknames, and editable team icon.
    expect(container!.querySelector(`[data-collab-chat="team:${teamId}"]`)).not.toBeNull();
    expect(container!.querySelector("[data-collab-right-invite-member]")).not.toBeNull();
    expect(container!.querySelector("[data-collab-avatar-edit] img")?.getAttribute("src")).toBe("data:image/jpeg;base64,TEAMICON");
    const rightPanel = container!.querySelector("[data-collab-right-panel]")!;
    expect(rightPanel.textContent).toContain("老罗");
    expect(rightPanel.textContent).toContain("小罗");

    // Click friend in sidebar -> friend chat with avatars on BOTH peer and own bubbles & folder browser hiding dotfiles.
    const friendBtn = container!.querySelector<HTMLButtonElement>('[data-collab-friend-row="202"]')!;
    await act(async () => { friendBtn.click(); });
    await renderHarness();
    expect(container!.querySelector('[data-collab-chat="friend:202"]')).not.toBeNull();
    expect(container!.textContent).toContain("你好，设计稿发你了");

    // Send a chat message and verify own bubble also shows own avatar.
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
    const selfMsg = container!.querySelector('[data-collab-msg="12"]')!;
    expect(selfMsg.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/4AAQ");

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

    // Switch back to 机器人 returns right pane to chat.
    const botsOption = container!.querySelector<HTMLButtonElement>('[data-collab-switch-option="bots"]')!;
    await act(async () => { botsOption.click(); });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showChat" });
  });

  it("supports friend group chat avatars, own+peer nicknames on bubbles, @bot picker authorization, and removes invite-code UI", async () => {
    fixture.dispatch.mockImplementation((action: { type: string }) => {
      if (action.type === "showCollab") fixture.storeState.activeView = "collab";
    });
    const overview = makeOverview({ incomingFriend: false, incomingTeam: false });
    fixture.api.mockImplementation(async (path, init) => {
      if (path === "/api/donebot/collab/overview") return overview;
      if (path.startsWith(`/api/donebot/collab/chats/group/${groupId}/messages`) && !init?.method) {
        return [
          {
            id: 21,
            scope_type: "group",
            target_id: groupId,
            sender_id: 101,
            sender_email: "alice@example.invalid",
            sender_nickname: "老罗",
            sender_avatar_url: "data:image/jpeg;base64,/9j/4AAQ",
            kind: "text",
            body: "大家看下方案",
            created_at: "2026-11-23T00:10:00Z",
          },
          {
            id: 22,
            scope_type: "group",
            target_id: groupId,
            sender_id: 101,
            sender_email: "alice@example.invalid",
            sender_nickname: "老罗",
            sender_kind: "bot",
            sender_bot_id: chatBot1Id,
            sender_bot_name: "写作助手",
            sender_bot_color: "green",
            kind: "text",
            body: "已整理好要点",
            created_at: "2026-11-23T00:11:00Z",
          },
          {
            id: 24,
            scope_type: "group",
            target_id: groupId,
            sender_id: 202,
            sender_email: "bob@example.invalid",
            sender_nickname: "小罗",
            kind: "file",
            body: "",
            file_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
            file_name: "donkey.png",
            file_mime: "image/png",
            file_size: 204800,
            created_at: "2026-11-23T00:11:10Z",
          },
          {
            id: 25,
            scope_type: "group",
            target_id: groupId,
            sender_id: 202,
            sender_email: "bob@example.invalid",
            sender_nickname: "小罗",
            kind: "file",
            body: "",
            file_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
            file_name: "demo.mp4",
            file_mime: "video/mp4",
            file_size: 4096000,
            created_at: "2026-11-23T00:11:20Z",
          },
          {
            id: 26,
            scope_type: "group",
            target_id: groupId,
            sender_id: 202,
            sender_email: "bob@example.invalid",
            sender_nickname: "小罗",
            kind: "file",
            body: "",
            file_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
            file_name: "theme.mp3",
            file_mime: "audio/mpeg",
            file_size: 1024000,
            created_at: "2026-11-23T00:11:30Z",
          },
        ];
      }
      if (path === `/api/donebot/collab/chats/group/${groupId}/messages` && init?.method === "POST") {
        return {
          id: 23,
          scope_type: "group",
          target_id: groupId,
          sender_id: 101,
          sender_email: "alice@example.invalid",
          sender_nickname: "老罗",
          kind: "text",
          body: "@写作助手 写一段公告",
          triggered_bot_ids: [chatBot1Id],
          created_at: "2026-11-23T00:12:00Z",
        };
      }
      if (path.startsWith("/api/donebot/collab/chats/")) return [];
      return { ok: true };
    });

    await renderHarness();
    const collabOption = container!.querySelector<HTMLButtonElement>('[data-collab-switch-option="collab"]')!;
    await act(async () => { collabOption.click(); });
    await renderHarness();

    // Open AddTeamDialog -> no invite-code tab.
    const addTeamBtn = container!.querySelector<HTMLButtonElement>("[data-collab-add-team]")!;
    await act(async () => { addTeamBtn.click(); });
    await renderHarness();
    expect(container!.textContent).not.toContain("邀请码加入");
    expect(container!.textContent).not.toContain("43 位团队邀请码");

    // Select friend group chat.
    const groupRow = container!.querySelector<HTMLButtonElement>(`[data-collab-group-row="${groupId}"]`)!;
    await act(async () => { groupRow.click(); });
    await renderHarness();

    // Own bubble in group chat displays BOTH own avatar AND own nickname; bot reply displays 机器人 badge.
    const selfMsg = container!.querySelector('[data-collab-msg="21"]')!;
    expect(selfMsg.querySelector("[data-collab-msg-sender]")?.textContent).toBe("老罗");
    expect(selfMsg.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/4AAQ");
    const botMsg = container!.querySelector('[data-collab-msg="22"]')!;
    expect(botMsg.textContent).toContain("写作助手");
    expect(botMsg.textContent).toContain("机器人");
    expect(botMsg.textContent).toContain("已整理好要点");
    // Renders DoneBot's native MausAvatar SVG for the Bot reply rather than a blank icon fallback.
    expect(botMsg.querySelector("svg")).not.toBeNull();

    // Group icon is clickable for avatar replacement and shows current custom group avatar.
    expect(container!.querySelector("[data-collab-avatar-edit] img")?.getAttribute("src")).toBe("data:image/jpeg;base64,GROUPICON");

    // Click @ button -> mention picker lists BOTH group members AND bots (authorized enabled, unauthorized disabled).
    const atBtn = container!.querySelector<HTMLButtonElement>("[data-collab-chat-at-btn]")!;
    await act(async () => { atBtn.click(); });
    const menu = container!.querySelector("[data-collab-mention-menu]")!;
    expect(menu).not.toBeNull();
    const memberBtn = menu.querySelector<HTMLButtonElement>('[data-collab-mention-member="202"]')!;
    expect(memberBtn).not.toBeNull();
    expect(memberBtn.textContent).toContain("@小罗");
    const allowedBtn = menu.querySelector<HTMLButtonElement>(`[data-collab-mention-item="${chatBot1Id}"]`)!;
    const deniedBtn = menu.querySelector<HTMLButtonElement>(`[data-collab-mention-item="${chatBot2Id}"]`)!;
    expect(allowedBtn.disabled).toBe(false);
    expect(deniedBtn.disabled).toBe(true);
    expect(deniedBtn.textContent).toContain("需所有者授权");

    // Clicking a group member inserts @小罗 into the composer cleanly.
    await act(async () => { memberBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
    const chatInput = container!.querySelector<HTMLTextAreaElement>("[data-collab-chat-input]")!;
    expect(chatInput.value).toBe("@小罗 ");

    // Re-open @ picker, select authorized bot and send -> sends mention_bot_ids.
    await act(async () => { atBtn.click(); });
    const menu2 = container!.querySelector("[data-collab-mention-menu]")!;
    const allowedBtn2 = menu2.querySelector<HTMLButtonElement>(`[data-collab-mention-item="${chatBot1Id}"]`)!;
    await act(async () => { allowedBtn2.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(chatInput, "@写作助手 写一段公告");
      chatInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const sendBtn = container!.querySelector<HTMLButtonElement>("[data-collab-chat-send]")!;
    await act(async () => { sendBtn.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(fixture.api).toHaveBeenCalledWith(`/api/donebot/collab/chats/group/${groupId}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "@写作助手 写一段公告", mention_bot_ids: [chatBot1Id] }),
    });

    // Frameless image, video, and music messages open preview Lightbox on click instead of downloading.
    const imgBubble = container!.querySelector<HTMLButtonElement>('[data-collab-msg="24"] [data-collab-media-bubble="image"]')!;
    expect(imgBubble).not.toBeNull();
    expect(container!.querySelector('[data-collab-msg="24"]')?.textContent).not.toContain("donkey.png");
    await act(async () => { imgBubble.click(); });
    expect(container!.querySelector('[data-collab-media-preview="image"] img')).not.toBeNull();
    await act(async () => { container!.querySelector<HTMLButtonElement>('button[aria-label="关闭预览"]')!.click(); });

    const videoBubble = container!.querySelector<HTMLButtonElement>('[data-collab-msg="25"] [data-collab-media-bubble="video"]')!;
    expect(videoBubble).not.toBeNull();
    await act(async () => { videoBubble.click(); });
    expect(container!.querySelector('[data-collab-media-preview="video"] video')).not.toBeNull();
    await act(async () => { container!.querySelector<HTMLButtonElement>('button[aria-label="关闭预览"]')!.click(); });

    const audioBubble = container!.querySelector<HTMLButtonElement>('[data-collab-msg="26"] [data-collab-media-bubble="audio"]')!;
    expect(audioBubble).not.toBeNull();
    await act(async () => { audioBubble.click(); });
    expect(container!.querySelector('[data-collab-media-preview="audio"] audio')).not.toBeNull();
    await act(async () => { container!.querySelector<HTMLButtonElement>('button[aria-label="关闭预览"]')!.click(); });

    // Right panel「Bot」tab shows group bots and owner authorization button.
    const botsTab = container!.querySelector<HTMLButtonElement>('[data-collab-right-tab="bots"]')!;
    await act(async () => { botsTab.click(); });
    expect(container!.querySelector(`[data-collab-bot-grants="${chatBot1Id}"]`)).not.toBeNull();
    expect(container!.querySelector(`[data-collab-bot-grants="${chatBot2Id}"]`)).toBeNull();
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

  it("falls back to DoneBot circle mascot body instead of legacy cursor triangle in group chat", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const clipPathD = (clipSvg: string) => clipSvg.match(/d="([^"]+)"/)?.[1];

    await act(async () => {
      root!.render(createElement(CollabBotBadge, { name: "多宝", color: "chrome", size: 30 }));
    });
    expect(container.querySelector("clipPath path")?.getAttribute("d")).toBe(clipPathD(MASCOT_BODIES.circle.clip));
    expect(container.querySelector("clipPath path")?.getAttribute("d")).not.toBe(clipPathD(MASCOT_BODIES.cursor.clip));

    await act(async () => {
      root!.render(createElement(CollabBotBadge, { name: "多宝", color: "chrome", bodyId: "cursor", size: 30 }));
    });
    expect(container.querySelector("clipPath path")?.getAttribute("d")).toBe(clipPathD(MASCOT_BODIES.circle.clip));

    await act(async () => {
      root!.render(createElement(CollabBotBadge, { name: "多宝", color: "blue", bodyId: "star", size: 30 }));
    });
    expect(container.querySelector("clipPath path")?.getAttribute("d")).toBe(clipPathD(MASCOT_BODIES.star.clip));

    // Custom photo respects crop radius, zoom, and focus point identically to BotAvatar.
    await act(async () => {
      root!.render(createElement(CollabBotBadge, {
        name: "设计师",
        color: "pink",
        avatarUrl: "data:image/png;base64,iVBORw0KGgo=",
        avatarCrop: "rounded",
        avatarZoom: 1.8,
        avatarFocusX: 0.2,
        avatarFocusY: 0.8,
        size: 32,
      }));
    });
    const frame = container.querySelector<HTMLSpanElement>("span")!;
    const img = container.querySelector<HTMLImageElement>("img")!;
    expect(frame.style.borderRadius).toBe("22%");
    expect(img.style.objectPosition).toBe("20% 80%");
    expect(img.style.transform).toBe("scale(1.8)");

    // Switching back to mascot crop renders mascot even if an old avatarUrl is present.
    const resolvedMascot = resolveCollabBotBadgeFromChatBot({
      id: chatBot1Id,
      scope_type: "group",
      target_id: groupId,
      owner_user_id: 202,
      owner_email: "bob@example.invalid",
      installation_id: installId,
      local_bot_id: "remote-bot",
      bot_name: "星星",
      bot_color: "purple",
      bot_avatar_url: "data:image/png;base64,STALE",
      bot_mascot_body: "star",
      bot_avatar_crop: "mascot",
      allow_all_members: true,
      allowed_user_ids: [],
      can_invoke: true,
      created_at: "2026-11-23T00:00:00Z",
    });
    expect(resolvedMascot.avatarUrl).toBe("");
    expect(resolvedMascot.bodyId).toBe("star");

    // Cross-device message falls back to synced server appearance fields.
    const resolvedMsg = resolveCollabBotBadgeFromMessage({
      id: 99,
      scope_type: "group",
      target_id: groupId,
      sender_id: 202,
      sender_kind: "bot",
      sender_email: "bob@example.invalid",
      sender_bot_id: chatBot1Id,
      sender_bot_name: "星星",
      sender_bot_color: "purple",
      sender_bot_mascot_body: "hexagon",
      sender_bot_avatar_crop: "mascot",
      kind: "text",
      body: "hi",
      created_at: "2026-11-23T00:00:00Z",
    });
    expect(resolvedMsg.bodyId).toBe("hexagon");
    expect(resolvedMsg.color).toBe("purple");
  });

  it("scrolls to the bottom after opening a collab chat and loading messages", async () => {
    fixture.dispatch.mockImplementation((action: { type: string }) => {
      if (action.type === "showCollab") fixture.storeState.activeView = "collab";
      if (action.type === "showChat") fixture.storeState.activeView = "chat";
    });
    const overview = makeOverview();
    overview.groups = [{
      id: groupId,
      name: "测试群",
      creator_id: 101,
      members: [
        { user_id: 101, email: "alice@example.invalid", nickname: "老罗", joined_at: "2026-11-23T00:00:00Z" },
        { user_id: 202, email: "bob@example.invalid", nickname: "小罗", joined_at: "2026-11-23T00:00:00Z" },
      ],
      created_at: "2026-11-23T00:00:00Z",
      updated_at: "2026-11-23T00:00:00Z",
    }];
    let resolveMessages!: (value: unknown) => void;
    const messagesPromise = new Promise(resolve => { resolveMessages = resolve; });

    fixture.api.mockImplementation(async (path: string) => {
      if (path === "/api/donebot/collab/overview") return overview;
      if (path === "/api/donebot/collab/activity") return { activity: [] };
      if (path === "/api/donebot/collab/local-folders") return { folders: [] };
      if (path.startsWith(`/api/donebot/collab/chats/group/${groupId}/messages`)) return messagesPromise;
      if (path.startsWith("/api/donebot/collab/chats/")) return [];
      return { ok: true };
    });

    await renderHarness();
    const collabOption = container!.querySelector<HTMLButtonElement>('[data-collab-switch-option="collab"]')!;
    await act(async () => { collabOption.click(); });
    await renderHarness();

    const groupRow = container!.querySelector<HTMLButtonElement>(`[data-collab-group-row="${groupId}"]`)!;
    await act(async () => { groupRow.click(); });
    await renderHarness();

    const scroller = container!.querySelector<HTMLDivElement>("[data-collab-chat-scroller]")!;
    expect(scroller).not.toBeNull();
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 1800 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 600 });
    scroller.scrollTop = 0;

    await act(async () => {
      resolveMessages([
        {
          id: 1,
          scope_type: "group",
          target_id: groupId,
          sender_id: 101,
          sender_kind: "user",
          sender_email: "alice@example.invalid",
          kind: "text",
          body: "较早的消息",
          created_at: "2026-11-23T01:02:00Z",
        },
        {
          id: 2,
          scope_type: "group",
          target_id: groupId,
          sender_id: 202,
          sender_kind: "user",
          sender_email: "bob@example.invalid",
          kind: "text",
          body: "最新的消息",
          created_at: "2026-11-23T01:29:00Z",
        },
      ]);
      await Promise.resolve();
    });

    expect(scroller.scrollTop).toBe(1800);
  });
});
