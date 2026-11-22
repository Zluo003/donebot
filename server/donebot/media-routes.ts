import { UNIFIED_MEDIA_PROTOCOL, unifiedOperation } from "./unified-media.ts";
import { z } from "zod";
import type { HelperToolContext } from "../routes/helper-tools.ts";
import { PASS } from "../routes/table.ts";
import { COLLAB_CHAT_MEDIA_BLOCK_MESSAGE, isCollabChatThread } from "./collab-chat-policy.ts";
import { mediaKindSchema, type MediaJob } from "./media-store.ts";
import type { DoneBotMediaService, MediaContext } from "./media.ts";
import { DONEBOT_MEDIA_MODELS } from "./media-registry.ts";
import { mediaReplyContext } from "./media-replies.ts";

const submitSchema = z.object({ kind: mediaKindSchema, model: z.string().min(1).max(256).optional(), parameters: z.record(z.string(), z.unknown()),
  fallback_model: z.string().min(1).max(256).optional(),
  fallback_parameters: z.record(z.string(), z.unknown()).nullable().optional(), fallback_reason: z.string().min(1).max(500).optional(),
  fallback_operation: z.enum(["generate", "edit", "extend"]).optional(),
  operation: z.enum(["generate", "edit", "extend"]).optional(), variation_key: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional() }).strict();
const jobSchema = z.object({ job_id: z.string().uuid() }).strict();
const capabilitySchema = z.object({ model: z.string().min(1).max(256).optional(), kind: z.enum(["llm", "image", "video", "music", "tts"]).optional() }).strict();

export function publicMediaJob(job: MediaJob) {
  return { id: job.id, kind: job.kind, model: job.model, operation: job.operation, status: job.status,
    previous_attempts: job.previousAttempts, fallback_model: job.fallback?.model, fallback_unavailable: job.fallbackUnavailable, fallback_waiting_confirmation: job.fallbackDecision === "pending",
    task_id: job.taskId, receipt_id: job.receiptId, error: job.error, diagnostic: job.diagnostic, artifacts: job.artifacts,
    waiting_stopped: job.waitingStopped, created_at: job.createdAt, updated_at: job.updatedAt,
    ...(job.waitingStopped ? { notice: job.status === "cancelled" ? "Further local dispatch is cancelled. Automatic follow-up is stopped." : "Automatic follow-up is stopped. An existing provider task can still finish; stopping the wait does not establish cancellation or billing." }
      : job.fallbackDecision === "pending" ? { notice: "The primary failed. Its reason and backup model were shown in this conversation. Waiting for the person's confirmation before submitting the backup video; do not submit another generation." }
      : job.status === "queued" ? { notice: "DoneBot has saved this request for automatic dispatch. This is a local observation that can advance before your reply; it does not establish a lasting wait, a gateway queue position, dispatch history or billing." }
      : job.status === "submitting" ? { notice: "DoneBot is sending this operation; gateway acceptance has not been confirmed. Do not resubmit." }
      : job.status === "uncertain" ? { notice: "The submission or outcome is unconfirmed. DoneBot is checking the saved receipt; this is not a known queue position. Do not resubmit." }
      : job.status === "submitted" || job.status === "running" ? { notice: "A gateway task ID has been received. DoneBot is monitoring this existing task." }
      : job.status === "cancelled" ? { notice: "Further local dispatch is cancelled." } : {}) };
}

export function createDoneBotMediaRoutes(service: DoneBotMediaService, contextFor: (ctx: HelperToolContext & { threadId: string }) => MediaContext,
  modelsFor?: (kind: "image" | "video" | "music") => { primary: string; fallback: string }) {
  return async (ctx: HelperToolContext & { threadId: string }): Promise<typeof PASS | void> => {
    if (ctx.path === "/api/internal/images/generate") return ctx.json(ctx.res, 403, { error: "Use the DoneBot media tools for image generation." });
    const prefix = "/api/internal/donebot/media/";
    if (ctx.method !== "POST" || !ctx.path.startsWith(prefix)) return PASS;
    const action = ctx.path.slice(prefix.length);
    if (!["generate", "status", "stop-waiting", "capabilities"].includes(action)) return PASS;
    try {
      const context = contextFor(ctx);
      if (context.botId !== ctx.botId || context.threadId !== ctx.threadId || !context.active()) return ctx.json(ctx.res, 403, { error: "The media capability is no longer active in this conversation." });
      const body = await ctx.readBody();
      if (!context.active()) return ctx.json(ctx.res, 403, { error: "This turn ended before the media request was read." });
      if (action === "capabilities") {
        const capQuery = capabilitySchema.parse(body);
        if (isCollabChatThread(context.threadId) && (capQuery.kind === "video" || capQuery.kind === "music")) {
          return ctx.json(ctx.res, 403, { error: COLLAB_CHAT_MEDIA_BLOCK_MESSAGE });
        }
        return ctx.json(ctx.res, 200, { models: await service.capabilities(capQuery), reference_rule: "For unified images/videos, use references:[{type:'image',role:'reference',url:{local_path:'/allowed/file'}}]. DoneBot uploads local files; raw URLs and asset:// references are unavailable." });
      }
      if (action === "generate") {
        const input = submitSchema.parse(body);
        if (isCollabChatThread(context.threadId) && (input.kind === "video" || input.kind === "music")) {
          return ctx.json(ctx.res, 403, { error: COLLAB_CHAT_MEDIA_BLOCK_MESSAGE });
        }
        const selected = modelsFor?.(input.kind) ?? { primary: input.model ?? DONEBOT_MEDIA_MODELS[input.kind], fallback: "" };
        if (!selected.primary || input.model && input.model !== selected.primary) return ctx.json(ctx.res, 409, { error: "Media defaults changed or are unavailable. Use the current generation tool schema." });
        if (input.fallback_model !== undefined && input.fallback_model !== selected.fallback || typeof input.parameters.mode !== "string" && (input.fallback_model ?? "") !== selected.fallback) return ctx.json(ctx.res, 409, { error: "The configured fallback changed. Use the current generation tool schema." });
        if ((input.kind === "image" || input.kind === "video") && typeof input.parameters.mode === "string") {
          if (input.fallback_parameters !== undefined || input.fallback_operation !== undefined || input.fallback_reason !== undefined) return ctx.json(ctx.res, 400, { error: "Unified media uses one request for both models; omit fallback parameters." });
          const parameters = { ...input.parameters, protocol: UNIFIED_MEDIA_PROTOCOL };
          const operation = unifiedOperation(parameters);
          if (input.operation !== undefined && input.operation !== operation) return ctx.json(ctx.res, 400, { error: "Operation does not match mode." });
          const job = await service.submit(context, { kind: input.kind, model: selected.primary, parameters, operation, variationKey: input.variation_key,
            ...(selected.fallback ? { fallback: { model: selected.fallback, parameters: structuredClone(parameters), operation } } : {}) });
          return ctx.json(ctx.res, 202, { job: publicMediaJob(job), reply_context: mediaReplyContext(job, action), ...(job.fallbackUnavailable ? { fallback_unavailable: job.fallbackUnavailable } : {}) });
        }
        if (selected.fallback && input.fallback_parameters === undefined || input.fallback_parameters === null && !input.fallback_reason) return ctx.json(ctx.res, 400, { error: "Provide the configured fallback's native parameters, or explain why this request is unsupported by that fallback." });
        if (!selected.fallback && input.fallback_parameters) return ctx.json(ctx.res, 409, { error: "The fallback model is no longer available." });
        const job = await service.submit(context, { kind: input.kind, model: selected.primary, parameters: input.parameters, operation: input.operation, variationKey: input.variation_key,
          ...(selected.fallback && input.fallback_parameters ? { fallback: { model: selected.fallback, parameters: input.fallback_parameters, operation: input.fallback_operation } } : {}) });
        return ctx.json(ctx.res, 202, { job: publicMediaJob(job), reply_context: mediaReplyContext(job, action), ...(input.fallback_parameters === null ? { fallback_unavailable: input.fallback_reason } : {}) });
      }
      const { job_id: id } = jobSchema.parse(body);
      const job = action === "status" ? await service.status(context, id) : await service.stopWaiting(context, id);
      return ctx.json(ctx.res, 200, { job: publicMediaJob(job), reply_context: mediaReplyContext(job, action === "status" ? "status" : "stop-waiting") });
    } catch (error) {
      if (error instanceof z.ZodError) return ctx.json(ctx.res, 400, { error: `Invalid DoneBot media parameters: ${error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` });
      const status = (error as { status?: unknown })?.status;
      return ctx.json(ctx.res, typeof status === "number" && status >= 400 && status <= 599 ? status : 502, { error: error instanceof Error ? error.message : "DoneBot media request failed." });
    }
  };
}
