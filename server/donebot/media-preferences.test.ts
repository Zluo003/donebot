import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DEFAULT_DONEBOT_MEDIA_PREFERENCES } from "../../shared/donebot.ts";
import { FAKE_DONEBOT_CATALOG } from "../testing/fake-donebot-gateway.ts";
import { DoneBotMediaPreferencesStore, selectedMediaModels } from "./media-preferences.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("persists defaults by account and rejects duplicate primary/backup choices", () => {
  const root = mkdtempSync(join(tmpdir(), "donebot-preferences-")); roots.push(root);
  const file = join(root, "media.json");
  const store = new DoneBotMediaPreferencesStore(file);
  const preferences = { image: { primary: "gpt-image-2.6-flare", fallback: "seedream-5-5" }, video: { primary: "muse-video", fallback: "seedance-2-5" } };
  store.save("account-a", preferences);
  expect(new DoneBotMediaPreferencesStore(file).get("account-a")).toEqual(preferences);
  expect(store.get("account-b")).toEqual(DEFAULT_DONEBOT_MEDIA_PREFERENCES);
  expect(() => store.save("account-a", { ...preferences, image: { primary: "same", fallback: "same" } })).toThrow();
  const copy = store.get("account-a"); copy.image.primary = "mutated";
  expect(store.get("account-a")).toEqual(preferences);
});

it("uses enabled registered choices, the configured backup if primary is disabled, and no arbitrary substitute for a saved unavailable model", () => {
  const preferences = { ...DEFAULT_DONEBOT_MEDIA_PREFERENCES, image: { primary: "gpt-image-2.6-flare", fallback: "seedream-5-5" } };
  expect(selectedMediaModels(FAKE_DONEBOT_CATALOG, preferences, "image")).toEqual(preferences.image);
  const catalog = structuredClone(FAKE_DONEBOT_CATALOG);
  catalog.models = catalog.models.filter(model => model.id !== preferences.image.primary);
  expect(selectedMediaModels(catalog, preferences, "image")).toEqual({ primary: "seedream-5-5", fallback: "" });
  expect(selectedMediaModels(catalog, { ...preferences, image: { ...preferences.image, fallback: "" } }, "image")).toEqual({ primary: "", fallback: "" });
  expect(selectedMediaModels(null, preferences, "image")).toEqual({ primary: "", fallback: "" });
});

it("preserves a damaged preferences file and permits recovery without preventing startup", () => {
  const root = mkdtempSync(join(tmpdir(), "donebot-preferences-")); roots.push(root);
  const file = join(root, "media.json"), damaged = "{ incomplete";
  writeFileSync(file, damaged);
  const store = new DoneBotMediaPreferencesStore(file);
  expect(store.get("fixture-user")).toEqual(DEFAULT_DONEBOT_MEDIA_PREFERENCES);
  const backup = readdirSync(root).find(name => name.startsWith("media.json.invalid."))!;
  expect(readFileSync(join(root, backup), "utf8")).toBe(damaged);
  store.save("fixture-user", DEFAULT_DONEBOT_MEDIA_PREFERENCES);
  expect(new DoneBotMediaPreferencesStore(file).get("fixture-user")).toEqual(DEFAULT_DONEBOT_MEDIA_PREFERENCES);
});
