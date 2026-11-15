// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { initialState, StoreProvider, useStore, type AppState } from "../state/store";
import { bindCloudWorkspaceCache, readCloudWorkspaceCache, saveCloudWorkspaceCache } from "./workspace-cache";

afterEach(() => { bindCloudWorkspaceCache(null); sessionStorage.clear(); vi.unstubAllGlobals(); });
const snapshot = () => ({ ...initialState, hydrated: true, selectedId: "bot", config: { donebot: { enabled: true, authenticated: true } },
  bots: [{ id: "bot", name: "Cloud Bot", messages: Array.from({ length: 100 }, (_, i) => ({ id: String(i), text: "reply" })), busy: true }],
} as unknown as AppState);

it("restores bounded Cloud messages after a switch with no pending actions or live connection", () => {
  bindCloudWorkspaceCache("instance-A:owner-101");
  saveCloudWorkspaceCache(snapshot());
  const restored = readCloudWorkspaceCache()!;
  expect(restored.selectedId).toBe("bot");
  expect(restored.bots[0]!.messages).toHaveLength(80);
  expect(restored.bots[0]!.busy).toBe(false);
  expect(restored).not.toHaveProperty("pendingQueued");
  expect(restored).not.toHaveProperty("connected");
});

it("does not expose another account, expired cache or signed-out content", () => {
  bindCloudWorkspaceCache("instance-A:owner-101"); saveCloudWorkspaceCache(snapshot());
  bindCloudWorkspaceCache("instance-A:owner-202"); expect(readCloudWorkspaceCache()).toBeNull();
  bindCloudWorkspaceCache("instance-A:owner-101");
  const key = "donebot.cloud-workspace.v1", old = JSON.parse(sessionStorage.getItem(key)!);
  sessionStorage.setItem(key, JSON.stringify({ ...old, at: Date.now() - 86400_001 }));
  expect(readCloudWorkspaceCache()).toBeNull();
  saveCloudWorkspaceCache(snapshot()); bindCloudWorkspaceCache(null);
  bindCloudWorkspaceCache("instance-A:owner-101"); expect(readCloudWorkspaceCache()).toBeNull();
});

it("paints the cached conversation while all fresh network reads are still pending", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const requests: string[] = [];
  vi.stubGlobal("fetch", (_path: string, init?: RequestInit) => { requests.push(init?.method ?? "GET"); return new Promise(() => {}); });
  bindCloudWorkspaceCache("instance-A:owner-101"); saveCloudWorkspaceCache(snapshot());
  function View() {
    const { state } = useStore();
    return createElement("output", null, JSON.stringify({ name: state.bots[0]?.name, connected: state.connected }));
  }
  const host = document.createElement("div"), root = createRoot(host);
  try {
    await act(async () => root.render(createElement(StoreProvider, null, createElement(View))));
    expect(host.textContent).toBe('{"name":"Cloud Bot","connected":false}');
    expect(requests.every(method => method === "GET")).toBe(true);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
