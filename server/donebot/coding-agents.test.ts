import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_CODING_AGENT_GROUP_REFUSAL,
  EXTERNAL_CODING_AGENT_SWITCH_REFUSAL,
  isExternalCodingAgentBot,
  isExternalCodingAgentDriver,
} from "../../shared/coding-agents.ts";
import { hasDeepSeekKey } from "../drivers/acp/deepseek.ts";
import type { BotRecord } from "../store.ts";
import {
  buildExternalCodingAgentConfigs,
  createDoneBotCodingAgentRoutes,
  externalCodingAgentDrivers,
  externalCodingAgentMemberRefusal,
  externalCodingAgentSwitchRefusal,
  findClaudeDesktopBinary,
} from "./coding-agents.ts";
import { handleCollabGroupWrite } from "./collab-group-routes.ts";
import { DoneBotGatewayError } from "./gateway.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("external local coding agents", () => {
  it("whitelists exactly the 5 approved coding agent drivers and blocks other 3P LLMs", () => {
    const kinds = externalCodingAgentDrivers().map((driver) => driver.driverKind).sort();
    expect(kinds).toEqual([
      "antigravityAgent",
      "claudeAgent",
      "codex",
      "deepseekAgent",
      "zcodeAgent",
    ]);
    for (const kind of kinds) {
      expect(isExternalCodingAgentDriver(kind)).toBe(true);
    }
    expect(isExternalCodingAgentDriver("openai-compat")).toBe(false);
    expect(isExternalCodingAgentDriver("grok")).toBe(false);
    expect(isExternalCodingAgentDriver("mistral")).toBe(false);
    expect(isExternalCodingAgentDriver("donebot")).toBe(false);

    const configs = buildExternalCodingAgentConfigs({ HOME: makeTempDir("donebot-ca-empty-"), PATH: "" });
    expect(Object.keys(configs).sort()).toEqual([
      "coding-antigravity",
      "coding-claude",
      "coding-codex",
      "coding-deepseek",
      "coding-zcode",
    ]);
  });

  it("discovers highest semver Claude Code binary inside Claude Desktop on macOS", () => {
    const prevSealed = process.env.DONEBOT_TEST_SEALED_PATH;
    delete process.env.DONEBOT_TEST_SEALED_PATH;
    try {
      const home = makeTempDir("donebot-claude-desk-");
      const oldBin = join(home, "Library", "Application Support", "Claude", "claude-code", "2.1.100", "claude.app", "Contents", "MacOS", "claude");
      const newBin = join(home, "Library", "Application Support", "Claude", "claude-code", "2.1.219", "claude.app", "Contents", "MacOS", "claude");
      mkdirSync(join(home, "Library", "Application Support", "Claude", "claude-code", "2.1.100", "claude.app", "Contents", "MacOS"), { recursive: true });
      mkdirSync(join(home, "Library", "Application Support", "Claude", "claude-code", "2.1.219", "claude.app", "Contents", "MacOS"), { recursive: true });
      writeFileSync(oldBin, "#!/bin/sh\n", "utf8");
      writeFileSync(newBin, "#!/bin/sh\n", "utf8");

      const found = findClaudeDesktopBinary({ HOME: home }, "darwin");
      expect(found.desktopAppDetected).toBe(true);
      expect(found.cliPath).toBe(newBin);
    } finally {
      if (prevSealed !== undefined) process.env.DONEBOT_TEST_SEALED_PATH = prevSealed;
    }
  });

  it("recognizes DeepSeek Harness desktop account token in ~/.dsh/.credentials.yaml", () => {
    const dshDir = makeTempDir("donebot-dsh-home-");
    expect(hasDeepSeekKey({ DSH_HOME: dshDir })).toBe(false);

    writeFileSync(
      join(dshDir, ".credentials.yaml"),
      [
        "version: 1",
        "records:",
        "  deepseek-account-platform/default:",
        "    kind: token",
        "    payload:",
        "      token: desktop_session_token_example",
      ].join("\n"),
      "utf8",
    );
    expect(hasDeepSeekKey({ DSH_HOME: dshDir })).toBe(true);
  });

  it("blocks external coding agent bots from local groups, engine switching, and collab group/team chats", async () => {
    const normalBot = {
      id: "bot-normal",
      name: "多宝",
      color: "blue",
      modelSelection: { instanceId: "donebot", model: "gpt-5.4" },
    } as unknown as BotRecord;
    const claudeBot = {
      id: "bot-claude",
      name: "Claude Code",
      color: "orange",
      modelSelection: { instanceId: "coding-claude", model: "claude-sonnet-4-6" },
    } as unknown as BotRecord;

    expect(isExternalCodingAgentBot(normalBot)).toBe(false);
    expect(isExternalCodingAgentBot(claudeBot)).toBe(true);

    const bots = new Map([
      [normalBot.id, normalBot],
      [claudeBot.id, claudeBot],
    ]);
    expect(externalCodingAgentMemberRefusal([normalBot.id], (id) => bots.get(id))).toBeUndefined();
    expect(externalCodingAgentMemberRefusal([normalBot.id, claudeBot.id], (id) => bots.get(id))).toBe(
      EXTERNAL_CODING_AGENT_GROUP_REFUSAL,
    );

    expect(
      externalCodingAgentSwitchRefusal(
        { instanceId: "coding-claude", model: "claude-sonnet-4-6" },
        { instanceId: "coding-claude", model: "claude-opus-4-6" },
      ),
    ).toBeUndefined();
    expect(
      externalCodingAgentSwitchRefusal(
        { instanceId: "donebot", model: "gpt-5.4" },
        { instanceId: "coding-claude", model: "claude-sonnet-4-6" },
      ),
    ).toBe(EXTERNAL_CODING_AGENT_SWITCH_REFUSAL);
    expect(
      externalCodingAgentSwitchRefusal(
        { instanceId: "coding-zcode", model: "GLM-5.3" },
        { instanceId: "donebot", model: "gpt-5.4" },
      ),
    ).toBe(EXTERNAL_CODING_AGENT_SWITCH_REFUSAL);

    const groupUuid = "11111111-1111-4111-8111-111111111111";
    for (const scope of ["group", "team"] as const) {
      await expect(
        handleCollabGroupWrite({
          method: "POST",
          reqPath: `/api/donebot/collab/chats/${scope}/${groupUuid}/bots`,
          body: { bot_id: claudeBot.id, allow_all_members: false, allowed_user_ids: [] },
          gateway: {} as never,
          store: { bot: (id) => bots.get(id) ?? null },
          activateBotWorker: () => {},
          res: {} as ServerResponse,
          json: () => {},
        }),
      ).rejects.toMatchObject({
        status: 403,
        message: EXTERNAL_CODING_AGENT_GROUP_REFUSAL,
      } satisfies Partial<DoneBotGatewayError>);
    }
  });

  it("creates local coding agent bots via /api/donebot/coding-agents/:id/bot and blocks when disabled", async () => {
    const createdBots: BotRecord[] = [];
    const broadcast = vi.fn();
    const res = { setHeader: vi.fn() } as unknown as ServerResponse;
    const responses: Array<{ status: number; value: unknown }> = [];
    const json = (_r: ServerResponse, status: number, value: unknown) => {
      responses.push({ status, value });
    };

    const handler = createDoneBotCodingAgentRoutes({
      enabled: true,
      store: {
        get bots() { return createdBots; },
        bot: (id) => createdBots.find((b) => b.id === id) ?? null,
        createBot: (profile = {}) => {
          const rec = {
            id: `bot-${createdBots.length + 1}`,
            threadId: `th-${createdBots.length + 1}`,
            name: profile.name ?? "ZCode",
            title: profile.title ?? "",
            description: profile.description ?? "",
            color: profile.color ?? "purple",
            modelSelection: profile.modelSelection ?? { instanceId: "coding-zcode", model: "default" },
            cwd: profile.cwd,
          } as unknown as BotRecord;
          createdBots.push(rec);
          return rec;
        },
        patchBot: (id, patch) => {
          const target = createdBots.find((b) => b.id === id);
          if (!target) return null;
          Object.assign(target, patch);
          return target;
        },
      },
      registry: {
        get: (id) =>
          id === "coding-zcode"
            ? ({
                instanceId: "coding-zcode",
                driverKind: "zcodeAgent",
                displayName: "ZCode",
                enabled: true,
                models: { default: "default", options: [{ id: "default", label: "ZCode 默认" }] },
                snapshot: async () => ({ state: "available", authenticated: true, version: "0.16.9" }),
              } as never)
            : null,
        cliTarget: () => ({ driverKind: "zcodeAgent", cli: "zcode" }),
        refreshModels: async () => true,
        installRuntime: async () => false,
        forgetSnapshots: () => {},
      },
      providerAuthSessions: {
        start: async () => ({ phase: "succeeded", flowId: null, authorizationUrl: null, expiresAt: null }),
        status: async () => ({ phase: "succeeded", flowId: null, authorizationUrl: null, expiresAt: null }),
        cancel: async () => {},
      },
      providerConfigs: () => ({
        "coding-zcode": { driver: "zcodeAgent", displayName: "ZCode", config: { cli: "zcode" } },
      }),
      engineLaunches: (configs) => configs,
      reloadProviders: async () => {},
      publicBot: (bot) => bot,
      broadcast,
      configStatus: () => ({}),
    });

    await handler({
      req: {} as IncomingMessage,
      res,
      url: new URL("http://localhost/api/donebot/coding-agents/zcode/bot"),
      path: "/api/donebot/coding-agents/zcode/bot",
      method: "POST",
      auth: { kind: "loopback", scopes: ["admin"] },
      json,
      readBody: async () => ({ name: "我的 ZCode" }),
    });

    expect(responses[0]?.status).toBe(201);
    expect(createdBots).toHaveLength(1);
    expect(createdBots[0]?.name).toBe("我的 ZCode");
    expect(createdBots[0]?.modelSelection).toEqual({ instanceId: "coding-zcode", model: "default" });
    expect(createdBots[0]?.computer).toBe("local");
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ kind: "bot.created" }));

    const disabledResponses: Array<{ status: number; value: unknown }> = [];
    const disabledHandler = createDoneBotCodingAgentRoutes({
      enabled: false,
      store: { bots: [], bot: () => null, createBot: () => { throw new Error(); }, patchBot: () => null },
      registry: { get: () => null, cliTarget: () => null, refreshModels: async () => true, installRuntime: async () => false, forgetSnapshots: () => {} },
      providerAuthSessions: { start: async () => ({ phase: "succeeded", flowId: null, authorizationUrl: null, expiresAt: null }), status: async () => ({ phase: "succeeded", flowId: null, authorizationUrl: null, expiresAt: null }), cancel: async () => {} },
      providerConfigs: () => ({}),
      engineLaunches: () => ({}),
      reloadProviders: async () => {},
      publicBot: (bot) => bot,
      broadcast: () => {},
      configStatus: () => ({}),
    });

    await disabledHandler({
      req: {} as IncomingMessage,
      res,
      url: new URL("http://localhost/api/donebot/coding-agents"),
      path: "/api/donebot/coding-agents",
      method: "GET",
      auth: { kind: "loopback", scopes: ["admin"] },
      json: (_r, status, value) => { disabledResponses.push({ status, value }); },
      readBody: async () => ({}),
    });
    expect(disabledResponses[0]?.status).toBe(403);
  });
});
