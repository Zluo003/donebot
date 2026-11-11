import { PROVIDER_CREDENTIAL_TARGETS } from "../../shared/credential-request.ts";

const MANAGED_CREDENTIALS: ReadonlySet<string> = new Set([
  ...PROVIDER_CREDENTIAL_TARGETS, "xaiApiKey", "opencodeGoApiKey", "openaiImageApiKey", "ttsKey", "geminiTtsKey", "fishAudioKey",
]);

export const DONEBOT_MODEL_CREDENTIAL_RULE = "DoneBot model and media services use the signed-in DoneBot account exclusively through https://donebot.cn. Do not request third-party model API keys, including as custom secrets. Generate images, videos and standalone audio only with DoneBot media tools; streaming speech uses DoneBot's existing voice channel. Do not bypass these services with direct supplier APIs, external media MCP servers, browser generators or installed media CLIs. The DoneBot client selects a registered public media model and builds its native request; the gateway only forwards and bills it. Report only the actual tool error; do not infer missing gateway configuration or substitute a local mockup for requested generated media. Local editing or format conversion of existing files is still allowed.";

const MODEL_SERVICE = /\b(?:openai|anthropic|openrouter|opencode|gemini|xai|x\.ai|elevenlabs|fish\s*audio|replicate|fal\.ai|apimart|suno|midjourney|deepseek|mistral|groq|cerebras|greenference|google\s*ai\s*studio|image\s*generation|text[ -]to[ -]speech|tts)\b|生图|视频生成|音乐生成|语音合成/i;
const SECRET = /\b(?:api[ _-]?key|key|token|credential|secret)\b|密钥|秘钥|凭据/i;

export function doneBotCredentialRefusal(name: string, args: Record<string, unknown>): string | undefined {
  if (name !== "request_credential") return undefined;
  const id = args.credential_id ?? args.credentialId;
  if (typeof id === "string" && MANAGED_CREDENTIALS.has(id)) return DONEBOT_MODEL_CREDENTIAL_RULE;
  if (id !== undefined) return undefined;
  const description = [args.label, args.reason, args.placeholder].filter((value): value is string => typeof value === "string").join(" ");
  return MODEL_SERVICE.test(description) && SECRET.test(description) ? DONEBOT_MODEL_CREDENTIAL_RULE : undefined;
}

export function doneBotCredentialTool<T extends { name: string; description: string; inputSchema: unknown }>(tool: T): T {
  if (tool.name !== "request_credential") return tool;
  const schema = tool.inputSchema as { properties: { credential_id: { enum: string[] } } };
  return { ...tool, description: `${tool.description} ${DONEBOT_MODEL_CREDENTIAL_RULE}`, inputSchema: {
    ...schema, properties: { ...schema.properties, credential_id: { ...schema.properties.credential_id,
      enum: schema.properties.credential_id.enum.filter(id => !MANAGED_CREDENTIALS.has(id)) } },
  } };
}
