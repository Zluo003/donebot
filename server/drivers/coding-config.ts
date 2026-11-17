import type { CodexEndpointConfig } from "./codex-endpoint-config.ts";

export interface CodexConfig {
  cli: string;
  fullAuto: boolean;
  preserveModelConfig?: boolean;
  authMode?: "chatgpt-plan";
  managed?: CodexEndpointConfig;
  endpoint?: CodexEndpointConfig;
}

export interface ClaudeConfig {
  cli: string;
  configDir?: string;
  managed?: boolean;
  managedModels?: string[];
  /** A custom endpoint's own models: the whole catalog, first one the default. No Claude model is offered. */
  endpointModels?: string[];
  preserveModelConfig?: boolean;
  permissionMode: "acceptEdits" | "auto" | "bypassPermissions";
  tools?: string[];
  disallowedTools?: string[];
  requireApiKey?: boolean; bedrock?: boolean;
}
