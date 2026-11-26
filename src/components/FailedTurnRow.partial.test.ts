import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo, Message } from "@/state/store";
import { failedTurnTool } from "../../shared/failed-turn";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { dispatch: vi.fn() };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: {}, instances: [] as InstanceInfo[], bots: [] }, dispatch: fixture.dispatch, refreshInstances: vi.fn(), refreshModels: vi.fn() }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "darwin" }, localComputer: { available: true } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => null }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { FailedTurnRow } = await import("./ChatView");
const { activityPreview } = await import("@/lib/failed-turn");
const cause = "Stopped because the tool call “read_file” failed. The bot's reply isn't proof the work was done; the failed step shows the error.";
const show = (tool: NonNullable<Message["tool"]>) => renderToStaticMarkup(createElement(FailedTurnRow, { tool, engine: undefined, onRetry: vi.fn() }));

beforeEach(() => setLocale("en"));
afterEach(() => setLocale("en"));

describe("a turn whose reply came back but a step failed", () => {
  it("renders an ordinary failed step as a calm collapsible note with step name, details and retry", () => {
    const html = show(failedTurnTool(cause, { terminal: true, partial: true }));
    expect(html).toContain("Reply received · step “read_file” didn&#x27;t succeed");
    expect(html).toContain("border-hairline");
    expect(html).not.toMatch(/danger|warning|lucide-triangle-alert|lucide-alert-triangle/);
    expect(html).toMatch(/<details[\s\S]*Details[\s\S]*Stopped because the tool call/);
    expect(html).toContain("Retry");
  });

  it("localizes step failure notices in Chinese instead of showing raw English upfront", () => {
    setLocale("zh");
    const html = show(failedTurnTool(cause, { terminal: true, partial: true }));
    expect(html).toContain("已回复 · 中间步骤「read_file」未执行成功");
    expect(html).toContain("本次回复已正常完成");
  });

  it("keeps a gentle warning tone when a step wasn't allowed to run", () => {
    const refusedCause = "Stopped because the tool call “gmail_send” wasn't allowed. The bot's reply isn't proof the work was done; that step didn't run.";
    const html = show(failedTurnTool(refusedCause, { terminal: true, partial: true }));
    expect(html).toContain("Reply received · step “gmail_send” wasn&#x27;t allowed");
    expect(html).toContain("warning");
    expect(html).not.toContain("danger");
  });

  it("is still the red failure row when the turn did not finish", () => {
    const html = show(failedTurnTool(cause, { terminal: true }));
    expect(html).toContain("danger");
    expect(html).not.toContain("Reply received");
  });

  it("says partly done in the chat list preview helper too", () => {
    expect(activityPreview(failedTurnTool(cause, { partial: true }), undefined)).toBe("Partly done: a step didn't work");
    expect(activityPreview(failedTurnTool(cause), undefined)).not.toContain("Partly done");
  });
});
