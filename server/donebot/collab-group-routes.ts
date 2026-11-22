import type { ServerResponse } from "node:http";
import { z } from "zod";
import { botAvatarProfile } from "../../shared/bot-avatar.ts";
import { readAttachment } from "../attachments.ts";
import { PASS } from "../routes/table.ts";
import type { BotRecord, Store } from "../store.ts";
import {
  collabAddChatBot,
  collabAddGroupMembers,
  collabCreateGroup,
  collabLeaveGroup,
  collabListChatBots,
  collabListGroups,
  collabRemoveChatBot,
  collabRenameGroup,
  collabSetGroupAvatar,
  collabSetTeamAvatar,
  collabUpdateChatBotGrants,
} from "./collab-gateway.ts";
import { DoneBotGatewayError, type DoneBotGateway } from "./gateway.ts";

const uuidV4 = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const INLINE_AVATAR_DATA_URL = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/;

const avatarOnlySchema = z.object({
  avatar_url: z.string().max(750_000),
}).strict();
const createGroupSchema = z.object({
  name: z.string().trim().max(100).default(""),
  member_ids: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(99),
}).strict();
const renameGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
}).strict();
const groupMembersSchema = z.object({
  member_ids: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(99),
}).strict();
const addChatBotSchema = z.object({
  bot_id: z.string().trim().min(1).max(128),
  allow_all_members: z.boolean().default(false),
  allowed_user_ids: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(200).default([]),
}).strict();
const updateChatBotGrantsSchema = z.object({
  allow_all_members: z.boolean(),
  allowed_user_ids: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(200).default([]),
}).strict();

function validGroupOrTeamTarget(scopeType: string, targetId: string): boolean {
  return (scopeType === "team" || scopeType === "group") && uuidV4.safeParse(targetId).success;
}

const ALLOWED_INLINE_AVATAR_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

function inlineBotAvatarDataUrl(bot: BotRecord): string {
  const profile = botAvatarProfile(bot);
  if (!profile.avatarUrl || profile.avatarCrop === "mascot") return "";
  const match = profile.avatarUrl.match(/^\/api\/attachments\/([A-Za-z0-9-]+\.(?:png|jpg|webp))$/);
  if (!match?.[1]) return "";
  try {
    const file = readAttachment(match[1]);
    if (!file || file.bytes.length === 0 || file.bytes.length > 500_000) return "";
    const mime = file.mime === "image/jpg" ? "image/jpeg" : file.mime;
    if (!ALLOWED_INLINE_AVATAR_MIMES.has(mime)) return "";
    const dataUrl = `data:${mime};base64,${file.bytes.toString("base64")}`;
    return dataUrl.length <= 720_000 ? dataUrl : "";
  } catch {
    return "";
  }
}

export async function handleCollabGroupReadOrDelete(opts: {
  method: string;
  reqPath: string;
  gateway: DoneBotGateway;
  res: ServerResponse;
  json: (res: ServerResponse, status: number, value: unknown) => void;
}): Promise<typeof PASS | undefined> {
  const { method, reqPath, gateway, res, json } = opts;
  if (method === "GET") {
    if (reqPath === "/api/donebot/collab/groups") {
      json(res, 200, await collabListGroups(gateway.collabCtx()));
      return undefined;
    }
    const chatBotsGet = reqPath.match(/^\/api\/donebot\/collab\/chats\/(team|group)\/([^/]+)\/bots$/);
    if (chatBotsGet) {
      const [, scopeType, targetId] = chatBotsGet;
      if (!scopeType || !targetId || !validGroupOrTeamTarget(scopeType, targetId)) {
        json(res, 400, { error: "无效的群聊对象。" });
        return undefined;
      }
      json(res, 200, await collabListChatBots(gateway.collabCtx(), scopeType, targetId));
      return undefined;
    }
    return PASS;
  }

  if (method === "DELETE") {
    const chatBotDel = reqPath.match(/^\/api\/donebot\/collab\/chats\/(team|group)\/([^/]+)\/bots\/([0-9a-f-]{36})$/);
    if (chatBotDel) {
      const [, scopeType, targetId, botId] = chatBotDel;
      if (!scopeType || !targetId || !validGroupOrTeamTarget(scopeType, targetId)) {
        json(res, 400, { error: "无效的群聊对象。" });
        return undefined;
      }
      json(res, 200, await collabRemoveChatBot(gateway.collabCtx(), scopeType, targetId, botId!));
      return undefined;
    }
  }

  return PASS;
}

export async function handleCollabGroupWrite(opts: {
  method: string;
  reqPath: string;
  body: unknown;
  gateway: DoneBotGateway;
  store: Pick<Store, "bot">;
  activateBotWorker: () => void;
  res: ServerResponse;
  json: (res: ServerResponse, status: number, value: unknown) => void;
}): Promise<typeof PASS | undefined> {
  const { method, reqPath, body, gateway, store, activateBotWorker, res, json } = opts;

  const teamAvatarPut = reqPath.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/avatar$/);
  if (method === "PUT" && teamAvatarPut) {
    const parsed = avatarOnlySchema.safeParse(body);
    if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_avatar", "头像格式无效。");
    if (parsed.data.avatar_url !== "" && !INLINE_AVATAR_DATA_URL.test(parsed.data.avatar_url.trim())) {
      throw new DoneBotGatewayError(400, "invalid_avatar", "头像仅支持 PNG、JPEG 或 WebP 图片。");
    }
    json(res, 200, await collabSetTeamAvatar(gateway.collabCtx(), teamAvatarPut[1]!, parsed.data.avatar_url.trim()));
    return undefined;
  }

  if (method === "POST" && reqPath === "/api/donebot/collab/groups") {
    const parsed = createGroupSchema.safeParse(body);
    if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "请至少选择一位好友创建群聊。");
    json(res, 200, await collabCreateGroup(gateway.collabCtx(), parsed.data.name, parsed.data.member_ids));
    return undefined;
  }

  const groupPatch = reqPath.match(/^\/api\/donebot\/collab\/groups\/([0-9a-f-]{36})$/);
  if (method === "PATCH" && groupPatch) {
    const parsed = renameGroupSchema.safeParse(body);
    if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "请输入 1-100 字的群聊名称。");
    json(res, 200, await collabRenameGroup(gateway.collabCtx(), groupPatch[1]!, parsed.data.name));
    return undefined;
  }

  const groupAvatarPut = reqPath.match(/^\/api\/donebot\/collab\/groups\/([0-9a-f-]{36})\/avatar$/);
  if (method === "PUT" && groupAvatarPut) {
    const parsed = avatarOnlySchema.safeParse(body);
    if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_avatar", "头像格式无效。");
    if (parsed.data.avatar_url !== "" && !INLINE_AVATAR_DATA_URL.test(parsed.data.avatar_url.trim())) {
      throw new DoneBotGatewayError(400, "invalid_avatar", "头像仅支持 PNG、JPEG 或 WebP 图片。");
    }
    json(res, 200, await collabSetGroupAvatar(gateway.collabCtx(), groupAvatarPut[1]!, parsed.data.avatar_url.trim()));
    return undefined;
  }

  const groupMembersPost = reqPath.match(/^\/api\/donebot\/collab\/groups\/([0-9a-f-]{36})\/members$/);
  if (method === "POST" && groupMembersPost) {
    const parsed = groupMembersSchema.safeParse(body);
    if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "请选择要加入群聊的好友。");
    json(res, 200, await collabAddGroupMembers(gateway.collabCtx(), groupMembersPost[1]!, parsed.data.member_ids));
    return undefined;
  }

  const groupLeavePost = reqPath.match(/^\/api\/donebot\/collab\/groups\/([0-9a-f-]{36})\/leave$/);
  if (method === "POST" && groupLeavePost) {
    json(res, 200, await collabLeaveGroup(gateway.collabCtx(), groupLeavePost[1]!));
    return undefined;
  }

  const chatBotAdd = reqPath.match(/^\/api\/donebot\/collab\/chats\/(team|group)\/([^/]+)\/bots$/);
  if (method === "POST" && chatBotAdd) {
    const [, scopeType, targetId] = chatBotAdd;
    if (!scopeType || !targetId || !validGroupOrTeamTarget(scopeType, targetId)) {
      json(res, 400, { error: "无效的群聊对象。" });
      return undefined;
    }
    const parsed = addChatBotSchema.safeParse(body);
    if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "请选择要添加到群聊的本机 Bot。");
    const bot = store.bot(parsed.data.bot_id);
    if (!bot || bot.hidden) throw new DoneBotGatewayError(404, "bot_not_found", "未找到该本机 Bot。");
    const identity = await gateway.collabIdentity();
    const added = await collabAddChatBot(gateway.collabCtx(), scopeType, targetId, {
      installation_id: identity.installation_id,
      local_bot_id: bot.id,
      bot_name: bot.name.slice(0, 120),
      bot_color: bot.color || "blue",
      bot_avatar_url: inlineBotAvatarDataUrl(bot),
      bot_title: (bot.title ?? "").slice(0, 200),
      allow_all_members: parsed.data.allow_all_members,
      allowed_user_ids: parsed.data.allowed_user_ids,
    });
    activateBotWorker();
    json(res, 200, added);
    return undefined;
  }

  const chatBotGrantsPut = reqPath.match(/^\/api\/donebot\/collab\/chats\/(team|group)\/([^/]+)\/bots\/([0-9a-f-]{36})\/grants$/);
  if (method === "PUT" && chatBotGrantsPut) {
    const [, scopeType, targetId, botId] = chatBotGrantsPut;
    if (!scopeType || !targetId || !validGroupOrTeamTarget(scopeType, targetId)) {
      json(res, 400, { error: "无效的群聊对象。" });
      return undefined;
    }
    const parsed = updateChatBotGrantsSchema.safeParse(body);
    if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "无效的机器人授权名单。");
    json(res, 200, await collabUpdateChatBotGrants(gateway.collabCtx(), scopeType, targetId, botId!, parsed.data));
    return undefined;
  }

  return PASS;
}
