// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXTERNAL_CODING_AGENTS, type ExternalCodingAgentStatus } from "../../shared/coding-agents";
import { BotAvatar } from "@/components/Avatar";
import { BotModelBadge } from "@/components/BotModelBadge";
import { ProviderMark } from "@/components/ProviderIcons";
import { configuredModelInstances } from "@/lib/engine-rail";
import type { InstanceInfo } from "@/state/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dialogFixture = vi.hoisted(() => ({
  api: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  dispatch: vi.fn(),
  bots: [{ id: "bot-ag", name: "Antigravity" }],
}));

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    api: dialogFixture.api,
    useStore: () => ({ state: { bots: dialogFixture.bots }, dispatch: dialogFixture.dispatch }),
  };
});

const { CodingAgentsDialog } = await import("./CodingAgentsDialog");

function makeInstance(instanceId: string, driverKind: string): InstanceInfo {
  return {
    instanceId,
    driverKind,
    displayName: instanceId,
    enabled: true,
    models: { default: "m1", options: [{ id: "m1", label: "Model 1" }] },
    snapshot: { state: "available", authenticated: true },
  } as unknown as InstanceInfo;
}

describe("external coding agent icons and model isolation", () => {
  it("renders dedicated official brand icon avatars for all 5 external coding agents", () => {
    for (const agent of EXTERNAL_CODING_AGENTS) {
      const html = renderToStaticMarkup(
        createElement(BotAvatar, {
          bot: {
            name: agent.name,
            color: agent.defaultColor,
            modelSelection: { instanceId: agent.instanceId },
          },
          size: 36,
          animated: false,
        }),
      );
      expect(html).toContain(`data-coding-agent-avatar="${agent.id}"`);
      expect(html).toContain("<svg");
    }

    const zcodeMark = renderToStaticMarkup(createElement(ProviderMark, { driverKind: "zcodeAgent", size: 16 }));
    expect(zcodeMark).toContain("<svg");
  });

  it("hides redundant corner engine badge for coding agent bots whose avatar is already the brand icon", () => {
    const instances = [
      makeInstance("donebot", "donebot"),
      makeInstance("coding-claude", "claudeAgent"),
    ];
    const hidden = renderToStaticMarkup(
      createElement(BotModelBadge, {
        bot: { modelSelection: { instanceId: "coding-claude", model: "m1" } },
        instances,
        avatarSize: 36,
      }),
    );
    expect(hidden).toBe("");

    const shown = renderToStaticMarkup(
      createElement(BotModelBadge, {
        bot: { modelSelection: { instanceId: "donebot", model: "m1" } },
        instances,
        avatarSize: 36,
      }),
    );
    expect(shown).toContain("model-badge");
  });

  it("isolates model picker instances between DoneBot gateway bots and external coding agent bots", () => {
    const instances = [
      makeInstance("donebot", "donebot"),
      makeInstance("coding-claude", "claudeAgent"),
      makeInstance("coding-codex", "codex"),
      makeInstance("coding-zcode", "zcodeAgent"),
    ];

    expect(configuredModelInstances(instances, "donebot").map((i) => i.instanceId)).toEqual(["donebot"]);
    expect(configuredModelInstances(instances, "coding-claude").map((i) => i.instanceId)).toEqual(["coding-claude"]);
    expect(configuredModelInstances(instances, "coding-zcode").map((i) => i.instanceId)).toEqual(["coding-zcode"]);
  });
});

describe("CodingAgentsDialog already-added state", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    if (root) {
      await act(async () => { root!.unmount(); });
      root = null;
    }
    container?.remove();
    container = null;
    dialogFixture.api.mockReset();
    dialogFixture.dispatch.mockReset();
  });

  it("hides add-as-bot controls for already-added agents while keeping them for unadded ready agents", async () => {
    const baseAgent = (overrides: Partial<ExternalCodingAgentStatus>): ExternalCodingAgentStatus => ({
      id: "codex",
      instanceId: "coding-codex",
      driverKind: "codex",
      name: "Codex",
      displayName: "Codex",
      vendor: "OpenAI",
      tagline: "OpenAI 官方本地编程 Agent",
      docsUrl: "https://example.invalid",
      loginGuide: "",
      installed: true,
      authenticated: true,
      source: "desktop",
      desktopAppDetected: true,
      cliPath: "/usr/local/bin/codex",
      version: "1.0.0",
      account: null,
      reason: null,
      supportsManagedInstall: false,
      supportsInAppAuth: false,
      models: { default: "auto", options: [{ id: "auto", label: "Auto" }] },
      bots: [],
      ...overrides,
    });

    dialogFixture.api.mockResolvedValue({
      agents: [
        baseAgent({ id: "codex", name: "Codex", displayName: "Codex", bots: [] }),
        baseAgent({
          id: "antigravity",
          instanceId: "coding-antigravity",
          driverKind: "antigravityAgent",
          name: "Antigravity",
          displayName: "Antigravity",
          vendor: "Google",
          bots: [{ id: "bot-ag", name: "Antigravity" }],
        }),
      ],
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(createElement(CodingAgentsDialog, { open: true, onClose: () => {} }));
    });
    await act(async () => { await Promise.resolve(); });

    const codexCard = container.querySelector('[data-coding-agent-card="codex"]')!;
    const agCard = container.querySelector('[data-coding-agent-card="antigravity"]')!;
    expect(codexCard.textContent).toContain("添加为 Bot");
    expect(codexCard.textContent).toContain("绑定项目目录");

    expect(agCard.textContent).not.toContain("添加为 Bot");
    expect(agCard.textContent).not.toContain("绑定项目目录");
    expect(agCard.textContent).toContain("进入对话");
    expect(agCard.textContent).toContain("已添加");
  });
});
