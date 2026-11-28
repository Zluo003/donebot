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
import { DoneBotOrgWorkflowStore } from "./opc-org-workflow.ts";
import { createDoneBotAccountRoutes } from "./routes.ts";

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
  const sections: string[] = [...new Set(initialBots.map(b => b.section?.trim()).filter((s): s is string => Boolean(s)))];
  let seq = 10;
  return {
    get bots() { return bots; },
    get groups() { return []; },
    get sections() { return sections; },
    bot(id: string) { return bots.find(b => b.id === id); },
    deleteBot(id: string) {
      const idx = bots.findIndex(b => b.id === id);
      if (idx >= 0) bots.splice(idx, 1);
    },
    createBot(input: Partial<BotRecord>) {
      const cleanSection = input.section?.trim() || undefined;
      if (cleanSection && !sections.includes(cleanSection)) sections.push(cleanSection);
      const created = makeBot({
        ...input,
        section: cleanSection,
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
    setChiefOfStaff(id: string, section?: string | null) {
      const selected = bots.find(b => b.id === id);
      if (!selected) return;
      const scope = selected.section?.trim() || (section?.trim() ?? "");
      for (const candidate of bots) {
        if ((candidate.section?.trim() || "") !== scope) continue;
        candidate.chiefOfStaff = candidate.id === id;
      }
    },
    addSection(name?: string) {
      const clean = name?.trim();
      if (clean && !sections.includes(clean)) sections.push(clean);
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

    let capturedInstalledFiles: Array<{ path: string; content: string }> = [];
    const packageImportDeps = (): PackageImportDeps => ({
      store,
      routines: { create: vi.fn(), remove: vi.fn() },
      skills: {
        install: (botId, _source, files) => {
          capturedInstalledFiles = files.map(f => ({ path: f.path, content: String(f.content) }));
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
        { name: "xhs-hooks", description: "标题钩子", source: "local", enabled: true, files: ["references/hooks.md", "scripts/score.py"] } as never,
        { name: "private-skill", description: "不公开", source: "local", enabled: true } as never,
      ],
      collectTeamSkills: (_bots, selection) => {
        const chosen = Array.isArray(selection) ? selection : ["xhs-hooks", "private-skill"];
        const map = new Map<string, Array<{ name: string; description: string; instructions: string; source: string; files?: Array<{ path: string; content: string }> }>>();
        map.set(bot.id, chosen.map(name => ({
          name: String(name),
          description: "技能说明",
          instructions: `---\nname: ${name}\ndescription: 技能说明\n---\n按步骤执行高质量输出`,
          source: "local",
          ...(name === "xhs-hooks"
            ? {
                files: [
                  { path: "references/hooks.md", content: "# Hooks\n先抛痛点。\n" },
                  { path: "scripts/score.py", content: "print('score=95')\n" },
                ],
              }
            : {}),
        })));
        return { ok: true, all: false, skillsByBot: map, skipped: [], available: ["xhs-hooks", "private-skill"] };
      },
      defaultSelection: async () => ({ instanceId: "donebot", model: "gpt-5.4" }),
      packageImportDeps,
      broadcast: frame => broadcasts.push(frame),
      publicBot: b => b,
    });

    // 0. Local bots listing exposes skill support file paths
    const localList = await callRoute(handler, "GET", "/api/donebot/market/local-bots");
    expect(localList.status).toBe(200);
    const listedBots = (localList.payload as { bots: Array<{ skills: Array<{ name: string; files?: string[] }> }> }).bots;
    expect(listedBots[0]?.skills.find(s => s.name === "xhs-hooks")?.files).toEqual(["references/hooks.md", "scripts/score.py"]);

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
    const publishedSkill = (capturedPublishBody!.skills as Array<{ name: string; files?: Array<{ path: string; content: string }> }>)[0]!;
    expect(publishedSkill.name).toBe("xhs-hooks");
    expect(publishedSkill.files?.map(f => f.path)).toEqual(["references/hooks.md", "scripts/score.py"]);
    const pkgJson = JSON.stringify(capturedPublishBody!.package);
    expect(pkgJson).not.toContain("MEMORY.md");
    expect(pkgJson).not.toContain("private-skill");

    // 2. Install from marketplace restores SKILL.md AND support files
    const inst = await callRoute(handler, "POST", `/api/donebot/market/bots/${listingId}/install`, {});
    expect(inst.status, JSON.stringify(inst.payload)).toBe(200);
    const instPayload = inst.payload as { ok: boolean; bot_id: string; enabled_skills: string[] };
    expect(instPayload.ok).toBe(true);
    expect(instPayload.enabled_skills).toEqual(["xhs-hooks"]);
    expect(capturedInstalledFiles.map(f => f.path)).toEqual(["SKILL.md", "references/hooks.md", "scripts/score.py"]);
    expect(installedSkillStates.get(`${instPayload.bot_id}:xhs-hooks`)).toBe(true);
    expect(marketInstalls.getActiveToken(instPayload.bot_id)).toBe(installToken);
    expect(broadcasts.some(b => (b as { kind?: string }).kind === "bot")).toBe(true);

    // Non-market path passes through
    const pass = await callRoute(handler, "GET", "/api/other/path");
    expect(pass.result).toBe(PASS);
  });

  it("account routes pass through POST /api/donebot/market/* without consuming the request body stream", async () => {
    const accountHandler = createDoneBotAccountRoutes(mockGateway(vi.fn() as unknown as typeof fetch));
    const readBody = vi.fn(async () => { throw new Error("readBody must not be called by account routes for market endpoints"); });
    const res = {
      headersSent: false,
      setHeader() {},
      destroy() {},
    } as unknown as ServerResponse;
    for (const path of [
      "/api/donebot/market/publish",
      "/api/donebot/market/bots/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/install",
      "/api/donebot/market/creator/transfer",
      "/api/donebot/market/creator/withdrawals",
    ]) {
      const result = await accountHandler({
        req: {} as IncomingMessage,
        res,
        url: new URL(`http://127.0.0.1${path}`),
        path,
        method: "POST",
        auth: { kind: "loopback", scopes: ["admin"] },
        json() {},
        readBody,
      } as never);
      expect(result).toBe(PASS);
    }
    expect(readBody).not.toHaveBeenCalled();
  });

  it("uses /v1/donebot/runtime/market with installation credential in Cloud mode and blocks payout mutations", async () => {
    const calls: Array<{ url: string; auth: string | null; install: string | null }> = [];
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        auth: headers.get("authorization"),
        install: headers.get("X-DoneBot-Installation"),
      });
      return new Response(JSON.stringify({ code: 0, data: { items: [], total: 0, page: 1, page_size: 20 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const controllers = new Set<AbortController>();
    const cloudGateway = {
      collabIdentity: async () => ({
        account_id: "42",
        installation_id: "inst-cloud-1",
        device_name: "cloud",
        email: "creator@example.com",
      }),
      account: async () => ({ balance_cents: 0, concurrency: 5 }),
      collabCtx: () => ({
        origin: "https://donebot.cn",
        fetcher,
        controllers,
        epoch: () => 1,
        checkEpoch: () => {},
        validSession: async () => ({
          mode: "installation" as const,
          accessToken: "",
          credential: "sk-donebot-cloud-cred",
          installationId: "inst-cloud-1",
          expiresAt: Date.now() + 3600_000,
          user: { id: "42", email: "creator@example.com" },
        }),
        readGatewayJson: async (res: Response) => res.json(),
      }),
    } as unknown as DoneBotGateway;

    const store = makeStore([makeBot()]);
    const handler = createDoneBotMarketRoutes({
      gateway: cloudGateway,
      store,
      marketInstalls: new DoneBotMarketInstallStore(tempFile("cloud-installs.json")),
      listBotSkills: () => [],
      collectTeamSkills: () => ({ ok: true, all: true, skillsByBot: new Map(), skipped: [], available: [] }),
      defaultSelection: async () => ({ instanceId: "donebot", model: "gpt-5.4" }),
      packageImportDeps: () => ({}) as unknown as PackageImportDeps,
      broadcast: () => {},
      publicBot: (b: BotRecord) => b,
    });

    const browse = await callRoute(handler, "GET", "/api/donebot/market/bots");
    expect(browse.status, JSON.stringify(browse.payload)).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://donebot.cn/v1/donebot/runtime/market/bots");
    expect(calls[0]!.auth).toBe("Bearer sk-donebot-cloud-cred");
    expect(calls[0]!.install).toBe("inst-cloud-1");

    const transfer = await callRoute(handler, "POST", "/api/donebot/market/creator/transfer", { amount: 10 });
    expect(transfer.status).toBe(403);
    const withdraw = await callRoute(handler, "POST", "/api/donebot/market/creator/withdrawals", {
      amount: 100,
      alipay_account: "test@example.com",
      alipay_real_name: "测试",
    });
    expect(withdraw.status).toBe(403);
    // Payout mutations must be rejected locally without hitting the gateway.
    expect(calls).toHaveLength(1);
  });

  it("publishes a department pack to Bot Market (rejecting external coding agents) and strips attribution token on self-install", async () => {
    const editor = makeBot({
      id: "bot-editor",
      name: "主编",
      section: "编辑部",
      chiefOfStaff: true,
      soul: "你是编辑部主编，负责制定每周选题规划、把关文章结构质量并统筹撰稿交付给老板审阅。",
    });
    const writer = makeBot({
      id: "bot-writer",
      name: "写手",
      section: "编辑部",
      soul: "你是编辑部主笔写手，根据主编给定的选题提纲撰写通顺清晰的中文成稿并标注配图建议。",
    });
    const codingBot = makeBot({
      id: "bot-coding",
      name: "码匠",
      section: "研发部",
      modelSelection: { instanceId: "coding-antigravity", model: "gemini-3.8-flash" },
      soul: "你是本机编程代理，负责阅读代码库并执行终端测试与修复。",
    });

    const store = makeStore([editor, writer, codingBot]);
    const marketInstalls = new DoneBotMarketInstallStore(tempFile("dept-installs.json"));
    const listingId = "22222222-2222-4222-8222-222222222222";
    let capturedPublishBody: Record<string, unknown> | null = null;

    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/donebot/market/bots") && init?.method === "POST") {
        capturedPublishBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          code: 0,
          data: {
            id: listingId,
            listing_type: capturedPublishBody.listing_type,
            name: capturedPublishBody.name,
            status: "pending_review",
            latest_version: 1,
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith(`/api/v1/donebot/market/bots/${listingId}/install`) && init?.method === "POST") {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            install_id: "self-inst-1",
            listing_id: listingId,
            listing_type: "studio",
            release_id: "rel-self-1",
            version: 1,
            name: "内容编辑部",
            install_token: "self_signed_token_that_must_not_be_stored",
            self_install: true,
            expires_at: new Date(Date.now() + 86400_000).toISOString(),
            package: capturedPublishBody!.package,
            skills: [],
            soul_text: String(capturedPublishBody!.soul_text ?? ""),
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/v1/donebot/market/creator/daily-summary")) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            items: [{
              date: "2026-11-23",
              installed_count: 12,
              new_installs: 3,
              llm_tokens: 192000,
              llm_calls: 24,
              media_count: 5,
              image_count: 3,
              video_count: 1,
              music_count: 1,
              base_cost: 18.4,
              reward_amount: 0.85,
              status: "frozen",
            }],
            total: 1,
            page: 1,
            page_size: 30,
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    const packageImportDeps = (): PackageImportDeps => ({
      store,
      routines: { create: vi.fn(), remove: vi.fn() },
      skills: {
        install: () => ({ name: "ok", description: "", source: "package", enabled: false }) as never,
        setEnabled: () => ({ name: "ok", description: "", source: "package", enabled: true }) as never,
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
      listBotSkills: () => [],
      collectTeamSkills: () => ({ ok: true, all: true, skillsByBot: new Map(), skipped: [], available: [] }),
      defaultSelection: async () => ({ instanceId: "donebot", model: "gpt-5.4" }),
      packageImportDeps,
      broadcast: () => {},
      publicBot: (b: BotRecord) => b,
      readSectionBrief: (team) => (team === "编辑部" ? "所有稿件坚持原创与客观事实，禁止夸大宣传。" : undefined),
      listRoutines: () => [],
    });

    // 1. Department with external coding agent is refused clearly.
    const refused = await callRoute(handler, "POST", "/api/donebot/market/publish-department", {
      team: "研发部",
      category_id: 2,
      name: "研发部",
      tagline: "研发编程自动化部门",
    });
    expect(refused.status).toBe(403);
    expect(String((refused.payload as { error: string }).error)).toContain("码匠");

    // 2. Clean multi-bot department publishes as studio pack with team brief & stripped private memory.
    const pub = await callRoute(handler, "POST", "/api/donebot/market/publish-department", {
      team: "编辑部",
      category_id: 2,
      name: "内容编辑部",
      tagline: "主编与写手协同完成每日选题与高质量成稿",
      description: "内置部门主 Bot 与共享写作规范。",
    });
    expect(pub.status, JSON.stringify(pub.payload)).toBe(200);
    expect(capturedPublishBody).not.toBeNull();
    expect(capturedPublishBody!.listing_type).toBe("studio");
    expect(capturedPublishBody!.bots_summary).toHaveLength(2);
    expect(String(capturedPublishBody!.soul_text)).toContain("所有稿件坚持原创与客观事实");
    const exportedPkg = capturedPublishBody!.package as { package: { team?: { brief?: string } } };
    expect(exportedPkg.package.team?.brief).toBe("所有稿件坚持原创与客观事实，禁止夸大宣传。");

    // 3. Self-install stores empty installToken so self-usage never sends attribution header or accrues rebates.
    const inst = await callRoute(handler, "POST", `/api/donebot/market/bots/${listingId}/install`, {});
    expect(inst.status, JSON.stringify(inst.payload)).toBe(200);
    const botIds = (inst.payload as { bot_ids: string[] }).bot_ids;
    expect(botIds).toHaveLength(2);
    for (const id of botIds) {
      expect(marketInstalls.getActiveToken(id)).toBeUndefined();
    }

    // 4. Creator daily summary route proxies rolled-up previous-day metrics cleanly.
    const daily = await callRoute(handler, "GET", "/api/donebot/market/creator/daily-summary?page=1&page_size=30");
    expect(daily.status).toBe(200);
    const dailyData = daily.payload as { items: Array<{ date: string; installed_count: number; llm_tokens: number; media_count: number; reward_amount: number }>; total: number };
    expect(dailyData.total).toBe(1);
    expect(dailyData.items[0]).toEqual(expect.objectContaining({
      date: "2026-11-23",
      installed_count: 12,
      llm_tokens: 192000,
      media_count: 5,
      reward_amount: 0.85,
    }));
  });

  it("rewrites local filesystem skill sources to portable local:<name> while preserving all side files across publish and install", async () => {
    const listingId = "66666666-6666-4666-8666-666666666666";
    const bot = makeBot({
      id: "writer-1",
      name: "砚舟",
      section: "创作部",
      soul: "你是独立的中文作家，擅长长篇小说、短篇小说、故事与散文随笔，写作自然凝练并兼顾人物动机与长篇伏笔连续性。",
    });
    const store = makeStore([bot]);
    const marketInstalls = new DoneBotMarketInstallStore(tempFile("bot-market-local-skill.json"));
    const capturedBodies: Array<Record<string, unknown>> = [];

    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/donebot/market/bots") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        capturedBodies.push(body);
        return new Response(JSON.stringify({
          code: 0,
          data: {
            id: listingId,
            listing_type: body.listing_type,
            name: body.name,
            status: "pending_review",
            latest_version: 1,
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith(`/api/v1/donebot/market/bots/${listingId}/install`) && init?.method === "POST") {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            install_id: "inst-local-1",
            listing_id: listingId,
            listing_type: "bot",
            release_id: "rel-local-1",
            version: 1,
            name: "小说写作",
            install_token: "",
            self_install: true,
            expires_at: new Date(Date.now() + 86400_000).toISOString(),
            package: capturedBodies[0]!.package,
            skills: capturedBodies[0]!.skills,
            soul_text: String(capturedBodies[0]!.soul_text ?? ""),
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    const skillsByBot = new Map([
      [bot.id, [
        {
          name: "novel-writing",
          description: "中文长短篇小说写作指南",
          source: "/Users/dev/skills/novel-writing",
          instructions: "---\nname: novel-writing\ndescription: 中文长短篇小说写作指南\n---\n\n# 写作规范\n",
          files: [
            { path: "references/style/pacing.md", content: "# 节奏控制\n" },
            { path: "references/outline.md", content: "# 大纲模板\n" },
          ],
          enabled: true,
        },
        {
          name: "win-local",
          description: "Windows 本地技能",
          source: "C:\\Users\\dev\\skills\\win-local",
          instructions: "---\nname: win-local\ndescription: Windows 本地技能\n---\n\n# Win\n",
          enabled: true,
        },
        {
          name: "remote-ref",
          description: "远端技能",
          source: "https://github.com/example/skills/remote-ref",
          instructions: "---\nname: remote-ref\ndescription: 远端技能\n---\n\n# Remote\n",
          enabled: true,
        },
      ]],
    ]);

    const installedSkills: Array<{ source: string; files: Array<{ path: string; content: string }> }> = [];
    const packageImportDeps = (): PackageImportDeps => ({
      store,
      routines: { create: vi.fn(), remove: vi.fn() },
      skills: {
        install: (_botId, source, files) => {
          installedSkills.push({ source, files });
          return { name: source.replace(/^local:/, ""), description: "", source, enabled: false } as never;
        },
        setEnabled: (_botId, name) => ({ name, description: "", source: "local", enabled: true }) as never,
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
      listBotSkills: () => [],
      collectTeamSkills: () => ({ ok: true, all: true, skillsByBot, skipped: [], available: ["novel-writing", "win-local", "remote-ref"] }),
      defaultSelection: async () => ({ instanceId: "donebot", model: "gpt-5.4" }),
      packageImportDeps,
      broadcast: () => {},
      publicBot: (b: BotRecord) => b,
    });

    const single = await callRoute(handler, "POST", "/api/donebot/market/publish", {
      listing_type: "bot",
      bot_id: bot.id,
      category_id: 1,
      name: "小说写作",
      tagline: "中文小说与短文作家",
      skill_names: ["novel-writing", "win-local", "remote-ref"],
    });
    expect(single.status, JSON.stringify(single.payload)).toBe(200);

    const dept = await callRoute(handler, "POST", "/api/donebot/market/publish-department", {
      team: "创作部",
      category_id: 1,
      name: "创作部",
      tagline: "中文小说与短文创作部门",
      skill_names: ["novel-writing", "win-local", "remote-ref"],
    });
    expect(dept.status, JSON.stringify(dept.payload)).toBe(200);
    expect(capturedBodies).toHaveLength(2);

    for (const published of capturedBodies) {
      const pkg = published.package as { package: { skills?: { entries: Array<{ name: string; source?: string; files?: Array<{ path: string }> }> } } };
      const entries = pkg.package.skills?.entries ?? [];
      const localEntry = entries.find((e) => e.name === "novel-writing");
      const winEntry = entries.find((e) => e.name === "win-local");
      const remoteEntry = entries.find((e) => e.name === "remote-ref");
      expect(localEntry?.source).toBe("local:novel-writing");
      expect(localEntry?.files?.map((f) => f.path)).toEqual(["references/style/pacing.md", "references/outline.md"]);
      expect(winEntry?.source).toBe("local:win-local");
      expect(remoteEntry?.source).toBe("https://github.com/example/skills/remote-ref");

      const marketSkills = published.skills as Array<{ name: string; files?: Array<{ path: string }> }>;
      expect(marketSkills.find((s) => s.name === "novel-writing")?.files?.map((f) => f.path)).toEqual([
        "references/style/pacing.md",
        "references/outline.md",
      ]);
    }

    const inst = await callRoute(handler, "POST", `/api/donebot/market/bots/${listingId}/install`, {});
    expect(inst.status, JSON.stringify(inst.payload)).toBe(200);
    const novelInstalled = installedSkills.find((s) => s.source === "local:novel-writing");
    expect(novelInstalled).toBeDefined();
    expect(novelInstalled!.files.map((f) => f.path)).toEqual([
      "SKILL.md",
      "references/style/pacing.md",
      "references/outline.md",
    ]);
  });

  it("installs a single market bot directly into General (under the System Coordinator) without creating a named department or displacing the coordinator, while studio packs keep their department", async () => {
    const chief = makeBot({
      id: "bot-chief",
      name: "多宝",
      chiefOfStaff: true,
      section: undefined,
      soul: "你是全局唯一的总协调机器人，负责通用部门与跨部门任务统筹。",
    });
    const sourceLead = makeBot({
      id: "bot-source-lead",
      name: "抖音猎手",
      chiefOfStaff: true,
      section: "增长部",
      soul: "你是抖音精准获客与短视频增长专家，负责拆解选题与评论区线索跟进。",
    });
    const deptPeer = makeBot({
      id: "bot-dept-peer",
      name: "剪辑助手",
      section: "增长部",
      soul: "你是短视频后期剪辑与字幕排版专家，负责将文案脚本高效落地成片。",
    });
    const store = makeStore([chief, sourceLead, deptPeer]);
    const marketInstalls = new DoneBotMarketInstallStore(tempFile("single-vs-studio-installs.json"));
    const orgStore = new DoneBotOrgWorkflowStore(tempFile("single-vs-studio-org.json"));
    const singleListingId = "77777777-7777-4777-8777-777777777777";
    const studioListingId = "88888888-8888-4888-8888-888888888888";
    const publishedPackages = new Map<string, Record<string, unknown>>();

    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/donebot/market/bots") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const id = body.listing_type === "studio" ? studioListingId : singleListingId;
        publishedPackages.set(id, body);
        return Response.json({
          code: 0,
          data: { id, listing_type: body.listing_type, name: body.name, status: "published", latest_version: 1 },
        });
      }
      if (url.endsWith(`/api/v1/donebot/market/bots/${singleListingId}/install`) && init?.method === "POST") {
        const rawPkg = structuredClone(publishedPackages.get(singleListingId)!.package) as {
          package: { team?: { name: string; brief?: string; leader?: string }; agents: Array<{ key: string }> };
        };
        // Simulate an older market listing whose exported single-bot package carried team.brief, team.leader, and blueprint.
        rawPkg.package.team = {
          name: "抖音猎手",
          brief: "旧包残留的部门说明不应写入通用部门或新建部门",
          leader: rawPkg.package.agents[0]!.key,
        };
        return Response.json({
          code: 0,
          data: {
            install_id: "inst-single-1",
            listing_id: singleListingId,
            listing_type: "bot",
            release_id: "rel-single-1",
            version: 1,
            name: "抖音猎手",
            install_token: "v1.single.token",
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            package: {
              ...rawPkg,
              donebotOrgBlueprint: {
                version: 1,
                enforcementMode: "enforced",
                allowChiefCrossDispatch: true,
                entries: [{ slotIndex: 0, reportsToSlot: null }],
              },
            },
            skills: [],
            soul_text: String(publishedPackages.get(singleListingId)!.soul_text ?? ""),
          },
        });
      }
      if (url.endsWith(`/api/v1/donebot/market/bots/${studioListingId}/install`) && init?.method === "POST") {
        return Response.json({
          code: 0,
          data: {
            install_id: "inst-studio-1",
            listing_id: studioListingId,
            listing_type: "studio",
            release_id: "rel-studio-1",
            version: 1,
            name: "增长突击部",
            install_token: "v1.studio.token",
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            package: publishedPackages.get(studioListingId)!.package,
            skills: [],
            soul_text: String(publishedPackages.get(studioListingId)!.soul_text ?? ""),
          },
        });
      }
      return Response.json({ code: 0, data: {} });
    }) as unknown as typeof fetch;

    const writeBrief = vi.fn();
    const broadcasts: Array<{ kind: string }> = [];
    const packageImportDeps = (): PackageImportDeps => ({
      store,
      routines: { create: vi.fn(), remove: vi.fn() },
      skills: {
        install: () => ({ name: "ok", description: "", source: "package", enabled: false }) as never,
        setEnabled: () => ({ name: "ok", description: "", source: "package", enabled: true }) as never,
      },
      memory: { writeIndex: vi.fn(), writeTopic: vi.fn() },
      mcp: { servers: () => ({}), refusal: () => undefined, persist: vi.fn() },
      sections: { writeBrief },
      images: { save: () => "/img.png" },
      defaultSelection: () => ({ instanceId: "donebot", model: "gpt-5.4" }),
    });

    const handler = createDoneBotMarketRoutes({
      gateway: mockGateway(fetcher),
      store,
      marketInstalls,
      listBotSkills: () => [],
      collectTeamSkills: () => ({ ok: true, all: true, skillsByBot: new Map(), skipped: [], available: [] }),
      defaultSelection: async () => ({ instanceId: "donebot", model: "gpt-5.4" }),
      packageImportDeps,
      broadcast: (frame) => broadcasts.push(frame as { kind: string }),
      publicBot: (b: BotRecord) => b,
      listSections: () => [...store.sections],
      orgStore,
    });

    // 1. Publish a single bot that happens to be a department chief locally -> exported package must not mark leader.
    const pubSingle = await callRoute(handler, "POST", "/api/donebot/market/publish", {
      listing_type: "bot",
      bot_id: sourceLead.id,
      category_id: 1,
      name: "抖音猎手",
      tagline: "精准挖掘抖音行业客户并产出转化话术",
    });
    expect(pubSingle.status, JSON.stringify(pubSingle.payload)).toBe(200);
    const exportedSinglePkg = publishedPackages.get(singleListingId)!.package as { package: { team?: { leader?: string } } };
    expect(exportedSinglePkg.package.team?.leader).toBeUndefined();

    // 2. Install single bot -> must land in General (section undefined), under System Coordinator, with NO new section.
    const sectionsBeforeSingle = [...store.sections];
    const instSingle = await callRoute(handler, "POST", `/api/donebot/market/bots/${singleListingId}/install`, {});
    expect(instSingle.status, JSON.stringify(instSingle.payload)).toBe(200);
    const singleBotId = (instSingle.payload as { bot_id: string }).bot_id;
    const installedSingle = store.bot(singleBotId)!;
    expect(installedSingle.section).toBeUndefined();
    expect(installedSingle.chiefOfStaff).toBeFalsy();
    expect(store.bot(chief.id)!.chiefOfStaff).toBe(true);
    expect(store.sections).toEqual(sectionsBeforeSingle);
    expect(writeBrief).not.toHaveBeenCalled();
    expect(broadcasts.some(b => b.kind === "sections")).toBe(false);
    const orgAfterSingle = orgStore.getOrgChart(store.bots);
    expect(orgAfterSingle.nodes[singleBotId]?.reportsToBotId).toBe(chief.id);
    expect(orgAfterSingle.enforcementMode).toBe("free");

    // 3. Publish & install a multi-bot department pack -> still creates its dedicated department section.
    const pubStudio = await callRoute(handler, "POST", "/api/donebot/market/publish-department", {
      team: "增长部",
      category_id: 1,
      name: "增长突击部",
      tagline: "抖音猎手与剪辑助手协同获客部门",
    });
    expect(pubStudio.status, JSON.stringify(pubStudio.payload)).toBe(200);
    const instStudio = await callRoute(handler, "POST", `/api/donebot/market/bots/${studioListingId}/install`, {});
    expect(instStudio.status, JSON.stringify(instStudio.payload)).toBe(200);
    const studioBotIds = (instStudio.payload as { bot_ids: string[] }).bot_ids;
    expect(studioBotIds).toHaveLength(2);
    const studioSection = store.bot(studioBotIds[0]!)!.section;
    expect(studioSection).toBeTruthy();
    expect(store.bot(studioBotIds[1]!)!.section).toBe(studioSection);
    expect(store.sections).toContain(studioSection!);
    expect(broadcasts.some(b => b.kind === "sections")).toBe(true);
  });
});
