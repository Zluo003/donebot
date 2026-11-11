import type { ToolCallContext, ToolCallResult } from "../drivers/agents-call.ts";
import type { Json } from "../drivers/agents-client.ts";
import { MEDIA_REPLY_STYLE, MEDIA_PROGRESS_RULES } from "./media-replies.ts";

type MediaIntent = "image" | "video" | "audio";
const MEDIA_TOOL_RULES = `${MEDIA_REPLY_STYLE} ${MEDIA_PROGRESS_RULES} Read media_model_capabilities for the requested media kind, choose a locally supported public model that fits the task, and build its registered native request body. Pass reference files as {local_path:'/allowed/file'} only in the model's native reference fields; DoneBot uploads them to the gateway. Submit the exact public model ID and native parameters. The DoneBot API forwards and bills the request; it does not choose a model or translate a generic intent. A generation is saved as a persistent job and returns immediately. Acknowledge it once and wait for the completion receipt in this same conversation. Do not poll or resubmit queued, pending or uncertain jobs. Successful artifacts are attached to the original conversation. Repeating the same request in this turn reuses the existing operation; use variation_key only for a distinct generation explicitly requested by the person.`;

function generationTool(kind: MediaIntent) {
  const operations = kind === "image" ? ["generate", "edit"]
    : kind === "video" ? ["generate", "edit", "extend"] : ["generate"];
  return {
    name: `generate_${kind}`,
    description: `Generate ${kind === "audio" ? "standalone audio or music" : kind} through the signed-in DoneBot account. Streaming text-to-speech remains available through the existing voice tools. ${MEDIA_TOOL_RULES}`,
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        model: { type: "string", minLength: 1, maxLength: 256, description: "The exact public model ID selected from media_model_capabilities for this task." },
        operation: { type: "string", enum: operations, description: "Image/video operation. For video, also build the matching native task fields described in the selected model's capability rules." },
        parameters: { type: "object", additionalProperties: true, description: "The selected model's native generation request fields, excluding model. Include the complete prompt/content and supported output controls. Put local_path reference objects at the native reference URL positions." },
        variation_key: { type: "string", maxLength: 80, pattern: "^[A-Za-z0-9_-]{1,80}$", description: "Only for another distinct generation explicitly requested in this turn. Reuse the same value when checking or retrying the same operation." },
      },
      required: ["model", "parameters"],
    },
  };
}

export const DONEBOT_MEDIA_TOOL_DEFINITIONS = [
  {
    name: "media_model_capabilities",
    description: `Read the current DoneBot gateway catalog and the client's verified native media request contracts. Call this before choosing a model or constructing a media request. A kind-only query returns all locally supported public models and their parameters, limits, examples and availability; an exact model can be requested for a focused result. This is a local read and never submits or charges a generation. ${MEDIA_REPLY_STYLE}`,
    inputSchema: { type: "object", additionalProperties: false,
      properties: { kind: { type: "string", enum: ["image", "video", "audio"] }, model: { type: "string", minLength: 1, maxLength: 256 } }, required: ["kind"] },
  },
  generationTool("image"), generationTool("video"), generationTool("audio"),
  {
    name: "media_job_status",
    description: `Read the latest saved observation of one DoneBot media job belonging to this exact bot and conversation when the user asks about its progress. It never creates or restarts a paid generation. ${MEDIA_REPLY_STYLE} ${MEDIA_PROGRESS_RULES} An uncertain result must be checked by its receipt, not resubmitted. Background completion sends this bot a receipt and publishes successful artifacts in this conversation unless waiting has stopped.`,
    inputSchema: { type: "object", additionalProperties: false, properties: { job_id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["job_id"] },
  },
  {
    name: "media_stop_waiting",
    description: `Stop a DoneBot media job's local dispatch or automatic follow-up. A queued job is removed from local dispatch; an existing provider task may still finish and its result is retained. Follow reply_context and the returned state; stopping the wait does not establish provider cancellation or billing. ${MEDIA_REPLY_STYLE} ${MEDIA_PROGRESS_RULES}`,
    inputSchema: { type: "object", additionalProperties: false, properties: { job_id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["job_id"] },
  },
];

export const DONEBOT_MEDIA_TOOL_NAMES: ReadonlySet<string> = new Set(DONEBOT_MEDIA_TOOL_DEFINITIONS.map(tool => tool.name));
export const DONEBOT_LEGACY_MEDIA_TOOL_NAMES: ReadonlySet<string> = new Set(["media_center", "generate_music", "model_capabilities"]);

export async function callDoneBotMediaTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const input = args as Record<string, Json>;
  const kind = typeof input.kind === "string" ? input.kind : undefined;
  const model = typeof input.model === "string" ? input.model : undefined;
  const generationKind = name === "generate_audio" ? "audio" : name === "generate_image" || name === "generate_video" ? name.slice("generate_".length) : undefined;
  const action = name === "media_model_capabilities" ? "capabilities" : generationKind ? "generate" : name === "media_job_status" ? "status" : "stop-waiting";
  const body = action === "capabilities"
    ? { ...(kind ? { kind: kind === "audio" ? "music" : kind } : {}), ...(model ? { model } : {}) }
    : generationKind
      ? { kind: generationKind === "audio" ? "music" : generationKind, ...input }
      : input;
  const { ok, body: response } = await context.client.apiResponse(`/api/internal/donebot/media/${action}`, { method: "POST", body: JSON.stringify(body) });
  return ok ? { text: JSON.stringify(response) } : { text: String(response.error ?? "DoneBot media request failed."), isError: true };
}
