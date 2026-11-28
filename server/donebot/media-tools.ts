import type { ToolCallContext, ToolCallResult } from "../drivers/agents-call.ts";
import type { Json } from "../drivers/agents-client.ts";
import { MEDIA_REPLY_STYLE, MEDIA_PROGRESS_RULES } from "./media-replies.ts";

type MediaIntent = "image" | "video" | "audio";
const MEDIA_TOOL_RULES = `${MEDIA_REPLY_STYLE} ${MEDIA_PROGRESS_RULES} Use the user's explicit or remembered media CLI/MCP preference first, then the configured gateway primary and fallback. The client supplies the selected model and registered parameter schema. Image and video requests use one unified schema, with explicit mode, prompt, output controls, references and options. The client reuses this request for the configured backup. Submit directly without capability queries. For images and videos use references:[{type:'image',role:'reference',url:{local_path:'/allowed/file'}}]; use video/audio types or first_frame/last_frame roles only when supported and requested. The saved asynchronous job returns immediately; acknowledge once and wait for completion in this conversation. Do not poll or resubmit a pending or uncertain job. Repeating this turn's same request reuses its job; variation_key is only for a distinct generation explicitly requested by the person.`;

function generationTool(kind: MediaIntent) {
  const operations = kind === "image" ? ["generate"]
    : kind === "video" ? ["generate", "edit", "extend"] : ["generate"];
  return {
    name: `generate_${kind}`,
    description: `Generate ${kind === "audio" ? "instrumental music or songs with lyrics" : kind} through the signed-in DoneBot account using the configured media defaults. ${MEDIA_TOOL_RULES}`,
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        model: { type: "string", description: "Use the primary model supplied in this tool's current schema." },
        fallback_model: { type: "string", description: "Use the backup model supplied in this tool's current schema." },
        fallback_parameters: { type: ["object", "null"], description: "Native request for the configured backup, expressing the same intent. Null only when that model cannot support the requested operation; explain fallback_reason." },
        fallback_operation: { type: "string", enum: ["generate", "edit", "extend"] },
        fallback_reason: { type: "string", maxLength: 500 },
        operation: { type: "string", enum: operations, description: "Use the operations in the current model schema. GPT Image reference edits use edit; Seedream reference edits and layer decomposition use generate. Video operations also require their matching native task fields." },
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
    description: `Inspect the client's registered media contract when explicitly needed. Generation tools already contain their configured model and native parameter schema; capability lookup is unnecessary before submission. This local read never submits or charges a generation. ${MEDIA_REPLY_STYLE}`,
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
  {
    name: "transcribe_audio",
    description: "Transcribe spoken dialogue from a local audio or video file (WAV/PCM directly, or MP4/MOV/MKV/MP3/M4A via local ffmpeg) through the signed-in DoneBot gateway ASR model, returning full text and timestamped segments. Use start_sec and duration_sec (up to 600 s per call) to slice key windows from long videos or livestream recordings instead of transcribing hours at once.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        local_path: { type: "string", minLength: 1, maxLength: 8192, description: "Workspace or attached local audio/video file path." },
        start_sec: { type: "number", minimum: 0, description: "Optional start offset in seconds (default 0)." },
        duration_sec: { type: "number", minimum: 1, maximum: 600, description: "Optional slice duration in seconds (max 600 s per call)." },
        language_hints: { type: "array", items: { type: "string", minLength: 2, maxLength: 32 }, maxItems: 8, description: "Optional language hints such as ['zh', 'en']." },
        hotwords: { type: "object", additionalProperties: { type: "integer" }, description: "Optional domain vocabulary weights (1-5 or 50), e.g. brand or product names." },
      },
      required: ["local_path"],
    },
  },
];

export const DONEBOT_MEDIA_TOOL_NAMES: ReadonlySet<string> = new Set(DONEBOT_MEDIA_TOOL_DEFINITIONS.map(tool => tool.name));
export const DONEBOT_LEGACY_MEDIA_TOOL_NAMES: ReadonlySet<string> = new Set(["media_center", "generate_music", "model_capabilities"]);

export async function callDoneBotMediaTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const input = args as Record<string, Json>;
  if (name === "transcribe_audio") {
    const { ok, body: response } = await context.client.apiResponse("/api/internal/donebot/media/transcribe", { method: "POST", body: JSON.stringify(input) });
    return ok ? { text: JSON.stringify(response) } : { text: String(response.error ?? "DoneBot audio transcription failed."), isError: true };
  }
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
