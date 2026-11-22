// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollabOverview } from "./collab-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  api: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}));

vi.mock("@/state/api", () => ({ api: fixture.api }));

const { RemoteCollab } = await import("./RemoteCollab");

const teamId = "11111111-1111-4111-8111-111111111111";
const installId = "22222222-2222-4222-8222-222222222222";
const sharedFolderId = "33333333-3333-4333-8333-333333333333";
const sharedBotId = "44444444-4444-4444-8444-444444444444";
const incomingReqId = "55555555-5555-4555-8555-555555555555";
const incomingInvId = "66666666-6666-4666-8666-666666666666";

function makeOverview(): CollabOverview {
  return {
    identity: { account_id: "101", installation_id: installId, device_name: "Alice Mac", email: "alice@example.invalid" },
    friends: {
      friends: [{ user_id: 202, email: "bob@example.invalid", created_at: "2026-11-22T00:00:00Z" }],
      incoming_requests: [{ id: incomingReqId, requester_id: 303, requester_email: "dave@example.invalid", recipient_id: 101, recipient_email: "alice@example.invalid", note: "加个好友", status: "pending", created_at: "2026-11-22T00:00:00Z" }],
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
        sources: [{ kind: "friend" }],
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
        description: "擅长 Go 和 TypeScript 评审",
        skill_count: 3,
        has_soul: true,
        sources: [{ kind: "friend" }],
        updated_at: "2026-11-22T00:00:00Z",
      }],
    },
    teams: [{ id: teamId, name: "产品研发组", role: "owner", member_version: 1, created_at: "2026-11-22T00:00:00Z" }],
    team_capabilities: ["identity", "collaboration"],
    team_members: { [teamId]: [{ user_id: 101, email: "alice@example.invalid", role: "owner", version: 1 }] },
    incoming_team_invitations: [{
      id: incomingInvId,
      team_id: "77777777-7777-4777-8777-777777777777",
      team_name: "市场组",
      role: "member",
      invited_by_email: "eve@example.invalid",
      expires_at: "2026-11-29T00:00:00Z",
    }],
    local_bots: [{
      id: "bot-writer",
      name: "写作助手",
      title: "中文文案",
      description: "专攻产品文档",
      has_soul: true,
      skill_count: 2,
    }],
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(createElement(RemoteCollab, { standalone: true })); });
  await act(async () => { await Promise.resolve(); });
}

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  container?.remove();
  container = null;
  delete (window as { ogb?: unknown }).ogb;
  fixture.api.mockReset();
});

describe("RemoteCollab", () => {
  it("shares a local folder with per-subject read/write grants, browses shared folders, installs shared bots, and accepts friend/team requests without team Cloud UI", async () => {
    const newFolderId = "88888888-8888-4888-8888-888888888888";
    const saveLocalFolder = vi.fn().mockResolvedValue({ id: newFolderId, accountId: "101", path: "/Users/alice/Project", name: "Project", enabled: true, allowWrite: true });
    (window as { ogb?: unknown }).ogb = {
      collab: {
        chooseFolder: vi.fn().mockResolvedValue({ id: newFolderId, path: "/Users/alice/Project", name: "Project" }),
        listFolders: vi.fn().mockResolvedValue([]),
        saveFolder: saveLocalFolder,
        removeFolder: vi.fn().mockResolvedValue({ ok: true }),
        status: vi.fn().mockResolvedValue({ connected: true, activeCount: 1 }),
        activity: vi.fn().mockResolvedValue([]),
      },
    };

    const overview = makeOverview();
    fixture.api.mockImplementation(async (path, init) => {
      if (path === "/api/donebot/collab/overview") return overview;
      if (path === "/api/donebot/collab/folders" && init?.method === "POST") return { id: newFolderId };
      if (path === `/api/donebot/collab/folders/${sharedFolderId}/invoke`) {
        return { result: { content: [{ type: "text", text: "brief.md (120 B)\nassets/\n" }] } };
      }
      if (path === `/api/donebot/collab/bots/${sharedBotId}/install`) {
        return { ok: true, bots: [{ name: "代码审查官" }], skills: 3 };
      }
      if (path === `/api/donebot/collab/friends/requests/${incomingReqId}/accept`) return { user_id: 303 };
      if (path === `/api/donebot/collab/teams/invitations/${incomingInvId}/accept`) return { id: "77777777-7777-4777-8777-777777777777" };
      if (path === `/api/donebot/collab/teams/${teamId}/invitations`) return [];
      return { ok: true };
    });

    await mount();

    // No team Cloud controls appear anywhere.
    expect(container!.textContent).not.toContain("团队 Cloud");
    expect(container!.textContent).toContain("设计资源");

    // Browse a folder shared with me.
    const browseBtn = [...container!.querySelectorAll("button")].find(b => b.textContent?.includes("浏览文件"))!;
    await act(async () => { browseBtn.click(); });
    expect(container!.textContent).toContain("brief.md");

    // Pick a local folder, grant friend write access, and save.
    const pickBtn = [...container!.querySelectorAll("button")].find(b => b.textContent?.includes("共享本机文件夹"))!;
    await act(async () => { pickBtn.click(); });
    const bobCheckbox = [...container!.querySelectorAll("label")]
      .find(l => l.textContent?.includes("bob@example.invalid"))!
      .querySelector("input[type='checkbox']") as HTMLInputElement;
    await act(async () => { bobCheckbox.click(); });
    const writeBtn = [...container!.querySelectorAll("button")].find(b => b.textContent === "可编辑")!;
    await act(async () => { writeBtn.click(); });
    const saveBtn = [...container!.querySelectorAll("button")].find(b => b.textContent?.includes("保存共享配置"))!;
    await act(async () => { saveBtn.click(); });

    expect(saveLocalFolder).toHaveBeenCalledWith(expect.objectContaining({ id: newFolderId, allowWrite: true, enabled: true }));
    expect(fixture.api).toHaveBeenCalledWith("/api/donebot/collab/folders", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining(`"access":"write"`),
    }));

    // Switch to Shared Bots tab and install a shared bot.
    const botsTab = container!.querySelector<HTMLButtonElement>('[data-collab-tab="bots"]')!;
    await act(async () => { botsTab.click(); });
    expect(container!.textContent).toContain("代码审查官");
    const installBtn = [...container!.querySelectorAll("button")].find(b => b.textContent?.includes("添加到我的电脑"))!;
    await act(async () => { installBtn.click(); });
    expect(fixture.api).toHaveBeenCalledWith(`/api/donebot/collab/bots/${sharedBotId}/install`, { method: "POST", body: "{}" });
    expect(container!.textContent).toContain("已在本机创建同能力 Bot");

    // Switch to Contacts tab and accept incoming friend request & team invitation directly.
    const contactsTab = container!.querySelector<HTMLButtonElement>('[data-collab-tab="contacts"]')!;
    await act(async () => { contactsTab.click(); });
    expect(container!.textContent).toContain("dave@example.invalid");
    expect(container!.textContent).toContain("市场组");

    const acceptFriendBtn = [...container!.querySelectorAll("button")].find(b => b.textContent === "同意")!;
    await act(async () => { acceptFriendBtn.click(); });
    expect(fixture.api).toHaveBeenCalledWith(`/api/donebot/collab/friends/requests/${incomingReqId}/accept`, { method: "POST", body: "{}" });

    const joinTeamBtn = [...container!.querySelectorAll("button")].find(b => b.textContent === "加入团队")!;
    await act(async () => { joinTeamBtn.click(); });
    expect(fixture.api).toHaveBeenCalledWith(`/api/donebot/collab/teams/invitations/${incomingInvId}/accept`, { method: "POST", body: "{}" });
  });
});
