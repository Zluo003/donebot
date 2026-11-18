// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import type { Bot, ConfigStatus } from "@/state/store";
import { EMPTY_ONBOARDING, LOCAL_VIEWER } from "@/lib/onboarding";
import { CHIEF_SETUP_HINT, chiefSetupBot, chiefSetupKey, chiefSetupPatch, chiefSetupSoul, initialChiefSetup, readChiefSetupDraft, saveChiefSetupDraft } from "./chief-setup";
import { NEW_BOT_BODY, PICKABLE_BOT_BODIES } from "./avatars";

const bot: Bot = { id: "chief", threadId: "thread", name: "DoneBot", title: "", description: "", color: "chrome", notifications: true, unread: false,
  modelSelection: { instanceId: "donebot", model: "fixture-model" }, messages: [], soul: "Keep my existing responsibilities.", defaultBot: {}, chiefOfStaff: true };
const config = (): ConfigStatus => ({ onboarding: structuredClone(EMPTY_ONBOARDING) }) as ConfigStatus;
const facts = () => ({ bots: [structuredClone(bot)], config: config(), connected: true, hydrated: true, viewer: LOCAL_VIEWER, email: null, remote: false });
beforeEach(() => localStorage.clear());
it("requires setup for fresh local and Cloud chiefs, including remote Cloud windows", () => {
  expect(chiefSetupBot(facts())?.id).toBe(bot.id);
  expect(chiefSetupBot({ ...facts(), remote: true, viewer: { hosted: false, canSave: true, cloudHome: true } })?.id).toBe(bot.id);
  expect(chiefSetupBot({ ...facts(), remote: true })).toBeUndefined();
});
it("does not interrupt established users, imported bots, members, or another Chief", () => {
  const existing = facts(); existing.bots[0]!.welcomed = true;
  expect(chiefSetupBot(existing)).toBeUndefined();
  expect(chiefSetupBot({ ...facts(), viewer: { hosted: true, canSave: false } })).toBeUndefined();
  expect(chiefSetupBot({ ...facts(), hydrated: false })).toBeUndefined();
  expect(chiefSetupBot({ ...facts(), email: undefined })).toBeUndefined();
  const history = facts(); history.bots[0]!.messages.push({ id: "m", role: "user", kind: "text", text: "Existing work", at: 1 });
  expect(chiefSetupBot(history)).toBeUndefined();
  const chief = facts(); chief.bots[0]!.chiefOfStaff = false;
  chief.bots.push({ ...bot, id: "other", defaultBot: undefined });
  expect(chiefSetupBot(chief)).toBeUndefined();
  const completed = facts(); completed.config.onboarding!.completedAt = "2026-11-18T00:00:00Z";
  expect(chiefSetupBot(completed)).toBeUndefined();
});
it("resumes a scoped draft after a partial save but respects completion from another window", () => {
  const key = chiefSetupKey(bot.id);
  const draft = { ...initialChiefSetup(bot), name: "阿宝", address: "小林", step: 3 };
  saveChiefSetupDraft(key, draft);
  const f = facts(); f.bots[0]!.welcomed = true;
  expect(chiefSetupBot(f)?.id).toBe(bot.id);
  expect(readChiefSetupDraft(key)).toEqual(draft);
  expect(readChiefSetupDraft(chiefSetupKey(bot.id, "other-account"))).toBeNull();
  f.config.onboarding!.hintsSeen.push(CHIEF_SETUP_HINT);
  expect(chiefSetupBot(f)).toBeUndefined();
});
it("rejects malformed drafts and never offers a triangle", () => {
  localStorage.setItem("malformed", '{"step":99}'); expect(readChiefSetupDraft("malformed")).toBeNull();
  expect(NEW_BOT_BODY).toBe("circle"); expect(PICKABLE_BOT_BODIES).not.toContain("cursor");
  expect(initialChiefSetup({ ...bot, mascotBody: "cursor" }).body).toBe("circle");
});
it("saves style and address as standing instructions while preserving the existing soul", () => {
  const draft = { ...initialChiefSetup(bot), address: "小林", traits: ["concise", "professional"] as const, custom: "用中文，结论在前。" };
  const editable = { ...draft, traits: [...draft.traits] };
  const soul = chiefSetupSoul(bot.soul!, editable);
  expect(soul).toContain(bot.soul); expect(soul).toContain('Address the user as "小林".');
  expect(soul).toContain("Lead with the answer"); expect(soul).toContain("professional language"); expect(soul).toContain(draft.custom);
  expect(chiefSetupSoul(soul, { ...editable, address: "老板" })).not.toContain("小林");
  expect(chiefSetupSoul(soul, editable)).toBe(soul);
});
it("uses 多宝 for a blank name and allows only the current enabled DoneBot model", () => {
  const draft = { ...initialChiefSetup(bot), name: "  ", body: "star" as const, color: "blue" as const };
  const patch = chiefSetupPatch(bot, draft, [{ id: "fixture-model", label: "Fixture" }]);
  expect(patch).toMatchObject({ name: "多宝", mascotBody: "star", color: "blue", welcomed: true, modelSelection: { instanceId: "donebot", model: "fixture-model" }, requireAvailableModel: true });
  expect(chiefSetupPatch(bot, draft, [])).not.toHaveProperty("modelSelection");
});
