import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import type { SendTurnInput } from "../contracts.ts";
import { allowsTool, parseToolScope } from "../../shared/tool-scope.ts";
import type { DoneBotCatalog } from "../../shared/donebot.ts";
import { createOpenAIChatRuntime } from "../drivers/openai-chat.ts";
import { createDoneBotCompletion, type DoneBotLlmProtocol, type DoneBotLlmRequest } from "./llm-protocol.ts";
import { guideDoneBotMedia } from "./media-guidance.ts";
import { createWorkspaceTools } from "./workspace-tools.ts";

const MEDIA_CAPABILITY_TOOL = "mcp:agents:media_model_capabilities";
const MEDIA_GENERATION_TOOLS = ["generate_image", "generate_video", "generate_audio"] as const;

export function doneBotMediaToolScope(scope: SendTurnInput["toolScope"]): SendTurnInput["toolScope"] {
  const parsed = parseToolScope(scope);
  if (!parsed.ok || !parsed.scope?.allow || allowsTool(parsed.scope, { kind: "mcp", server: "agents", name: "media_model_capabilities" }) ||
      !MEDIA_GENERATION_TOOLS.some(name => allowsTool(parsed.scope, { kind: "mcp", server: "agents", name }))) return scope;
  return { ...parsed.scope, allow: [...parsed.scope.allow, MEDIA_CAPABILITY_TOOL] };
}

export interface DoneBotLlmDependencies {
  request: DoneBotLlmRequest;
  models(): ModelCatalog;
  protocol(model: string): DoneBotLlmProtocol;
  authenticated(): boolean;
  imageInput?(model: string): boolean;
  catalog?(): DoneBotCatalog | null;
  toolUse?(model: string): boolean;
}

export function createDoneBotLlmDriver(deps: DoneBotLlmDependencies): ProviderDriver<Record<string, never>> {
  return {
    driverKind: "donebot",
    metadata: { displayName: "DoneBot", access: "api" },
    get models() { return deps.models(); },
    decodeConfig(raw) { if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length)) throw new Error("DoneBot model service is managed by your account"); return {}; },
    defaultConfig: () => ({}),
    async create(input) {
      const complete = createDoneBotCompletion(deps.request, model => {
        if (!deps.authenticated()) throw new Error("Sign in to DoneBot to use models");
        if (!deps.models().options.some(one => one.id === model)) throw new Error("This model is not available to your DoneBot account");
        return deps.protocol(model);
      });
      const runtime = createOpenAIChatRuntime({ input, driverKind: "donebot", apiKey: "", apiUrl: "https://donebot.cn/v1", authenticated: deps.authenticated,
        models: deps.models, completionTransport: turn => complete(guideDoneBotMedia(turn, deps.catalog?.() ?? null)),
        localTools: createWorkspaceTools, computerUse: true, imageInput: deps.imageInput, toolUse: deps.toolUse, modelVariants: true,
        requestBody: () => { throw new Error("DoneBot models require their registered native protocol"); },
        httpErrorLabel: "DoneBot gateway", missingKeyError: "Sign in to DoneBot to use models", unavailableReason: "Sign in to DoneBot to use models", timeoutMs: 180_000,
        retryScale: 1,
        reasoning: true, billing: "metered", includeUsageInCompleted: true,
        nativeLog: { source: "donebot.native", outgoing: (_turn, messages, model, tools) => ({ model, messageCount: messages.length, tools: tools.map(({ function: fn }) => fn.name) }), incoming: ({ text, reasoning, usage }) => ({ textLength: text.length, reasoningLength: reasoning.length, usage }) },
      });
      return { ...runtime, get models() { return runtime.models; }, adapter: { ...runtime.adapter,
        sendTurn: turn => runtime.adapter.sendTurn({ ...turn, toolScope: doneBotMediaToolScope(turn.toolScope) }),
      } };
    },
  };
}
