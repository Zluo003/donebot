// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DoneBotMediaSettings } from "../../shared/donebot";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/api", () => ({ api: fixture.api }));
const { DoneBotMediaSettingsPanel } = await import("./MediaSettings");
let host: HTMLDivElement, root: Root, settings: DoneBotMediaSettings;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  settings = { accountId: "fixture-user", preferences: { image: { primary: "seedream-5-5", fallback: "" }, video: { primary: "seedance-2-5", fallback: "" } },
    models: [{ id: "seedream-5-5", name: "Seedream 5.5", kind: "image" }, { id: "gpt-image-2.6-flare", name: "GPT Image", kind: "image" },
      { id: "seedance-2-5", name: "Seedance 2.5", kind: "video" }, { id: "muse-video", name: "Muse", kind: "video" }] };
  fixture.api.mockReset().mockImplementation(async (_path, init) => {
    if (init?.method === "PUT") settings.preferences = JSON.parse(init.body).preferences;
    return structuredClone(settings);
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const mount = async () => act(async () => root.render(createElement(DoneBotMediaSettingsPanel)));
const select = async (name: string, value: string) => {
  const field = host.querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`)!;
  await act(async () => { field.value = value; field.dispatchEvent(new Event("change", { bubbles: true })); });
};

it("uses separate image/video primary and backup choices and saves only for the displayed account", async () => {
  await mount();
  expect(host.querySelectorAll("select")).toHaveLength(4);
  expect(host.querySelector('select[aria-label="图片首选模型"]')?.textContent).not.toContain("Muse");
  await select("视频首选模型", "muse-video"); await select("视频备用模型", "seedance-2-5");
  await select("图片备用模型", "gpt-image-2.6-flare");
  expect(fixture.api.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
  const save = [...host.querySelectorAll("button")].find(button => button.textContent === "保存媒体设置")!;
  await act(async () => save.click());
  const writes = fixture.api.mock.calls.filter(([, init]) => init?.method === "PUT");
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0]![1].body)).toEqual({ accountId: "fixture-user", preferences: {
    image: { primary: "seedream-5-5", fallback: "gpt-image-2.6-flare" }, video: { primary: "muse-video", fallback: "seedance-2-5" },
  } });
  expect(host.querySelector('[role="status"]')?.textContent).toContain("已保存");
});

it("keeps a disabled saved model visible and shows synchronization errors", async () => {
  settings.models = settings.models.filter(model => model.id !== "seedream-5-5");
  await mount();
  expect(host.querySelector('select[aria-label="图片首选模型"] option:disabled')?.textContent).toContain("当前不可用");
  fixture.api.mockRejectedValueOnce(new Error("Synthetic save failure"));
  const save = [...host.querySelectorAll("button")].find(button => button.textContent === "保存媒体设置")!;
  await act(async () => save.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Synthetic save failure");
});
