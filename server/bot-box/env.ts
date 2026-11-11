// The environment a boxed process gets: an allow-list, never the server's whole environment. The drivers already strip
// the workspace credentials and every DONEBOT_CLOUD_ setting before a spawn (server/config.ts stripWorkspaceCredentialEnv);
// this is the second gate, applied at the box boundary, so a name a driver forgot never reaches a bot's shell.

/** Names a bot's engine, its tools and the proxies DoneBot starts inside the box may read. */
export const BOX_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "HOSTNAME", "PWD",
  "LANG", "LANGUAGE", "TZ", "TERM", "COLORTERM", "TMPDIR", "NO_COLOR", "FORCE_COLOR", "CI", "DEBUG",
  "NODE_ENV", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY",
  "AGENT_BROWSER_EXECUTABLE_PATH", "BROWSER", "BASH_MAX_TIMEOUT_MS", "ELECTRON_RUN_AS_NODE", "PYTHONUNBUFFERED", "PYTHONDONTWRITEBYTECODE",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
]);

/** DoneBot's own variables a boxed process reads: what the harness sets for a bot's engine, its hooks and the MCP
 * proxies it starts. Security: no other `DONEBOT_` name passes, whatever the operator set on the server (an SMTP URL, a
 * token); env.test.ts lists every `DONEBOT_` name the server knows, so a new one needs a decision. */
export const BOX_ENV_DONEBOT_NAMES: ReadonlySet<string> = new Set([
  "DONEBOT_HARNESS_URL", "DONEBOT_BOT_ID", "DONEBOT_THREAD_ID", "DONEBOT_COMMS_TOKEN", "DONEBOT_TURN_DEPTH", "DONEBOT_EXTERNAL_RUNTIME",
  "DONEBOT_CHIEF_OF_STAFF", "DONEBOT_MAUSBOT", "DONEBOT_SKILL_AUTHORING_ENABLED", "DONEBOT_MEMORY_ENABLED", "DONEBOT_SHARED_COMPUTERS_ENABLED",
  "DONEBOT_VOICE_NOTES", "DONEBOT_X_RESEARCH", "DONEBOT_RESEARCH", "DONEBOT_TEAM_PEOPLE", "DONEBOT_COMPUTER_SELECTION", "DONEBOT_ROOM",
  "DONEBOT_MEDIA", "DONEBOT_IMAGE_GENERATION", "DONEBOT_MEETINGS", "DONEBOT_AGENTS_TOOL_BRIDGE", "DONEBOT_TOOL_LIMIT", "DONEBOT_TOOL_SCHEMA_PROFILE",
  "DONEBOT_MCP_CONFIG", "DONEBOT_MCP_RESTART", "DONEBOT_MCP_RESULT_BUDGET",
  "DONEBOT_HOOK_URL", "DONEBOT_HOOK_TOKEN_FILE", "DONEBOT_HOOK_TIMEOUT_MS", "DONEBOT_PERMISSION_TOOL_SCOPE",
  "DONEBOT_CONNECTOR_UPSTREAM_URL", "DONEBOT_CONNECTOR_UPSTREAM_HEADERS", "DONEBOT_CONNECTOR_TOKEN", "DONEBOT_CONNECTOR_ALLOWED_TOOLS",
  "DONEBOT_CONNECTOR_SERVICE_SLUGS", "DONEBOT_CONNECTOR_APP_TOOLS", "DONEBOT_CONNECTOR_APP_TOOL_NAMES",
  "DONEBOT_GATE_NAME", "DONEBOT_GATE_UPSTREAM", "DONEBOT_GATE_BUDGET", "DONEBOT_GATE_SPILL_DIR", "DONEBOT_GATE_SPILL_HINT", "DONEBOT_GATE_TOOL_SCOPE",
  "DONEBOT_GATE_DIRECTORY", "DONEBOT_GATE_APPS", "DONEBOT_REMOTE_MCP_SERVER", "DONEBOT_REMOTE_MCP_DIRECTORY", "DONEBOT_REMOTE_MCP_APPS",
  "DONEBOT_CONTROL_URL", "DONEBOT_CONTROL_TOKEN", "DONEBOT_COMPUTER_JOURNAL", "DONEBOT_CUA_ARGS", "DONEBOT_CUA_COMMAND", "DONEBOT_CUA_PLATFORM",
  "DONEBOT_PHONE_TOKEN", "DONEBOT_ADB_PATH", "DONEBOT_RESOURCES_PATH", "DONEBOT_CODEX_AUTH_SOCKET", "DONEBOT_CODEX_AUTH_SECRET",
  "DONEBOT_COPILOT_MCP_CONFIG", "DONEBOT_BROWSER_PROFILE", "DONEBOT_BOX_PROBE", "DONEBOT_EXTRA_PATH", "DONEBOT_TEST_SEALED_PATH",
]);
/** Families of the same, one variable per server or kind: a harness MCP server's token, a gated or remote server's config. */
export const BOX_ENV_DONEBOT_PREFIXES: readonly string[] = ["DONEBOT_MCP_TOKEN_", "DONEBOT_GATE_CONFIG_", "DONEBOT_REMOTE_MCP_CONFIG_"];

/** Prefixes of the engines' own settings and keys (T0b replaces the keys with per-turn broker tokens). */
export const BOX_ENV_PREFIXES: readonly string[] = [
  "LC_", "OPENMAUSBOT_", "NPM_CONFIG_", "npm_config_",
  "ANTHROPIC_", "CLAUDE_", "CODEX_", "OPENAI_", "OPENCODE_", "OPENROUTER_", "GEMINI_", "GOOGLE_", "GROK_", "XAI_",
  "MISTRAL_", "CEREBRAS_", "GROQ_", "GREENFERENCE_", "MODELGO_", "META_", "MINIMAX_", "KIMI_", "MOONSHOT_", "CURSOR_", "FACTORY_", "CLINE_", "HERMES_",
  "MUSE_", "PI_", "DWEB_", "UNSLOTH_", "FAKE_CLAUDE_", "MCP_", "ANTIGRAVITY_", "AGY_",
];

/** Never, whatever the allow-list says: the control plane's settings and secrets, and the server's own placement. The
 * CLI's session token and server address (server/headless/client.ts) too: nothing in a box reads them, and one an
 * operator set on the server would otherwise pass under the engines' OPENMAUSBOT_ prefix. */
export const BOX_ENV_NEVER: ReadonlySet<string> = new Set([
  "DONEBOT_LICENSE_KEY", "DONEBOT_INSTALLATION_CREDENTIAL", "DONEBOT_LOOPBACK_TRUST", "DONEBOT_CLOUD_SECRETS_FD",
  "DONEBOT_DATA_DIR", "DONEBOT_STATIC_DIR", "DONEBOT_DUCKDB_DIR", "DONEBOT_PORT", "DONEBOT_WEBHOOK_PORT",
  "DONEBOT_TOKEN", "DONEBOT_URL",
]);
export const BOX_ENV_NEVER_PREFIXES: readonly string[] = ["DONEBOT_CLOUD_"];

/** `allow` is what one spawn vouches for: the keys the person saved for its engine, under whatever name that engine reads
 * (NANO_GPT_API_KEY, OPENCODE_API_KEY). Security: it lifts the allow-list and `deny` for that process only, and never for
 * a name of DoneBot's own (`DONEBOT_`) or one on the never-list. */
export function boxEnvironmentAllows(name: string, deny: ReadonlySet<string> = new Set(), allow: ReadonlySet<string> = new Set()): boolean {
  if (BOX_ENV_NEVER.has(name) || BOX_ENV_NEVER_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  if (allow.has(name) && !name.startsWith("DONEBOT_")) return true;
  if (deny.has(name)) return false;
  if (name.startsWith("DONEBOT_")) return BOX_ENV_DONEBOT_NAMES.has(name) || BOX_ENV_DONEBOT_PREFIXES.some((prefix) => name.startsWith(prefix));
  return BOX_ENV_NAMES.has(name) || BOX_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The box's environment: the allowed names of `env` with a value, in a fresh object. `deny` adds names (the workspace
 * credentials) that are refused even when a prefix would allow them. */
export function boxEnvironment(
  env: Record<string, string | undefined>,
  deny: ReadonlySet<string> = new Set(),
  allow: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !boxEnvironmentAllows(name, deny, allow)) continue;
    kept[name] = value;
  }
  return kept;
}

/** The names of `env` that hold the value `instance` gave them: what the environment configured for one engine instance
 * (its saved keys) put in a spawn, for that spawn's `allowEnv`. */
export function instanceEnvNames(instance: Readonly<Record<string, string>>, env: Record<string, string | undefined>): string[] {
  return Object.keys(instance).filter((name) => env[name] !== undefined && env[name] === instance[name]);
}
