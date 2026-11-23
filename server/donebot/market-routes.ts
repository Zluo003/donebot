import { z } from "zod";
import { EXTERNAL_CODING_AGENT_SHARE_REFUSAL, isExternalCodingAgentBot } from "../../shared/coding-agents.ts";
import type { MarketLocalBotOption, MarketSkillDoc } from "../../shared/donebot-market.ts";
import { parsePackageDocument } from "../bot-package.ts";
import type { ModelSelection } from "../contracts.ts";
import { createTeamPackageExport, TeamExportError, type ExportablePackageSkill, type TeamExportSkip } from "../package-export.ts";
import { importPackageDocument, PackageImportError, type PackageImportDeps } from "../package-import.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import type { SkillListing } from "../skills.ts";
import type { BotRecord, Store } from "../store.ts";
import { DoneBotGatewayError, type DoneBotGateway } from "./gateway.ts";
import { createDoneBotMarketClient } from "./market-gateway.ts";
import type { DoneBotOrgWorkflowStore } from "./opc-org-workflow.ts";
import type { OpcOrgBlueprint } from "../../shared/donebot-opc.ts";
import type { DoneBotMarketInstallStore } from "./market-installs.ts";

const uuidV4 = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

const evalSampleSchema = z.object({
  title: z.string().trim().max(80).optional(),
  prompt: z.string().trim().min(1).max(400),
  output_preview: z.string().trim().min(1).max(1200),
  model: z.string().trim().max(80).optional(),
  latency_ms: z.number().int().nonnegative().optional(),
  verified_at: z.string().trim().max(40).optional(),
}).strict();

const publishSchema = z.object({
  listing_type: z.enum(["bot", "studio"]).default("bot"),
  bot_id: z.string().trim().min(1).max(128).optional(),
  bot_ids: z.array(z.string().trim().min(1).max(128)).min(2).max(8).optional(),
  listing_id: uuidV4.optional(),
  category_id: z.number().int().positive(),
  name: z.string().trim().min(2).max(60),
  tagline: z.string().trim().min(4).max(160),
  description: z.string().trim().max(4000).default(""),
  tags: z.array(z.string().trim().min(1).max(24)).max(6).default([]),
  sample_prompts: z.array(z.string().trim().min(1).max(300)).max(3).default([]),
  skill_names: z.array(z.string().trim().min(1).max(128)).max(90).optional(),
  cost_tier: z.enum(["light", "standard", "heavy"]).default("standard"),
  eval_verified: z.boolean().default(false),
  eval_samples: z.array(evalSampleSchema).max(5).default([]),
  changelog: z.string().trim().max(1000).default(""),
}).strict();

const visibilitySchema = z.object({
  listed: z.boolean(),
}).strict();

const reportSchema = z.object({
  reason_type: z.enum(["token_abuse", "malicious_loop", "data_exfiltration", "illegal_content", "spam_low_quality", "other"]),
  detail: z.string().trim().max(2000).default(""),
}).strict();

const transferSchema = z.object({
  amount: z.number().finite().positive().optional(),
}).strict();

const withdrawSchema = z.object({
  amount: z.number().finite().positive(),
  alipay_account: z.string().trim().min(3).max(120),
  alipay_real_name: z.string().trim().min(2).max(60),
}).strict();

const updateInstallSchema = z.object({
  bot_id: z.string().trim().min(1).max(128).optional(),
}).strict();

export interface DoneBotMarketRouteDeps {
  gateway: DoneBotGateway;
  store: Store;
  marketInstalls: DoneBotMarketInstallStore;
  listBotSkills(botId: string): SkillListing[];
  removeBotSkill?(botId: string, name: string): unknown;
  collectTeamSkills(bots: readonly BotRecord[], selection: unknown):
    | { ok: true; all: boolean; skillsByBot: Map<string, ExportablePackageSkill[]>; skipped: TeamExportSkip[]; available: string[] }
    | { ok: false; status?: number; error: string };
  defaultSelection(): Promise<ModelSelection>;
  packageImportDeps(selection: ModelSelection): PackageImportDeps;
  broadcast(frame: unknown): void;
  publicBot(bot: BotRecord): unknown;
  orgStore?: DoneBotOrgWorkflowStore;
}

function visibleBotIds(store: Store): Set<string> {
  return new Set(store.bots.filter(bot => !bot.hidden).map(bot => bot.id));
}

function enableInstalledSkills(
  importDeps: PackageImportDeps,
  botId: string,
  skillNames: readonly string[],
): string[] {
  const enabled: string[] = [];
  for (const name of skillNames) {
    if (!name) continue;
    const res = importDeps.skills.setEnabled(botId, name, true);
    if (!("error" in res)) enabled.push(name);
  }
  return enabled;
}

export function createDoneBotMarketRoutes(deps: DoneBotMarketRouteDeps): RouteHandler {
  const client = createDoneBotMarketClient(() => deps.gateway.collabCtx());

  return async ({ req, res, url, path: reqPath, method, auth, json, readBody }) => {
    if (!reqPath.startsWith("/api/donebot/market/")) return PASS;
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "仅工作空间所有者可使用 Bot 广场。" });
    res.setHeader("Cache-Control", "no-store");
    try {
      if (process.env.DONEBOT_TEAM_RUNTIME === "1") {
        return json(res, 403, { error: "Bot 广场仅在本机个人空间使用。" });
      }

      if (method === "GET" && reqPath === "/api/donebot/market/categories") {
        return json(res, 200, await client.listCategories());
      }

      if (method === "GET" && reqPath === "/api/donebot/market/local-bots") {
        const bots: MarketLocalBotOption[] = deps.store.bots
          .filter(bot => !bot.hidden && !isExternalCodingAgentBot(bot))
          .map(bot => {
            const soul = (bot.soul ?? "").trim();
            const skills = deps.listBotSkills(bot.id).map(sk => ({
              name: sk.name,
              description: sk.description ?? "",
              enabled: Boolean(sk.enabled),
            }));
            return {
              id: bot.id,
              name: bot.name,
              title: bot.title ?? "",
              description: bot.description ?? "",
              color: bot.color,
              ...(bot.mascotBody ? { mascot_body: bot.mascotBody } : {}),
              ...(bot.mascotFaceColor ? { mascot_face_color: bot.mascotFaceColor } : {}),
              ...(bot.mascotExpression ? { mascot_expression: bot.mascotExpression } : {}),
              soul,
              soul_length: soul.length,
              has_soul: soul.length > 0,
              skills,
            };
          });
        return json(res, 200, { bots });
      }

      if (method === "GET" && reqPath === "/api/donebot/market/bots") {
        const params = new URLSearchParams();
        for (const key of ["category_id", "listing_type", "q", "sort", "page", "page_size"]) {
          const val = url.searchParams.get(key);
          if (val && val.trim()) params.set(key, val.trim());
        }
        const data = await client.listMarketplace(params);
        return json(res, 200, {
          ...data,
          installed_by_listing: deps.marketInstalls.publicByListing(visibleBotIds(deps.store)),
        });
      }

      if (method === "GET" && reqPath === "/api/donebot/market/bots/mine") {
        return json(res, 200, await client.listMine());
      }

      const detailMatch = reqPath.match(/^\/api\/donebot\/market\/bots\/([0-9a-f-]{36})$/);
      if (method === "GET" && detailMatch) {
        const detail = await client.getDetail(detailMatch[1]!);
        const installed = deps.marketInstalls.findByListingId(detailMatch[1]!, visibleBotIds(deps.store));
        return json(res, 200, {
          ...detail,
          ...(installed ? {
            installed_local: {
              bot_id: installed.botId,
              install_id: installed.installId,
              listing_id: installed.listingId,
              release_id: installed.releaseId,
              version: installed.version,
              expires_at: installed.expiresAt,
              installed_at: installed.installedAt,
            },
          } : {}),
        });
      }

      if (method === "GET" && reqPath === "/api/donebot/market/creator/wallet") {
        return json(res, 200, await client.getCreatorWallet());
      }

      if (method === "GET" && reqPath === "/api/donebot/market/creator/ledger") {
        const params = new URLSearchParams();
        for (const key of ["page", "page_size"]) {
          const val = url.searchParams.get(key);
          if (val && /^\d+$/.test(val)) params.set(key, val);
        }
        return json(res, 200, await client.listCreatorLedger(params));
      }

      if (method === "GET" && reqPath === "/api/donebot/market/creator/withdrawals") {
        const params = new URLSearchParams();
        for (const key of ["page", "page_size"]) {
          const val = url.searchParams.get(key);
          if (val && /^\d+$/.test(val)) params.set(key, val);
        }
        return json(res, 200, await client.listCreatorWithdrawals(params));
      }

      if (method !== "POST" && method !== "PATCH") return PASS;
      const body = await readBody(req, 4 * 1024 * 1024);

      if (method === "POST" && reqPath === "/api/donebot/market/publish") {
        const parsed = publishSchema.safeParse(body);
        if (!parsed.success) {
          return json(res, 400, { error: "请完整填写名称、简介和分类（名称 2–60 字，简介 4–160 字）。" });
        }
        const input = parsed.data;
        const isStudio = input.listing_type === "studio";
        const targetIds = isStudio
          ? Array.from(new Set(input.bot_ids ?? []))
          : input.bot_id ? [input.bot_id] : [];
        if (isStudio && targetIds.length < 2) {
          return json(res, 400, { error: "AI 工作室整包至少需要选择 2 位本地 Bot 员工。" });
        }
        if (!isStudio && targetIds.length !== 1) {
          return json(res, 400, { error: "请选择要分享的本地 Bot。" });
        }

        const bots: BotRecord[] = [];
        for (const id of targetIds) {
          const bot = deps.store.bot(id);
          if (!bot || bot.hidden) return json(res, 404, { error: "未找到要分享的本地 Bot。" });
          if (isExternalCodingAgentBot(bot)) return json(res, 403, { error: EXTERNAL_CODING_AGENT_SHARE_REFUSAL });
          if (Array.from((bot.soul ?? "").trim()).length < 20) {
            return json(res, 400, { error: `「${bot.name}」的 SOUL.md 内容不足 20 字，请先完善人设与能力设定再发布。` });
          }
          bots.push(bot);
        }

        const selection = input.skill_names === undefined
          ? "all"
          : input.skill_names.length === 0
            ? []
            : input.skill_names;
        const collected = deps.collectTeamSkills(bots, selection);
        if (!collected.ok) return json(res, collected.status ?? 400, { error: collected.error });

        const primaryBot = bots[0]!;
        const exportedBots: BotRecord[] = isStudio
          ? bots.map(bot => ({
            ...bot,
            section: input.name,
            soul: (bot.soul ?? "").trim(),
          }))
          : [{
            ...primaryBot,
            section: "",
            name: input.name,
            title: input.tagline,
            description: input.description || input.tagline,
            soul: (primaryBot.soul ?? "").trim(),
          }];

        const soulText = isStudio
          ? exportedBots.map((bot, idx) => `## 员工 ${idx + 1}：${bot.name}${bot.title ? `（${bot.title}）` : ""}\n${bot.soul}`).join("\n\n")
          : exportedBots[0]!.soul ?? "";

        const botsSummary = isStudio
          ? exportedBots.map(bot => ({
            name: bot.name,
            role: (bot.title || bot.description || "").trim().slice(0, 120),
            color: bot.color,
            skill_count: (collected.skillsByBot.get(bot.id) ?? []).length,
          }))
          : [];

        const identity = await deps.gateway.collabIdentity();
        const exported = createTeamPackageExport({
          team: isStudio ? input.name : "",
          name: input.name,
          summary: input.tagline,
          authorName: identity.email || undefined,
          bots: exportedBots,
          groups: [],
          routines: [],
          skillsByBot: collected.skillsByBot,
          skillSelection: collected.all ? "all" : "chosen",
          // Auto-redacted: never include MEMORY.md, starter notes, conversation logs, MCP keys, or local permissions.
          published: null,
          memoryByBot: undefined,
          mcpServers: {},
          skipped: [...collected.skipped],
          preset: null,
        });

        const skillsPayload: MarketSkillDoc[] = (exported.document.package.skills?.entries ?? []).map(entry => ({
          name: entry.name,
          description: entry.description ?? "",
          instructions: entry.instructions,
        }));

        const appearance = {
          color: primaryBot.color,
          ...(primaryBot.mascotBody ? { mascot_body: primaryBot.mascotBody } : {}),
          ...(primaryBot.mascotFaceColor ? { mascot_face_color: primaryBot.mascotFaceColor } : {}),
          ...(primaryBot.mascotExpression ? { mascot_expression: primaryBot.mascotExpression } : {}),
        };

        const orgBlueprint = isStudio && deps.orgStore ? deps.orgStore.exportOrgBlueprint(bots.map(b => b.id)) : undefined;
        const packagePayload = orgBlueprint
          ? { ...(exported.document as unknown as Record<string, unknown>), donebotOrgBlueprint: orgBlueprint }
          : exported.document;
        const result = await client.publish({
          ...(input.listing_id ? { listing_id: input.listing_id } : {}),
          listing_type: input.listing_type,
          source_bot_id: primaryBot.id,
          category_id: input.category_id,
          name: input.name,
          tagline: input.tagline,
          description: input.description,
          tags: input.tags,
          sample_prompts: input.sample_prompts,
          appearance,
          ...(isStudio ? { bots_summary: botsSummary } : {}),
          cost_tier: input.cost_tier,
          eval_verified: input.eval_verified && input.eval_samples.length > 0,
          eval_samples: input.eval_samples,
          soul_text: soulText,
          skills: skillsPayload,
          package: packagePayload,
          changelog: input.changelog,
        });
        return json(res, 200, result);
      }

      const visMatch = reqPath.match(/^\/api\/donebot\/market\/bots\/([0-9a-f-]{36})\/visibility$/);
      if (method === "PATCH" && visMatch) {
        const parsed = visibilitySchema.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "参数无效。" });
        return json(res, 200, await client.setVisibility(visMatch[1]!, parsed.data.listed));
      }

      const installMatch = reqPath.match(/^\/api\/donebot\/market\/bots\/([0-9a-f-]{36})\/install$/);
      if (method === "POST" && installMatch) {
        const fetched = await client.install(installMatch[1]!);
        let orgBlueprint: OpcOrgBlueprint | undefined;
        let rawPackage: unknown = fetched.package;
        if (rawPackage && typeof rawPackage === "object" && !Array.isArray(rawPackage) && "donebotOrgBlueprint" in rawPackage) {
          const cloned = { ...(rawPackage as Record<string, unknown>) };
          orgBlueprint = cloned.donebotOrgBlueprint as OpcOrgBlueprint;
          delete cloned.donebotOrgBlueprint;
          rawPackage = cloned;
        }
        const parsedDoc = parsePackageDocument(rawPackage, { trust: "file" });
        const importDeps = deps.packageImportDeps(await deps.defaultSelection());
        const imported = importPackageDocument(parsedDoc, { mode: "add", trust: "file" }, importDeps);
        if (imported.alreadyAdded || imported.bots.length === 0) {
          return json(res, 400, { error: "未能从广场模板创建本地 Bot，请稍后重试。" });
        }
        const created = imported.bots[0]!;
        const skillNames = (parsedDoc.package.skills?.entries ?? []).map(s => s.name);
        const enabledSkillsSet = new Set<string>();
        const installedAt = Date.now();
        // Bind every bot in a studio pack to the install token so creator rebates track actual consumption per bot.
        const installRecords = imported.bots.map(bot => {
          for (const enabledName of enableInstalledSkills(importDeps, bot.id, skillNames)) {
            enabledSkillsSet.add(enabledName);
          }
          return {
            botId: bot.id,
            installId: fetched.install_id,
            listingId: fetched.listing_id,
            releaseId: fetched.release_id,
            version: fetched.version,
            installToken: fetched.install_token,
            expiresAt: fetched.expires_at,
            installedAt,
          };
        });
        deps.marketInstalls.setMany(installRecords);
        if (orgBlueprint && deps.orgStore) {
          deps.orgStore.importOrgBlueprint(imported.bots.map(b => b.id), orgBlueprint);
        }
        const installRecord = installRecords[0]!;
        const enabledSkills = [...enabledSkillsSet];

        const publicBots: unknown[] = [];
        for (const bot of imported.bots) {
          const full = deps.store.bot(bot.id) ?? bot;
          const pub = deps.publicBot(full);
          publicBots.push(pub);
          deps.broadcast({ kind: "bot", bot: pub });
        }
        const fullCreated = deps.store.bot(created.id) ?? created;
        return json(res, 200, {
          ok: true,
          listing_type: fetched.listing_type ?? (imported.bots.length > 1 ? "studio" : "bot"),
          bot: deps.publicBot(fullCreated),
          bot_id: created.id,
          bots: publicBots,
          bot_ids: imported.bots.map(b => b.id),
          enabled_skills: enabledSkills,
          install: {
            bot_id: installRecord.botId,
            ...(imported.bots.length > 1 ? { bot_ids: imported.bots.map(b => b.id) } : {}),
            install_id: installRecord.installId,
            listing_id: installRecord.listingId,
            release_id: installRecord.releaseId,
            version: installRecord.version,
            expires_at: installRecord.expiresAt,
            installed_at: installRecord.installedAt,
          },
        });
      }

      const updateMatch = reqPath.match(/^\/api\/donebot\/market\/bots\/([0-9a-f-]{36})\/update$/);
      if (method === "POST" && updateMatch) {
        const parsed = updateInstallSchema.safeParse(body ?? {});
        if (!parsed.success) return json(res, 400, { error: "参数无效。" });
        const listingId = updateMatch[1]!;
        const existingRecord = parsed.data.bot_id
          ? deps.marketInstalls.get(parsed.data.bot_id)
          : deps.marketInstalls.findByListingId(listingId, visibleBotIds(deps.store));
        const targetBotId = parsed.data.bot_id ?? existingRecord?.botId;
        const targetBot = targetBotId ? deps.store.bot(targetBotId) : undefined;
        if (!targetBot || targetBot.hidden) {
          return json(res, 404, { error: "未找到已安装的本地 Bot，请重新安装。" });
        }

        const fetched = await client.install(listingId);
        const parsedDoc = parsePackageDocument(fetched.package, { trust: "file" });
        const agent = parsedDoc.package.agents[0];
        const nextSoul = (fetched.soul_text || agent?.soul || "").trim();
        if (nextSoul) {
          deps.store.patchBot(targetBot.id, {
            soul: nextSoul,
            ...(agent?.title !== undefined ? { title: agent.title } : {}),
            ...(agent?.description !== undefined ? { description: agent.description } : {}),
          });
        }
        const importDeps = deps.packageImportDeps(await deps.defaultSelection());
        const existingSkills = new Set(deps.listBotSkills(targetBot.id).map(sk => sk.name));
        const enabledSkills: string[] = [];
        for (const entry of parsedDoc.package.skills?.entries ?? []) {
          if (existingSkills.has(entry.name) && deps.removeBotSkill) {
            try { deps.removeBotSkill(targetBot.id, entry.name); } catch { /* Best-effort replace */ }
          }
          const added = importDeps.skills.install(
            targetBot.id,
            entry.source ?? `market:${listingId}`,
            [{ path: "SKILL.md", content: entry.instructions }, ...(entry.files ?? [])],
          );
          if (!("error" in added)) {
            const on = importDeps.skills.setEnabled(targetBot.id, added.name, true);
            if (!("error" in on)) enabledSkills.push(added.name);
          }
        }

        const nextRecord = {
          botId: targetBot.id,
          installId: fetched.install_id,
          listingId: fetched.listing_id,
          releaseId: fetched.release_id,
          version: fetched.version,
          installToken: fetched.install_token,
          expiresAt: fetched.expires_at,
          installedAt: Date.now(),
        };
        deps.marketInstalls.set(nextRecord);
        const updatedBot = deps.store.bot(targetBot.id) ?? targetBot;
        deps.broadcast({ kind: "bot", bot: deps.publicBot(updatedBot) });
        return json(res, 200, {
          ok: true,
          bot: deps.publicBot(updatedBot),
          bot_id: updatedBot.id,
          enabled_skills: enabledSkills,
          install: {
            bot_id: nextRecord.botId,
            install_id: nextRecord.installId,
            listing_id: nextRecord.listingId,
            release_id: nextRecord.releaseId,
            version: nextRecord.version,
            expires_at: nextRecord.expiresAt,
            installed_at: nextRecord.installedAt,
          },
        });
      }

      const reportMatch = reqPath.match(/^\/api\/donebot\/market\/bots\/([0-9a-f-]{36})\/report$/);
      if (method === "POST" && reportMatch) {
        const parsed = reportSchema.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "请选择有效的举报原因。" });
        return json(res, 200, await client.report(reportMatch[1]!, parsed.data));
      }

      if (method === "POST" && reqPath === "/api/donebot/market/creator/transfer") {
        const parsed = transferSchema.safeParse(body ?? {});
        if (!parsed.success) return json(res, 400, { error: "请输入有效的转入金额。" });
        const result = await client.transferToBalance(parsed.data.amount);
        // Refresh cached gateway account balance in the background so settings/usage reflect immediately.
        void deps.gateway.account().catch(() => {});
        return json(res, 200, result);
      }

      if (method === "POST" && reqPath === "/api/donebot/market/creator/withdrawals") {
        const parsed = withdrawSchema.safeParse(body);
        if (!parsed.success) {
          return json(res, 400, { error: "请填写有效的提现金额、支付宝账号及收款人真实姓名。" });
        }
        return json(res, 200, await client.requestWithdrawal(parsed.data));
      }

      return PASS;
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof DoneBotGatewayError) return json(res, error.status, { error: error.message, code: error.code });
      if (error instanceof TeamExportError || error instanceof PackageImportError) return json(res, error.status, { error: error.message });
      const rawMsg = error instanceof Error ? error.message : "";
      const friendly = /fetch failed|econnreset|etimedout|socket|network/i.test(rawMsg)
        ? "暂时无法连接到 DoneBot 网关，请检查网络或稍候几秒重试。"
        : (rawMsg || "Bot 广场请求失败，请稍后重试。");
      return json(res, 502, { error: friendly });
    }
  };
}
