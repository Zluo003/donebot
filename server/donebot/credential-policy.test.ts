import { describe, expect, it, vi } from "vitest";
import { PROVIDER_CREDENTIAL_TARGETS } from "../../shared/credential-request.ts";
import { availableTools, catalogProfileFromEnv } from "../drivers/agents-catalog.ts";
import { callTool, type ToolCallContext } from "../drivers/agents-call.ts";
import { doneBotCredentialRefusal } from "./credential-policy.ts";

describe("DoneBot managed model credentials", () => {
  const blocked = [...PROVIDER_CREDENTIAL_TARGETS, "xaiApiKey", "opencodeGoApiKey", "openaiImageApiKey", "ttsKey", "geminiTtsKey", "fishAudioKey"];

  it("offers application credentials without advertising external model keys", () => {
    const credentials = (donebotMedia: boolean) => {
      const tool = availableTools(catalogProfileFromEnv(donebotMedia ? { DONEBOT_MEDIA: "1" } : {})).find(tool => tool.name === "request_credential")!;
      return (tool.inputSchema as { properties: { credential_id: { enum: string[] } } }).properties.credential_id.enum;
    };
    expect(credentials(false)).toEqual(expect.arrayContaining(blocked));
    expect(credentials(true)).toEqual(expect.arrayContaining(["composioApiKey", "onePasswordToken", "email"]));
    for (const id of blocked) expect(credentials(true)).not.toContain(id);
  });

  it.each(blocked)("refuses a stale or invented %s request before creating a card", async credential_id => {
    const api = vi.fn(async () => ({ id: "fixture-card" })), apiResponse = vi.fn();
    const context: ToolCallContext = { botId: "fixture", threadId: "fixture", depth: 0, externalRuntime: false, sharedComputers: false,
      donebotMedia: true, client: { api, apiResponse } };
    expect(await callTool("request_credential", { credential_id }, context)).toMatchObject({ isError: true, text: expect.stringContaining("signed-in DoneBot account") });
    expect(api).not.toHaveBeenCalled(); expect(apiResponse).not.toHaveBeenCalled();
    expect((await callTool("request_credential", { credential_id }, { ...context, donebotMedia: false })).isError).not.toBe(true);
    expect(api).toHaveBeenCalledOnce();
  });

  it("keeps business credentials, custom secrets and unrelated tools available", () => {
    for (const credential_id of ["composioApiKey", "onePasswordToken", "email", "boxToken", undefined]) {
      expect(doneBotCredentialRefusal("request_credential", { credential_id, label: "Store API token" })).toBeUndefined();
    }
    expect(doneBotCredentialRefusal("list_bots", { credential_id: "openaiApiKey" })).toBeUndefined();
  });

  it.each(["Gemini speech API key", "OpenAI API key", "ElevenLabs token", "Fish Audio key", "Suno API key", "fal.ai API key", "语音合成密钥"])("allows a custom %s card for an external tool while reserving built-in settings", label => {
    expect(doneBotCredentialRefusal("request_credential", { label, reason: "Authenticate the user's selected external media tool", delivery: "file" })).toBeUndefined();
    expect(doneBotCredentialRefusal("request_credential", { credentialId: "geminiTtsKey" })).toContain("signed-in DoneBot account");
    expect(doneBotCredentialRefusal("request_credential", { label: "API token", reason: "Use Google AI Studio for media generation" })).toBeUndefined();
  });

  it.each(["ref", "file"])("forwards an external media secret's %s request to the existing secure card mechanism", async delivery => {
    const api = vi.fn(), apiResponse = vi.fn(async (_path: string, _init?: { body?: string }) => ({ ok: true, status: 201, body: { id: "fixture-card" } }));
    const context: ToolCallContext = { botId: "fixture", threadId: "fixture", depth: 0, externalRuntime: false, sharedComputers: false,
      donebotMedia: true, client: { api, apiResponse } };
    const args = { label: "Suno API key", reason: "The user chose an external music tool", delivery };
    expect((await callTool("request_credential", args, context)).isError).not.toBe(true);
    expect(api).not.toHaveBeenCalled();
    expect(apiResponse).toHaveBeenCalledOnce();
    expect(JSON.parse(apiResponse.mock.calls[0]![1]!.body!)).toMatchObject(args);
  });

  it.each([
    { label: "OpenAI API key" },
    { label: "Gemini token", reason: "Connect a third-party chat completions endpoint" },
    { label: "External API token", reason: "Use another LLM through an MCP server" },
    { label: "第三方密钥", reason: "配置聊天模型" },
    { label: "Suno API key", reason: "Also configure an external LLM" },
  ])("refuses external LLM credentials, including custom cards: %j", async args => {
    const api = vi.fn(), apiResponse = vi.fn();
    const context: ToolCallContext = { botId: "fixture", threadId: "fixture", depth: 0, externalRuntime: false, sharedComputers: false,
      donebotMedia: true, client: { api, apiResponse } };
    expect(await callTool("request_credential", { ...args, delivery: "ref" }, context)).toMatchObject({ isError: true, text: expect.stringContaining("LLM access must") });
    expect(api).not.toHaveBeenCalled();
    expect(apiResponse).not.toHaveBeenCalled();
  });
});
