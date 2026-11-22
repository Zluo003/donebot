// @vitest-environment happy-dom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    api: fixture.api,
    useStore: () => ({ state: { ...original.initialState, bots: [localBot] }, dispatch: fixture.dispatch }),
  };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { ManageMembersPanel } from "./ManageMembersPanel";
import { NewRoomPanel } from "./SidebarNewRoomPanel";

const localBot: Bot = {
  id: "local-writer", threadId: "t-local", name: "Writer", title: "", description: "",
  color: "green", notifications: false, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "claude", model: "fake" },
};
const remoteAtlas = {
  id: "link-0000abcd-cloud-atlas",
  home: { id: "cloud-1", key: "0000abcd", kind: "cloud" as const, name: "DoneBot Cloud", online: true },
  botId: "cloud-atlas",
  name: "Atlas",
  color: "teal",
  title: "Cloud Analyst",
};

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.api.mockResolvedValue({ bots: [remoteAtlas] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("lets NewRoomPanel pick both local and linked remote bots when creating a group", async () => {
  const onClose = vi.fn();
  await act(async () => root.render(createElement(NewRoomPanel, { onClose })));
  const localBox = host.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="Writer"]')!;
  const remoteBox = host.querySelector<HTMLButtonElement>(`[data-far-member="${remoteAtlas.id}"]`)!;
  expect(remoteBox).toBeTruthy();
  expect(remoteBox.textContent).toContain("Atlas");
  expect(remoteBox.textContent).toContain("DoneBot Cloud");
  await act(async () => { localBox.click(); remoteBox.click(); });
  const createBtn = [...host.querySelectorAll<HTMLButtonElement>("button")].at(-1)!;
  await act(async () => createBtn.click());
  expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({
    type: "createGroup",
    memberIds: ["local-writer", remoteAtlas.id],
  }));
  expect(onClose).toHaveBeenCalledOnce();
});

it("lets ManageMembersPanel add a newly linked remote bot to an existing group", async () => {
  const group: Group = {
    id: "room-1", threadId: "t-room-1", name: "Bridge", memberIds: ["local-writer"],
    defaultResponder: { kind: "auto" }, bulletin: "", unread: false, createdAt: 1, messages: [],
  };
  const onClose = vi.fn();
  await act(async () => root.render(createElement(ManageMembersPanel, { group, onClose, triggerRef: createRef<HTMLButtonElement>() })));
  const remoteBox = host.querySelector<HTMLButtonElement>(`[data-far-member="${remoteAtlas.id}"]`)!;
  expect(remoteBox.getAttribute("aria-checked")).toBe("false");
  await act(async () => remoteBox.click());
  expect(remoteBox.getAttribute("aria-checked")).toBe("true");
  const saveBtn = [...host.querySelectorAll<HTMLButtonElement>("button")].at(-1)!;
  await act(async () => saveBtn.click());
  expect(fixture.dispatch).toHaveBeenCalledWith({
    type: "patchGroup",
    groupId: "room-1",
    patch: { memberIds: ["local-writer", remoteAtlas.id] },
  });
  expect(onClose).toHaveBeenCalledOnce();
});
