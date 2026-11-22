// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DoneBotWorkspaceSnapshot } from "../../shared/donebot-teams";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/api", () => ({ api: fixture.api }));
const { DoneBotTeams } = await import("./Teams");
let host: HTMLDivElement, root: Root, snapshot: DoneBotWorkspaceSnapshot;
const teamA = "33333333-3333-4333-8333-333333333333";
const teamB = "33333333-3333-4333-8333-333333333334";
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.confirm = vi.fn(() => false);
  snapshot = { protocol: "donebot.teams.v1", account_id: "1", capabilities: ["identity"], workspaces: [{ id: teamA, name: "Fixture Studio", role: "owner", member_version: 1, created_at: "2026-11-20T00:00:00Z" }] };
  fixture.api.mockReset().mockImplementation(async path => path.endsWith("/members") ? [
    { user_id: 1, email: "owner@example.invalid", role: "owner", version: 1 }, { user_id: 2, email: "member@example.invalid", role: "member", version: 1 },
  ] : structuredClone(snapshot));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const mount = async (standalone = false) => act(async () => root.render(createElement(DoneBotTeams, { standalone })));

it("offers no team entry until the gateway declares compatible identity support", async () => {
  snapshot.capabilities = [];
  await mount(); expect(host.textContent).toBe("");
});
it.each([null, {}, { protocol: "donebot.teams.v0", capabilities: ["identity"], workspaces: [] }, { protocol: "donebot.teams.v1", account_id: "1", capabilities: ["identity"] }])("hides incompatible discovery responses without breaking settings: %j", async value => {
  fixture.api.mockResolvedValue(value);
  await mount(); expect(host.textContent).toBe("");
});
it("lists existing teams immediately, selects the first by default, and requires confirmation for removal", async () => {
  await mount(true);
  expect(host.querySelector(`[data-team-item="${teamA}"]`)?.getAttribute("aria-pressed")).toBe("true");
  expect(host.textContent).toContain("Fixture Studio");
  expect(host.textContent).toContain("协作运行服务尚未就绪");
  expect(host.textContent).not.toMatch(/余额|账户密钥|购买算力/);
  expect([...host.querySelectorAll("button")].filter(button => button.textContent === "移除成员")).toHaveLength(1);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "移除成员")!.click());
  expect(fixture.api.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  confirm.mockReturnValue(true);
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "移除成员")!.click());
  const writes = fixture.api.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(JSON.parse(writes[0]![1].body)).toEqual({ action: "remove-member", account_id: "1", team_id: teamA, user_id: 2 });
  confirm.mockRestore();
});
it("hides member management for members and ignores a stale team-switch member response", async () => {
  snapshot.workspaces = [
    { id: teamA, name: "Alpha Team", role: "member", member_version: 1, created_at: "2026-11-20T00:00:00Z" },
    { id: teamB, name: "Beta Team", role: "member", member_version: 1, created_at: "2026-11-21T00:00:00Z" },
  ];
  let answerA!: (value: unknown) => void;
  fixture.api.mockImplementation(path => {
    if (path === `/api/donebot/teams/${teamA}/members`) return new Promise(resolve => { answerA = resolve; });
    if (path === `/api/donebot/teams/${teamB}/members`) return Promise.resolve([{ user_id: 1, email: "beta-member@example.invalid", role: "member", version: 1 }]);
    return Promise.resolve(structuredClone(snapshot));
  });
  await mount(true);
  await act(async () => host.querySelector<HTMLButtonElement>(`[data-team-item="${teamB}"]`)!.click());
  await act(async () => answerA([{ user_id: 2, email: "private-stale@example.invalid", role: "member", version: 1 }]));
  expect(host.textContent).toContain("beta-member@example.invalid");
  expect(host.textContent).not.toContain("private-stale");
  expect(host.textContent).not.toContain("移除成员");
  expect(host.textContent).not.toContain("生成邀请");
});

it("renders team Cloud switch controls and local device switch when capabilities are negotiated", async () => {
  const instanceId = "44444444-4444-4444-8444-444444444444";
  const planId = "55555555-5555-4555-8555-555555555555";
  const deviceId = "66666666-6666-4666-8666-666666666666";
  const openTeamCloud = vi.fn(async () => ({ outcome: "connected" as const }));
  (window as unknown as { ogb?: unknown }).ogb = { workspaces: { openTeamCloud } };

  snapshot.capabilities = ["identity", "cloud_access", "local_execution", "shared_files"];
  fixture.api.mockImplementation(async (path, init) => {
    if (path === "/api/donebot/workspaces") return structuredClone(snapshot);
    if (path === `/api/donebot/teams/${teamA}/members`) return [{ user_id: 1, email: "owner@example.invalid", role: "owner", version: 1 }];
    if (path === "/api/donebot/teams/plans") return [{ id: planId, name: "Studio 团队版", enabled: true, monthly_price: "49", retention_days: 7, runtime: { cpu_millis: 2000, memory_mib: 4096, storage_gib: 10, pids: 256 }, desktop: { cpu_millis: 1000, memory_mib: 2048, storage_gib: 10, pids: 512 }, shared_quota_bytes: 5 * 1024 ** 3, max_file_bytes: 100 * 1024 ** 2 }];
    if (path === `/api/donebot/teams/${teamA}/cloud` && !init?.method) {
      return { account_id: "1", instance: { instance_id: instanceId, desired: "running", actual: "running", generation: 1, error: "", paid_until: new Date(Date.now() + 86400000).toISOString(), subscription_state: "active", purge_locked: false, auto_renew: true, plan_id: planId, plan_name: "Studio 团队版" }, operations: [], connection_available: true };
    }
    if (path === `/api/donebot/teams/${teamA}/devices` && !init?.method) {
      return { account_id: "1", installation_id: "77777777-7777-4777-8777-777777777777", local_device_id: deviceId, devices: [{ id: deviceId, user_id: 1, email: "owner@example.invalid", name: "MacBook", enabled: false, version: 1, online: false, last_seen: null, revoked_at: null }] };
    }
    return { ok: true };
  });

  await mount(true);
  expect(host.textContent).toContain("团队 Cloud");
  expect(host.textContent).toContain("运行中");
  expect(host.textContent).toContain("Studio 团队版");
  expect(host.textContent).toContain("允许本机参与团队执行");
  expect(host.textContent).toContain("MacBook（本机）");

  const cloudRenewSwitch = host.querySelector<HTMLButtonElement>('[data-team-cloud-auto-renew-switch]')!;
  expect(cloudRenewSwitch.getAttribute("role")).toBe("switch");
  expect(cloudRenewSwitch.getAttribute("aria-checked")).toBe("true");
  await act(async () => cloudRenewSwitch.click());
  expect(host.querySelector('[aria-label="确认团队 Cloud 操作"]')?.textContent).toContain("仅关闭自动续费");

  await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "进入团队工作空间")!.click());
  expect(openTeamCloud).toHaveBeenCalledExactlyOnceWith(teamA, instanceId, "1", "Fixture Studio", "owner");

  const localSwitch = host.querySelector<HTMLButtonElement>('[data-team-local-device-switch]')!;
  expect(localSwitch.getAttribute("role")).toBe("switch");
  expect(localSwitch.getAttribute("aria-checked")).toBe("false");
  await act(async () => localSwitch.click());
  const deviceWrites = fixture.api.mock.calls.filter(([path, init]) => path === `/api/donebot/teams/${teamA}/devices` && init?.method === "POST");
  expect(JSON.parse(deviceWrites[0]![1].body)).toEqual({ action: "set", account_id: "1", enabled: true });
});

it("resolves admin device revocation permissions from team members when device payload omits role", async () => {
  const adminDeviceId = "66666666-6666-4666-8666-666666666661";
  const ownerDeviceId = "66666666-6666-4666-8666-666666666662";
  const memberDeviceId = "66666666-6666-4666-8666-666666666663";
  snapshot.account_id = "2";
  snapshot.capabilities = ["identity", "local_execution"];
  snapshot.workspaces[0]!.role = "admin";
  fixture.api.mockImplementation(async (path, init) => {
    if (path === "/api/donebot/workspaces") return structuredClone(snapshot);
    if (path === `/api/donebot/teams/${teamA}/members`) {
      return [
        { user_id: 1, email: "owner@example.invalid", role: "owner", version: 1 },
        { user_id: 2, email: "admin@example.invalid", role: "admin", version: 1 },
        { user_id: 3, email: "member@example.invalid", role: "member", version: 1 },
      ];
    }
    if (path === `/api/donebot/teams/${teamA}/devices` && !init?.method) {
      return {
        account_id: "2",
        installation_id: "77777777-7777-4777-8777-777777777777",
        local_device_id: adminDeviceId,
        devices: [
          { id: ownerDeviceId, user_id: 1, email: "owner@example.invalid", name: "Owner Mac", enabled: true, version: 1, online: true, last_seen: "2026-11-22T00:00:00Z", revoked_at: null },
          { id: adminDeviceId, user_id: 2, email: "admin@example.invalid", name: "Admin Mac", enabled: true, version: 1, online: true, last_seen: "2026-11-22T00:00:00Z", revoked_at: null },
          { id: memberDeviceId, user_id: 3, email: "member@example.invalid", name: "Member Mac", enabled: true, version: 1, online: true, last_seen: "2026-11-22T00:00:00Z", revoked_at: null },
        ],
      };
    }
    return { ok: true };
  });

  await mount(true);
  const card = host.querySelector("[data-team-devices-card]")!;
  expect(card.querySelector('[data-team-local-device-switch]')?.getAttribute("aria-checked")).toBe("true");
  const items = [...card.querySelectorAll("li")];
  expect(items.find(item => item.textContent?.includes("Owner Mac"))?.querySelector("button")).toBeNull();
  expect(items.find(item => item.textContent?.includes("Admin Mac（本机）"))?.querySelector("button")?.textContent).toBe("撤销设备");
  expect(items.find(item => item.textContent?.includes("Member Mac"))?.querySelector("button")?.textContent).toBe("撤销设备");
});
