// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot, ConfigStatus, InstanceInfo } from "@/state/store";
import { EMPTY_ONBOARDING } from "@/lib/onboarding";
import { setLocale } from "@/lib/i18n";
import { CHIEF_SETUP_HINT, chiefSetupKey, initialChiefSetup, readChiefSetupDraft, saveChiefSetupDraft } from "./chief-setup";

const f = vi.hoisted(() => ({ state: {} as { config: ConfigStatus; instances: InstanceInfo[] }, dispatch: vi.fn(), api: vi.fn(), save: vi.fn(), done: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: f.api, persistBotUpdate: f.save }));
vi.mock("@/components/Avatar", () => ({ BotAvatar: () => null, MausAvatar: () => null }));
const { DoneBotChiefSetup } = await import("./ChiefSetup");
const bot: Bot = { id: "chief", threadId: "thread", name: "DoneBot", title: "", description: "", color: "chrome", notifications: true, unread: false,
  modelSelection: { instanceId: "donebot", model: "fixture-model" }, messages: [], soul: "Keep responsibilities.", defaultBot: {}, chiefOfStaff: true };
let host: HTMLDivElement, root: Root;
const key = chiefSetupKey(bot.id);
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === name)!;
const click = async (name: string) => { const node = button(name); expect(node, name).toBeTruthy(); expect(node.disabled).toBe(false); await act(async () => node.click()); };
const mount = async () => { await act(async () => root.render(createElement(DoneBotChiefSetup, { bot, onDone: f.done }))); };
beforeEach(() => {
  setLocale("zh"); localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  f.state = { config: { onboarding: structuredClone(EMPTY_ONBOARDING) } as ConfigStatus,
    instances: [{ instanceId: "donebot", models: { default: "fixture-model", options: [{ id: "fixture-model", label: "Fixture Model" }] } }] as InstanceInfo[] };
  f.dispatch.mockReset(); f.done.mockReset();
  f.api.mockReset().mockResolvedValue(f.state.config); f.save.mockReset().mockResolvedValue({ ...bot, welcomed: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); setLocale("en"); });
it("starts with identity and a circular avatar, saves only after reviewing all steps", async () => {
  await mount(); expect(document.querySelector("[data-chief-setup]")?.getAttribute("data-chief-setup")).toBe("identity");
  expect(readChiefSetupDraft(key)?.body).toBe("circle");
  await click("下一步"); await click("专业严谨"); await click("逻辑分析");
  expect(readChiefSetupDraft(key)?.traits).toEqual(["concise", "warm", "professional", "analytical"]);
  await click("下一步"); expect(document.querySelectorAll("option")).toHaveLength(1);
  await click("下一步");
  expect(document.querySelector('button[aria-label="光标"]')).toBeNull();
  expect(document.querySelectorAll('[role="group"][aria-label="头像造型"] button')).toHaveLength(9);
  await click("下一步"); expect(f.save).not.toHaveBeenCalled();
  await click("保存并开始");
  expect(f.save.mock.calls[0]![1]).toMatchObject({ name: "多宝", mascotBody: "circle", modelSelection: { instanceId: "donebot", model: "fixture-model" } });
  expect(f.save.mock.calls[0]![1].soul).toContain("relevant evidence");
  expect(JSON.parse(f.api.mock.calls[0]![1].body).onboarding.hintsSeen).toContain(CHIEF_SETUP_HINT);
  expect(f.done).toHaveBeenCalledExactlyOnceWith(bot.id); expect(readChiefSetupDraft(key)).toBeNull();
});
it("keeps a resumable draft when completion fails after the bot was saved, then retries", async () => {
  saveChiefSetupDraft(key, { ...initialChiefSetup(bot), name: "阿宝", address: "小林", custom: "结论在前。", step: 4 });
  f.api.mockRejectedValueOnce(new Error("synthetic completion failure"));
  await mount(); await click("保存并开始");
  expect(f.done).not.toHaveBeenCalled(); expect(document.querySelector('[role="alert"]')?.textContent).toContain("已保留填写内容");
  expect(readChiefSetupDraft(key)).toMatchObject({ name: "阿宝", address: "小林", step: 4 });
  await click("保存并开始"); expect(f.done).toHaveBeenCalledOnce();
  expect(f.save.mock.calls[1]![1].soul).toBe(f.save.mock.calls[0]![1].soul);
});
it("never marks onboarding complete when saving the bot fails", async () => {
  saveChiefSetupDraft(key, { ...initialChiefSetup(bot), step: 4 });
  f.save.mockRejectedValueOnce(new Error("synthetic save failure")); await mount(); await click("保存并开始");
  expect(f.api).not.toHaveBeenCalled(); expect(f.done).not.toHaveBeenCalled(); expect(readChiefSetupDraft(key)).not.toBeNull();
});
it("blocks duplicate submissions until saving finishes", async () => {
  saveChiefSetupDraft(key, { ...initialChiefSetup(bot), step: 4 });
  let resolve!: (bot: Bot) => void; f.save.mockImplementationOnce(() => new Promise<Bot>(done => { resolve = done; }));
  await mount(); const save = button("保存并开始"); await act(async () => { save.click(); save.click(); });
  expect(f.save).toHaveBeenCalledOnce(); expect(button("正在保存…").disabled).toBe(true);
  await act(async () => resolve(bot)); expect(f.done).toHaveBeenCalledOnce();
});
it("finishes Cloud setup with the same preferences and no second legacy welcome", async () => {
  f.state.config.cloudHome = true; saveChiefSetupDraft(key, { ...initialChiefSetup(bot), step: 4 });
  await mount(); await click("保存并开始");
  expect(JSON.parse(f.api.mock.calls[0]![1].body).onboarding.hintsSeen).toEqual(expect.arrayContaining([CHIEF_SETUP_HINT, "cloud-welcome-done", "cloud-intent-asked"]));
});
