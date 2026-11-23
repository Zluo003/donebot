import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { DONEBOT_COLLAB_MAX_FILE_BYTES } from "../../shared/donebot-collab.ts";
import { PASS } from "../routes/table.ts";
import {
  collabAddTeamTaskComment,
  collabBotReviewTeamTask,
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
import { listTaskBindings, removeTaskBinding, saveTaskBinding } from "./collab-task-bindings.ts";
import { getCollabTaskPrefs, saveCollabTaskPrefs } from "./collab-task-prefs.ts";
import type { CollabTaskDispatchInput, CollabTaskDispatchResult } from "./collab-task-dispatch.ts";
import { DoneBotGatewayError, type DoneBotGateway } from "./gateway.ts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const taskStatusEnum = z.enum([
  "todo",
  "in_progress",
  "in_review",
  "bot_reviewing",
  "bot_revising",
  "ready_for_review",
  "changes_requested",
  "blocked",
  "done",
]);
const taskPriorityEnum = z.enum(["low", "normal", "high", "urgent"]);
const actorKindEnum = z.enum(["user", "bot"]);

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
  acceptance_criteria: z.array(z.string().trim().min(1).max(240)).max(12).default([]),
  priority: taskPriorityEnum.default("normal"),
  assignee_id: positiveInt.nullable().optional(),
  reviewer_id: positiveInt.nullable().optional(),
  collaborator_ids: z.array(positiveInt).max(50).default([]),
  due_at: z.string().max(40).nullable().optional(),
  auto_review_enabled: z.boolean().default(true),
  max_auto_revisions: z.number().int().min(0).max(5).default(2),
  assignee_auto_resubmit: z.boolean().default(true),
  source_scope_type: z.enum(["", "team", "channel"]).default(""),
  source_target_id: z.string().max(64).default(""),
  source_message_id: positiveInt.nullable().optional(),
  source_quote: z.string().max(1000).default(""),
  notify_channel: z.boolean().default(true),
  actor_kind: actorKindEnum.optional(),
  actor_bot_name: z.string().max(120).optional(),
}).strict();

const updateTaskSchema = z.object({
  channel_id: z.string().max(64).optional(),
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().max(8000).optional(),
  acceptance_criteria: z.array(z.string().trim().min(1).max(240)).max(12).optional(),
  status: taskStatusEnum.optional(),
  priority: taskPriorityEnum.optional(),
  assignee_id: positiveInt.optional(),
  clear_assignee: z.boolean().optional(),
  reviewer_id: positiveInt.optional(),
  clear_reviewer: z.boolean().optional(),
  collaborator_ids: z.array(positiveInt).max(50).optional(),
  due_at: z.string().max(40).optional(),
  clear_due_at: z.boolean().optional(),
  auto_review_enabled: z.boolean().optional(),
  max_auto_revisions: z.number().int().min(0).max(5).optional(),
  assignee_auto_resubmit: z.boolean().optional(),
  note: z.string().max(1000).optional(),
}).strict();

const commentSchema = z.object({
  body: z.string().trim().min(1).max(8000),
}).strict();

const submitTaskSchema = z.object({
  body: z.string().max(8000).default(""),
  batch_id: z.string().max(64).optional(),
  notify_channel: z.boolean().default(true),
  actor_kind: actorKindEnum.optional(),
  actor_bot_name: z.string().max(120).optional(),
}).strict();

const reviewTaskSchema = z.object({
  decision: z.enum(["approve", "request_changes"]),
  body: z.string().max(8000).default(""),
  notify_channel: z.boolean().default(true),
  actor_kind: actorKindEnum.optional(),
  actor_bot_name: z.string().max(120).optional(),
}).strict();

const botReviewTaskSchema = z.object({
  verdict: z.enum(["pass", "hard_fail", "escalate"]),
  summary: z.string().max(8000).default(""),
  passed_items: z.array(z.string().max(240)).max(20).default([]),
  attention_items: z.array(z.string().max(240)).max(20).default([]),
  failed_criteria: z.array(z.string().max(240)).max(20).default([]),
  actionable_fixes: z.array(z.string().max(400)).max(20).default([]),
  batch_id: z.string().max(64).optional(),
  bot_name: z.string().max(120).optional(),
  notify_channel: z.boolean().default(true),
}).strict();

const saveBindingSchema = z.object({
  teamId: z.string().regex(uuidPattern),
  teamName: z.string().max(120).default(""),
  taskId: z.string().regex(uuidPattern),
  taskTitle: z.string().max(160).default(""),
  botId: z.string().trim().min(1).max(128),
  threadId: z.string().trim().min(1).max(128),
  chiefBotId: z.string().trim().min(1).max(128).optional(),
  chiefThreadId: z.string().trim().min(1).max(128).optional(),
  workerBotId: z.string().trim().min(1).max(128).optional(),
  workerThreadId: z.string().trim().min(1).max(128).optional(),
}).strict();

const updateTaskPrefsSchema = z.object({
  chief_auto_submit_on_approve: z.boolean().optional(),
}).strict();

const dispatchViaBotSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  channel_id: z.string().max(64).optional(),
  source_quote: z.string().max(1000).optional(),
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
  kickTaskWorker?: () => void;
}): Promise<typeof PASS | undefined> {
  const { req, res, url, reqPath, method, gateway, json, helpers, kickTaskWorker } = opts;

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
    const batchId = (url.searchParams.get("batch_id") ?? "").trim();
    if (batchId) params.set("batch_id", batchId.slice(0, 64));
    const finalize = (url.searchParams.get("finalize") ?? "").trim();
    if (finalize === "0" || finalize === "1") params.set("finalize", finalize);
    const actorKind = (url.searchParams.get("actor_kind") ?? "").trim();
    if (actorKind === "user" || actorKind === "bot") params.set("actor_kind", actorKind);
    const actorBotName = (url.searchParams.get("actor_bot_name") ?? "").trim();
    if (actorBotName) params.set("actor_bot_name", actorBotName.slice(0, 120));

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
      if (kind === "submission" && finalize !== "0") kickTaskWorker?.();
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
    if (reqPath === "/api/donebot/collab/task-bindings") {
      json(res, 200, { bindings: listTaskBindings() });
      return undefined;
    }

    if (reqPath === "/api/donebot/collab/task-prefs") {
      json(res, 200, getCollabTaskPrefs());
      return undefined;
    }

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
    const bindingDel = reqPath.match(/^\/api\/donebot\/collab\/task-bindings\/([0-9a-f-]{36})$/);
    if (bindingDel) {
      removeTaskBinding(bindingDel[1]!);
      json(res, 200, { ok: true });
      return undefined;
    }

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
  kickTaskWorker?: () => void;
  dispatchViaChiefBot?: (teamId: string, input: CollabTaskDispatchInput) => Promise<CollabTaskDispatchResult>;
}): Promise<typeof PASS | undefined> {
  const { method, reqPath, body, gateway, res, json, kickTaskWorker, dispatchViaChiefBot } = opts;

  const taskDispatchPost = reqPath.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/tasks\/dispatch-via-bot$/);
  if (method === "POST" && taskDispatchPost) {
    if (!dispatchViaChiefBot) {
      throw new DoneBotGatewayError(503, "dispatch_unavailable", "本机主协调助手调度未就绪。");
    }
    const parsed = dispatchViaBotSchema.safeParse(body);
    if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "请输入 1-4000 字的任务派发需求。");
    json(res, 200, await dispatchViaChiefBot(taskDispatchPost[1]!, parsed.data));
    return undefined;
  }

  if (method === "POST" && reqPath === "/api/donebot/collab/task-bindings") {
    const parsed = saveBindingSchema.safeParse(body);
    if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "无效的任务助手绑定参数。");
    json(res, 200, { binding: saveTaskBinding(parsed.data) });
    return undefined;
  }

  if (method === "PATCH" && reqPath === "/api/donebot/collab/task-prefs") {
    const parsed = updateTaskPrefsSchema.safeParse(body);
    if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "无效的协作自动化配置参数。");
    json(res, 200, saveCollabTaskPrefs(parsed.data));
    return undefined;
  }

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
    const created = await collabCreateTeamTask(gateway.collabCtx(), taskPost[1]!, parsed.data);
    kickTaskWorker?.();
    json(res, 200, created);
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
    const submitted = await collabSubmitTeamTask(gateway.collabCtx(), taskSubmitPost[1]!, taskSubmitPost[2]!, parsed.data);
    kickTaskWorker?.();
    json(res, 200, submitted);
    return undefined;
  }

  const taskReviewPost = reqPath.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/tasks\/([0-9a-f-]{36})\/review$/);
  if (method === "POST" && taskReviewPost) {
    const parsed = reviewTaskSchema.safeParse(body);
    if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "验收操作参数无效。");
    const reviewed = await collabReviewTeamTask(gateway.collabCtx(), taskReviewPost[1]!, taskReviewPost[2]!, parsed.data);
    kickTaskWorker?.();
    json(res, 200, reviewed);
    return undefined;
  }

  const taskBotReviewPost = reqPath.match(/^\/api\/donebot\/collab\/teams\/([0-9a-f-]{36})\/tasks\/([0-9a-f-]{36})\/bot-review$/);
  if (method === "POST" && taskBotReviewPost) {
    const parsed = botReviewTaskSchema.safeParse(body);
    if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "Bot 审阅参数无效。");
    const reviewed = await collabBotReviewTeamTask(gateway.collabCtx(), taskBotReviewPost[1]!, taskBotReviewPost[2]!, parsed.data);
    kickTaskWorker?.();
    json(res, 200, reviewed);
    return undefined;
  }

  return PASS;
}
