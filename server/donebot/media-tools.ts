import type { ToolCallContext, ToolCallResult } from "../drivers/agents-call.ts";
import type { Json } from "../drivers/agents-client.ts";
import { MEDIA_REPLY_STYLE, MEDIA_PROGRESS_RULES } from "./media-replies.ts";
import { doneBotFixedMediaModel } from "./media-registry.ts";

type MediaIntent = "image" | "video" | "audio";
const MEDIA_TOOL_RULES = `${MEDIA_REPLY_STYLE} ${MEDIA_PROGRESS_RULES} Use this gateway tool by default unless the user selects another provider for this request or has saved a different provider for this media kind; use that provider's CLI, MCP or skill instead. For the gateway, the client fixes the media model and provides its native parameter schema. Submit directly without model selection or capability queries. Pass reference files as {local_path:'/allowed/file'} in native reference fields. The saved asynchronous job returns immediately; acknowledge once and wait for completion in this conversation. Do not poll or resubmit a pending or uncertain job. Repeating this turn's same request reuses its job; variation_key is only for a distinct generation explicitly requested by the person.`;

function generationTool(kind: MediaIntent) {
  const operations = kind === "image" ? ["generate"]
    : kind === "video" ? ["generate", "edit", "extend"] : ["generate"];
  return {
    name: `generate_${kind}`,
    description: `Generate ${kind === "audio" ? "instrumental music or songs with lyrics" : kind} with ${doneBotFixedMediaModel(kind)} through the signed-in DoneBot account. ${MEDIA_TOOL_RULES}`,
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        operation: { type: "string", enum: operations, description: "Images, including reference edits and layer decomposition, use generate. Video edit/extend also use the matching native task fields." },
        parameters: { type: "object", additionalProperties: true, description: "Only the selected model's verified native generation request fields, excluding model. Do not add reason or other tool metadata. Include the complete prompt/content and supported output controls. Put local_path reference objects at the native reference URL positions." },
        variation_key: { type: "string", maxLength: 80, pattern: "^[A-Za-z0-9_-]{1,80}$", description: "Only for another distinct generation explicitly requested in this turn. Reuse the same value when checking or retrying the same operation." },
      },
      required: ["parameters"],
    },
  };
}

export const DONEBOT_MEDIA_TOOL_DEFINITIONS = [
  {
    name: "media_model_capabilities",
    description: `Inspect the client's registered media contract when explicitly needed. Generation tools already contain their fixed model and native parameter schema; capability lookup is unnecessary before submission. This local read never submits or charges a generation. ${MEDIA_REPLY_STYLE}`,
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
      ? { kind: generationKind === "audio" ? "music" : generationKind, ...input, model: doneBotFixedMediaModel(generationKind as MediaIntent) }
      : input;
  const { ok, body: response } = await context.client.apiResponse(`/api/internal/donebot/media/${action}`, { method: "POST", body: JSON.stringify(body) });
  return ok ? { text: JSON.stringify(response) } : { text: String(response.error ?? "DoneBot media request failed."), isError: true };
}
