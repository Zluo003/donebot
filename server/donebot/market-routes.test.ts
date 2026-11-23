import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MARKET_INSTALL_HEADER } from "../../shared/donebot-market.ts";
import type { PackageImportDeps } from "../package-import.ts";
import { PASS } from "../routes/table.ts";
import type { BotRecord, Store } from "../store.ts";
import type { DoneBotGateway } from "./gateway.ts";
import {
  attachMarketInstallHeader,
  currentMarketBotId,
  DoneBotMarketInstallStore,
  runWithMarketBot,
} from "./market-installs.ts";
import { createDoneBotMarketRoutes } from "./market-routes.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "donebot-market-test-"));
  tempDirs.push(dir);
  return join(dir, name);
}

function makeBot(overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    id: "bot-1",
    name: "小红书爆款运营官",
    title: "爆款图文与标题专家",
    description: "擅长拆解爆款笔记、生成封面结构与高转化文案",
    color: "orange",
    soul: "你是拥有 8 年经验的小红书爆款内容操盘手。每次创作前先分析目标受众痛点，输出 3 个备选标题和结构化正文。",
    threadId: "thread-1",
    modelSelection: { instanceId: "donebot", model: "gpt-5.4" },
    ...overrides,
  } as BotRecord;
}

function makeStore(initialBots: BotRecord[]): Store {
  const bots = [...initialBots];
  let seq = 10;
  return {
    get bots() { return bots; },
    get groups() { return []; },
    get sections() { return []; },
    bot(id: string) { return bots.find(b => b.id === id); },
    deleteBot(id: string) {
      const idx = bots.findIndex(b => b.id === id);
      if (idx >= 0) bots.splice(idx, 1);
    },
    createBot(input: Partial<BotRecord>) {
      const created = makeBot({
        ...input,
        id: `installed-${++seq}`,
        threadId: `thread-${seq}`,
      });
      bots.push(created);
      return created;
    },
    patchBot(id: string, patch: Partial<BotRecord>) {
      const idx = bots.findIndex(b => b.id === id);
      if (idx < 0) return undefined;
      bots[idx] = { ...bots[idx]!, ...patch };
      return bots[idx];
    },
  } as unknown as Store;
}

function mockGateway(fetcher: typeof fetch): DoneBotGateway {
  const controllers = new Set<AbortController>();
  return {
    collabIdentity: async () => ({
      account_id: "42",
      installation_id: "inst-abc",
      device_name: "MacBook",
      email: "creator@example.com",
    }),
    account: async () => ({ balance_cents: 12000, concurrency: 5 }),
    collabCtx: () => ({
      origin: "https://donebot.cn",
      fetcher,
      controllers,
      epoch: () => 1,
      checkEpoch: () => {},
      validSession: async () => ({
        mode: "account",
        accessToken: "jwt-token",
        credential: "cred-token",
        installationId: "inst-abc",
        expiresAt: Date.now() + 3600_000,
        user: { id: "42", email: "creator@example.com" },
      }),
      readGatewayJson: async (res: Response) => res.json(),
    }),
  } as unknown as DoneBotGateway;
}

async function callRoute(
  handler: ReturnType<typeof createDoneBotMarketRoutes>,
  method: string,
  pathWithQuery: string,
  body?: unknown,
) {
  const url = new URL(`http://127.0.0.1${pathWithQuery}`);
  let status = 0;
  let payload: unknown;
  const headers = new Map<string, string>();
  const res = {
    headersSent: false,
    setHeader(k: string, v: string) { headers.set(k.toLowerCase(), v); },
    destroy() {},
  } as unknown as ServerResponse;
  const result = await handler({
    req: {} as IncomingMessage,
    res,
    url,
    path: url.pathname,
    method,
    auth: { kind: "loopback", scopes: ["admin"] },
    json(_res: ServerResponse, code: number, data: unknown) {
      status = code;
      payload = data;
    },
    readBody: async () => body,
  } as never);
  return { result, status, payload, headers };
}

describe("DoneBotMarketInstallStore and header context", () => {
  it("persists install tokens, expires stale ones, and propagates AsyncLocalStorage botId", () => {
    const file = tempFile("bot-market-installs.json");
    const store = new DoneBotMarketInstallStore(file);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 10_000).toISOString();

    store.set({
      botId: "bot-active",
      installId: "11111111-1111-4111-8111-111111111111",
      listingId: "22222222-2222-4222-8222-222222222222",
      releaseId: "33333333-3333-4333-8333-333333333333",
      version: 1,
      installToken: "v1.eyJ0ZXN0IjoxfQ.sig1234567890abcdef",
      expiresAt: future,
      installedAt: 1000,
    });
    store.set({
      botId: "bot-expired",
      installId: "44444444-4444-4444-8444-444444444444",
      listingId: "55555555-5555-4555-8555-555555555555",
      releaseId: "66666666-6666-4666-8666-666666666666",
      version: 1,
      installToken: "v1.eyJleHAiOjF9.sig0987654321fedcba",
      expiresAt: past,
      installedAt: 1000,
    });

    const reloaded = new DoneBotMarketInstallStore(file);
    expect(reloaded.getActiveToken("bot-active")).toBe("v1.eyJ0ZXN0IjoxfQ.sig1234567890abcdef");
    expect(reloaded.getActiveToken("bot-expired")).toBeUndefined();

    const captured = runWithMarketBot("bot-active", () => {
      const token = reloaded.getActiveToken(currentMarketBotId());
      const reqInit = attachMarketInstallHeader({ method: "POST" }, token);
      return new Headers(reqInit.headers).get(MARKET_INSTALL_HEADER);
    });
    expect(captured).toBe("v1.eyJ0ZXN0IjoxfQ.sig1234567890abcdef");
  });
});

describe("createDoneBotMarketRoutes", () => {
  it("publishes a local bot with SOUL.md + selected SKILL.md (auto-redacted, no memory) and installs with skills enabled by default", async () => {
    const bot = makeBot();
    const store = makeStore([bot]);
    const marketInstalls = new DoneBotMarketInstallStore(tempFile("installs.json"));
    const installedSkillStates = new Map<string, boolean>();
    const broadcasts: unknown[] = [];

    let capturedPublishBody: Record<string, unknown> | null = null;
    const listingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const releaseId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const installId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const installToken = "v1.eyJpIjoiY2NjYyJ9.abcdef0123456789";

    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/api/v1/donebot/market/bots") && init?.method === "POST") {
        capturedPublishBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json({
          code: 0,
          data: {
            id: listingId,
            name: capturedPublishBody.name,
            tagline: capturedPublishBody.tagline,
            category_id: capturedPublishBody.category_id,
            category_name: "内容创作",
            status: "published",
            latest_version: 1,
            published_version: 1,
            skill_count: 1,
            install_count: 0,
          },
        });
      }
      if (url.endsWith(`/api/v1/donebot/market/bots/${listingId}/install`) && init?.method === "POST") {
        expect(new Headers(init.headers).get("X-DoneBot-Installation")).toBe("inst-abc");
        return Response.json({
          code: 0,
          data: {
            install_id: installId,
            listing_id: listingId,
            release_id: releaseId,
            version: 1,
            name: "小红书爆款运营官",
            install_token: installToken,
            expires_at: new Date(Date.now() + 180 * 86_400_000).toISOString(),
            package: capturedPublishBody?.package,
            skills: capturedPublishBody?.skills,
            soul_text: capturedPublishBody?.soul_text,
          },
        });
      }
      return Response.json({ code: 0, data: {} });
    }) as unknown as typeof fetch;

    const packageImportDeps = (): PackageImportDeps => ({
      store,
      routines: { create: vi.fn(), remove: vi.fn() },
      skills: {
        install: (botId, _source, files) => {
          const content = files[0]?.content ?? "";
          const name = /name:\s*([a-z0-9-]+)/.exec(content)?.[1] ?? "xhs-hooks";
          installedSkillStates.set(`${botId}:${name}`, false);
          return { name, description: "标题钩子", source: "package", enabled: false } as never;
        },
        setEnabled: (botId, name, enabled) => {
          installedSkillStates.set(`${botId}:${name}`, enabled);
          return { name, description: "标题钩子", source: "package", enabled } as never;
        },
      },
      memory: { writeIndex: vi.fn(), writeTopic: vi.fn() },
      mcp: { servers: () => ({}), refusal: () => undefined, persist: vi.fn() },
      sections: { writeBrief: vi.fn() },
      images: { save: () => "/img.png" },
      defaultSelection: () => ({ instanceId: "donebot", model: "gpt-5.4" }),
    });

    const handler = createDoneBotMarketRoutes({
      gateway: mockGateway(fetcher),
      store,
      marketInstalls,
      listBotSkills: () => [
        { name: "xhs-hooks", description: "标题钩子", source: "local", enabled: true } as never,
        { name: "private-skill", description: "不公开", source: "local", enabled: true } as never,
      ],
      collectTeamSkills: (_bots, selection) => {
        const chosen = Array.isArray(selection) ? selection : ["xhs-hooks", "private-skill"];
        const map = new Map<string, Array<{ name: string; description: string; instructions: string; source: string }>>();
        map.set(bot.id, chosen.map(name => ({
          name: String(name),
          description: "技能说明",
          instructions: `---\nname: ${name}\ndescription: 技能说明\n---\n按步骤执行高质量输出`,
          source: "local",
        })));
        return { ok: true, all: false, skillsByBot: map, skipped: [], available: ["xhs-hooks", "private-skill"] };
      },
      defaultSelection: async () => ({ instanceId: "donebot", model: "gpt-5.4" }),
      packageImportDeps,
      broadcast: frame => broadcasts.push(frame),
      publicBot: b => b,
    });

    // 1. Publish selecting ONLY xhs-hooks
    const pub = await callRoute(handler, "POST", "/api/donebot/market/publish", {
      bot_id: bot.id,
      category_id: 2,
      name: "小红书爆款运营官",
      tagline: "一键拆解爆款笔记并生成高点击图文结构",
      description: "内置标题钩子 Skill，开箱即用。",
      tags: ["小红书", "文案"],
      sample_prompts: ["帮我写一篇咖啡探店笔记"],
      skill_names: ["xhs-hooks"],
    });
    expect(pub.status, JSON.stringify(pub.payload)).toBe(200);
    expect(capturedPublishBody).not.toBeNull();
    expect(capturedPublishBody!.skills).toHaveLength(1);
    expect((capturedPublishBody!.skills as Array<{ name: string }>)[0]!.name).toBe("xhs-hooks");
    const pkgJson = JSON.stringify(capturedPublishBody!.package);
    expect(pkgJson).not.toContain("MEMORY.md");
    expect(pkgJson).not.toContain("private-skill");

    // 2. Install from marketplace
    const inst = await callRoute(handler, "POST", `/api/donebot/market/bots/${listingId}/install`, {});
    expect(inst.status, JSON.stringify(inst.payload)).toBe(200);
    const instPayload = inst.payload as { ok: boolean; bot_id: string; enabled_skills: string[] };
    expect(instPayload.ok).toBe(true);
    expect(instPayload.enabled_skills).toEqual(["xhs-hooks"]);
    expect(installedSkillStates.get(`${instPayload.bot_id}:xhs-hooks`)).toBe(true);
    expect(marketInstalls.getActiveToken(instPayload.bot_id)).toBe(installToken);
    expect(broadcasts.some(b => (b as { kind?: string }).kind === "bot")).toBe(true);

    // Non-market path passes through
    const pass = await callRoute(handler, "GET", "/api/other/path");
    expect(pass.result).toBe(PASS);
  });
});
