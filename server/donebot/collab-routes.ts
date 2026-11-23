import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { botAvatarProfile, botAvatarUrlFromStoredPath, clampAvatarFocus, clampAvatarZoom } from "../../shared/bot-avatar.ts";
import { EXTERNAL_CODING_AGENT_SHARE_REFUSAL, isExternalCodingAgentBot } from "../../shared/coding-agents.ts";
import { DONEBOT_COLLAB_MAX_FILE_BYTES, type DoneBotCollabChatBot } from "../../shared/donebot-collab.ts";
import { saveImage } from "../attachments.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import { parsePackageDocument } from "../bot-package.ts";
import { createTeamPackageExport, TeamExportError, type ExportablePackageSkill, type TeamExportSkip } from "../package-export.ts";
import { importPackageDocument, PackageImportError, type PackageImportDeps } from "../package-import.ts";
import type { ModelSelection } from "../contracts.ts";
import type { BotRecord, Store } from "../store.ts";
import { boundedResponseText } from "./bounded-response.ts";
import { buildCollabChatBotAppearance, chatBotNeedsSync, type CollabChatBotAppearance } from "./collab-bot-avatar.ts";
import { createCollabChatBotWorker, type CollabBotTurnOptions } from "./collab-chat-bots.ts";
import {
  collabListChatBots,
  collabListGroups,
  collabListTeamChannels,
  collabListTeamMemberProfiles,
  collabSyncChatBots,
  collabTeamTaskCounts,
} from "./collab-gateway.ts";
import { handleCollabGroupReadOrDelete, handleCollabGroupWrite } from "./collab-group-routes.ts";
import {
  handleCollabWorkspaceReadOrDelete,
  handleCollabWorkspaceStreams,
  handleCollabWorkspaceWrite,
} from "./collab-workspace-routes.ts";
import { DoneBotGatewayError, type DoneBotGateway } from "./gateway.ts";

const uuidV4 = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const transferIdPattern = /^[a-f0-9-]{36}$/;
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
const profileUpdateSchema = z.object({
  nickname: z.string().trim().max(64).optional(),
  avatar_url: z.string().max(750_000).optional(),
}).strict();
const friendRemarkSchema = z.object({
  remark: z.string().max(64),
}).strict();
const chatMessageSchema = z.object({
  body: z.string().trim().min(1).max(8000),
  mention_bot_ids: z.array(uuidV4).max(10).optional(),
}).strict();
const chatReadSchema = z.object({
  last_read_id: z.number().int().min(0).optional(),
}).strict();

function validChatTarget(scopeType: string, targetId: string): boolean {
  if (scopeType === "friend") return /^[1-9]\d{0,18}$/.test(targetId);
  if (scopeType === "team" || scopeType === "group" || scopeType === "channel") return uuidV4.safeParse(targetId).success;
  return false;
}

const INLINE_AVATAR_DATA_URL = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/;

export interface DoneBotCollabRouteDeps {
  gateway: DoneBotGateway;
  store: Pick<Store, "bots" | "bot"> & Partial<Pick<Store, "taskByThread" | "createTask" | "appendMessage" | "messagesFor">>;
  collectTeamSkills(bots: readonly BotRecord[], selection: unknown):
    | { ok: true; all: boolean; skillsByBot: Map<string, ExportablePackageSkill[]>; skipped: TeamExportSkip[]; available: string[] }
    | { ok: false; error: string; available: string[] };
  defaultSelection(): Promise<ModelSelection>;
  packageImportDeps(selection: ModelSelection): PackageImportDeps;
  broadcast(payload: Record<string, unknown>): void;
  publicBot(bot: BotRecord): unknown;
  syncLocalProfile?(patch: { name?: string; avatarUrl?: string; email?: string }): void;
  currentLocalProfile?(): { name?: string; avatarUrl?: string; email?: string } | undefined;
  startTurn?: (botId: string, text: string, opts: CollabBotTurnOptions) => Promise<unknown>;
  threadBusy?: (botId: string, threadId: string) => boolean;
  generateBotText?: (botId: string, prompt: string, signal?: AbortSignal) => Promise<string | undefined>;
}

function cleanRelativeFilePath(raw: string | null): string | null {
  const value = (raw ?? "").trim().replace(/^\/+/, "");
  if (!value || value.length > 2048 || /[\\:\0]/.test(value)) return null;
  if (value.split("/").some(part => part === "..")) return null;
  return value;
}

function storeLocalAvatarFromDataUrl(dataUrl: string): string | undefined {
  if (dataUrl === "") return "";
  const match = INLINE_AVATAR_DATA_URL.exec(dataUrl.trim());
  if (!match) return undefined;
  try {
    const mime = match[1] === "image/jpg" ? "image/jpeg" : match[1]!;
    const bytes = Buffer.from(match[2]!, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > 512 * 1024) return undefined;
    const saved = saveImage(bytes, mime);
    return botAvatarUrlFromStoredPath(saved.path) ?? undefined;
  } catch {
    return undefined;
  }
}

function boundedRequestWebStream(req: IncomingMessage, maxBytes: number): ReadableStream<Uint8Array> {
  const web = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
  let seen = 0;
  return web.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        controller.error(new DoneBotGatewayError(413, "file_too_large", "文件不能超过 100 MB。"));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
}

async function readUpstreamError(response: Response, fallback: string): Promise<string> {
  try {
    const text = await boundedResponseText(response, 16_384);
    if (!text) return fallback;
    try {
      const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
      if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    } catch { /* plain text */ }
    return text.slice(0, 300);
  } catch {
    return fallback;
  }
}

async function pipeUpstreamStream(
  upstream: Response,
  res: ServerResponse,
  json: (res: ServerResponse, status: number, value: unknown) => void,
  fallbackError: string,
  extraHeaders: string[],
): Promise<void> {
  if (!upstream.ok) {
    const message = await readUpstreamError(upstream, fallbackError);
    json(res, upstream.status >= 400 ? upstream.status : 502, { error: message });
    return;
  }
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  for (const name of extraHeaders) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(upstream.body as unknown as import("node:stream/web").ReadableStream), res);
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
  const botWorker = createCollabChatBotWorker({
    gateway,
    store: deps.store,
    startTurn: deps.startTurn,
    threadBusy: deps.threadBusy,
    generateBotText: deps.generateBotText,
  });
  return async ({ req, res, url, path: reqPath, method, auth, json, readBody }) => {
    if (!reqPath.startsWith("/api/donebot/collab/")) return PASS;
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "仅工作空间所有者可使用远程协作。" });
    res.setHeader("Cache-Control", "no-store");
    try {
      if (process.env.DONEBOT_TEAM_RUNTIME === "1") {
        return json(res, 403, { error: "远程协作仅在本机个人空间使用。" });
      }

      // --- Streaming file transfer routes (never call readBody) ---
      const wsStreamHandled = await handleCollabWorkspaceStreams({
        req,
        res,
        url,
        reqPath,
        method,
        gateway,
        json,
        helpers: { boundedRequestWebStream, readUpstreamError, pipeUpstreamStream },
      });
      if (wsStreamHandled !== PASS) return wsStreamHandled;

      const chatFileDownload = reqPath.match(/^\/api\/donebot\/collab\/chats\/files\/([0-9a-f-]{36})$/);
      if (chatFileDownload && method === "GET") {
        const inline = url.searchParams.get("inline") === "1";
        const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
        const abort = new AbortController();
        const onClose = () => abort.abort();
        res.once("close", onClose);
        try {
          const upstream = await gateway.collabDownloadChatFile(chatFileDownload[1]!, inline, abort.signal, range);
          await pipeUpstreamStream(upstream, res, json, "下载聊天文件失败。", [
            "Content-Type", "Content-Disposition", "Content-Length", "Accept-Ranges", "Content-Range", "X-File-Sha256",
          ]);
        } finally {
          res.off("close", onClose);
        }
        return;
      }

      const chatFileUpload = reqPath.match(/^\/api\/donebot\/collab\/chats\/(friend|team|group|channel)\/([^/]+)\/files$/);
      if (chatFileUpload && method === "POST") {
        const [, scopeType, targetId] = chatFileUpload;
        if (!scopeType || !targetId || !validChatTarget(scopeType, targetId)) {
          return json(res, 400, { error: "无效的聊天对象。" });
        }
        const rawLen = req.headers["content-length"];
        const parsedLen = typeof rawLen === "string" && /^\d+$/.test(rawLen) ? Number(rawLen) : -1;
        if (parsedLen > DONEBOT_COLLAB_MAX_FILE_BYTES) {
          return json(res, 413, { error: "发送的文件不能超过 100 MB。" });
        }
        const params = new URLSearchParams();
        const fileName = (url.searchParams.get("name") ?? "").trim();
        if (fileName) params.set("name", fileName.slice(0, 240));
        const caption = (url.searchParams.get("body") ?? "").trim();
        if (caption) params.set("body", caption.slice(0, 2000));
        const headers: Record<string, string> = {
          "content-type": typeof req.headers["content-type"] === "string" && req.headers["content-type"].trim()
            ? req.headers["content-type"].trim()
            : "application/octet-stream",
        };
        if (parsedLen >= 0) headers["content-length"] = String(parsedLen);
        const abort = new AbortController();
        const onClose = () => abort.abort();
        req.once("aborted", onClose);
        try {
          const upstream = await gateway.collabSendChatFile(
            scopeType,
            targetId,
            params.toString(),
            boundedRequestWebStream(req, DONEBOT_COLLAB_MAX_FILE_BYTES),
            headers,
            abort.signal,
          );
          if (!upstream.ok) {
            return json(res, upstream.status >= 400 ? upstream.status : 502, {
              error: await readUpstreamError(upstream, "发送聊天文件失败。"),
            });
          }
          const payload = await upstream.json() as { code?: number; data?: unknown };
          return json(res, 200, payload?.code === 0 && "data" in payload ? payload.data : payload);
        } finally {
          req.off("aborted", onClose);
        }
      }

      const folderFile = reqPath.match(/^\/api\/donebot\/collab\/folders\/([0-9a-f-]{36})\/file$/);
      if (folderFile && method === "GET") {
        const relPath = cleanRelativeFilePath(url.searchParams.get("path"));
        if (!relPath) return json(res, 400, { error: "请输入有效的相对文件路径。" });
        const abort = new AbortController();
        const onClose = () => abort.abort();
        res.once("close", onClose);
        try {
          const upstream = await gateway.collabDownloadFile(folderFile[1]!, relPath, abort.signal);
          await pipeUpstreamStream(upstream, res, json, "下载远程共享文件失败。", [
            "Content-Type", "Content-Disposition", "Content-Length", "X-File-Sha256",
          ]);
        } finally {
          res.off("close", onClose);
        }
        return;
      }

      if (folderFile && method === "PUT") {
        const relPath = cleanRelativeFilePath(url.searchParams.get("path"));
        if (!relPath) return json(res, 400, { error: "请输入有效的相对文件路径。" });
        const rawLen = req.headers["content-length"];
        const parsedLen = typeof rawLen === "string" && /^\d+$/.test(rawLen) ? Number(rawLen) : -1;
        if (parsedLen > DONEBOT_COLLAB_MAX_FILE_BYTES) {
          return json(res, 413, { error: "上传文件不能超过 100 MB。" });
        }
        const headers: Record<string, string> = {
          "content-type": typeof req.headers["content-type"] === "string" && req.headers["content-type"].trim()
            ? req.headers["content-type"].trim()
            : "application/octet-stream",
        };
        if (parsedLen >= 0) headers["content-length"] = String(parsedLen);
        const abort = new AbortController();
        const onClose = () => abort.abort();
        req.once("aborted", onClose);
        try {
          const upstream = await gateway.collabUploadFile(
            folderFile[1]!,
            relPath,
            boundedRequestWebStream(req, DONEBOT_COLLAB_MAX_FILE_BYTES),
            headers,
            abort.signal,
          );
          if (!upstream.ok) {
            return json(res, upstream.status >= 400 ? upstream.status : 502, {
              error: await readUpstreamError(upstream, "上传文件到共享文件夹失败。"),
            });
          }
          const payload = await upstream.json() as { code?: number; data?: unknown };
          return json(res, 200, payload?.code === 0 && "data" in payload ? payload.data : payload);
        } finally {
          req.off("aborted", onClose);
        }
      }

      const relayTransfer = reqPath.match(/^\/api\/donebot\/collab\/relay\/transfers\/([a-f0-9-]{36})\/(upload|download|fail)$/);
      if (relayTransfer) {
        const [, transferId, action] = relayTransfer;
        if (!transferId || !transferIdPattern.test(transferId)) return json(res, 400, { error: "无效的传输标识。" });
        if (action === "upload" && method === "POST") {
          const rawLen = req.headers["content-length"];
          const parsedLen = typeof rawLen === "string" && /^\d+$/.test(rawLen) ? Number(rawLen) : -1;
          if (parsedLen > DONEBOT_COLLAB_MAX_FILE_BYTES) {
            return json(res, 413, { error: "共享文件不能超过 100 MB。" });
          }
          const headers: Record<string, string> = {
            "content-type": typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "application/octet-stream",
          };
          for (const key of ["content-length", "x-file-size", "x-file-name", "x-file-content-type", "x-file-sha256"]) {
            const val = req.headers[key];
            if (typeof val === "string" && val.trim()) headers[key] = val.trim();
          }
          const abort = new AbortController();
          const onClose = () => abort.abort();
          req.once("aborted", onClose);
          try {
            const upstream = await gateway.collabRelayTransferUpload(
              transferId,
              boundedRequestWebStream(req, DONEBOT_COLLAB_MAX_FILE_BYTES),
              headers,
              abort.signal,
            );
            if (!upstream.ok) {
              return json(res, upstream.status >= 400 ? upstream.status : 502, {
                error: await readUpstreamError(upstream, "发送共享文件流失败。"),
              });
            }
            return json(res, 200, { ok: true });
          } finally {
            req.off("aborted", onClose);
          }
        }
        if (action === "download" && method === "GET") {
          const abort = new AbortController();
          const onClose = () => abort.abort();
          res.once("close", onClose);
          try {
            const upstream = await gateway.collabRelayTransferDownload(transferId, abort.signal);
            await pipeUpstreamStream(upstream, res, json, "接收远程上传流失败。", ["Content-Type", "Content-Length"]);
          } finally {
            res.off("close", onClose);
          }
          return;
        }
        if (action === "fail" && method === "POST") {
          const body = await readBody(req, 32 * 1024);
          const msg = typeof (body as { error?: unknown })?.error === "string" ? String((body as { error?: unknown }).error).slice(0, 500) : "文件传输失败。";
          return json(res, 200, await gateway.collabRelayTransferFail(transferId, msg));
        }
      }

      // --- Standard JSON collab routes ---
      if (method === "GET" && reqPath === "/api/donebot/collab/profile") {
        const [identity, profile] = await Promise.all([
          gateway.collabIdentity(),
          gateway.collabUserProfile().catch(() => null),
        ]);
        return json(res, 200, {
          email: identity.email,
          nickname: typeof profile?.username === "string" ? profile.username.trim() : "",
          avatar_url: typeof profile?.avatar_url === "string" ? profile.avatar_url.trim() : "",
        });
      }

      if (method === "GET" && reqPath === "/api/donebot/collab/overview") {
        const ctx = typeof gateway.collabCtx === "function" ? gateway.collabCtx() : null;
        const [identity, profile, friends, folders, bots, workspaces, incomingInvitations, chatSummaries, groups, taskCounts] = await Promise.all([
          gateway.collabIdentity(),
          gateway.collabUserProfile?.().catch(() => null) ?? Promise.resolve(null),
          gateway.collabFriends(),
          gateway.collabFolders(),
          gateway.collabBots(),
          gateway.workspaceSnapshot().catch(() => ({ account_id: "", protocol: "donebot.teams.v1", capabilities: [], workspaces: [] })),
          gateway.collabIncomingTeamInvitations().catch(() => []),
          gateway.collabChatSummaries?.().catch(() => []) ?? Promise.resolve([]),
          ctx ? collabListGroups(ctx).catch(() => []) : Promise.resolve([]),
          ctx ? collabTeamTaskCounts(ctx).catch(() => []) : Promise.resolve([]),
        ]);
        const nickname = typeof profile?.username === "string" ? profile.username.trim() : "";
        const avatarUrl = typeof profile?.avatar_url === "string" ? profile.avatar_url.trim() : "";
        if (deps.syncLocalProfile && deps.currentLocalProfile) {
          const local = deps.currentLocalProfile();
          const needName = !local?.name?.trim() && Boolean(nickname);
          const needAvatar = !local?.avatarUrl?.trim() && Boolean(avatarUrl);
          if (needName || needAvatar) {
            const localAvatar = needAvatar
              ? (/^https?:\/\//i.test(avatarUrl) ? avatarUrl : storeLocalAvatarFromDataUrl(avatarUrl))
              : undefined;
            if (needName || localAvatar) {
              try {
                deps.syncLocalProfile({
                  ...(needName ? { name: nickname } : {}),
                  ...(localAvatar ? { avatarUrl: localAvatar } : {}),
                  ...(identity.email && !local?.email ? { email: identity.email } : {}),
                });
              } catch { /* Best-effort local profile sync */ }
            }
          }
        }
        const teamMembers: Record<string, unknown[]> = {};
        const teamChannels: Record<string, unknown[]> = {};
        const teamMemberProfiles: Record<string, unknown[]> = {};
        const chatBots: Record<string, unknown[]> = {};
        const teamList = Array.isArray(workspaces?.workspaces) ? workspaces.workspaces : [];
        const groupList = Array.isArray(groups) ? (groups as Array<{ id: string }>) : [];
        let hasOwnedChatBots = false;
        const myId = Number(identity.account_id);
        await Promise.all([
          ...teamList.map(async team => {
            try {
              teamMembers[team.id] = await gateway.teamMembers(team.id);
            } catch {
              teamMembers[team.id] = [];
            }
            if (ctx) {
              await Promise.all([
                (async () => {
                  try {
                    const list = await collabListChatBots(ctx, "team", team.id) as Array<{ owner_user_id?: number }>;
                    chatBots[`team:${team.id}`] = Array.isArray(list) ? list : [];
                    if (Array.isArray(list) && list.some(b => b.owner_user_id === myId)) hasOwnedChatBots = true;
                  } catch {
                    chatBots[`team:${team.id}`] = [];
                  }
                })(),
                (async () => {
                  try {
                    const list = await collabListTeamChannels(ctx, team.id, false);
                    teamChannels[team.id] = Array.isArray(list) ? list : [];
                  } catch {
                    teamChannels[team.id] = [];
                  }
                })(),
                (async () => {
                  try {
                    const list = await collabListTeamMemberProfiles(ctx, team.id);
                    teamMemberProfiles[team.id] = Array.isArray(list) ? list : [];
                  } catch {
                    teamMemberProfiles[team.id] = [];
                  }
                })(),
              ]);
            }
          }),
          ...groupList.map(async group => {
            if (ctx) {
              try {
                const list = await collabListChatBots(ctx, "group", group.id) as Array<{ owner_user_id?: number }>;
                chatBots[`group:${group.id}`] = Array.isArray(list) ? list : [];
                if (Array.isArray(list) && list.some(b => b.owner_user_id === myId)) hasOwnedChatBots = true;
              } catch {
                chatBots[`group:${group.id}`] = [];
              }
            }
          }),
        ]);
        if (ctx) botWorker.setActive(hasOwnedChatBots);
        const visibleLocalById = new Map<string, BotRecord>();
        for (const bot of deps.store.bots) {
          if (!bot.hidden && !isExternalCodingAgentBot(bot)) visibleLocalById.set(bot.id, bot);
        }
        if (ctx && hasOwnedChatBots) {
          const appearances = new Map<string, CollabChatBotAppearance>();
          const dirty = new Map<string, CollabChatBotAppearance>();
          for (const list of Object.values(chatBots)) {
            if (!Array.isArray(list)) continue;
            for (let i = 0; i < list.length; i += 1) {
              const entry = list[i] as DoneBotCollabChatBot;
              if (entry.owner_user_id !== myId || entry.installation_id !== identity.installation_id) continue;
              const localBot = visibleLocalById.get(entry.local_bot_id);
              if (!localBot) continue;
              let appearance = appearances.get(localBot.id);
              if (!appearance) {
                appearance = buildCollabChatBotAppearance(localBot);
                appearances.set(localBot.id, appearance);
              }
              if (chatBotNeedsSync(entry, appearance)) {
                dirty.set(localBot.id, appearance);
                list[i] = { ...entry, ...appearance };
              }
            }
          }
          if (dirty.size > 0) {
            await collabSyncChatBots(
              ctx,
              identity.installation_id,
              [...dirty.values()].slice(0, 50) as unknown as Record<string, unknown>[],
            ).catch(() => {});
          }
        }
        const localBots = deps.store.bots
          .filter(bot => !bot.hidden && !isExternalCodingAgentBot(bot))
          .map(bot => {
            const collected = deps.collectTeamSkills([bot], "all");
            const skillCount = collected.ok ? (collected.skillsByBot.get(bot.id)?.length ?? 0) : 0;
            const avatar = botAvatarProfile(bot);
            return {
              id: bot.id,
              name: bot.name,
              title: bot.title ?? "",
              description: bot.description ?? "",
              color: bot.color,
              avatar_url: avatar.avatarCrop !== "mascot" ? avatar.avatarUrl : undefined,
              avatar_crop: avatar.avatarCrop,
              avatar_zoom: clampAvatarZoom(bot.avatarZoom ?? 1),
              avatar_focus_x: clampAvatarFocus(bot.avatarFocusX ?? 0.5),
              avatar_focus_y: clampAvatarFocus(bot.avatarFocusY ?? 0.5),
              mascot_body: bot.mascotBody ?? undefined,
              mascot_face_color: bot.mascotFaceColor ?? undefined,
              mascot_expression: bot.mascotExpression ?? undefined,
              has_soul: Boolean(bot.soul && bot.soul.trim()),
              skill_count: skillCount,
            };
          });
        return json(res, 200, {
          identity: {
            ...identity,
            ...(nickname ? { nickname } : {}),
            ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
          },
          friends,
          folders,
          bots,
          teams: teamList,
          groups: groupList,
          chat_bots: chatBots,
          team_capabilities: workspaces?.capabilities ?? [],
          team_members: teamMembers,
          team_channels: teamChannels,
          team_member_profiles: teamMemberProfiles,
          team_task_counts: Array.isArray(taskCounts) ? taskCounts : [],
          incoming_team_invitations: incomingInvitations,
          chat_summaries: Array.isArray(chatSummaries) ? chatSummaries : [],
          local_bots: localBots,
        });
      }

      const chatMessagesGet = reqPath.match(/^\/api\/donebot\/collab\/chats\/(friend|team|group|channel)\/([^/]+)\/messages$/);
      if (method === "GET" && chatMessagesGet) {
        const [, scopeType, targetId] = chatMessagesGet;
        if (!scopeType || !targetId || !validChatTarget(scopeType, targetId)) {
          return json(res, 400, { error: "无效的聊天对象。" });
        }
        const params = new URLSearchParams();
        for (const key of ["after_id", "before_id", "limit"]) {
          const val = url.searchParams.get(key);
          if (val && /^\d+$/.test(val)) params.set(key, val);
        }
        return json(res, 200, await gateway.collabChatMessages(scopeType, targetId, params.toString()));
      }

      const chatFilesGet = reqPath.match(/^\/api\/donebot\/collab\/chats\/(friend|team|group|channel)\/([^/]+)\/files$/);
      if (method === "GET" && chatFilesGet) {
        const [, scopeType, targetId] = chatFilesGet;
        if (!scopeType || !targetId || !validChatTarget(scopeType, targetId)) {
          return json(res, 400, { error: "无效的聊天对象。" });
        }
        return json(res, 200, await gateway.collabChatFiles(scopeType, targetId));
      }

      if ((method === "GET" || method === "DELETE") && (reqPath.startsWith("/api/donebot/collab/groups") || reqPath.includes("/bots"))) {
        const handled = await handleCollabGroupReadOrDelete({ method, reqPath, gateway, res, json });
        if (handled !== PASS) return handled;
      }

      if (method === "GET" || method === "DELETE") {
        const wsReadHandled = await handleCollabWorkspaceReadOrDelete({ method, reqPath, url, gateway, res, json });
        if (wsReadHandled !== PASS) return wsReadHandled;
      }

      const teamInvList = reqPath.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/invitations$/);
      if (method === "GET" && teamInvList) {
        return json(res, 200, await gateway.collabTeamInvitations(teamInvList[1]!));
      }

      if (method === "GET" && reqPath === "/api/donebot/collab/folders") {
        return json(res, 200, await gateway.collabFolders());
      }

      if (method === "GET" && reqPath === "/api/donebot/collab/bots") {
        return json(res, 200, await gateway.collabBots());
      }

      if (method === "DELETE") {
        const friendDel = reqPath.match(/^\/api\/donebot\/collab\/friends\/([1-9]\d{0,18})$/);
        if (friendDel) return json(res, 200, await gateway.collabRemoveFriend(Number(friendDel[1])));
        const folderDel = reqPath.match(/^\/api\/donebot\/collab\/folders\/([0-9a-f-]{36})$/);
        if (folderDel) return json(res, 200, await gateway.collabDeleteFolder(folderDel[1]!));
        const botDel = reqPath.match(/^\/api\/donebot\/collab\/bots\/([0-9a-f-]{36})$/);
        if (botDel) return json(res, 200, await gateway.collabDeleteBot(botDel[1]!));
        return PASS;
      }

      if (method !== "POST" && method !== "PUT" && method !== "PATCH") return PASS;
      const body = await readBody(req, 4 * 1024 * 1024);

      if (method === "PUT" && reqPath === "/api/donebot/collab/profile") {
        const parsed = profileUpdateSchema.safeParse(body);
        if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "请填写有效的昵称或头像图片。");
        if (parsed.data.avatar_url !== undefined && parsed.data.avatar_url !== "" && !INLINE_AVATAR_DATA_URL.test(parsed.data.avatar_url.trim())) {
          throw new DoneBotGatewayError(400, "invalid_avatar", "头像仅支持 PNG、JPEG 或 WebP 图片。");
        }
        const payload: { username?: string; avatar_url?: string } = {};
        if (parsed.data.nickname !== undefined) payload.username = parsed.data.nickname;
        if (parsed.data.avatar_url !== undefined) payload.avatar_url = parsed.data.avatar_url.trim();
        const updated = await gateway.collabUpdateProfile(payload);
        const identity = await gateway.collabIdentity();
        const nextNickname = typeof updated?.username === "string" ? updated.username.trim() : (parsed.data.nickname ?? "");
        const nextAvatar = typeof updated?.avatar_url === "string" ? updated.avatar_url.trim() : (parsed.data.avatar_url ?? "");
        const localAvatar = parsed.data.avatar_url !== undefined ? storeLocalAvatarFromDataUrl(parsed.data.avatar_url) : undefined;
        if (deps.syncLocalProfile) {
          try {
            deps.syncLocalProfile({
              ...(parsed.data.nickname !== undefined ? { name: nextNickname } : {}),
              ...(localAvatar !== undefined ? { avatarUrl: localAvatar } : {}),
              email: identity.email,
            });
          } catch { /* Best-effort local profile sync */ }
        }
        return json(res, 200, {
          email: identity.email,
          nickname: nextNickname,
          avatar_url: nextAvatar,
          ...(localAvatar !== undefined ? { local_avatar_url: localAvatar } : {}),
        });
      }

      const chatSendPost = reqPath.match(/^\/api\/donebot\/collab\/chats\/(friend|team|group|channel)\/([^/]+)\/messages$/);
      if (method === "POST" && chatSendPost) {
        const [, scopeType, targetId] = chatSendPost;
        if (!scopeType || !targetId || !validChatTarget(scopeType, targetId)) {
          return json(res, 400, { error: "无效的聊天对象。" });
        }
        const parsed = chatMessageSchema.safeParse(body);
        if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "消息内容不能为空且不超过 8000 字。");
        const sent = await gateway.collabSendChatMessage(scopeType, targetId, parsed.data.body, parsed.data.mention_bot_ids) as { triggered_bot_ids?: string[] };
        if (Array.isArray(sent?.triggered_bot_ids) && sent.triggered_bot_ids.length > 0 && typeof gateway.collabCtx === "function") {
          botWorker.kick();
        }
        return json(res, 200, sent);
      }

      const chatReadPost = reqPath.match(/^\/api\/donebot\/collab\/chats\/(friend|team|group|channel)\/([^/]+)\/read$/);
      if (method === "POST" && chatReadPost) {
        const [, scopeType, targetId] = chatReadPost;
        if (!scopeType || !targetId || !validChatTarget(scopeType, targetId)) {
          return json(res, 400, { error: "无效的聊天对象。" });
        }
        const parsed = chatReadSchema.safeParse(body ?? {});
        if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "无效的已读标记。");
        return json(res, 200, await gateway.collabMarkChatRead(scopeType, targetId, parsed.data.last_read_id));
      }

      const groupWriteHandled = await handleCollabGroupWrite({
        method,
        reqPath,
        body,
        gateway,
        store: deps.store,
        activateBotWorker: () => botWorker.setActive(true),
        res,
        json,
      });
      if (groupWriteHandled !== PASS) return groupWriteHandled;

      const wsWriteHandled = await handleCollabWorkspaceWrite({
        method,
        reqPath,
        body,
        gateway,
        res,
        json,
      });
      if (wsWriteHandled !== PASS) return wsWriteHandled;

      const friendRemark = reqPath.match(/^\/api\/donebot\/collab\/friends\/([1-9]\d{0,18})\/remark$/);
      if (method === "PUT" && friendRemark) {
        const parsed = friendRemarkSchema.safeParse(body);
        if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "好友备注最多 64 个字符。");
        return json(res, 200, await gateway.collabSetFriendRemark(Number(friendRemark[1]), parsed.data.remark));
      }

      if (method === "POST" && reqPath === "/api/donebot/collab/friends/request") {
        const parsed = z.object({ email: z.string().trim().min(3).max(254), note: z.string().max(200).optional() }).strict().safeParse(body);
        if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "请输入有效的好友账号邮箱。");
        return json(res, 200, await gateway.collabSendFriendRequest(parsed.data.email, parsed.data.note ?? ""));
      }

      const friendReqAction = reqPath.match(/^\/api\/donebot\/collab\/friends\/requests\/([0-9a-f-]{36})\/(accept|reject)$/);
      if (method === "POST" && friendReqAction) {
        const [, id, action] = friendReqAction;
        return json(res, 200, action === "accept"
          ? await gateway.collabAcceptFriendRequest(id!)
          : await gateway.collabRejectFriendRequest(id!));
      }

      const teamInvAction = reqPath.match(/^\/api\/donebot\/collab\/teams\/invitations\/([0-9a-f-]{36})\/(accept|decline)$/);
      if (method === "POST" && teamInvAction) {
        const [, id, action] = teamInvAction;
        return json(res, 200, action === "accept"
          ? await gateway.collabAcceptTeamInvitation(id!)
          : await gateway.collabDeclineTeamInvitation(id!));
      }

      const teamLeave = reqPath.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/leave$/);
      if (method === "POST" && teamLeave) {
        return json(res, 200, await gateway.collabLeaveTeam(teamLeave[1]!));
      }

      if (method === "POST" && reqPath === "/api/donebot/collab/folders") {
        const parsed = saveFolderSchema.safeParse(body);
        if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "无效的共享文件夹配置。");
        return json(res, 200, await gateway.collabSaveFolder(parsed.data));
      }

      const folderPut = reqPath.match(/^\/api\/donebot\/collab\/folders\/([0-9a-f-]{36})$/);
      if (method === "PUT" && folderPut) {
        const parsed = saveFolderSchema.safeParse(body);
        if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "无效的共享文件夹权限配置。");
        return json(res, 200, await gateway.collabSaveFolder(parsed.data, folderPut[1]!));
      }

      const folderInvoke = reqPath.match(/^\/api\/donebot\/collab\/folders\/([0-9a-f-]{36})\/invoke$/);
      if (method === "POST" && folderInvoke) {
        const parsed = invokeFolderSchema.safeParse(body);
        if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "不支持的远程文件夹操作。");
        return json(res, 200, await gateway.collabInvokeFolder(folderInvoke[1]!, parsed.data));
      }

      if (method === "POST" && reqPath === "/api/donebot/collab/relay/poll") {
        return json(res, 200, await gateway.collabRelayPoll());
      }

      if (method === "POST" && reqPath === "/api/donebot/collab/relay/result") {
        const parsed = z.object({ job_id: z.string().min(1).max(128), result: z.unknown() }).strict().safeParse(body);
        if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "无效的中继结果。");
        return json(res, 200, await gateway.collabRelayResult(parsed.data.job_id, parsed.data.result));
      }

      if (method === "POST" && reqPath === "/api/donebot/collab/bots/share") {
        const parsed = shareBotSchema.safeParse(body);
        if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "请选择要共享的 Bot 和授权对象。");
        const bot = deps.store.bot(parsed.data.bot_id);
        if (!bot || bot.hidden) throw new DoneBotGatewayError(404, "bot_not_found", "未找到该 Bot。");
        if (isExternalCodingAgentBot(bot)) throw new DoneBotGatewayError(403, "coding_agent_share_forbidden", EXTERNAL_CODING_AGENT_SHARE_REFUSAL);
        const identity = await gateway.collabIdentity();
        const payload = buildBotSharePayload(deps, bot, identity.email);
        return json(res, 200, await gateway.collabSaveBot({
          ...(parsed.data.id ? { id: parsed.data.id } : {}),
          ...payload,
          grants: parsed.data.grants,
        }, parsed.data.id));
      }

      const botPut = reqPath.match(/^\/api\/donebot\/collab\/bots\/([0-9a-f-]{36})$/);
      if (method === "PUT" && botPut) {
        const parsed = updateSharedBotSchema.safeParse(body);
        if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "无效的共享 Bot 权限配置。");
        const payload: Record<string, unknown> = { grants: parsed.data.grants };
        if (parsed.data.bot_id) {
          const bot = deps.store.bot(parsed.data.bot_id);
          if (bot && !bot.hidden) {
            if (isExternalCodingAgentBot(bot)) throw new DoneBotGatewayError(403, "coding_agent_share_forbidden", EXTERNAL_CODING_AGENT_SHARE_REFUSAL);
            const identity = await gateway.collabIdentity();
            Object.assign(payload, buildBotSharePayload(deps, bot, identity.email));
          }
        }
        if (parsed.data.name) payload.name = parsed.data.name;
        if (parsed.data.title !== undefined) payload.title = parsed.data.title;
        if (parsed.data.description !== undefined) payload.description = parsed.data.description;
        return json(res, 200, await gateway.collabSaveBot(payload, botPut[1]!));
      }

      const botInstall = reqPath.match(/^\/api\/donebot\/collab\/bots\/([0-9a-f-]{36})\/install$/);
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
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof DoneBotGatewayError) return json(res, error.status, { error: error.message, code: error.code });
      if (error instanceof TeamExportError || error instanceof PackageImportError) return json(res, error.status, { error: error.message });
      return json(res, 502, { error: error instanceof Error ? error.message : "远程协作请求失败，请稍后重试。" });
    }
  };
}

export { handleDoneBotCollabInternal } from "./collab-internal.ts";
