// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DoneBotWorkspaceSnapshot } from "../../shared/donebot-teams";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/api", () => ({ api: fixture.api }));
const { DoneBotTeams } = await import("./Teams");
let host: HTMLDivElement, root: Root, snapshot: DoneBotWorkspaceSnapshot;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.confirm = vi.fn(() => false);
  snapshot = { protocol: "donebot.teams.v1", account_id: "1", capabilities: ["identity"], workspaces: [{ id: "33333333-3333-4333-8333-333333333333", name: "Fixture Studio", role: "owner", member_version: 1, created_at: "2026-11-20T00:00:00Z" }] };
  fixture.api.mockReset().mockImplementation(async path => path.endsWith("/members") ? [
    { user_id: 1, email: "owner@example.invalid", role: "owner", version: 1 }, { user_id: 2, email: "member@example.invalid", role: "member", version: 1 },
  ] : structuredClone(snapshot));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const mount = async () => act(async () => root.render(createElement(DoneBotTeams)));
const select = async () => {
  const field = host.querySelector<HTMLSelectElement>('select[aria-label="团队工作空间"]')!;
  await act(async () => { field.value = snapshot.workspaces[0]!.id; field.dispatchEvent(new Event("change", { bubbles: true })); });
};
it("offers no team entry until the gateway declares compatible identity support", async () => {
  snapshot.capabilities = [];
  await mount(); expect(host.textContent).toBe("");
});
it("separates team roles from personal billing and requires confirmation for removal", async () => {
  await mount(); await select();
  expect(host.textContent).toContain("协作运行服务尚未就绪");
  expect(host.textContent).not.toMatch(/余额|账户密钥|购买算力/);
  expect([...host.querySelectorAll("button")].filter(button => button.textContent === "移除成员")).toHaveLength(1);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "移除成员")!.click());
  expect(fixture.api.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  confirm.mockReturnValue(true);
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "移除成员")!.click());
  const writes = fixture.api.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(JSON.parse(writes[0]![1].body)).toEqual({ action: "remove-member", account_id: "1", team_id: snapshot.workspaces[0]!.id, user_id: 2 });
  confirm.mockRestore();
});
it("hides member management for members and ignores a stale selected-team response", async () => {
  snapshot.workspaces[0]!.role = "member";
  let answer!: (value: unknown) => void;
  fixture.api.mockImplementation(path => path.endsWith("/members") ? new Promise(resolve => { answer = resolve; }) : Promise.resolve(structuredClone(snapshot)));
  await mount(); await select();
  const field = host.querySelector<HTMLSelectElement>("select")!;
  await act(async () => { field.value = ""; field.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => answer([{ user_id: 2, email: "private-stale@example.invalid", role: "member", version: 1 }]));
  expect(host.textContent).not.toContain("private-stale");
  expect(host.textContent).not.toContain("移除成员");
  expect(host.textContent).not.toContain("生成邀请");
});
