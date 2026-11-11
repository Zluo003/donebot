import { z } from "zod";
import type { HelperToolContext } from "../routes/helper-tools.ts";
import { PASS } from "../routes/table.ts";
import { mediaKindSchema, type MediaJob } from "./media-store.ts";
import type { DoneBotMediaService, MediaContext } from "./media.ts";
import { DONEBOT_MEDIA_MODELS } from "./media-registry.ts";
import { mediaReplyContext } from "./media-replies.ts";

const submitSchema = z.object({ kind: mediaKindSchema, model: z.string().min(1).max(256).optional(), parameters: z.record(z.string(), z.unknown()),
  operation: z.enum(["generate", "edit", "extend"]).optional(), variation_key: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional() }).strict();
const jobSchema = z.object({ job_id: z.string().uuid() }).strict();
const capabilitySchema = z.object({ model: z.string().min(1).max(256).optional(), kind: z.enum(["llm", "image", "video", "music", "tts"]).optional() }).strict();

export function publicMediaJob(job: MediaJob) {
  return { id: job.id, kind: job.kind, model: job.model, operation: job.operation, status: job.status,
    task_id: job.taskId, receipt_id: job.receiptId, error: job.error, diagnostic: job.diagnostic, artifacts: job.artifacts,
    waiting_stopped: job.waitingStopped, created_at: job.createdAt, updated_at: job.updatedAt,
    ...(job.waitingStopped ? { notice: job.status === "cancelled" ? "Further local dispatch is cancelled. Automatic follow-up is stopped." : "Automatic follow-up is stopped. An existing provider task can still finish; stopping the wait does not establish cancellation or billing." }
      : job.status === "queued" ? { notice: "DoneBot has saved this request for automatic dispatch. This is a local observation that can advance before your reply; it does not establish a lasting wait, a gateway queue position, dispatch history or billing." }
      : job.status === "submitting" ? { notice: "DoneBot is sending this operation; gateway acceptance has not been confirmed. Do not resubmit." }
      : job.status === "uncertain" ? { notice: "The submission or outcome is unconfirmed. DoneBot is checking the saved receipt; this is not a known queue position. Do not resubmit." }
      : job.status === "submitted" || job.status === "running" ? { notice: "A gateway task ID has been received. DoneBot is monitoring this existing task." }
      : job.status === "cancelled" ? { notice: "Further local dispatch is cancelled." } : {}) };
}

export function createDoneBotMediaRoutes(service: DoneBotMediaService, contextFor: (ctx: HelperToolContext & { threadId: string }) => MediaContext) {
  return async (ctx: HelperToolContext & { threadId: string }): Promise<typeof PASS | void> => {
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
        return ctx.json(ctx.res, 200, { models: await service.capabilities(capabilitySchema.parse(body)), reference_rule: "Use local_path objects at native reference URL positions. DoneBot uploads reference files to its gateway; raw URLs and asset:// references are unavailable." });
      }
      if (action === "generate") {
        const input = submitSchema.parse(body);
        const job = await service.submit(context, { kind: input.kind, model: input.model ?? DONEBOT_MEDIA_MODELS[input.kind], parameters: input.parameters, operation: input.operation, variationKey: input.variation_key });
        return ctx.json(ctx.res, 202, { job: publicMediaJob(job), reply_context: mediaReplyContext(job, action) });
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
