// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { packageSummary, parsePackageDocument } from "../../shared/package-format";
import type { TeamTemplate } from "../../shared/team-templates";
import type { ShareResponse } from "@/lib/team-share";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { bots: [{ id: "b1", name: "Mira", section: "Sales", hidden: false }] } }),
}));

const { ShareTeamDialog } = await import("./ShareTeamDialog");
const raw = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "shared", "package-fixtures", "full-team.v2.json"), "utf8"));
const document = parsePackageDocument(raw);
const share: ShareResponse = {
  document, filename: "sales-1.0.0.openmaus.json", redacted: [], skipped: [], summary: packageSummary(document), choices: { skills: [] },
};
const template: TeamTemplate = {
  slug: "sales-team", name: "Sales", scope: "department", tagline: "", release: "1.0.0",
  revision: "b".repeat(64), addedBy: "owner", addedAt: 1,
};
let host: HTMLElement;
let root: Root;
const calls: Array<{ path: string; method: string; body?: string }> = [];
let publishError: Error | null = null;

beforeEach(() => {
  setLocale("en");
  calls.length = 0;
  publishError = null;
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (path === "/api/teams/export") return share;
    if (path === "/api/team-templates" && method === "POST") {
      if (publishError) throw publishError;
      return { template };
    }
    return {};
  });
  host = documentHost();
  root = createRoot(host);
});

function documentHost() {
  const element = globalThis.document.createElement("div");
  globalThis.document.body.append(element);
  return element;
}

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  setLocale("en");
});

const button = (label: string) => [...globalThis.document.body.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)!;
const render = async (onPublished = vi.fn()) => {
  await act(async () => root.render(createElement(ShareTeamDialog, {
    team: "Sales", publishTarget: { slug: template.slug, scope: template.scope, revision: template.revision }, onPublished, onClose: vi.fn(),
  })));
  await act(async () => {});
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  return onPublished;
};

describe("publishing a reviewed team template", () => {
  it("exports the selected team and publishes the exact revision target once", async () => {
    const onPublished = await render();
    expect(button("Publish update").disabled).toBe(false);
    await act(async () => button("Publish update").click());
    expect(calls.filter((call) => call.path === "/api/teams/export")).toHaveLength(2);
    const publish = calls.find((call) => call.path === "/api/team-templates")!;
    expect(publish.method).toBe("POST");
    expect(JSON.parse(publish.body!)).toEqual({ confirm: true, slug: template.slug, scope: template.scope, revision: template.revision, document });
    expect(onPublished).toHaveBeenCalledTimes(1);
    expect(globalThis.document.body.textContent).toContain("Published “Sales”");
  });

  it("surfaces a stale revision refusal without retrying or claiming success", async () => {
    publishError = new Error("The template changed. Refresh before publishing.");
    const onPublished = await render();
    await act(async () => button("Publish update").click());
    expect(calls.filter((call) => call.path === "/api/team-templates")).toHaveLength(1);
    expect(globalThis.document.body.querySelector("[role='alert']")?.textContent).toContain("Refresh before publishing");
    expect(onPublished).not.toHaveBeenCalled();
  });
});
