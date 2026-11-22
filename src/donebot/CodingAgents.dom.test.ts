// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EXTERNAL_CODING_AGENTS } from "../../shared/coding-agents";
import { BotAvatar } from "@/components/Avatar";
import { BotModelBadge } from "@/components/BotModelBadge";
import { ProviderMark } from "@/components/ProviderIcons";
import { configuredModelInstances } from "@/lib/engine-rail";
import type { InstanceInfo } from "@/state/store";

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
