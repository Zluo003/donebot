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

const teamId = "11111111-1111-4111-8111-111111111111";
const installId = "22222222-2222-4222-8222-222222222222";
const sharedFolderId = "33333333-3333-4333-8333-333333333333";
const sharedBotId = "44444444-4444-4444-8444-444444444444";
const incomingReqId = "55555555-5555-4555-8555-555555555555";
const incomingInvId = "66666666-6666-4666-8666-666666666666";

function makeOverview(opts: { incomingFriend?: boolean; incomingTeam?: boolean } = {}): CollabOverview {
  return {
    identity: { account_id: "101", installation_id: installId, device_name: "Alice Mac", email: "alice@example.invalid" },
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
    local_bots: [],
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

describe("Collab sidebar switcher, workspace, and live notifications", () => {
  it("shows red badge on 好友与团队 switch, pops persistent toast and desktop notification on incoming requests, and lets user navigate friend & team views", async () => {
    const showDesktop = vi.fn().mockResolvedValue(true);
    (window as { ogb?: unknown }).ogb = {
      desktopNotifications: { show: showDesktop, onOpen: () => () => {} },
    };

    fixture.dispatch.mockImplementation((action: { type: string }) => {
      if (action.type === "showCollab") fixture.storeState.activeView = "collab";
      if (action.type === "showChat") fixture.storeState.activeView = "chat";
    });

    const overview = makeOverview();
    fixture.api.mockImplementation(async (path) => {
      if (path === "/api/donebot/collab/overview") return overview;
      if (path === `/api/donebot/collab/teams/${teamId}/invitations`) return [];
      if (path === `/api/donebot/collab/folders/${sharedFolderId}/invoke`) {
        return { result: { content: [{ type: "text", text: "spec.md (99 B)\n" }] } };
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

    // Persistent toast notification appeared for the incoming friend request & team invitation.
    const toastRegion = container!.querySelector('[data-collab-toast-region]')!;
    expect(toastRegion.textContent).toContain("dave@example.invalid 请求添加你为好友");
    expect(toastRegion.textContent).toContain("市场组");

    // Native desktop notification was requested with collab routing target.
    expect(showDesktop).toHaveBeenCalledWith(expect.objectContaining({
      botId: COLLAB_DESKTOP_NOTIFY_BOT_ID,
      threadId: COLLAB_DESKTOP_NOTIFY_THREAD_ID,
      title: "新的好友申请",
    }));

    // Switch sidebar to 好友与团队.
    await act(async () => { collabOption.click(); });
    await renderHarness();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showCollab" });
    expect(container!.querySelector('[data-collab-sidebar-list="full"]')).not.toBeNull();
    expect(container!.textContent).toContain("消息与申请");
    expect(container!.textContent).toContain("bob@example.invalid");
    expect(container!.textContent).toContain("产品研发组");

    // Select a friend in the left sidebar -> right pane displays friend detail with shared folder browser & bot install.
    const friendBtn = container!.querySelector<HTMLButtonElement>('[data-collab-friend-row="202"]')!;
    await act(async () => { friendBtn.click(); });
    await renderHarness();
    expect(container!.querySelector("[data-collab-workspace] h1")?.textContent).toBe("bob@example.invalid");
    expect(container!.textContent).toContain("设计资源");
    expect(container!.textContent).toContain("代码审查官");

    const browseBtn = [...container!.querySelectorAll("button")].find(b => b.textContent?.includes("浏览文件"))!;
    await act(async () => { browseBtn.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(container!.textContent).toContain("spec.md");

    // Select a team in the left sidebar -> right pane displays team members & team shared resources.
    const teamBtn = container!.querySelector<HTMLButtonElement>(`[data-collab-team-row="${teamId}"]`)!;
    await act(async () => { teamBtn.click(); });
    await renderHarness();
    expect(container!.querySelector("[data-collab-workspace] h1")?.textContent).toBe("产品研发组");
    expect(container!.textContent).toContain("团队成员与邀请（2）");

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
    // Hidden while settings modal is open.
    expect(container!.querySelector(`[data-collab-toast="friend-req:${incomingReqId}"]`)).toBeNull();

    // Closing modal reveals the pending toast.
    fixture.storeState.appSettingsOpen = false;
    await renderHarness();
    const toast = container!.querySelector(`[data-collab-toast="friend-req:${incomingReqId}"]`)!;
    expect(toast).not.toBeNull();

    // One-click accept directly from toast clears toast & badge.
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

  it("displays friend remark > nickname > email and saves custom friend remarks", async () => {
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
    expect(container!.querySelector("[data-collab-workspace] h1")?.textContent).toBe("设计师老博");
    expect(container!.textContent).toContain("昵称 小博 · bob@example.invalid");

    const editBtn = container!.querySelector<HTMLButtonElement>("[data-collab-edit-remark]")!;
    await act(async () => { editBtn.click(); });
    const input = container!.querySelector<HTMLInputElement>('input[name="friend_remark"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "前端架构师");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = input.closest("form")!;
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(fixture.api).toHaveBeenCalledWith("/api/donebot/collab/friends/202/remark", {
      method: "PUT",
      body: JSON.stringify({ remark: "前端架构师" }),
    });
  });
});
