import type { ServerResponse } from "node:http";
import { z } from "zod";
import { ownerOrAdmin } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import { parsePackageDocument } from "../bot-package.ts";
import { createTeamPackageExport, TeamExportError, type ExportablePackageSkill, type TeamExportSkip } from "../package-export.ts";
import { importPackageDocument, PackageImportError, type PackageImportDeps } from "../package-import.ts";
import type { ModelSelection } from "../contracts.ts";
import type { BotRecord, Store } from "../store.ts";
import { DoneBotGatewayError, type DoneBotGateway } from "./gateway.ts";

const uuidV4 = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const subjectTypeSchema = z.enum(["user", "team"]);
const accessSchema = z.enum(["read", "write"]);
const folderGrantSchema = z.object({
  subject_type: subjectTypeSchema,
  subject_id: z.string().min(1).max(64),
  access: accessSchema,
}).strict();
const botGrantSchema = z.object({
  subject_type: subjectTypeSchema,
  subject_id: z.string().min(1).max(64),
}).strict();
const saveFolderSchema = z.object({
  id: uuidV4.optional(),
  device_name: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  grants: z.array(folderGrantSchema).max(200).default([]),
}).strict();
const invokeFolderSchema = z.object({
  action: z.enum(["list_files", "read_file", "write_file", "edit_file", "append_file", "delete_file"]),
  path: z.string().max(2048).optional(),
  content: z.string().max(350_000).optional(),
  encoding: z.enum(["utf8", "base64"]).optional(),
  old_text: z.string().min(1).max(350_000).optional(),
  new_text: z.string().max(350_000).optional(),
  expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
const internalInvokeSchema = invokeFolderSchema.extend({ folder_id: uuidV4 }).strict();
const shareBotSchema = z.object({
  id: uuidV4.optional(),
  bot_id: z.string().trim().min(1).max(128),
  grants: z.array(botGrantSchema).max(200).default([]),
}).strict();
const updateSharedBotSchema = z.object({
  bot_id: z.string().trim().min(1).max(128).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  title: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  grants: z.array(botGrantSchema).max(200),
}).strict();

export interface DoneBotCollabRouteDeps {
  gateway: DoneBotGateway;
  store: Pick<Store, "bots" | "bot">;
  collectTeamSkills(bots: readonly BotRecord[], selection: unknown):
    | { ok: true; all: boolean; skillsByBot: Map<string, ExportablePackageSkill[]>; skipped: TeamExportSkip[]; available: string[] }
    | { ok: false; error: string; available: string[] };
  defaultSelection(): Promise<ModelSelection>;
  packageImportDeps(selection: ModelSelection): PackageImportDeps;
  broadcast(payload: Record<string, unknown>): void;
  publicBot(bot: BotRecord): unknown;
}

function buildBotSharePayload(deps: DoneBotCollabRouteDeps, bot: BotRecord, authorEmail: string) {
  const skills = deps.collectTeamSkills([bot], "all");
  if (!skills.ok) throw new DoneBotGatewayError(400, "collab_bot_skills", skills.error);
  const botSkills = skills.skillsByBot.get(bot.id) ?? [];
  const exported = createTeamPackageExport({
    team: "",
    name: bot.name,
    summary: bot.description?.trim() || bot.title?.trim() || undefined,
    authorName: authorEmail || undefined,
    bots: [{ ...bot, section: "" }],
    groups: [],
    routines: [],
    skillsByBot: skills.skillsByBot,
    skillSelection: "all",
    // Security: shared bots never include memory, starter notes, conversation logs, or credentials.
    published: null,
    memoryByBot: undefined,
    mcpServers: {},
    skipped: [...skills.skipped],
    preset: null,
  });
  return {
    source_bot_id: bot.id,
    name: bot.name.slice(0, 120),
    title: (bot.title ?? "").slice(0, 200),
    description: (bot.description ?? "").slice(0, 1000),
    skill_count: botSkills.length,
    has_soul: Boolean(bot.soul && bot.soul.trim()),
    package: exported.document,
  };
}

export function createDoneBotCollabRoutes(deps: DoneBotCollabRouteDeps): RouteHandler {
  const { gateway } = deps;
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!path.startsWith("/api/donebot/collab/")) return PASS;
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "仅工作空间所有者可使用远程协作。" });
    res.setHeader("Cache-Control", "no-store");
    try {
      if (process.env.DONEBOT_TEAM_RUNTIME === "1") {
        return json(res, 403, { error: "远程协作仅在本机个人空间使用。" });
      }

      if (method === "GET" && path === "/api/donebot/collab/overview") {
        const [identity, friends, folders, bots, workspaces, incomingInvitations] = await Promise.all([
          gateway.collabIdentity(),
          gateway.collabFriends(),
          gateway.collabFolders(),
          gateway.collabBots(),
          gateway.workspaceSnapshot().catch(() => ({ account_id: "", protocol: "donebot.teams.v1", capabilities: [], workspaces: [] })),
          gateway.collabIncomingTeamInvitations().catch(() => []),
        ]);
        const teamMembers: Record<string, unknown[]> = {};
        const teamList = Array.isArray(workspaces?.workspaces) ? workspaces.workspaces : [];
        await Promise.all(teamList.map(async team => {
          try {
            teamMembers[team.id] = await gateway.teamMembers(team.id);
          } catch {
            teamMembers[team.id] = [];
          }
        }));
        const localBots = deps.store.bots
          .filter(bot => !bot.hidden)
          .map(bot => {
            const collected = deps.collectTeamSkills([bot], "all");
            const skillCount = collected.ok ? (collected.skillsByBot.get(bot.id)?.length ?? 0) : 0;
            return {
              id: bot.id,
              name: bot.name,
              title: bot.title ?? "",
              description: bot.description ?? "",
              color: bot.color,
              has_soul: Boolean(bot.soul && bot.soul.trim()),
              skill_count: skillCount,
            };
          });
        return json(res, 200, {
          identity,
          friends,
          folders,
          bots,
          teams: teamList,
          team_capabilities: workspaces?.capabilities ?? [],
          team_members: teamMembers,
          incoming_team_invitations: incomingInvitations,
          local_bots: localBots,
        });
      }

      const teamInvList = path.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/invitations$/);
      if (method === "GET" && teamInvList) {
        return json(res, 200, await gateway.collabTeamInvitations(teamInvList[1]!));
      }

      if (method === "GET" && path === "/api/donebot/collab/folders") {
        return json(res, 200, await gateway.collabFolders());
      }

      if (method === "GET" && path === "/api/donebot/collab/bots") {
        return json(res, 200, await gateway.collabBots());
      }

      if (method === "DELETE") {
        const friendDel = path.match(/^\/api\/donebot\/collab\/friends\/([1-9]\d{0,18})$/);
        if (friendDel) return json(res, 200, await gateway.collabRemoveFriend(Number(friendDel[1])));
        const folderDel = path.match(/^\/api\/donebot\/collab\/folders\/([0-9a-f-]{36})$/);
        if (folderDel) return json(res, 200, await gateway.collabDeleteFolder(folderDel[1]!));
        const botDel = path.match(/^\/api\/donebot\/collab\/bots\/([0-9a-f-]{36})$/);
        if (botDel) return json(res, 200, await gateway.collabDeleteBot(botDel[1]!));
        return PASS;
      }

      if (method !== "POST" && method !== "PUT") return PASS;
      const body = await readBody(req, 2 * 1024 * 1024);

      if (method === "POST" && path === "/api/donebot/collab/friends/request") {
        const parsed = z.object({ email: z.string().trim().min(3).max(254), note: z.string().max(200).optional() }).strict().safeParse(body);
        if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "请输入有效的好友账号邮箱。");
        return json(res, 200, await gateway.collabSendFriendRequest(parsed.data.email, parsed.data.note ?? ""));
      }

      const friendReqAction = path.match(/^\/api\/donebot\/collab\/friends\/requests\/([0-9a-f-]{36})\/(accept|reject)$/);
      if (method === "POST" && friendReqAction) {
        const [, id, action] = friendReqAction;
        return json(res, 200, action === "accept"
          ? await gateway.collabAcceptFriendRequest(id!)
          : await gateway.collabRejectFriendRequest(id!));
      }

      const teamInvAction = path.match(/^\/api\/donebot\/collab\/teams\/invitations\/([0-9a-f-]{36})\/(accept|decline)$/);
      if (method === "POST" && teamInvAction) {
        const [, id, action] = teamInvAction;
        return json(res, 200, action === "accept"
          ? await gateway.collabAcceptTeamInvitation(id!)
          : await gateway.collabDeclineTeamInvitation(id!));
      }

      const teamLeave = path.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/leave$/);
      if (method === "POST" && teamLeave) {
        return json(res, 200, await gateway.collabLeaveTeam(teamLeave[1]!));
      }

      if (method === "POST" && path === "/api/donebot/collab/folders") {
        const parsed = saveFolderSchema.safeParse(body);
        if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "无效的共享文件夹配置。");
        return json(res, 200, await gateway.collabSaveFolder(parsed.data));
      }

      const folderPut = path.match(/^\/api\/donebot\/collab\/folders\/([0-9a-f-]{36})$/);
      if (method === "PUT" && folderPut) {
        const parsed = saveFolderSchema.safeParse(body);
        if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "无效的共享文件夹权限配置。");
        return json(res, 200, await gateway.collabSaveFolder(parsed.data, folderPut[1]!));
      }

      const folderInvoke = path.match(/^\/api\/donebot\/collab\/folders\/([0-9a-f-]{36})\/invoke$/);
      if (method === "POST" && folderInvoke) {
        const parsed = invokeFolderSchema.safeParse(body);
        if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "不支持的远程文件夹操作。");
        return json(res, 200, await gateway.collabInvokeFolder(folderInvoke[1]!, parsed.data));
      }

      if (method === "POST" && path === "/api/donebot/collab/relay/poll") {
        return json(res, 200, await gateway.collabRelayPoll());
      }

      if (method === "POST" && path === "/api/donebot/collab/relay/result") {
        const parsed = z.object({ job_id: z.string().min(1).max(128), result: z.unknown() }).strict().safeParse(body);
        if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "无效的中继结果。");
        return json(res, 200, await gateway.collabRelayResult(parsed.data.job_id, parsed.data.result));
      }

      if (method === "POST" && path === "/api/donebot/collab/bots/share") {
        const parsed = shareBotSchema.safeParse(body);
        if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "请选择要共享的 Bot 和授权对象。");
        const bot = deps.store.bot(parsed.data.bot_id);
        if (!bot || bot.hidden) throw new DoneBotGatewayError(404, "bot_not_found", "未找到该 Bot。");
        const identity = await gateway.collabIdentity();
        const payload = buildBotSharePayload(deps, bot, identity.email);
        return json(res, 200, await gateway.collabSaveBot({
          ...(parsed.data.id ? { id: parsed.data.id } : {}),
          ...payload,
          grants: parsed.data.grants,
        }, parsed.data.id));
      }

      const botPut = path.match(/^\/api\/donebot\/collab\/bots\/([0-9a-f-]{36})$/);
      if (method === "PUT" && botPut) {
        const parsed = updateSharedBotSchema.safeParse(body);
        if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "无效的共享 Bot 权限配置。");
        const payload: Record<string, unknown> = { grants: parsed.data.grants };
        if (parsed.data.bot_id) {
          const bot = deps.store.bot(parsed.data.bot_id);
          if (bot && !bot.hidden) {
            const identity = await gateway.collabIdentity();
            Object.assign(payload, buildBotSharePayload(deps, bot, identity.email));
          }
        }
        if (parsed.data.name) payload.name = parsed.data.name;
        if (parsed.data.title !== undefined) payload.title = parsed.data.title;
        if (parsed.data.description !== undefined) payload.description = parsed.data.description;
        return json(res, 200, await gateway.collabSaveBot(payload, botPut[1]!));
      }

      const botInstall = path.match(/^\/api\/donebot\/collab\/bots\/([0-9a-f-]{36})\/install$/);
      if (method === "POST" && botInstall) {
        const fetched = await gateway.collabBotPackage(botInstall[1]!) as { id: string; name: string; package: unknown };
        const parsedDoc = parsePackageDocument(fetched.package, { trust: "file" });
        const importDeps = deps.packageImportDeps(await deps.defaultSelection());
        const imported = importPackageDocument(parsedDoc, { mode: "add", trust: "file" }, importDeps);
        if (imported.alreadyAdded) return json(res, 200, { ok: true, alreadyAdded: true, bots: [] });
        for (const created of imported.bots) {
          const full = deps.store.bot(created.id);
          if (full) deps.broadcast({ kind: "bot.created", bot: deps.publicBot(full) });
        }
        return json(res, 200, { ok: true, bots: imported.bots });
      }

      return PASS;
    } catch (error) {
      if (error instanceof DoneBotGatewayError) return json(res, error.status, { error: error.message, code: error.code });
      if (error instanceof TeamExportError || error instanceof PackageImportError) return json(res, error.status, { error: error.message });
      return json(res, 502, { error: error instanceof Error ? error.message : "远程协作请求失败，请稍后重试。" });
    }
  };
}

export async function handleDoneBotCollabInternal(
  gateway: DoneBotGateway,
  method: string,
  path: string,
  res: ServerResponse,
  json: (res: ServerResponse, status: number, value: unknown) => void,
  readInternalBody: () => Promise<Record<string, unknown>>,
): Promise<boolean> {
  if (method !== "POST" || !path.startsWith("/api/internal/donebot/collab/")) return false;
  try {
    if (path === "/api/internal/donebot/collab/folders") {
      const snapshot = await gateway.collabFolders() as { shared_with_me?: unknown[] };
      json(res, 200, { folders: snapshot?.shared_with_me ?? [] });
      return true;
    }
    if (path === "/api/internal/donebot/collab/invoke") {
      const body = await readInternalBody();
      const parsed = internalInvokeSchema.safeParse(body);
      if (!parsed.success) {
        json(res, 400, { error: "Invalid collab_folder arguments." });
        return true;
      }
      const { folder_id, ...operation } = parsed.data;
      const answer = await gateway.collabInvokeFolder(folder_id, operation);
      json(res, 200, answer);
      return true;
    }
    json(res, 404, { error: "unknown collab endpoint" });
    return true;
  } catch (error) {
    if (error instanceof DoneBotGatewayError) {
      json(res, error.status, { error: error.message });
      return true;
    }
    json(res, 502, { error: error instanceof Error ? error.message : "远程共享文件夹调用失败。" });
    return true;
  }
}
