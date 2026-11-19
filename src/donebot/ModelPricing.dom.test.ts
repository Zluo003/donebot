// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { MODEL_PRICING_CATALOG } from "../../scripts/testing/donebot-model-pricing-fixture";
import type { DoneBotCatalog } from "../../shared/donebot";

const fixture = vi.hoisted(() => ({ api: vi.fn(), account: "fixture-user" }));
vi.mock("@/state/api", () => ({ api: fixture.api }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: { donebot: { enabled: true, user: fixture.account ? { id: fixture.account } : undefined } } } }) }));
const { DoneBotModelPricing } = await import("./ModelPricing");
let host: HTMLDivElement, root: Root;
const mount = async () => act(async () => root.render(createElement(DoneBotModelPricing)));
const refresh = async () => act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
beforeEach(() => {
  setLocale("zh"); fixture.account = "fixture-user";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.api.mockReset().mockResolvedValue(structuredClone(MODEL_PRICING_CATALOG));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); setLocale("en"); });

it("lists the full gateway catalog in five categories with CNY selling units", async () => {
  await mount();
  expect([...host.querySelectorAll("section")].map(section => section.getAttribute("aria-label"))).toEqual(["LLM", "图片", "视频", "音乐", "音频"]);
  expect(host.querySelectorAll("[data-model-price-id]")).toHaveLength(MODEL_PRICING_CATALOG.models.length);
  const row = (id: string) => host.querySelector(`[data-model-price-id="${id}"]`)!.textContent;
  expect(row("gpt-6.1-sol")).toContain("2 元／百万 tokens");
  expect(row("gpt-6.1-sol")).toContain("8 元／百万 tokens");
  expect(row("seedream-5-5")).toContain("0.5 元／张");
  expect(row("seedance-2-5")).toContain("720p · 无参考视频2.5 元／秒");
  expect(row("seedance-2-5")).toContain("720p · 有参考视频1.25 元／秒");
  expect(row("muse-video")).toContain("2 元／秒");
  expect(row("muse-video")).not.toContain("元／次");
  expect(row("suno")).toContain("1.2 元／次");
  expect(row("gpt-4o-mini-tts")).toContain("0.012 元／千字");
  expect(row("future-image-model-with-a-long-public-identifier-for-layout-testing")).toContain("0 元／张");
  expect(row("fixture-audio-unpriced")).toContain("价格暂不可用");
  expect(fixture.api.mock.calls).toEqual([["/api/donebot/catalog"]]);
});
it("clears old prices during refresh, blocks duplicate clicks, then shows updated rates", async () => {
  await mount();
  let resolve!: (value: DoneBotCatalog) => void;
  fixture.api.mockImplementation(() => new Promise<DoneBotCatalog>(done => { resolve = done; }));
  await refresh(); await refresh();
  expect(host.querySelector("[data-model-price-id]")).toBeNull();
  expect(host.querySelector('[role="status"]')?.textContent).toContain("正在加载");
  expect(host.querySelector("button")!.disabled).toBe(true);
  expect(fixture.api).toHaveBeenCalledTimes(2);
  const changed = structuredClone(MODEL_PRICING_CATALOG);
  changed.models.find(model => model.id === "gpt-4o-mini-tts")!.pricing!.per_request = 20;
  await act(async () => resolve(changed));
  expect(host.textContent).toContain("0.02 元／千字");
  expect(host.querySelector("button")!.disabled).toBe(false);
});
it("shows failures without retaining stale prices and allows retry", async () => {
  await mount(); fixture.api.mockRejectedValueOnce(new Error("隔离测试：目录暂时不可用"));
  await refresh();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("目录暂时不可用");
  expect(host.querySelector("[data-model-price-id]")).toBeNull();
  await refresh();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector("[data-model-price-id]")).not.toBeNull();
});
it("keeps all five empty categories when the catalog has no enabled models", async () => {
  fixture.api.mockResolvedValue({ ...MODEL_PRICING_CATALOG, models: [] }); await mount();
  expect(host.querySelectorAll("section")).toHaveLength(5);
  expect(host.textContent?.match(/此分类暂无已启用的模型。/g)).toHaveLength(5);
});
it("resets prices on account changes and ignores a late response from the previous account", async () => {
  let resolveOld!: (value: DoneBotCatalog) => void;
  fixture.api.mockImplementationOnce(() => new Promise<DoneBotCatalog>(done => { resolveOld = done; }));
  await mount(); fixture.account = "second-user";
  fixture.api.mockResolvedValue({ ...MODEL_PRICING_CATALOG, models: [] });
  await mount();
  await act(async () => resolveOld(MODEL_PRICING_CATALOG));
  expect(host.querySelectorAll("section")).toHaveLength(5);
  expect(host.querySelector("[data-model-price-id]")).toBeNull();
  fixture.account = ""; await mount();
  expect(host.textContent).toContain("登录 DoneBot 账号后");
  expect(host.querySelector("section")).toBeNull();
  expect(fixture.api).toHaveBeenCalledTimes(2);
});
it("does not fetch a catalog before sign-in", async () => {
  fixture.account = ""; await mount();
  expect(host.textContent).toContain("登录 DoneBot 账号后");
  expect(fixture.api).not.toHaveBeenCalled();
});
