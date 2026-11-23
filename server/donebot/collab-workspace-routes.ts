import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { DONEBOT_COLLAB_MAX_FILE_BYTES } from "../../shared/donebot-collab.ts";
import { PASS } from "../routes/table.ts";
import {
  collabAddTeamTaskComment,
  collabCreateTeamChannel,
  collabCreateTeamTask,
  collabDeleteTeamTask,
  collabDownloadTeamTaskFile,
  collabGetTeamTaskDetail,
  collabListTeamChannels,
  collabListTeamMemberProfiles,
  collabListTeamTasks,
  collabReviewTeamTask,
  collabSetTeamMemberJobTitle,
  collabSubmitTeamTask,
  collabTeamTaskCounts,
  collabUpdateTeamChannel,
  collabUpdateTeamTask,
  collabUploadTeamTaskFile,
} from "./collab-gateway.ts";
import { DoneBotGatewayError, type DoneBotGateway } from "./gateway.ts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const taskStatusEnum = z.enum(["todo", "in_progress", "in_review", "changes_requested", "blocked", "done"]);
const taskPriorityEnum = z.enum(["low", "normal", "high", "urgent"]);

const createChannelSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(200).default(""),
  is_private: z.boolean().default(false),
  member_ids: z.array(positiveInt).max(200).default([]),
}).strict();

const updateChannelSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().max(200).optional(),
  is_private: z.boolean().optional(),
  member_ids: z.array(positiveInt).max(200).optional(),
  archived: z.boolean().optional(),
}).strict();

const jobTitleSchema = z.object({
  job_title: z.string().max(40),
}).strict();

const createTaskSchema = z.object({
  channel_id: z.string().max(64).default(""),
  title: z.string().trim().min(1).max(160),
  description: z.string().max(8000).default(""),
  priority: taskPriorityEnum.default("normal"),
  assignee_id: positiveInt.nullable().optional(),
  reviewer_id: positiveInt.nullable().optional(),
  collaborator_ids: z.array(positiveInt).max(50).default([]),
  due_at: z.string().max(40).nullable().optional(),
  source_scope_type: z.enum(["", "team", "channel"]).default(""),
  source_target_id: z.string().max(64).default(""),
  source_message_id: positiveInt.nullable().optional(),
  source_quote: z.string().max(1000).default(""),
  notify_channel: z.boolean().default(true),
}).strict();

const updateTaskSchema = z.object({
  channel_id: z.string().max(64).optional(),
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().max(8000).optional(),
  status: taskStatusEnum.optional(),
  priority: taskPriorityEnum.optional(),
  assignee_id: positiveInt.optional(),
  clear_assignee: z.boolean().optional(),
  reviewer_id: positiveInt.optional(),
  clear_reviewer: z.boolean().optional(),
  collaborator_ids: z.array(positiveInt).max(50).optional(),
  due_at: z.string().max(40).optional(),
  clear_due_at: z.boolean().optional(),
  note: z.string().max(1000).optional(),
}).strict();

const commentSchema = z.object({
  body: z.string().trim().min(1).max(8000),
}).strict();

const submitTaskSchema = z.object({
  body: z.string().max(8000).default(""),
  notify_channel: z.boolean().default(true),
}).strict();

const reviewTaskSchema = z.object({
  decision: z.enum(["approve", "request_changes"]),
  body: z.string().max(8000).default(""),
  notify_channel: z.boolean().default(true),
}).strict();

export interface CollabStreamHelpers {
  boundedRequestWebStream: (req: IncomingMessage, maxBytes: number) => ReadableStream<Uint8Array>;
  readUpstreamError: (response: Response, fallback: string) => Promise<string>;
  pipeUpstreamStream: (
    upstream: Response,
    res: ServerResponse,
    json: (res: ServerResponse, status: number, value: unknown) => void,
    fallbackError: string,
    extraHeaders: string[],
  ) => Promise<void>;
}

export async function handleCollabWorkspaceStreams(opts: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  reqPath: string;
  method: string;
  gateway: DoneBotGateway;
  json: (res: ServerResponse, status: number, value: unknown) => void;
  helpers: CollabStreamHelpers;
}): Promise<typeof PASS | undefined> {
  const { req, res, url, reqPath, method, gateway, json, helpers } = opts;

  const taskFileDownload = reqPath.match(/^\/api\/donebot\/collab\/tasks\/files\/([0-9a-f-]{36})$/);
  if (taskFileDownload && method === "GET") {
    const inline = url.searchParams.get("inline") === "1";
    const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
    const abort = new AbortController();
    const onClose = () => abort.abort();
    res.once("close", onClose);
    try {
      const upstream = await collabDownloadTeamTaskFile(gateway.collabCtx(), taskFileDownload[1]!, inline, abort.signal, range);
      await helpers.pipeUpstreamStream(upstream, res, json, "下载任务附件失败。", [
        "Content-Type", "Content-Disposition", "Content-Length", "Accept-Ranges", "Content-Range", "X-File-Sha256",
      ]);
    } finally {
      res.off("close", onClose);
    }
    return undefined;
  }

  const taskFileUpload = reqPath.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/tasks\/([0-9a-f-]{36})\/files$/);
  if (taskFileUpload && method === "POST") {
    const [, teamId, taskId] = taskFileUpload;
    if (!teamId || !taskId || !uuidPattern.test(teamId) || !uuidPattern.test(taskId)) {
      json(res, 400, { error: "无效的任务标识。" });
      return undefined;
    }
    const rawLen = req.headers["content-length"];
    const parsedLen = typeof rawLen === "string" && /^\d+$/.test(rawLen) ? Number(rawLen) : -1;
    if (parsedLen > DONEBOT_COLLAB_MAX_FILE_BYTES) {
      json(res, 413, { error: "上传的文件不能超过 100 MB。" });
      return undefined;
    }
    const params = new URLSearchParams();
    const kind = (url.searchParams.get("kind") ?? "submission").trim();
    if (kind === "comment" || kind === "submission") params.set("kind", kind);
    const fileName = (url.searchParams.get("name") ?? "").trim();
    if (fileName) params.set("name", fileName.slice(0, 240));
    const caption = (url.searchParams.get("body") ?? "").trim();
    if (caption) params.set("body", caption.slice(0, 2000));
    if (url.searchParams.get("notify_channel") === "1") params.set("notify_channel", "1");

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
      const upstream = await collabUploadTeamTaskFile(
        gateway.collabCtx(),
        teamId,
        taskId,
        params.toString(),
        helpers.boundedRequestWebStream(req, DONEBOT_COLLAB_MAX_FILE_BYTES),
        headers,
        abort.signal,
      );
      if (!upstream.ok) {
        json(res, upstream.status >= 400 ? upstream.status : 502, {
          error: await helpers.readUpstreamError(upstream, "上传任务交付物失败。"),
        });
        return undefined;
      }
      const payload = await upstream.json() as { code?: number; data?: unknown };
      json(res, 200, payload?.code === 0 && "data" in payload ? payload.data : payload);
    } finally {
      req.off("aborted", onClose);
    }
    return undefined;
  }

  return PASS;
}

export async function handleCollabWorkspaceReadOrDelete(opts: {
  method: string;
  reqPath: string;
  url: URL;
  gateway: DoneBotGateway;
  res: ServerResponse;
  json: (res: ServerResponse, status: number, value: unknown) => void;
}): Promise<typeof PASS | undefined> {
  const { method, reqPath, url, gateway, res, json } = opts;

  if (method === "GET") {
    if (reqPath === "/api/donebot/collab/tasks/counts") {
      json(res, 200, await collabTeamTaskCounts(gateway.collabCtx()));
      return undefined;
    }

    const channelsGet = reqPath.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/channels$/);
    if (channelsGet) {
      const includeArchived = url.searchParams.get("include_archived") === "1";
      json(res, 200, await collabListTeamChannels(gateway.collabCtx(), channelsGet[1]!, includeArchived));
      return undefined;
    }

    const profilesGet = reqPath.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/member-profiles$/);
    if (profilesGet) {
      json(res, 200, await collabListTeamMemberProfiles(gateway.collabCtx(), profilesGet[1]!));
      return undefined;
    }

    const tasksGet = reqPath.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/tasks$/);
    if (tasksGet) {
      const params = new URLSearchParams();
      for (const key of ["channel_id", "status", "scope"]) {
        const val = (url.searchParams.get(key) ?? "").trim();
        if (val) params.set(key, val);
      }
      json(res, 200, await collabListTeamTasks(gateway.collabCtx(), tasksGet[1]!, params.toString()));
      return undefined;
    }

    const taskDetailGet = reqPath.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/tasks\/([0-9a-f-]{36})$/);
    if (taskDetailGet) {
      json(res, 200, await collabGetTeamTaskDetail(gateway.collabCtx(), taskDetailGet[1]!, taskDetailGet[2]!));
      return undefined;
    }

    return PASS;
  }

  if (method === "DELETE") {
    const taskDel = reqPath.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/tasks\/([0-9a-f-]{36})$/);
    if (taskDel) {
      json(res, 200, await collabDeleteTeamTask(gateway.collabCtx(), taskDel[1]!, taskDel[2]!));
      return undefined;
    }
  }

  return PASS;
}

export async function handleCollabWorkspaceWrite(opts: {
  method: string;
  reqPath: string;
  body: unknown;
  gateway: DoneBotGateway;
  res: ServerResponse;
  json: (res: ServerResponse, status: number, value: unknown) => void;
}): Promise<typeof PASS | undefined> {
  const { method, reqPath, body, gateway, res, json } = opts;

  const channelPost = reqPath.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/channels$/);
  if (method === "POST" && channelPost) {
    const parsed = createChannelSchema.safeParse(body);
    if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "请输入 1-60 字的有效频道名称。");
    json(res, 200, await collabCreateTeamChannel(gateway.collabCtx(), channelPost[1]!, parsed.data));
    return undefined;
  }

  const channelPatch = reqPath.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/channels\/([0-9a-f-]{36})$/);
  if (method === "PATCH" && channelPatch) {
    const parsed = updateChannelSchema.safeParse(body);
    if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "频道修改参数无效。");
    json(res, 200, await collabUpdateTeamChannel(gateway.collabCtx(), channelPatch[1]!, channelPatch[2]!, parsed.data));
    return undefined;
  }

  const memberProfilePut = reqPath.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/members\/([1-9]\d{0,18})\/profile$/);
  if (method === "PUT" && memberProfilePut) {
    const parsed = jobTitleSchema.safeParse(body);
    if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "岗位分工最多 40 个字符。");
    json(res, 200, await collabSetTeamMemberJobTitle(gateway.collabCtx(), memberProfilePut[1]!, Number(memberProfilePut[2]), parsed.data.job_title));
    return undefined;
  }

  const taskPost = reqPath.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/tasks$/);
  if (method === "POST" && taskPost) {
    const parsed = createTaskSchema.safeParse(body);
    if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "请填写 1-160 字的任务标题及有效分工信息。");
    json(res, 200, await collabCreateTeamTask(gateway.collabCtx(), taskPost[1]!, parsed.data));
    return undefined;
  }

  const taskPatch = reqPath.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/tasks\/([0-9a-f-]{36})$/);
  if (method === "PATCH" && taskPatch) {
    const parsed = updateTaskSchema.safeParse(body);
    if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "任务更新参数无效。");
    json(res, 200, await collabUpdateTeamTask(gateway.collabCtx(), taskPatch[1]!, taskPatch[2]!, parsed.data));
    return undefined;
  }

  const taskCommentPost = reqPath.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/tasks\/([0-9a-f-]{36})\/comments$/);
  if (method === "POST" && taskCommentPost) {
    const parsed = commentSchema.safeParse(body);
    if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "评论内容不能为空且不超过 8000 字。");
    json(res, 200, await collabAddTeamTaskComment(gateway.collabCtx(), taskCommentPost[1]!, taskCommentPost[2]!, parsed.data.body));
    return undefined;
  }

  const taskSubmitPost = reqPath.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/tasks\/([0-9a-f-]{36})\/submit$/);
  if (method === "POST" && taskSubmitPost) {
    const parsed = submitTaskSchema.safeParse(body ?? {});
    if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "提交验收说明格式无效。");
    json(res, 200, await collabSubmitTeamTask(gateway.collabCtx(), taskSubmitPost[1]!, taskSubmitPost[2]!, parsed.data));
    return undefined;
  }

  const taskReviewPost = reqPath.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/tasks\/([0-9a-f-]{36})\/review$/);
  if (method === "POST" && taskReviewPost) {
    const parsed = reviewTaskSchema.safeParse(body);
    if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "验收操作参数无效。");
    json(res, 200, await collabReviewTeamTask(gateway.collabCtx(), taskReviewPost[1]!, taskReviewPost[2]!, parsed.data));
    return undefined;
  }

  return PASS;
}
