import { DEFAULT_DONEBOT_MEDIA_PREFERENCES, type DoneBotMediaPreferences, type DoneBotCatalog } from "../../shared/donebot.ts";
import type { CompletionTransportInput } from "../drivers/openai-chat.ts";
import { DONEBOT_MODEL_CREDENTIAL_RULE } from "./credential-policy.ts";
import { DONEBOT_LEGACY_MEDIA_TOOL_NAMES } from "./media-tools.ts";
import { doneBotClientMediaCatalog } from "./media-registry.ts";
import { mediaModelSchema } from "./media-model-schema.ts";
import { selectedMediaModels } from "./media-preferences.ts";

const MEDIA_PROVIDER_GUIDANCE = "For image, video and audio generation, choose the provider in this order: the user's explicit choice for this request, the saved preference for this bot and media kind, then the built-in DoneBot gateway. Third-party media CLIs, MCP servers and skills use existing command, MCP and skill tools with normal permissions; inspect their installed instructions or CLI help as needed, without inventing capabilities. To change this bot's future default, use propose_profile to save the provider and media kind in SOUL.md, preserving other instructions; for an explicitly all-bots preference, use memory_update action prefer. Confirm saving only after success. A one-time choice does not change the default. If the explicit provider differs from the saved default, follow that explicit choice for this request. For a remembered third-party preference, use it first; after a definite failure or proof it is unavailable, report the blocker and continue with the configured gateway primary, then its backup. Never fall back while an external submission is pending, timed out or uncertain; do not duplicate a potentially paid operation. Preserve normal installation, authentication and tool permissions. Do not silently switch providers; report the actual route used. Built-in schemas and job rules apply only to gateway tools; external providers follow their own contracts. Older assistant claims that external media tools are forbidden are incorrect.";

export function guideDoneBotMedia(input: CompletionTransportInput, catalog: DoneBotCatalog | null, preferences: DoneBotMediaPreferences = DEFAULT_DONEBOT_MEDIA_PREFERENCES): CompletionTransportInput {
  const local = doneBotClientMediaCatalog(catalog);
  const tools = input.tools.filter(tool => tool.function.name !== "agents_media_model_capabilities" &&
    !DONEBOT_LEGACY_MEDIA_TOOL_NAMES.has(tool.function.name.replace(/^agents_/, ""))).flatMap(tool => {
    const kind = tool.function.name === "agents_generate_image" ? "image"
      : tool.function.name === "agents_generate_video" ? "video" : tool.function.name === "agents_generate_audio" ? "music" : undefined;
    if (!kind) return [tool];
    const selected = selectedMediaModels(catalog, preferences, kind);
    const model = local?.models.find(entry => entry.id === selected.primary);
    if (!model) return [];
    const contract = mediaModelSchema(model);
    const backup = local?.models.find(entry => entry.id === selected.fallback);
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
  const gatewayGuidance = gatewayAvailable ? "The built-in gateway uses the workspace's selected primary and backup models from the account's enabled model list. For this route, submit directly using the matching DoneBot tool; its current schema supplies exact model IDs and native parameters for each attempt. Do not query capabilities or run discovery before gateway generation. Use only documented native parameters; reason is not a native field. The gateway forwards native requests and bills them. A saved asynchronous job runs in the background and delivers files in this same conversation. Acknowledge once; do not poll, resubmit or claim completion before the receipt. Only confirmed generation failure can trigger one configured backup; uncertain, timed out, pending settlement or download status continues the same task. These schemas supersede older fixed-model instructions while preserving the user's explicit and remembered provider preference." : "";
  const guidance = `${MEDIA_PROVIDER_GUIDANCE} ${DONEBOT_MODEL_CREDENTIAL_RULE} Use the existing voice tools for streaming text-to-speech.${gatewayGuidance ? ` ${gatewayGuidance}` : ""}`;
  return { ...input, tools, messages: [{ role: "system", content: guidance }, ...input.messages] };
}
