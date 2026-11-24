// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { packageSummary, parsePackageDocument } from "../../shared/package-format";
import type { ShareResponse } from "@/lib/team-share";
import { profileMenuItems } from "@/components/SidebarProfileMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({
    state: {
      config: { donebot: { enabled: true, authenticated: true } },
      bots: [
        {
          id: "b1",
          name: "主编",
          section: "内容部",
          hidden: false,
          chiefOfStaff: true,
          soul: "你是内容部主编，负责制定选题方向、组织撰稿并审核成稿质量交付老板。",
        },
        {
          id: "b2",
          name: "撰稿员",
          section: "内容部",
          hidden: false,
          soul: "你是内容部撰稿员，根据主编大纲输出通顺易读的中文稿件与配图建议。",
        },
      ],
    },
    dispatch: fixture.dispatch,
  }),
}));

vi.mock("@/state/api", () => ({
  api: fixture.api,
}));

const { ShareTeamDialog } = await import("@/components/ShareTeamDialog");
const raw = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "shared", "package-fixtures", "full-team.v2.json"), "utf8"));
const document = parsePackageDocument(raw);
const share: ShareResponse = {
  document,
  filename: "content-1.0.0.openmaus.json",
  redacted: [],
  skipped: [],
  summary: packageSummary(document),
  choices: { skills: [] },
};

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  setLocale("zh");
  fixture.api.mockReset();
  fixture.dispatch.mockReset();
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/teams/export") return share;
    if (path === "/api/donebot/market/categories") {
      return { categories: [{ id: 2, slug: "writing", name: "文案营销", description: "", sort_order: 1, enabled: true }] };
    }
    if (path === "/api/donebot/market/publish-department" && init?.method === "POST") {
      return {
        id: "33333333-3333-4333-8333-333333333333",
        listing_type: "studio",
        name: "内容部",
        status: "published",
        latest_version: 1,
        latest_release: {
          review_status: "approved",
          ai_report: { verdict: "approve", risk_score: 5, summary: "内部审核意见不应暴露" },
        },
      };
    }
    return {};
  });
  host = globalThis.document.createElement("div");
  globalThis.document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const findButton = (text: string) =>
  [...globalThis.document.body.querySelectorAll("button")].find(b => b.textContent?.includes(text));

describe("ShareTeamDialog Bot Market publish & SidebarProfileMenu cleanup", () => {
  it("replaces Publish to GitHub with Publish to Bot Market and hides review notes once published", async () => {
    await act(async () => {
      root.render(createElement(ShareTeamDialog, { team: "内容部", onClose: vi.fn() }));
    });
    await act(async () => new Promise(resolve => setTimeout(resolve, 300)));

    expect(globalThis.document.body.textContent).not.toContain("发布到 GitHub");
    const marketBtn = findButton("发布到 Bot 广场");
    expect(marketBtn).toBeTruthy();

    await act(async () => { marketBtn!.click(); });
    await act(async () => { await Promise.resolve(); });

    const submitBtn = findButton("提交发布审核");
    expect(submitBtn).toBeTruthy();
    expect(submitBtn!.disabled).toBe(false);

    await act(async () => {
      globalThis.document.body.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(fixture.api).toHaveBeenCalledWith(
      "/api/donebot/market/publish-department",
      expect.objectContaining({ method: "POST" }),
    );
    expect(globalThis.document.body.textContent).toContain("已上架");
    expect(globalThis.document.body.textContent).not.toContain("内部审核意见不应暴露");
  });

  it("omits duplicate edit-profile item from bottom-left sidebar menu", () => {
    const noop = () => {};
    const items = profileMenuItems({
      phone: [],
      usage: true,
      update: null,
      account: null,
      onUsage: noop,
      onSettings: noop,
      onShortcuts: noop,
      onAbout: noop,
      onHelp: noop,
      onFeedback: noop,
      onAccount: noop,
    });
    expect(items.some(item => item.key === "edit-profile" || item.label.includes("编辑头像与昵称"))).toBe(false);
  });
});
