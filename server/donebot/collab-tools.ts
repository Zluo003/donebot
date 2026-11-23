import type { ToolCallContext, ToolCallResult } from "../drivers/agents-call.ts";
import type { Json } from "../drivers/agents-client.ts";

export const DONEBOT_COLLAB_TOOL_DEFINITIONS = [
  {
    name: "list_collab_folders",
    description: "List remote folders that friends or team members have shared with the signed-in DoneBot user over the DoneBot gateway. Returns each folder's folder_id, name, owner_email, owner_nickname, owner_remark, device_name, access ('read' or 'write'), and whether the host computer is online right now. Always call this before using collab_folder.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "collab_folder",
    description: "Read, edit, download, or upload files inside a remote folder shared by a friend or team member over the DoneBot gateway. Get folder_id from list_collab_folders. Paths are relative to the shared folder root. For files larger than 2 MB (up to 100 MB), use download_file (with save_to absolute local path) or upload_file (with local_path absolute local path, requires 'write' access). For smaller files, read_file returns sha256, which is required as expected_sha256 before overwriting with write_file or deleting with delete_file. edit_file replaces old_text once with new_text; append_file appends content. Never substitute local files if the remote computer is offline.",
    annotations: undefined,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        folder_id: { type: "string", format: "uuid", description: "The shared folder_id returned by list_collab_folders." },
        action: { type: "string", enum: ["list_files", "read_file", "write_file", "edit_file", "append_file", "delete_file", "download_file", "upload_file"] },
        path: { type: "string", maxLength: 2048, description: "Relative path inside the shared folder; omit or empty string for folder root in list_files." },
        save_to: { type: "string", maxLength: 4096, description: "Absolute local path to save the downloaded file (required for download_file, supports up to 100 MB)." },
        local_path: { type: "string", maxLength: 4096, description: "Absolute local path of the file to upload (required for upload_file, supports up to 100 MB)." },
        content: { type: "string", maxLength: 350_000 },
        encoding: { type: "string", enum: ["utf8", "base64"] },
        old_text: { type: "string", minLength: 1, maxLength: 350_000 },
        new_text: { type: "string", maxLength: 350_000 },
        expected_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["folder_id", "action"],
    },
  },
  {
    name: "collab_team_directory",
    description: "List the signed-in user's DoneBot teams, channels, members, roles, and job titles (岗位分工). Always call this BEFORE creating or assigning a team task so you match the exact team_id, channel_id, assignee user_id (by name or job_title), and reviewer user_id.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "collab_create_team_task",
    description: "Create and assign a DoneBot team task on behalf of the user (typically called by the Chief of Staff bot). Workflow rules: (1) If the user's request is a single clear task with unambiguous team and assignee, create it immediately and reply with a concise receipt. (2) If there is ambiguity (e.g. multiple matching teams/members) or the user asks to split into 3 or more tasks at once, present a brief draft table first and create after the user confirms. (3) Always extract 2-5 objective, verifiable acceptance_criteria items so automated first-pass review has clear rules. Default reviewer_id to the user's own user_id unless they specify someone else. Default max_auto_revisions is 2.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        team_id: { type: "string", format: "uuid" },
        channel_id: { type: "string", description: "Optional channel_id from collab_team_directory." },
        title: { type: "string", minLength: 1, maxLength: 160 },
        description: { type: "string", maxLength: 8000 },
        acceptance_criteria: {
          type: "array",
          items: { type: "string", maxLength: 240 },
          maxItems: 12,
          description: "2-5 concrete, verifiable acceptance checklist items (count, aspect ratio, required elements, no garbled text, etc.).",
        },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        assignee_id: { type: "integer", description: "Team member user_id responsible for completing the task." },
        reviewer_id: { type: "integer", description: "Team member user_id who reviews and approves the task (default: the assigner)." },
        collaborator_ids: { type: "array", items: { type: "integer" } },
        due_at: { type: "string", description: "Optional due date in YYYY-MM-DD or ISO-8601 format." },
        auto_review_enabled: { type: "boolean", description: "Default true: assigner's Chief Bot runs first-pass review on submission." },
        max_auto_revisions: { type: "integer", minimum: 0, maximum: 5, description: "Max automated reject/revision rounds before escalating to humans (default 2; set 0 to disable auto-reject)." },
        notify_channel: { type: "boolean", description: "Default true: post a brief task assignment notice in the channel." },
      },
      required: ["team_id", "title"],
    },
  },
  {
    name: "collab_list_team_tasks",
    description: "List team tasks across one team or all of the user's teams. Use this to collect submitted tasks for review reports (scope='review', status='review_queue' or 'ready_for_review'), check open tasks, or inspect tasks assigned to the user (scope='mine').",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        team_id: { type: "string", format: "uuid", description: "Optional: omit to list across all teams." },
        channel_id: { type: "string", format: "uuid" },
        status: {
          type: "string",
          enum: ["all", "open", "review_queue", "todo", "in_progress", "in_review", "bot_reviewing", "bot_revising", "ready_for_review", "changes_requested", "blocked", "done"],
        },
        scope: { type: "string", enum: ["all", "mine", "review", "created"] },
      },
    },
  },
  {
    name: "collab_get_team_task",
    description: "Read full details, acceptance_criteria, latest_submission_files (with file_id and prompt_excerpt), and review timeline of a team task. Omit team_id/task_id to inspect the task bound to the current conversation thread. Also returns verified recent_thread_attachments for ALL deliverable types in this conversation (images with dimensions, videos/music/audio with media_meta duration/resolution, documents/code with text_excerpt, plus exact local path, size_bytes, prompt_excerpt, at_iso, is_latest, already_submitted_in_task) — NEVER call workspace_list or workspace_read to look for generated media/attachment files in private artifact folders. Set download_deliverables=true to download the latest submission files to a local sandbox folder and return their local paths, image dimensions, text excerpts, or video keyframes for inspection.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        team_id: { type: "string", format: "uuid" },
        task_id: { type: "string", format: "uuid" },
        download_deliverables: { type: "boolean", description: "Download latest submission files locally for direct inspection." },
      },
    },
  },
  {
    name: "collab_submit_team_task",
    description: "Submit a structured delivery brief and 0-10 deliverable files of ANY type (images, videos, music/audio, documents, PDF/Office, code, archives up to 100 MB each) to the task assigner as one submission batch. Can omit team_id/task_id when called inside a thread already bound to the task. Pass exact local paths directly from [DoneBot media receipt: terminal] or collab_get_team_task.recent_thread_attachments (matched by prompt_excerpt, text_excerpt, dimensions/media_meta, and at_iso). NEVER call workspace_list/workspace_read on private media directories, and NEVER regenerate, redraw, or rewrite ANY deliverable (image, video, music/audio, or document) that the user has already reviewed and approved! For partial revisions (e.g. keeping unchanged images/videos/songs/docs from the previous submission and replacing only revised items), pass unchanged file IDs from latest_submission_files in reuse_file_ids (or their original local paths in file_paths) together with the newly revised local file paths in file_paths. IMPORTANT: For the FIRST submission or after human feedback, ONLY call this after the assignee user explicitly approves submission (e.g. '可以了，提交任务'). During an automated bot_revising round after objective hard_fail rejection, you may call this directly after completing text/code/image fixes (never auto-run expensive video/music regeneration without user confirmation).",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        team_id: { type: "string", format: "uuid" },
        task_id: { type: "string", format: "uuid" },
        brief: {
          type: "string",
          minLength: 1,
          maxLength: 8000,
          description: "Structured delivery report: checklist completion summary, purpose of each file, revision notes if resubmitting, and key items for the reviewer to decide.",
        },
        file_paths: {
          type: "array",
          items: { type: "string", maxLength: 4096 },
          maxItems: 10,
          description: "Absolute local paths of deliverable files produced for this task to upload.",
        },
        reuse_file_ids: {
          type: "array",
          items: { type: "string", maxLength: 128 },
          maxItems: 10,
          description: "Optional file_id list from latest_submission_files of THIS task to keep unchanged in the new submission batch (ideal for partial revisions).",
        },
        notify_channel: { type: "boolean", description: "Default true: post a concise submission notice in the channel." },
      },
      required: ["brief"],
    },
  },
  {
    name: "collab_review_team_task",
    description: "Record either (A) the Chief Bot's automated first-pass review (mode='bot_review') or (B) the human reviewer's final sign-off decision spoken to their Chief Bot (mode='human_decision'). Rules for mode='bot_review': ONLY use verdict='hard_fail' for objective, unambiguous violations of hard requirements (missing deliverables, wrong file count/aspect ratio/format, obvious garbled text/broken images, missing core required sections). NEVER auto-reject for subjective style/taste preferences — use verdict='pass' and list subjective choices in attention_items for the human reviewer to decide. Use mode='human_decision' ONLY when the human reviewer explicitly instructs you to approve or request changes.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        team_id: { type: "string", format: "uuid" },
        task_id: { type: "string", format: "uuid" },
        mode: { type: "string", enum: ["bot_review", "human_decision"] },
        verdict: { type: "string", enum: ["pass", "hard_fail", "escalate"], description: "Required when mode='bot_review'." },
        decision: { type: "string", enum: ["approve", "request_changes"], description: "Required when mode='human_decision'." },
        summary: { type: "string", maxLength: 8000, description: "Concise review summary or revision feedback." },
        passed_items: { type: "array", items: { type: "string", maxLength: 240 } },
        attention_items: { type: "array", items: { type: "string", maxLength: 240 }, description: "Points for the human reviewer to pay attention to or decide." },
        failed_criteria: { type: "array", items: { type: "string", maxLength: 240 }, description: "Objective criteria that failed (for hard_fail)." },
        actionable_fixes: { type: "array", items: { type: "string", maxLength: 300 }, description: "Concrete fix instructions for the assignee's bot (for hard_fail)." },
        notify_channel: { type: "boolean" },
      },
      required: ["team_id", "task_id", "mode"],
    },
  },
];

export const DONEBOT_COLLAB_TOOL_NAMES: ReadonlySet<string> = new Set(DONEBOT_COLLAB_TOOL_DEFINITIONS.map(tool => tool.name));

const TASK_TOOL_PATHS: Record<string, string> = {
  collab_team_directory: "/api/internal/donebot/collab/tasks/directory",
  collab_create_team_task: "/api/internal/donebot/collab/tasks/create",
  collab_list_team_tasks: "/api/internal/donebot/collab/tasks/list",
  collab_get_team_task: "/api/internal/donebot/collab/tasks/detail",
  collab_submit_team_task: "/api/internal/donebot/collab/tasks/submit",
  collab_review_team_task: "/api/internal/donebot/collab/tasks/review",
};

export async function callDoneBotCollabTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  if (name === "list_collab_folders") {
    const { ok, body } = await context.client.apiResponse("/api/internal/donebot/collab/folders", { method: "POST", body: "{}" });
    return ok ? { text: JSON.stringify(body) } : { text: String(body.error ?? "无法获取远程共享文件夹列表。"), isError: true };
  }
  const taskPath = TASK_TOOL_PATHS[name];
  if (taskPath) {
    const payload = args && typeof args === "object" && !Array.isArray(args)
      ? { ...args, bot_id: context.botId, thread_id: context.threadId }
      : { bot_id: context.botId, thread_id: context.threadId };
    const { ok, body } = await context.client.apiResponse(taskPath, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return ok ? { text: JSON.stringify(body) } : { text: String(body.error ?? "团队任务操作失败。"), isError: true };
  }
  const { ok, body } = await context.client.apiResponse("/api/internal/donebot/collab/invoke", {
    method: "POST",
    body: JSON.stringify(args ?? {}),
  });
  if (!ok) return { text: String(body.error ?? "远程共享文件夹操作失败。"), isError: true };
  const result = body.result as Json;
  if (Array.isArray(result?.content)) return { text: "", passthrough: result };
  return { text: JSON.stringify(result ?? body) };
}
