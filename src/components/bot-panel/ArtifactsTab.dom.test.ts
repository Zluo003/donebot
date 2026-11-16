// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BotArtifact, BotArtifactPage } from "../../../shared/artifacts";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), groups: [] }));
vi.mock("@/state/store", async importOriginal => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, api: fixture.api, useStore: () => ({ state: { ...original.initialState, groups: fixture.groups }, dispatch: fixture.dispatch }) };
});
const { ArtifactsTab, artifactDateGroups } = await import("./ArtifactsTab");
const bot = { id: "editor", name: "Editor", messages: [], tasks: [] } as unknown as Bot;
const artifact = (id: string, kind: BotArtifact["kind"] = "image", at = new Date(2026, 10, 17, 12).getTime()): BotArtifact => ({
  id, kind, at, title: "Pixar 3D cartoon donkey", name: `8e657781-14ec-408c-9719-a17bf033d40e.${kind === "image" ? "png" : kind === "video" ? "mp4" : kind === "audio" ? "mp3" : "pdf"}`,
  path: `/attachments/${id}`, threadId: "chat", threadTitle: "Creative brief", messageId: `file-${id}`, reportMessageId: "summary", previewUrl: `/api/preview/${id}`,
});
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  fixture.api.mockReset(); fixture.dispatch.mockReset();
  vi.stubGlobal("IntersectionObserver", undefined);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const render = (shown = bot) => flushSync(() => root.render(createElement(ArtifactsTab, { bot: shown })));
const click = (element: Element | null) => {
  if (!element) throw new Error("missing fixture button");
  flushSync(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};

it("groups by the viewer's calendar date, keeping newest reports first", () => {
  const first = artifact("one");
  const older = artifact("two", "document", new Date(2026, 10, 16, 12).getTime());
  expect(artifactDateGroups([first, older], "en").map(group => group.date)).toEqual(["2026-11-17", "2026-11-16"]);
});

it("renders one named row per artifact, thumbnails for images and videos, and loads older dates on demand", async () => {
  fixture.api.mockResolvedValueOnce({ items: [artifact("image"), artifact("video", "video"), artifact("audio", "audio")], nextCursor: "older" });
  fixture.api.mockResolvedValueOnce({ items: [artifact("document", "document", new Date(2026, 10, 16, 12).getTime())], nextCursor: null });
  render();
  await vi.waitFor(() => expect(host.querySelectorAll("[data-artifact-id]")).toHaveLength(3));
  expect(host.textContent).not.toContain("8e657781");
  await vi.waitFor(() => expect(host.querySelector('[data-artifact-id="image"] img')).not.toBeNull());
  expect(host.querySelector('[data-artifact-id="video"] video')).not.toBeNull();
  expect(host.querySelector('[data-artifact-id="audio"] img, [data-artifact-id="audio"] video')).toBeNull();
  click([...host.querySelectorAll("button")].find(button => button.textContent === "Show older artifacts")!);
  await vi.waitFor(() => expect(host.querySelectorAll("[data-artifact-id]")).toHaveLength(4));
  expect(fixture.api.mock.calls[1]![0]).toBe("/api/bots/editor/artifacts?before=older");
  expect([...host.querySelectorAll("[data-artifact-date]")].map(element => element.getAttribute("data-artifact-date"))).toEqual(["2026-11-17", "2026-11-16"]);
  click(host.querySelector('[data-artifact-id="document"] button[aria-label="Show original report"]'));
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: "focusMessage", threadId: "chat", messageId: "summary" });
});

it("offers a retry after loading fails and then shows the empty state", async () => {
  fixture.api.mockRejectedValueOnce(new Error("network"));
  fixture.api.mockResolvedValueOnce({ items: [], nextCursor: null });
  render();
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
  click([...host.querySelectorAll("button")].find(button => button.textContent === "Retry")!);
  await vi.waitFor(() => expect(host.querySelector('[data-panel-empty="artifacts"]')).not.toBeNull());
});

it("cancels an old bot's request and never renders its files after switching bots", async () => {
  let finish: ((page: BotArtifactPage) => void) | undefined;
  fixture.api.mockImplementationOnce(() => new Promise<BotArtifactPage>(resolve => { finish = resolve; }));
  fixture.api.mockResolvedValueOnce({ items: [], nextCursor: null });
  render();
  await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledTimes(1));
  const signal = fixture.api.mock.calls[0]![1].signal as AbortSignal;
  render({ ...bot, id: "other" });
  expect(signal.aborted).toBe(true);
  finish!({ items: [artifact("old-bot")], nextCursor: null });
  await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledTimes(2));
  expect(host.querySelector("[data-artifact-id]")).toBeNull();
});
