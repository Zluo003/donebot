import { PROVIDER_CREDENTIAL_TARGETS } from "../../shared/credential-request.ts";

const MANAGED_CREDENTIALS: ReadonlySet<string> = new Set([
  ...PROVIDER_CREDENTIAL_TARGETS, "xaiApiKey", "opencodeGoApiKey", "openaiImageApiKey", "ttsKey", "geminiTtsKey", "fishAudioKey",
]);

export const DONEBOT_MODEL_CREDENTIAL_RULE = "LLM access must use the signed-in DoneBot account through https://donebot.cn; do not connect third-party LLMs through API keys, custom secrets, CLIs or MCP. Built-in media and speech also use this account; do not request provider keys to configure or repair them. The external-provider exception is for image, video and audio generation, including music. User-selected media tools use their own authentication. For a required external media secret, use request_credential with a custom label, a reason identifying the media purpose, and delivery (ref for MCP, file for commands), not a built-in credential_id. Never pass the DoneBot credential to an external tool or ask for secrets in chat. Report actual errors and verified results.";

const MODEL_SERVICE = /\b(?:openai|anthropic|openrouter|opencode|gemini|xai|x\.ai|elevenlabs|fish\s*audio|replicate|fal\.ai|apimart|suno|midjourney|deepseek|mistral|groq|cerebras|greenference|google\s*ai\s*studio|tts)\b|语音合成/i;
const LLM_PURPOSE = /\b(?:llms?|language[ -]models?|chat[ -]completions?|responses[ -]api|text[ -]generation|reasoning[ -]models?|chatbot)\b|大模型|语言模型|推理模型|聊天模型|对话模型|文本生成/i;
const MEDIA_PURPOSE = /\b(?:image|video|audio|music|media|seedream|seedance|suno|dreamina|midjourney)\b|即梦|生图|绘图|图片|图像|视频|音频|音乐/i;

export function doneBotCredentialRefusal(name: string, args: Record<string, unknown>): string | undefined {
  if (name !== "request_credential") return undefined;
  const id = args.credential_id ?? args.credentialId;
  if (typeof id === "string" && MANAGED_CREDENTIALS.has(id)) return DONEBOT_MODEL_CREDENTIAL_RULE;
  if (id !== undefined && id !== "") return undefined;
  const description = [args.label, args.reason, args.placeholder].filter((value): value is string => typeof value === "string").join(" ");
  if (LLM_PURPOSE.test(description) || (MODEL_SERVICE.test(description) && !MEDIA_PURPOSE.test(description))) return DONEBOT_MODEL_CREDENTIAL_RULE;
  return undefined;
}

export function doneBotCredentialTool<T extends { name: string; description: string; inputSchema: unknown }>(tool: T): T {
  if (tool.name !== "request_credential") return tool;
  const schema = tool.inputSchema as { properties: { credential_id: { enum: string[] } } };
  return { ...tool, description: `${tool.description} ${DONEBOT_MODEL_CREDENTIAL_RULE}`, inputSchema: {
    ...schema, properties: { ...schema.properties, credential_id: { ...schema.properties.credential_id,
      enum: schema.properties.credential_id.enum.filter(id => !MANAGED_CREDENTIALS.has(id)) } },
  } };
}
