// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale, t } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { ApprovalCard } from "./ApprovalCard";

const viewer = vi.hoisted(() => ({ owner: true }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => viewer.owner }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); viewer.owner = true; });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); setLocale("en"); });
const receipt = (): Message => ({ id: "change", role: "bot", kind: "options", at: 1,
  card: { title: "Changed Device name", subtitle: "Before → Office Mac", options: [], answered: "allow", autoApplied: true, dismissed: true,
    requestId: "setting-1", tool: "app_settings", appSettingRequest: { settingId: "general.deviceName", label: "Device name", before: "Before", after: "Office Mac", tier: "safe" } } });
const button = (key: Parameters<typeof t>[0]) => [...host.querySelectorAll("button")].find(one => one.textContent === t(key));
const render = (message = receipt()) => act(async () => root.render(createElement(ApprovalCard, { message, bot: { name: "Kiwi" }, threadId: "thread-1" })));

it.each(["en", "zh"] as const)("renders an applied setting in %s and sends Undo to its original conversation", async locale => {
  setLocale(locale);
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  await render();
  expect(host.textContent).toContain("Office Mac");
  expect(host.textContent).toContain("Device name");
  await act(async () => button("approval.applied.undo")!.click());
  expect(fetch).toHaveBeenCalledWith("/api/threads/thread-1/undo", expect.objectContaining({ method: "POST", body: JSON.stringify({ requestId: "setting-1" }) }));
  const message = receipt(); message.card!.undone = true;
  await render(message);
  expect(button("approval.applied.undo")).toBeUndefined();
});

it("shows a manual-edit conflict and keeps the server's receipt unchanged", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "stale", code: "changed-since" }), { status: 409, headers: { "content-type": "application/json" } })));
  const message = receipt(); await render(message);
  await act(async () => button("approval.applied.undo")!.click());
  expect(host.textContent).toContain(t("approval.applied.changedSince"));
  expect(message.card?.undone).toBeUndefined();
});

it("offers no workspace Undo to a member", async () => {
  viewer.owner = false; await render();
  expect(host.textContent).toContain("Office Mac");
  expect(button("approval.applied.undo")).toBeUndefined();
});
