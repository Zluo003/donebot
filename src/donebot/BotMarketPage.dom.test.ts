// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketCategory, MarketListResponse, MarketListingSummary } from "../../shared/donebot-market";

const fixture = vi.hoisted(() => ({
  listCategories: vi.fn(),
  listBots: vi.fn(),
  listMine: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock("@/state/store", () => ({
  useStore: () => ({
    state: { marketPublishBotId: null, config: { donebot: { cloudManaged: false } } },
    dispatch: fixture.dispatch,
  }),
}));

vi.mock("@/components/DesktopCapabilities", () => ({
  useCaptionChrome: () => ({ dragProps: {} }),
}));

vi.mock("./market-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./market-api")>();
  return {
    ...actual,
    marketApi: {
      ...actual.marketApi,
      listCategories: fixture.listCategories,
      listBots: fixture.listBots,
      listMine: fixture.listMine,
    },
  };
});

const { BotMarketPage, MARKET_PAGE_SIZE, buildPaginationItems } = await import("./BotMarketPage");

function makeListing(index: number, categoryId = 1): MarketListingSummary {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    listing_type: "bot",
    author_user_id: 1,
    author_name: "Tester",
    category_id: categoryId,
    category_name: categoryId === 1 ? "办公效率" : "研发编程",
    category_slug: categoryId === 1 ? "office" : "dev",
    name: `Bot ${index}`,
    tagline: `简介 ${index}`,
    description: `描述 ${index}`,
    tags: [],
    sample_prompts: [],
    has_soul: true,
    skill_count: 1,
    skill_names: ["skill-1"],
    latest_version: 1,
    published_version: 1,
    status: "published",
    featured: false,
    install_count: 100 - index,
    created_at: "2026-11-28T00:00:00Z",
    updated_at: "2026-11-28T00:00:00Z",
  };
}

const ALL_ITEMS = Array.from({ length: 30 }, (_, i) => makeListing(i + 1, i < 20 ? 1 : 2));
const CATEGORIES: MarketCategory[] = [
  { id: 1, slug: "office", name: "办公效率", description: "", sort_order: 1, enabled: true },
  { id: 2, slug: "dev", name: "研发编程", description: "", sort_order: 2, enabled: true },
];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.dispatch.mockReset();
  fixture.listCategories.mockReset().mockResolvedValue(CATEGORIES);
  fixture.listMine.mockReset().mockResolvedValue([]);
  fixture.listBots.mockReset().mockImplementation(async (params: { category_id?: number; page?: number; page_size?: number }): Promise<MarketListResponse> => {
    const filtered = params.category_id ? ALL_ITEMS.filter(item => item.category_id === params.category_id) : ALL_ITEMS;
    const page = params.page ?? 1;
    const pageSize = params.page_size ?? MARKET_PAGE_SIZE;
    const start = (page - 1) * pageSize;
    return {
      items: filtered.slice(start, start + pageSize),
      total: filtered.length,
      page,
      page_size: pageSize,
      installed_by_listing: {},
    };
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const flush = async () => {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
};

const clickButton = async (predicate: (btn: HTMLButtonElement) => boolean) => {
  const btn = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(predicate);
  expect(btn).toBeTruthy();
  await act(async () => btn!.click());
  await flush();
};

describe("BotMarketPage pagination", () => {
  it("computes compact page lists with ellipses for large page counts", () => {
    expect(buildPaginationItems(1, 1)).toEqual([1]);
    expect(buildPaginationItems(2, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(buildPaginationItems(1, 10)).toEqual([1, 2, 3, 4, 5, "ellipsis", 10]);
    expect(buildPaginationItems(5, 10)).toEqual([1, "ellipsis", 4, 5, 6, "ellipsis", 10]);
    expect(buildPaginationItems(10, 10)).toEqual([1, "ellipsis", 6, 7, 8, 9, 10]);
  });

  it("paginates 12 items per page, supports switching pages, and resets to page 1 on filter change", async () => {
    await act(async () => root.render(createElement(BotMarketPage)));
    await flush();

    expect(fixture.listBots).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, page_size: 12 }));
    expect(host.querySelectorAll("article").length).toBe(12);
    expect(host.textContent).toContain("共 30 个 · 第 1 / 3 页");
    expect(host.querySelector('button[aria-current="page"]')?.textContent).toBe("1");

    const prevBtn = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent?.includes("上一页"))!;
    expect(prevBtn.getAttribute("aria-disabled")).toBe("true");
    await act(async () => prevBtn.click());
    await flush();
    expect(fixture.listBots).toHaveBeenCalledTimes(1);

    await clickButton(b => Boolean(b.textContent?.includes("下一页")));
    expect(fixture.listBots).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, page_size: 12 }));
    expect(host.querySelectorAll("article").length).toBe(12);
    expect(host.textContent).toContain("共 30 个 · 第 2 / 3 页");
    expect(host.textContent).toContain("Bot 13");
    expect(host.textContent).not.toContain("Bot 1 ");

    await clickButton(b => b.getAttribute("aria-label") === "第 3 页");
    expect(fixture.listBots).toHaveBeenLastCalledWith(expect.objectContaining({ page: 3, page_size: 12 }));
    expect(host.querySelectorAll("article").length).toBe(6);
    expect(host.textContent).toContain("共 30 个 · 第 3 / 3 页");
    expect(host.querySelector('button[aria-current="page"]')?.textContent).toBe("3");

    const nextBtn = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent?.includes("下一页"))!;
    expect(nextBtn.getAttribute("aria-disabled")).toBe("true");
    const callsBeforeBoundaryClick = fixture.listBots.mock.calls.length;
    await act(async () => nextBtn.click());
    await flush();
    expect(fixture.listBots).toHaveBeenCalledTimes(callsBeforeBoundaryClick);

    await clickButton(b => b.textContent?.trim() === "研发编程");
    expect(fixture.listBots).toHaveBeenLastCalledWith(expect.objectContaining({ category_id: 2, page: 1, page_size: 12 }));
    expect(host.querySelectorAll("article").length).toBe(10);
    expect(host.textContent).toContain("共 10 个 · 第 1 / 1 页");
  });
});
