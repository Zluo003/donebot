import { expect, it } from "vitest";
import { codingInstanceAction, isDoneBotCodingInstance } from "./donebot-coding.ts";

it("opens installation and model refresh for fixed coding instances, and login only for subscription instances", () => {
  for (const engine of ["codex", "claude"]) for (const suffix of ["", "-subscription"]) {
    const id = `donebot-${engine}${suffix}`;
    expect(isDoneBotCodingInstance(id)).toBe(true);
    expect(codingInstanceAction(`/api/instances/${id}/install`, "POST")).toBe(true);
    expect(codingInstanceAction(`/api/instances/${id}/refresh-models`, "POST")).toBe(true);
    expect(codingInstanceAction(`/api/instances/${id}/auth/start`, "POST")).toBe(suffix !== "");
    expect(codingInstanceAction(`/api/instances/${id}/settings`, "PATCH")).toBe(false);
  }
  expect(isDoneBotCodingInstance("donebot-codex-other")).toBe(false);
  expect(codingInstanceAction("/api/instances/claude-endpoint", "POST")).toBe(false);
  expect(codingInstanceAction("/api/instances/donebot-codex/install", "DELETE")).toBe(false);
});
