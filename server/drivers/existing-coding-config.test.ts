import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";

const scratch: string[] = [];
const instances: ProviderInstance[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
  for (const directory of scratch.splice(0)) removeTempDir(directory);
});

it.each(["codex", "claude"] as const)("runs %s turns and background calls with existing provider configuration intact", async engine => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "donebot-existing-cli-")));
  scratch.push(directory);
  const cliHome = join(directory, engine === "codex" ? ".codex" : ".claude");
  mkdirSync(cliHome);
  const configuration = engine === "codex"
    ? 'model = "configured-model"\nmodel_provider = "user-provider"\nmodel_reasoning_effort = "high"\n[model_providers.user-provider]\nname = "User provider"\nbase_url = "https://existing.invalid/v1"\nwire_api = "responses"\n'
    : JSON.stringify({ model: "configured-model", effortLevel: "high", env: { ANTHROPIC_BASE_URL: "https://existing.invalid" } });
  const configFile = join(cliHome, engine === "codex" ? "config.toml" : "settings.json");
  const authFile = join(cliHome, engine === "codex" ? "auth.json" : ".credentials.json");
  const credentials = JSON.stringify({ fixtureOnly: "synthetic-existing-auth" });
  writeFileSync(configFile, configuration); writeFileSync(authFile, credentials);
  const dump = join(directory, "turn.json"), textDump = join(directory, "background.json");
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", engine === "codex" ? "fake-codex-app-server.ts" : "fake-claude-cli.ts");
  chmodSync(cli, 0o755);
  const environment = {
    HOME: directory, USERPROFILE: directory,
    ...(engine === "codex" ? { CODEX_HOME: cliHome, OPENAI_API_KEY: "synthetic-user-key", FAKE_CODEX_DUMP: dump, FAKE_CODEX_DUMP_TURNS_ONLY: "1", FAKE_CODEX_TEXT_LOG: textDump, FAKE_CODEX_MODE: "logged-out" }
      : { CLAUDE_CONFIG_DIR: cliHome, ANTHROPIC_BASE_URL: "https://existing.invalid", ANTHROPIC_API_KEY: "synthetic-user-key", ANTHROPIC_MODEL: "configured-model", FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_TEXT_DUMP: textDump, FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_AUTH: "out" }),
  };
  const input = { instanceId: `existing-${engine}-fixture`, displayName: "Fixture", enabled: true, environment };
  const instance = engine === "codex"
    ? await CodexDriver.create({ ...input, config: CodexDriver.decodeConfig({ cli, preserveModelConfig: true }) })
    : await ClaudeDriver.create({ ...input, config: ClaudeDriver.decodeConfig({ cli, preserveModelConfig: true }) });
  instances.push(instance);
  expect(await instance.snapshot()).toMatchObject({ state: "available" });
  const events = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: `existing-${engine}-turn`, cwd: directory, text: "Reply with fixture completion.", approvalMode: "ask" });
    expect(await events.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env[engine === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]).toBe(cliHome);
    expect(seen.env[engine === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"]).toBe("synthetic-user-key");
    expect(seen.argv).not.toContain("--model"); expect(seen.argv).not.toContain("--effort");
    if (engine === "codex") {
      expect(seen.argv.join(" ")).not.toMatch(/model_provider=|model_reasoning_effort=/);
      const start = seen.calls.find((call: { method: string }) => call.method === "thread/start");
      expect(start.params.model).toBeNull(); expect(start.params.modelProvider).toBeUndefined();
      const turn = seen.calls.find((call: { method: string }) => call.method === "turn/start");
      expect(turn.params.effort).toBeUndefined();
    } else {
      expect(seen.argv).toContain("user,project,local");
      expect(seen.env.ANTHROPIC_MODEL).toBe("configured-model");
      expect(seen.env.ANTHROPIC_BASE_URL).toBe("https://existing.invalid");
    }
    await (instance.generateText ?? instance.generateMemoryText)!("Reply with background fixture completion.");
    const text = readFileSync(textDump, "utf8").trim();
    const background = JSON.parse(engine === "codex" ? text.split("\n")[0]! : text);
    expect(background.argv).not.toContain("--model"); expect(background.argv).not.toContain("--ignore-user-config");
    expect(background.argv.join(" ")).not.toMatch(/model_reasoning_effort=|alwaysThinkingEnabled/);
    expect(background.env[engine === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]).toBe(cliHome);
    expect(readFileSync(configFile, "utf8")).toBe(configuration);
    expect(readFileSync(authFile, "utf8")).toBe(credentials);
  } finally { events.stop(); }
});
