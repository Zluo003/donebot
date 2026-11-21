// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => fixture }));
vi.mock("@/lib/cloud-files", () => ({ useCloudFilesReady: () => false }));
vi.mock("./SidebarFooterNav", () => ({ useAutomationsNeedYou: () => false }));
vi.mock("./CloudRoomCard", () => ({ CloudRoomCard: () => null }));
vi.mock("./CloudUsageMeter", () => ({ CloudUsageCard: () => null }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));
vi.mock("./SidebarPopoverMenu", () => ({
  SidebarPopoverMenu: ({ items }: { items: Array<{ key: string; label: string; onSelect: () => void }> }) => createElement("nav", null,
    items.map(item => createElement("button", { key: item.key, "data-menu-key": item.key, onClick: item.onSelect }, item.label))),
}));

import { SidebarPhoneBar } from "./SidebarPhoneBar";

let host: HTMLDivElement, root: Root;
async function render(state: Record<string, unknown>) {
  fixture.state = state;
  await act(async () => root.render(createElement(SidebarPhoneBar, { query: "", onQuery: vi.fn() })));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.dispatch.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("offers Team files in the mobile tools menu only when the server enables it", async () => {
  await render({ activeView: "chat", config: { team: { id: "team-1", name: "Fixture", sharedFiles: true } }, pluginsOpen: false });
  const row = host.querySelector<HTMLButtonElement>('[data-menu-key="team-files"]');
  expect(row?.textContent).toBe("Team files");
  await act(async () => row!.click());
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showTeamFiles" });

  await render({ activeView: "chat", config: { team: { id: "team-1", name: "Fixture", sharedFiles: false } }, pluginsOpen: false });
  expect(host.querySelector('[data-menu-key="team-files"]')).toBeNull();
});
