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

  it.each(["Gemini speech API key", "OpenAI API key", "ElevenLabs token", "Fish Audio key", "Suno API key", "fal.ai API key", "语音合成密钥"])("refuses model credentials disguised as a custom %s card", label => {
    expect(doneBotCredentialRefusal("request_credential", { label, delivery: "file" })).toContain("custom secrets");
    expect(doneBotCredentialRefusal("request_credential", { credentialId: "geminiTtsKey" })).toContain("signed-in DoneBot account");
    expect(doneBotCredentialRefusal("request_credential", { label: "API token", reason: "Use Google AI Studio for media generation" })).toBeDefined();
  });
});
