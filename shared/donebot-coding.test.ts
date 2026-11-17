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

it("only permits status checks for existing CLI configuration", () => {
  for (const engine of ["codex", "claude"]) {
    const prefix = `/api/instances/donebot-${engine}-existing`;
    expect(isDoneBotCodingInstance(`donebot-${engine}-existing`)).toBe(true);
    for (const action of ["check", "refresh-models"]) expect(codingInstanceAction(`${prefix}/${action}`, "POST")).toBe(true);
    for (const action of ["install", "auth/start", "auth/complete", "auth/sign-out"]) expect(codingInstanceAction(`${prefix}/${action}`, "POST")).toBe(false);
  }
});
