import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { z } from "zod";
import {
  DONEBOT_COLLAB_MAX_FILE_BYTES,
  type DoneBotTeamChannel,
  type DoneBotTeamMemberProfile,
  type DoneBotTeamTask,
  type DoneBotTeamTaskDetail,
} from "../../shared/donebot-collab.ts";
import {
  collabBotReviewTeamTask,
  collabCreateTeamTask,
  collabDownloadTeamTaskFile,
  collabGetTeamTaskDetail,
  collabListTeamChannels,
  collabListTeamMemberProfiles,
  collabListTeamTasks,
  collabReviewTeamTask,
  collabSubmitTeamTask,
  collabUploadTeamTaskFile,
} from "./collab-gateway.ts";
import { getTaskBindingByThread, saveTaskBinding } from "./collab-task-bindings.ts";
import { DoneBotGatewayError, type DoneBotGateway } from "./gateway.ts";

const execFileAsync = promisify(execFile);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

type ThreadAttachmentInput = {
  path: string;
  name?: string;
  mime?: string;
  at?: number;
  messageText?: string;
};

type MediaPromptMeta = {
  jobId: string;
  model?: string;
  kind?: string;
  prompt?: string;
  createdAt?: number;
};

type MediaPromptLookup = (filePathOrName: string) => MediaPromptMeta | undefined;

type TaskRuntimeHooks = {
  resolveBotName?: (botId: string) => string;
  kickTaskWorker?: () => void;
  listThreadAttachments?: (threadId: string) => ThreadAttachmentInput[];
};
let runtimeHooks: TaskRuntimeHooks = {};
let mediaPromptLookup: MediaPromptLookup | undefined;

export function registerCollabTaskRuntimeHooks(hooks: TaskRuntimeHooks): void {
  runtimeHooks = hooks;
}

export function registerMediaPromptLookup(lookup: MediaPromptLookup | undefined): void {
  mediaPromptLookup = lookup;
}

const createToolSchema = z.object({
  team_id: z.string().regex(uuidPattern),
  channel_id: z.string().max(64).optional(),
  title: z.string().trim().min(1).max(160),
  description: z.string().max(8000).default(""),
  acceptance_criteria: z.array(z.string().trim().min(1).max(240)).max(12).default([]),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  assignee_id: positiveInt.nullable().optional(),
  reviewer_id: positiveInt.nullable().optional(),
  collaborator_ids: z.array(positiveInt).max(50).default([]),
  due_at: z.string().max(40).nullable().optional(),
  auto_review_enabled: z.boolean().default(true),
  max_auto_revisions: z.number().int().min(0).max(5).default(2),
  notify_channel: z.boolean().default(true),
  bot_id: z.string().max(128).optional(),
  thread_id: z.string().max(128).optional(),
}).strict();

const listToolSchema = z.object({
  team_id: z.string().regex(uuidPattern).optional(),
  channel_id: z.string().regex(uuidPattern).optional(),
  status: z.enum(["all", "open", "review_queue", "todo", "in_progress", "in_review", "bot_reviewing", "bot_revising", "ready_for_review", "changes_requested", "blocked", "done"]).default("open"),
  scope: z.enum(["all", "mine", "review", "created"]).default("all"),
  bot_id: z.string().max(128).optional(),
  thread_id: z.string().max(128).optional(),
}).strict();

const detailToolSchema = z.object({
  team_id: z.string().regex(uuidPattern).optional(),
  task_id: z.string().regex(uuidPattern).optional(),
  download_deliverables: z.boolean().default(false),
  bot_id: z.string().max(128).optional(),
  thread_id: z.string().max(128).optional(),
}).strict();

const submitToolSchema = z.object({
  team_id: z.string().regex(uuidPattern).optional(),
  task_id: z.string().regex(uuidPattern).optional(),
  brief: z.string().trim().min(1).max(8000),
  file_paths: z.array(z.string().trim().min(1).max(4096)).max(10).default([]),
  reuse_file_ids: z.array(z.string().trim().min(1).max(128)).max(10).default([]),
  notify_channel: z.boolean().default(true),
  bot_id: z.string().max(128).optional(),
  thread_id: z.string().max(128).optional(),
}).strict();

const reviewToolSchema = z.object({
  team_id: z.string().regex(uuidPattern),
  task_id: z.string().regex(uuidPattern),
  mode: z.enum(["bot_review", "human_decision"]),
  verdict: z.enum(["pass", "hard_fail", "escalate"]).optional(),
  decision: z.enum(["approve", "request_changes"]).optional(),
  summary: z.string().max(8000).default(""),
  passed_items: z.array(z.string().max(240)).max(20).default([]),
  attention_items: z.array(z.string().max(240)).max(20).default([]),
  failed_criteria: z.array(z.string().max(240)).max(20).default([]),
  actionable_fixes: z.array(z.string().max(300)).max(20).default([]),
  notify_channel: z.boolean().default(true),
  bot_id: z.string().max(128).optional(),
  thread_id: z.string().max(128).optional(),
}).strict();

export interface DownloadedDeliverableInfo {
  file_id: string;
  file_name: string;
  file_mime: string;
  file_size: number;
  local_path: string;
  dimensions?: { width: number; height: number; aspect_ratio: string };
  media_meta?: { duration_sec?: number; width?: number; height?: number; has_audio?: boolean };
  keyframe_paths?: string[];
  text_excerpt?: string;
}

function safeFileName(raw: string, fallback: string): string {
  const base = path.basename((raw || "").replace(/\\/g, "/")).replace(/[\0/\\:*?"<>|]/g, "_").trim();
  return base || fallback;
}

export function readImageDimensions(buf: Buffer): { width: number; height: number; aspect_ratio: string } | undefined {
  // PNG header
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width > 0 && height > 0) return { width, height, aspect_ratio: formatAspectRatio(width, height) };
  }
  // WebP header (VP8X / VP8 / VP8L)
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      const width = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
      const height = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
      if (width > 0 && height > 0) return { width, height, aspect_ratio: formatAspectRatio(width, height) };
    } else if (chunk === "VP8 " && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      if (width > 0 && height > 0) return { width, height, aspect_ratio: formatAspectRatio(width, height) };
    } else if (chunk === "VP8L" && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      if (width > 0 && height > 0) return { width, height, aspect_ratio: formatAspectRatio(width, height) };
    }
  }
  // JPEG SOF marker scan
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1]!;
      if (marker === 0xd9 || marker === 0xda) break;
      const len = buf.readUInt16BE(i + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb)) {
        const height = buf.readUInt16BE(i + 5);
        const width = buf.readUInt16BE(i + 7);
        if (width > 0 && height > 0) return { width, height, aspect_ratio: formatAspectRatio(width, height) };
      }
      if (len < 2) break;
      i += 2 + len;
    }
  }
  return undefined;
}

async function readImageDimensionsFromFile(filePath: string): Promise<{ width: number; height: number; aspect_ratio: string } | undefined> {
  const fh = await fs.open(filePath, "r").catch(() => null);
  if (!fh) return undefined;
  try {
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return bytesRead > 0 ? readImageDimensions(buf.subarray(0, bytesRead)) : undefined;
  } catch {
    return undefined;
  } finally {
    await fh.close().catch(() => {});
  }
}

async function readTextExcerptFromFile(filePath: string): Promise<string | undefined> {
  const fh = await fs.open(filePath, "r").catch(() => null);
  if (!fh) return undefined;
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead <= 0) return undefined;
    const text = buf.subarray(0, bytesRead).toString("utf8").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 320) : undefined;
  } catch {
    return undefined;
  } finally {
    await fh.close().catch(() => {});
  }
}

async function inspectThreadAttachments(raw: ThreadAttachmentInput[], submittedNames: ReadonlySet<string>) {
  const deduped = new Map<string, ThreadAttachmentInput>();
  for (const item of raw) {
    const p = item.path?.trim();
    if (!p) continue;
    deduped.delete(p);
    deduped.set(p, { ...item, path: p });
  }
  const recent = [...deduped.values()].slice(-12);
  const inspected = await Promise.all(recent.map(async item => {
    const stat = await fs.lstat(item.path).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) return null;
    const name = item.name || path.basename(item.path);
    const mime = item.mime || guessMimeByExt(item.path);
    const mimeLower = mime.toLowerCase();
    const isImg = mimeLower.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(item.path);
    const isAv = mimeLower.startsWith("video/") || mimeLower.startsWith("audio/") || /\.(mp4|mov|webm|mp3|wav|m4a|ogg|flac|aac)$/i.test(item.path);
    const isTextDoc = mimeLower.startsWith("text/") || mimeLower === "application/json" || /\.(md|txt|csv|json|yaml|yml|xml|html|srt|ts|js|py|sql)$/i.test(item.path);
    const [dimensions, mediaMeta, textExcerpt] = await Promise.all([
      isImg ? readImageDimensionsFromFile(item.path) : Promise.resolve(undefined),
      isAv ? probeMediaMetadata(item.path) : Promise.resolve(undefined),
      isTextDoc ? readTextExcerptFromFile(item.path) : Promise.resolve(undefined),
    ]);
    const meta = mediaPromptLookup?.(item.path) ?? mediaPromptLookup?.(name);
    const ts = item.at ?? meta?.createdAt;
    return {
      path: item.path,
      name,
      mime,
      size_bytes: stat.size,
      ...(dimensions ? { dimensions } : {}),
      ...(mediaMeta ? { media_meta: mediaMeta } : {}),
      ...(textExcerpt ? { text_excerpt: textExcerpt } : {}),
      ...(meta?.kind ? { media_kind: meta.kind } : {}),
      ...(meta?.prompt ? { prompt_excerpt: meta.prompt } : {}),
      ...(meta?.model ? { model: meta.model } : {}),
      ...(ts ? { at: ts, at_iso: new Date(ts).toISOString() } : {}),
      already_submitted_in_task: submittedNames.has(name),
      ...(item.messageText ? { source_text: item.messageText } : {}),
    };
  }));
  const valid = inspected.filter((x): x is NonNullable<typeof x> => x !== null);
  return valid.map((item, idx) => (idx === valid.length - 1 ? { ...item, is_latest: true } : item));
}

function formatAspectRatio(w: number, h: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(w, h) || 1;
  const rw = Math.round(w / g);
  const rh = Math.round(h / g);
  if (rw <= 32 && rh <= 32) return `${rw}:${rh}`;
  return `${(w / h).toFixed(2)}:1`;
}

async function probeMediaMetadata(localPath: string): Promise<{ duration_sec?: number; width?: number; height?: number; has_audio?: boolean } | undefined> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-show_format", "-show_streams", "-of", "json", localPath,
    ], { timeout: 6_000, maxBuffer: 512 * 1024 });
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
    };
    const video = parsed.streams?.find(s => s.codec_type === "video");
    const hasAudio = Boolean(parsed.streams?.some(s => s.codec_type === "audio"));
    const duration = parsed.format?.duration ? Number(parsed.format.duration) : undefined;
    return {
      ...(Number.isFinite(duration) ? { duration_sec: Math.round(duration! * 10) / 10 } : {}),
      ...(video?.width ? { width: video.width } : {}),
      ...(video?.height ? { height: video.height } : {}),
      has_audio: hasAudio,
    };
  } catch {
    return undefined;
  }
}

async function extractVideoKeyframes(localPath: string, outDir: string, durationSec?: number): Promise<string[]> {
  const frames: string[] = [];
  const marks = durationSec && durationSec > 2
    ? [Math.min(0.5, durationSec * 0.15), durationSec * 0.5, Math.max(0.5, durationSec * 0.85)]
    : [0.2];
  for (let idx = 0; idx < marks.length; idx += 1) {
    const outPath = path.join(outDir, `frame_${idx + 1}.jpg`);
    try {
      await execFileAsync("ffmpeg", [
        "-y", "-ss", marks[idx]!.toFixed(2), "-i", localPath,
        "-frames:v", "1", "-q:v", "4", outPath,
      ], { timeout: 8_000 });
      const stat = await fs.stat(outPath).catch(() => null);
      if (stat && stat.size > 0) frames.push(outPath);
    } catch {
      break;
    }
  }
  return frames;
}

export async function downloadDeliverablesToSandbox(
  gateway: DoneBotGateway,
  detail: DoneBotTeamTaskDetail,
): Promise<DownloadedDeliverableInfo[]> {
  const latestBatchId = detail.task.latest_submission_batch_id;
  const allSubmissions = detail.updates.filter(u => u.kind === "submission" && u.file_id);
  const targetFiles = latestBatchId
    ? allSubmissions.filter(u => u.batch_id === latestBatchId)
    : allSubmissions.slice(-5);
  const files = targetFiles.length > 0 ? targetFiles : allSubmissions.slice(-5);
  if (files.length === 0) return [];

  const sandboxDir = path.join(
    os.tmpdir(),
    "donebot-task-review",
    detail.task.id,
    latestBatchId || "latest",
  );
  await fs.mkdir(sandboxDir, { recursive: true });

  const downloaded: DownloadedDeliverableInfo[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const u = files[i]!;
    if (!u.file_id) continue;
    const cleanName = safeFileName(u.file_name || "", `deliverable_${i + 1}`);
    const destPath = path.join(sandboxDir, `${i + 1}_${cleanName}`);
    const exists = await fs.stat(destPath).catch(() => null);
    if (!exists || exists.size === 0) {
      const upstream = await collabDownloadTeamTaskFile(gateway.collabCtx(), u.file_id, false);
      if (!upstream.ok || !upstream.body) continue;
      const out = createWriteStream(destPath);
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          if (!out.write(next.value)) {
            await new Promise<void>((resolve, reject) => {
              out.once("drain", resolve);
              out.once("error", reject);
            });
          }
        }
        await new Promise<void>((resolve, reject) => {
          out.once("error", reject);
          out.end(() => resolve());
        });
      } catch {
        out.destroy();
        await reader.cancel().catch(() => {});
        continue;
      }
    }

    const info: DownloadedDeliverableInfo = {
      file_id: u.file_id,
      file_name: u.file_name || cleanName,
      file_mime: u.file_mime || "application/octet-stream",
      file_size: u.file_size || 0,
      local_path: destPath,
    };
    const mimeLower = info.file_mime.toLowerCase();
    if (mimeLower.startsWith("image/")) {
      const head = await fs.readFile(destPath).catch(() => null);
      if (head) info.dimensions = readImageDimensions(head);
    } else if (mimeLower.startsWith("video/") || mimeLower.startsWith("audio/")) {
      info.media_meta = await probeMediaMetadata(destPath);
      if (mimeLower.startsWith("video/")) {
        const frameDir = path.join(sandboxDir, `frames_${i + 1}`);
        await fs.mkdir(frameDir, { recursive: true });
        const frames = await extractVideoKeyframes(destPath, frameDir, info.media_meta?.duration_sec);
        if (frames.length > 0) info.keyframe_paths = frames;
      }
    } else if (
      mimeLower.startsWith("text/")
      || mimeLower === "application/json"
      || /\.(md|txt|csv|json|yaml|yml|xml|html|srt)$/i.test(cleanName)
    ) {
      const rawText = await fs.readFile(destPath, "utf8").catch(() => "");
      if (rawText) info.text_excerpt = rawText.slice(0, 4000);
    }
    downloaded.push(info);
  }
  return downloaded;
}

function guessMimeByExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".xml": "application/xml",
    ".html": "text/html",
    ".srt": "text/plain",
    ".zip": "application/zip",
  };
  return map[ext] || "application/octet-stream";
}

export async function handleDoneBotCollabTaskInternal(
  gateway: DoneBotGateway,
  reqPath: string,
  res: ServerResponse,
  json: (res: ServerResponse, status: number, value: unknown) => void,
  readInternalBody: () => Promise<Record<string, unknown>>,
): Promise<boolean> {
  if (!reqPath.startsWith("/api/internal/donebot/collab/tasks/")) return false;
  const ctx = gateway.collabCtx();

  try {
    if (reqPath === "/api/internal/donebot/collab/tasks/directory") {
      const [identity, snap] = await Promise.all([
        gateway.collabIdentity(),
        gateway.workspaceSnapshot(),
      ]);
      const teams = await Promise.all((snap.workspaces ?? []).map(async team => {
        const [members, channels, profiles] = await Promise.all([
          gateway.teamMembers(team.id).catch(() => []),
          collabListTeamChannels(ctx, team.id, false).catch(() => []) as Promise<DoneBotTeamChannel[]>,
          collabListTeamMemberProfiles(ctx, team.id).catch(() => []) as Promise<DoneBotTeamMemberProfile[]>,
        ]);
        const jobByUid = new Map((Array.isArray(profiles) ? profiles : []).map(p => [p.user_id, p.job_title]));
        return {
          team_id: team.id,
          team_name: team.name,
          my_role: team.role,
          channels: (Array.isArray(channels) ? channels : []).map(c => ({
            channel_id: c.id,
            name: c.name,
            is_default: c.is_default,
            is_private: c.is_private,
            description: c.description || "",
          })),
          members: (Array.isArray(members) ? members : []).map(m => ({
            user_id: m.user_id,
            name: m.remark?.trim() || m.nickname?.trim() || m.email,
            nickname: m.nickname || "",
            email: m.email,
            role: m.role,
            job_title: jobByUid.get(m.user_id) || "",
          })),
        };
      }));
      json(res, 200, {
        my_user_id: Number(identity.account_id),
        my_email: identity.email,
        teams,
      });
      return true;
    }

    const body = await readInternalBody();

    if (reqPath === "/api/internal/donebot/collab/tasks/create") {
      const parsed = createToolSchema.safeParse(body);
      if (!parsed.success) {
        json(res, 400, { error: "创建团队任务参数不完整，请提供有效的 team_id 和 title。" });
        return true;
      }
      const { team_id, bot_id, thread_id: _threadId, ...rest } = parsed.data;
      const botName = bot_id ? (runtimeHooks.resolveBotName?.(bot_id) || "") : "";
      const created = await collabCreateTeamTask(ctx, team_id, {
        ...rest,
        channel_id: rest.channel_id ?? "",
        actor_kind: "bot",
        actor_bot_name: botName || "主协调助手",
      });
      runtimeHooks.kickTaskWorker?.();
      json(res, 200, { task: created });
      return true;
    }

    if (reqPath === "/api/internal/donebot/collab/tasks/list") {
      const parsed = listToolSchema.safeParse(body);
      if (!parsed.success) {
        json(res, 400, { error: "查询团队任务参数无效。" });
        return true;
      }
      const params = new URLSearchParams();
      if (parsed.data.channel_id) params.set("channel_id", parsed.data.channel_id);
      if (parsed.data.status) params.set("status", parsed.data.status);
      if (parsed.data.scope) params.set("scope", parsed.data.scope);
      const qs = params.toString();

      if (parsed.data.team_id) {
        const list = await collabListTeamTasks(ctx, parsed.data.team_id, qs) as DoneBotTeamTask[];
        json(res, 200, { tasks: Array.isArray(list) ? list : [] });
        return true;
      }
      const snap = await gateway.workspaceSnapshot();
      const all = await Promise.all((snap.workspaces ?? []).map(async team => {
        const list = await collabListTeamTasks(ctx, team.id, qs).catch(() => []) as DoneBotTeamTask[];
        return (Array.isArray(list) ? list : []).map(task => ({ ...task, team_name: team.name }));
      }));
      json(res, 200, { tasks: all.flat() });
      return true;
    }

    if (reqPath === "/api/internal/donebot/collab/tasks/detail") {
      const parsed = detailToolSchema.safeParse(body);
      if (!parsed.success) {
        json(res, 400, { error: "查询任务详情参数无效。" });
        return true;
      }
      let teamId = parsed.data.team_id;
      let taskId = parsed.data.task_id;
      if ((!teamId || !taskId) && parsed.data.bot_id && parsed.data.thread_id) {
        const binding = getTaskBindingByThread(parsed.data.bot_id, parsed.data.thread_id);
        if (binding) {
          teamId = teamId || binding.teamId;
          taskId = taskId || binding.taskId;
        }
      }
      if (!teamId || !taskId) {
        json(res, 400, { error: "当前对话未绑定团队任务，请先调用 collab_list_team_tasks 查找并指定 team_id 与 task_id。" });
        return true;
      }
      const detail = await collabGetTeamTaskDetail(ctx, teamId, taskId) as DoneBotTeamTaskDetail;
      const downloaded = parsed.data.download_deliverables
        ? await downloadDeliverablesToSandbox(gateway, detail)
        : [];
      const submissionUpdates = detail.updates.filter(u => u.kind === "submission" && u.file_id);
      const latestBatch = detail.task.latest_submission_batch_id;
      const latestBatchFiles = (latestBatch
        ? submissionUpdates.filter(u => u.batch_id === latestBatch)
        : submissionUpdates.slice(-10)
      ).map(u => {
        const meta = u.file_name ? mediaPromptLookup?.(u.file_name) : undefined;
        return {
          file_id: u.file_id!,
          file_name: u.file_name || "",
          file_mime: u.file_mime || "",
          file_size: u.file_size || 0,
          ...(meta?.prompt ? { prompt_excerpt: meta.prompt } : {}),
        };
      });
      const submittedNames = new Set(submissionUpdates.map(u => u.file_name).filter((n): n is string => Boolean(n)));
      const threadAttachments = parsed.data.thread_id
        ? await inspectThreadAttachments(runtimeHooks.listThreadAttachments?.(parsed.data.thread_id) ?? [], submittedNames)
        : [];
      json(res, 200, {
        ...detail,
        ...(latestBatchFiles.length > 0 ? { latest_submission_files: latestBatchFiles } : {}),
        ...(downloaded.length > 0 ? { downloaded_deliverables: downloaded } : {}),
        ...(threadAttachments.length > 0 ? {
          recent_thread_attachments: threadAttachments,
          attachments_note: "以上 recent_thread_attachments 已核验本会话全部本地交付物（图片、视频、音乐/音频、文档/代码等）的存在性、大小、图片像素尺寸、音视频时长与分辨率、文档摘录及生成提示词摘要（prompt_excerpt），并标记了 already_submitted_in_task 与 is_latest。严禁在主人已确认当前成果（图片/视频/音乐/文档等）后擅自重新生成、重画或重写，也切勿调用 workspace_list/workspace_read 访问私有产物目录！提交完整批次或局部返工时：直接把所需文件 path 传给 collab_submit_team_task.file_paths；如需保留上一版中未修改的原交付文件（图片/视频/音乐/文档均适用），可将 latest_submission_files 中的 file_id 传入 reuse_file_ids，与本次修改的新文件 file_paths 合并成完整批次一次提交。",
        } : {}),
      });
      return true;
    }

    if (reqPath === "/api/internal/donebot/collab/tasks/submit") {
      const parsed = submitToolSchema.safeParse(body);
      if (!parsed.success) {
        json(res, 400, { error: "提交任务需要填写简报（brief），且最多附带 10 个成果文件。" });
        return true;
      }
      if (parsed.data.file_paths.length + parsed.data.reuse_file_ids.length > 10) {
        json(res, 400, { error: "单次提交最多附带 10 个成果文件（file_paths 与 reuse_file_ids 合计不超过 10 个）。" });
        return true;
      }
      let teamId = parsed.data.team_id;
      let taskId = parsed.data.task_id;
      if ((!teamId || !taskId) && parsed.data.bot_id && parsed.data.thread_id) {
        const binding = getTaskBindingByThread(parsed.data.bot_id, parsed.data.thread_id);
        if (binding) {
          teamId = teamId || binding.teamId;
          taskId = taskId || binding.taskId;
        }
      }
      if (!teamId || !taskId) {
        json(res, 400, { error: "无法确定要提交的团队任务：请传入 team_id 和 task_id，或在任务详情页点击「带给我的助手干活」建立绑定。" });
        return true;
      }
      const botName = parsed.data.bot_id ? (runtimeHooks.resolveBotName?.(parsed.data.bot_id) || "个人助手") : "个人助手";
      const batchId = randomUUID();

      const threadAttachments = parsed.data.thread_id
        ? (runtimeHooks.listThreadAttachments?.(parsed.data.thread_id) ?? [])
        : [];

      const preparedFiles = await Promise.all(parsed.data.file_paths.map(async rawPath => {
        let abs = rawPath.trim();
        if (abs && !path.isAbsolute(abs) && threadAttachments.length > 0) {
          const hit = [...threadAttachments].reverse().find(att =>
            att.name === abs || path.basename(att.path) === abs,
          );
          if (hit) abs = hit.path;
        }
        if (!abs || abs.includes("\0") || !path.isAbsolute(abs)) {
          return { error: `成果文件路径必须为绝对路径：${abs}` };
        }
        const stat = await fs.lstat(abs).catch(() => null);
        if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
          return { error: `成果文件不存在或不是常规文件：${abs}` };
        }
        if (stat.size === 0 || stat.size > DONEBOT_COLLAB_MAX_FILE_BYTES) {
          return { error: `成果文件大小无效（须为 1B - 100MB）：${path.basename(abs)}` };
        }
        return { abs, size: stat.size, fileName: path.basename(abs), mime: guessMimeByExt(abs) };
      }));

      const invalid = preparedFiles.find(item => "error" in item);
      if (invalid && "error" in invalid) {
        json(res, 400, { error: invalid.error });
        return true;
      }

      const validFiles = preparedFiles as Array<{ abs: string; size: number; fileName: string; mime: string }>;
      const reuseDir = parsed.data.reuse_file_ids.length > 0
        ? path.join(os.tmpdir(), "donebot-task-reuse", batchId)
        : null;
      try {
        const reusedFiles: Array<{ abs: string; size: number; fileName: string; mime: string }> = [];
        if (parsed.data.reuse_file_ids.length > 0 && reuseDir) {
          const existingDetail = await collabGetTeamTaskDetail(ctx, teamId, taskId) as DoneBotTeamTaskDetail;
          const byFileId = new Map(
            existingDetail.updates
              .filter(u => u.kind === "submission" && u.file_id)
              .map(u => [u.file_id!, u]),
          );
          const uniqueReuseIds = [...new Set(parsed.data.reuse_file_ids)];
          for (const fid of uniqueReuseIds) {
            if (!byFileId.has(fid)) {
              json(res, 400, { error: `无法复用文件 ${fid}：该文件不属于当前任务的既有交付记录。` });
              return true;
            }
          }
          await fs.mkdir(reuseDir, { recursive: true });
          const downloadedReused = await Promise.all(uniqueReuseIds.map(async (fid, idx) => {
            const u = byFileId.get(fid)!;
            const fileName = safeFileName(u.file_name || "", `reused_${idx + 1}`);
            const dest = path.join(reuseDir, `${idx + 1}_${fileName}`);
            const upstream = await collabDownloadTeamTaskFile(ctx, fid, false);
            if (!upstream.ok || !upstream.body) {
              return { error: `拉取待复用原图「${fileName}」失败（HTTP ${upstream.status}）。` };
            }
            const out = createWriteStream(dest);
            const reader = upstream.body.getReader();
            try {
              for (;;) {
                const next = await reader.read();
                if (next.done) break;
                if (!out.write(next.value)) {
                  await new Promise<void>((resolve, reject) => {
                    out.once("drain", resolve);
                    out.once("error", reject);
                  });
                }
              }
              await new Promise<void>((resolve, reject) => {
                out.once("error", reject);
                out.end(() => resolve());
              });
            } catch {
              out.destroy();
              await reader.cancel().catch(() => {});
              return { error: `拉取待复用原图「${fileName}」时传输中断。` };
            }
            const stat = await fs.stat(dest).catch(() => null);
            if (!stat || stat.size === 0 || stat.size > DONEBOT_COLLAB_MAX_FILE_BYTES) {
              return { error: `待复用原图「${fileName}」大小无效。` };
            }
            return { abs: dest, size: stat.size, fileName, mime: u.file_mime || guessMimeByExt(fileName) };
          }));
          const failedReuse = downloadedReused.find(item => "error" in item);
          if (failedReuse && "error" in failedReuse) {
            json(res, 502, { error: failedReuse.error });
            return true;
          }
          reusedFiles.push(...(downloadedReused as Array<{ abs: string; size: number; fileName: string; mime: string }>));
        }

        const allFiles = [...reusedFiles, ...validFiles];
        const uploadResults = await Promise.all(allFiles.map(async file => {
          const q = new URLSearchParams({
            kind: "submission",
            batch_id: batchId,
            finalize: "0",
            name: file.fileName,
            actor_kind: "bot",
            actor_bot_name: botName,
          });
          const stream = Readable.toWeb(createReadStream(file.abs)) as unknown as ReadableStream<Uint8Array>;
          const upRes = await collabUploadTeamTaskFile(ctx, teamId, taskId, q.toString(), stream, {
            "content-type": file.mime,
            "content-length": String(file.size),
          });
          if (!upRes.ok) {
            return { status: upRes.status >= 400 ? upRes.status : 502, error: `上传成果文件「${file.fileName}」失败（HTTP ${upRes.status}）。` };
          }
          return { name: file.fileName, size: file.size };
        }));

        const failedUpload = uploadResults.find(item => "error" in item);
        if (failedUpload && "error" in failedUpload) {
          json(res, failedUpload.status ?? 502, { error: failedUpload.error });
          return true;
        }
        const uploadedFiles = uploadResults as Array<{ name: string; size: number }>;

        const detail = await collabSubmitTeamTask(ctx, teamId, taskId, {
          body: parsed.data.brief,
          batch_id: batchId,
          actor_kind: "bot",
          actor_bot_name: botName,
          notify_channel: parsed.data.notify_channel,
        }) as DoneBotTeamTaskDetail;

        if (parsed.data.bot_id && parsed.data.thread_id && detail?.task) {
          saveTaskBinding({
            teamId,
            teamName: "",
            taskId,
            taskTitle: detail.task.title,
            botId: parsed.data.bot_id,
            threadId: parsed.data.thread_id,
          });
        }
        runtimeHooks.kickTaskWorker?.();
        json(res, 200, {
          submitted: true,
          batch_id: batchId,
          uploaded_files: uploadedFiles,
          task: detail.task,
        });
        return true;
      } finally {
        if (reuseDir) await fs.rm(reuseDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    if (reqPath === "/api/internal/donebot/collab/tasks/review") {
      const parsed = reviewToolSchema.safeParse(body);
      if (!parsed.success) {
        json(res, 400, { error: "任务审阅参数无效。" });
        return true;
      }
      const botName = parsed.data.bot_id ? (runtimeHooks.resolveBotName?.(parsed.data.bot_id) || "主协调助手") : "主协调助手";
      if (parsed.data.mode === "bot_review") {
        if (!parsed.data.verdict) {
          json(res, 400, { error: "bot_review 模式必须提供 verdict（pass / hard_fail / escalate）。" });
          return true;
        }
        const detail = await collabBotReviewTeamTask(ctx, parsed.data.team_id, parsed.data.task_id, {
          verdict: parsed.data.verdict,
          summary: parsed.data.summary,
          passed_items: parsed.data.passed_items,
          attention_items: parsed.data.attention_items,
          failed_criteria: parsed.data.failed_criteria,
          actionable_fixes: parsed.data.actionable_fixes,
          bot_name: botName,
          notify_channel: parsed.data.notify_channel,
        });
        runtimeHooks.kickTaskWorker?.();
        json(res, 200, detail);
        return true;
      }

      if (!parsed.data.decision) {
        json(res, 400, { error: "human_decision 模式必须提供 decision（approve / request_changes）。" });
        return true;
      }
      const detail = await collabReviewTeamTask(ctx, parsed.data.team_id, parsed.data.task_id, {
        decision: parsed.data.decision,
        body: parsed.data.summary,
        actor_kind: "user",
        actor_bot_name: botName,
        notify_channel: parsed.data.notify_channel,
      });
      runtimeHooks.kickTaskWorker?.();
      json(res, 200, detail);
      return true;
    }

    json(res, 404, { error: "unknown collab task endpoint" });
    return true;
  } catch (error) {
    if (error instanceof DoneBotGatewayError) {
      json(res, error.status, { error: error.message });
      return true;
    }
    json(res, 502, { error: error instanceof Error ? error.message : "团队任务工具调用失败。" });
    return true;
  }
}
