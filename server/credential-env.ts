// Credential env names and the strippers that keep them out of child processes. Lives apart from
// config.ts so the lists can grow (one name per engine) without that file growing with them.

/** Workspace credential env names; spawned engine CLIs must never inherit them. */
export const WORKSPACE_CREDENTIAL_ENV = [
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "CEREBRAS_API_KEY",
  "DONEBOT_GROQ_API_KEY",
  "DONEBOT_GREENFERENCE_API_KEY",
  "DONEBOT_MODELGO_API_KEY",
  "DONEBOT_META_API_KEY",
  "DONEBOT_DEEPSEEK_API_KEY",
  "DONEBOT_ANTHROPIC_API_KEY",
  "DONEBOT_ANTHROPIC_API_URL",
  "DONEBOT_HOSTED_MODEL_TOKEN",
  "DONEBOT_HOSTED_MODELS",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_URL",
  "DONEBOT_OPENAI_API_KEY",
  "DONEBOT_OPENROUTER_API_KEY",
  "BOX_TOKEN",
  "OPENCODE_API_KEY",
  "DONEBOT_TTS_KEY",
  "DONEBOT_FISH_AUDIO_API_KEY",
  "DONEBOT_GEMINI_API_KEY",
  "DONEBOT_JEV_API_KEY",
  "DONEBOT_OPENROUTER_DECIDER_KEY",
  "DONEBOT_WORKERS_AI_TOKEN",
  "DONEBOT_OPENAI_IMAGE_KEY",
  "DONEBOT_CUSTOM_IMAGE_KEY",
  "DONEBOT_GEMINI_IMAGE_KEY",
  "DONEBOT_OPENAI_LIVE_KEY", "DONEBOT_TREG_KEY", "DONEBOT_POSTIZ_API_KEY",
  "COMPOSIO_API_KEY",
  "DONEBOT_COMPOSIO_BROKER_TOKEN",
  "DONEBOT_CLOUD_BOAT_TOKEN",
  "DONEBOT_CLOUD_VOICE_TOKEN",
  "DONEBOT_CLOUD_DECIDER_TOKEN",
  "DONEBOT_CLOUD_AI_TOKEN", "DONEBOT_CLOUD_X_TOKEN", "DONEBOT_CLOUD_CONNECTED_APPS_GRANT",
  // Not credentials, but they point a shell-capable agent at app-owned state.
  "DONEBOT_BROWSER_CONNECTION", "DONEBOT_USER_DATA", "DONEBOT_BOAT_API",
] as const;

/** Operator secrets only this process reads, plus every `DONEBOT_CLOUD_` var (the underscore leaves out DONEBOT_CLOUDFLARED_PATH). */
export const CONTROL_PLANE_ENV = ["DONEBOT_LICENSE_KEY", "DONEBOT_INSTALLATION_CREDENTIAL"] as const;
export const CONTROL_PLANE_ENV_PREFIX = "DONEBOT_CLOUD_";

/** Names compare case-insensitively because Windows environments do. */
export function stripControlPlaneEnv(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    if (name.startsWith(CONTROL_PLANE_ENV_PREFIX) || (CONTROL_PLANE_ENV as readonly string[]).includes(name)) delete env[key];
  }
}

export function stripWorkspaceCredentialEnv(env: Record<string, string | undefined>): void {
  for (const key of WORKSPACE_CREDENTIAL_ENV) delete env[key];
  stripControlPlaneEnv(env);
}

const DESKTOP_STORE_KEY_ENV: ReadonlySet<string> = new Set(["MISTRAL_API_KEY", "CEREBRAS_API_KEY", "OPENAI_COMPAT_API_KEY", "DONEBOT_OPENAI_API_KEY", "DONEBOT_OPENROUTER_API_KEY"]);

/** A key an operator set on the server. Security: under the desktop app these variables hold workspace keys from its
 * encrypted store, which reach only the instances the workspace routes, never one with a URL of its own. */
export function operatorEnvKey(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.DONEBOT_DESKTOP_PARENT === "1" && DESKTOP_STORE_KEY_ENV.has(name) ? undefined : env[name];
}

/** Env a provider CLI may read as its billing identity; a foreign key must never move a subscription CLI onto API billing. */
export const PROVIDER_CREDENTIAL_ENV = [
  "CLINE_API_KEY",
  "ANTHROPIC_API_KEY",
  "FACTORY_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "CEREBRAS_API_KEY",
  "GROQ_API_KEY",
  "GREENFERENCE_API_KEY",
  "MODELGO_API_KEY",
  "META_API_KEY",
  "DEEPSEEK_API_KEY",
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
] as const;

/** Provider keys OpenCode reads from its environment (with ANTHROPIC_API_KEY set it lists Anthropic's models). */
export const OPENCODE_PROVIDER_ENV = [
  "CLINE_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;
