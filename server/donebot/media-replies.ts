import type { MediaJob } from "./media-store.ts";

export const MEDIA_REPLY_STYLE = "Choose your own wording in the current bot's SOUL.md, personality, language and conversation style. These are factual constraints, not a reply template or text to quote.";

export const MEDIA_PROGRESS_RULES = "A job status is an observation that can advance before your reply. Initial queued/submitting states do not establish a lasting wait, queue position, waiting reason or billing outcome. Do not infer that generation has started, has not started, is free, has been charged or has been refunded from a local phase alone. Explain known errors or uncertainty accurately. When the user asks about progress, read media_job_status for the latest saved observation; do not guess or repeatedly poll. Billing claims require an explicit gateway accounting receipt.";

export function mediaJobLabel(job: Pick<MediaJob, "kind" | "model">): string {
  return job.model ? `${job.kind} · ${job.model}` : job.kind;
}

export function mediaReplyContext(job: MediaJob, action: "generate" | "status" | "stop-waiting") {
  const acknowledge = action === "generate" && !job.waitingStopped && !job.error &&
    ["queued", "submitting", "submitted", "running", "downloading"].includes(job.status);
  const intent = action === "stop-waiting" ? "report_stop_result" : acknowledge ? "acknowledge_request" : "report_status";
  return {
    intent,
    guidance: [
      MEDIA_REPLY_STYLE,
      acknowledge
        ? "Acknowledge that DoneBot has taken on this media request and will return its outcome in this conversation. Keep the acknowledgement focused on the user's requested work; do not narrate the initial dispatch snapshot as an ongoing delay. Do not claim provider acceptance or active rendering without supporting evidence."
        : "Report the returned observation, existing artifacts, known problem or stop outcome as appropriate. A repeated generate call may return an existing task, including a completed, failed or cancelled task; it does not mean a new generation was started. If waiting_stopped is true, automatic follow-up is stopped; do not promise further delivery or imply the provider task was cancelled.",
      MEDIA_PROGRESS_RULES,
      "Do not resubmit this existing operation. Background receipts report unconfirmed submissions and final outcomes unless waiting has stopped. Successful artifacts are attached in the original conversation.",
    ].join(" "),
  };
}
