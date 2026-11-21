// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TeamTemplate } from "../../shared/team-templates";
import { setLocale } from "@/lib/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api }));

const { TeamTemplatesTab } = await import("./TeamTemplatesTab");

const template: TeamTemplate = {
  slug: "helper", name: "Helper", scope: "bot", tagline: "Helps the team", release: "1.0.0",
  revision: "a".repeat(64), addedBy: "admin", addedAt: Date.parse("2026-11-20T12:00:00Z"),
};
let host: HTMLElement;
let root: Root;
let admin = false;
const calls: Array<{ path: string; method: string; body?: string }> = [];

beforeEach(() => {
  setLocale("en");
  admin = false;
  calls.length = 0;
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (method === "GET" && path === "/api/team-templates") return { templates: [template], admin };
    if (method === "GET" && path === "/api/team-templates/helper") return { template, document: { format: "openmaus.package", version: 1, package: {} } };
    if (method === "DELETE") return { removed: true };
    return {};
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.querySelectorAll("body > [role='alertdialog']").forEach((dialog) => dialog.remove());
  vi.restoreAllMocks();
  setLocale("en");
});

const render = async (onOpen = vi.fn(), onPublish = vi.fn()) => {
  await act(async () => root.render(createElement(TeamTemplatesTab, {
    teams: [{ name: "Sales", bots: 2 }, { name: "", bots: 1 }], refreshKey: 0, onOpen, onPublish,
  })));
  await act(async () => {});
  return { onOpen, onPublish };
};
const button = (label: string, scope: ParentNode = host) => [...scope.querySelectorAll("button")].find((item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label)!;

describe("team templates", () => {
  it("lets members preview and install candidates without showing management actions", async () => {
    const { onOpen } = await render();
    expect(host.textContent).toContain("Helper");
    expect(host.querySelector("input")).toBeNull();
    expect(host.querySelector("[aria-label='Remove Helper']")).toBeNull();
    await act(async () => button("Review and add").click());
    expect(calls.at(-1)?.path).toBe("/api/team-templates/helper");
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ format: "openmaus.package" }), template);
  });

  it("gates publication to admins and sends the chosen team and revision target", async () => {
    admin = true;
    const { onPublish } = await render();
    const input = host.querySelector<HTMLInputElement>("input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "new-bots");
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    await act(async () => button("Review").click());
    expect(onPublish).toHaveBeenCalledWith("Sales", { slug: "new-bots", scope: "department", revision: null });
    await act(async () => button("Publish update").click());
    await act(async () => button("Publish update").click());
    expect(onPublish).toHaveBeenLastCalledWith("", { slug: "helper", scope: "bot", revision: template.revision });
  });

  it("confirms removal and sends the reviewed revision", async () => {
    admin = true;
    await render();
    await act(async () => button("Remove Helper").click());
    const dialog = document.querySelector<HTMLElement>("[role='alertdialog']")!;
    expect(dialog.textContent).toContain("Copies already installed");
    await act(async () => button("Remove", dialog).click());
    expect(calls.find((call) => call.method === "DELETE")).toMatchObject({
      path: "/api/team-templates/helper", method: "DELETE",
      body: JSON.stringify({ confirm: true, revision: template.revision }),
    });
  });
});
