import { DEFAULT_DONEBOT_MEDIA_PREFERENCES, type DoneBotMediaPreferences, type DoneBotCatalog } from "../../shared/donebot.ts";
import type { CompletionTransportInput } from "../drivers/openai-chat.ts";
import { inCollabChatTurn, isForbiddenCollabChatMediaTool } from "./collab-chat-policy.ts";
import { DONEBOT_MODEL_CREDENTIAL_RULE } from "./credential-policy.ts";
import { DONEBOT_LEGACY_MEDIA_TOOL_NAMES } from "./media-tools.ts";
import { doneBotClientMediaCatalog, resolveDoneBotAsrModel } from "./media-registry.ts";
import { mediaModelSchema } from "./media-model-schema.ts";
import { selectedMediaModels } from "./media-preferences.ts";

const MEDIA_PROVIDER_GUIDANCE = "For image, video and audio generation, choose the provider in this order: the user's explicit choice for this request, the saved preference for this bot and media kind, then the built-in DoneBot gateway. Third-party media CLIs, MCP servers and skills use existing command, MCP and skill tools with normal permissions; inspect their installed instructions or CLI help as needed, without inventing capabilities. To change this bot's future default, use propose_profile to save the provider and media kind in SOUL.md, preserving other instructions; for an explicitly all-bots preference, use memory_update action prefer. Confirm saving only after success. A one-time choice does not change the default. If the explicit provider differs from the saved default, follow that explicit choice for this request. For a remembered third-party preference, use it first; after a definite failure or proof it is unavailable, report the blocker and continue with the configured gateway primary, then its backup. Never fall back while an external submission is pending, timed out or uncertain; do not duplicate a potentially paid operation. Preserve normal installation, authentication and tool permissions. Do not silently switch providers; report the actual route used. Built-in schemas and job rules apply only to gateway tools; external providers follow their own contracts. Older assistant claims that external media tools are forbidden are incorrect.";

export function guideDoneBotMedia(input: CompletionTransportInput, catalog: DoneBotCatalog | null, preferences: DoneBotMediaPreferences = DEFAULT_DONEBOT_MEDIA_PREFERENCES): CompletionTransportInput {
  const collabRestricted = inCollabChatTurn();
  const local = doneBotClientMediaCatalog(catalog);
  const asrModel = resolveDoneBotAsrModel(catalog);
  const tools = input.tools.filter(tool => tool.function.name !== "agents_media_model_capabilities" &&
    !DONEBOT_LEGACY_MEDIA_TOOL_NAMES.has(tool.function.name.replace(/^agents_/, "")) &&
    (!collabRestricted || !isForbiddenCollabChatMediaTool(tool.function.name))).flatMap(tool => {
    if (tool.function.name === "agents_transcribe_audio") {
      if (!asrModel) return [];
      return [{ ...tool, function: { ...tool.function, description: `${tool.function.description} Gateway ASR model: ${asrModel.id}.` } }];
    }
    const kind = tool.function.name === "agents_generate_image" ? "image"
      : tool.function.name === "agents_generate_video" ? "video" : tool.function.name === "agents_generate_audio" ? "music" : undefined;
    if (!kind) return [tool];
    if (collabRestricted && (kind === "video" || kind === "music")) return [];
    const selected = selectedMediaModels(catalog, preferences, kind);
    const model = local?.models.find(entry => entry.id === selected.primary);
    if (!model) return [];
    const contract = mediaModelSchema(model);
    const backup = local?.models.find(entry => entry.id === selected.fallback);

    if (kind === "image" || kind === "video") {
      const { variation_key } = tool.function.parameters.properties as Record<string, unknown>;
      return [{ ...tool, function: { ...tool.function,
        description: `${tool.function.description} Primary: ${selected.primary}. ${contract.guidance} ${backup ? `Configured backup: ${backup.id}. The client reuses this same structured request, checks its registered capabilities, and dispatches at most once after confirmed failure. Image backup proceeds after reporting the failure; video backup requires confirmation unless already authorized.` : ""}`,
        parameters: { type: "object", additionalProperties: false, properties: { model: { type: "string", enum: [selected.primary] }, parameters: contract.parameters, variation_key }, required: ["parameters", "model"] },
      } }];
    }
    const backupContract = backup ? mediaModelSchema(backup) : undefined;
    const schema = tool.function.parameters;
    const original = schema.properties as Record<string, Record<string, unknown>>;
    const { model: _model, fallback_model: _backup, fallback_parameters: _fallback, fallback_operation: _operation, fallback_reason: _reason, ...remaining } = original;
    const properties = { ...remaining, model: { type: "string", enum: [selected.primary] },
      operation: { type: "string", enum: contract.operations }, parameters: contract.parameters,
      ...(backupContract ? {
        fallback_model: { type: "string", enum: [selected.fallback] },
        fallback_parameters: { anyOf: [backupContract.parameters, { type: "null" }], description: `Same requested result using ${selected.fallback}. Preserve all required references and requested output controls. If unsupported, use null and explain fallback_reason; never silently drop references or downgrade the request.` },
        fallback_operation: { type: "string", enum: backupContract.operations },
        fallback_reason: { type: "string", minLength: 1, maxLength: 500 },
      } : {}),
    };
    return [{ ...tool, function: { ...tool.function,
      description: `${tool.function.description} Primary: ${selected.primary}. ${contract.guidance}${backupContract ? ` Backup: ${selected.fallback}. Include its native fallback_parameters for the same intent. ${backupContract.guidance} After confirmed failure the bot reports the reason and backup model before any dispatch. Image backup proceeds without another confirmation; video backup requires the person's confirmation unless an existing full access grant waives it. The client dispatches it at most once, never after uncertain status, settlement or download errors.` : ""}`,
      parameters: { ...schema, required: ["parameters", "model", ...(backupContract ? ["fallback_model", "fallback_parameters"] : [])], properties },
    } }];
  });
  const gatewayAvailable = tools.some(tool => ["agents_generate_image", "agents_generate_video", "agents_generate_audio"].includes(tool.function.name));
  const gatewayGuidance = gatewayAvailable ? "The built-in gateway uses the workspace's selected primary and backup models from the account's enabled model list. For this route, submit directly using the matching DoneBot tool; its current schema supplies exact model IDs and registered parameters. Images and videos use the same structured protocol across suppliers: prompt, mode, references, output controls and options. Supply one request only; the client validates and reuses it for the configured backup. Do not query capabilities or run discovery before gateway generation. Use only registered parameters. The gateway converts structured image/video fields into the selected supplier's format and bills the task. A saved asynchronous job runs in the background and delivers files in this same conversation. Acknowledge once; do not poll, resubmit or claim completion before the receipt. Only confirmed generation failure can trigger one configured backup; uncertain, timed out, pending settlement or download status continues the same task. These schemas supersede older fixed-model instructions while preserving the user's explicit and remembered provider preference." : "";
  const collabRule = collabRestricted
    ? " Group/team chat media policy: ONLY LLM text responses and image generation are allowed; video models and music/audio generation models are strictly forbidden. Politely refuse any video or music generation request."
    : "";
  const guidance = `${MEDIA_PROVIDER_GUIDANCE} ${DONEBOT_MODEL_CREDENTIAL_RULE} Use the existing voice tools for streaming text-to-speech.${gatewayGuidance ? ` ${gatewayGuidance}` : ""}${collabRule}`;
  return { ...input, tools, messages: [{ role: "system", content: guidance }, ...input.messages] };
}
