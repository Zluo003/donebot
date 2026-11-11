import { describe, expect, it, vi } from "vitest";
import type { CompletionTransportInput } from "../drivers/openai-chat.ts";
import { FAKE_DONEBOT_CATALOG } from "../testing/fake-donebot-gateway.ts";
import { createDoneBotCompletion } from "./llm-protocol.ts";
import { guideDoneBotMedia } from "./media-guidance.ts";
import { DONEBOT_MEDIA_TOOL_DEFINITIONS } from "./media-tools.ts";

const input = (): CompletionTransportInput => ({ model: "gemini-4-argon", stream: false, signal: new AbortController().signal,
  replay: () => undefined, onBytes: vi.fn(), messages: [{ role: "user", content: "Create a product image" }],
  tools: DONEBOT_MEDIA_TOOL_DEFINITIONS.map(tool => ({ type: "function", function: { name: `agents_${tool.name}`, description: tool.description, parameters: tool.inputSchema } })),
});

describe("DoneBot client-side media model selection", () => {
  it("exposes media capability discovery and the three generation tools", () => {
    const turn = input();
    turn.tools.push(
      { type: "function", function: { name: "agents_media_center", description: "Old center", parameters: {} } },
      { type: "function", function: { name: "agents_model_capabilities", description: "Old catalog", parameters: {} } },
      { type: "function", function: { name: "agents_generate_music", description: "Old audio tool", parameters: {} } },
      { type: "function", function: { name: "other_generate_image", description: "Unrelated", parameters: {} } },
    );
    const guided = guideDoneBotMedia(turn, FAKE_DONEBOT_CATALOG);
    expect(guided.tools.map(tool => tool.function.name)).toEqual([
      "agents_media_model_capabilities", "agents_generate_image", "agents_generate_video", "agents_generate_audio", "agents_media_job_status", "agents_media_stop_waiting", "other_generate_image",
    ]);
    expect(guided.model).toBe(turn.model);
    expect(guided.messages.slice(1)).toEqual(turn.messages);
    expect(guided.messages[0]?.content).toContain("The model choice and request construction happen in this client");
    expect(guided.messages[0]?.content).toContain("existing voice tools for streaming text-to-speech");
    expect(JSON.stringify(guided.tools)).not.toContain("preferred_model");
    expect(JSON.stringify(guided.tools)).toContain("media_model_capabilities");
  });

  it("requires explicit public models and native request parameter bodies", () => {
    const turn = input(), original = structuredClone({ messages: turn.messages, tools: turn.tools });
    const guided = guideDoneBotMedia(turn, FAKE_DONEBOT_CATALOG);
    expect(guided.model).toBe(turn.model);
    expect(guided.messages[0]?.content).toContain("choose a locally supported public model");
    expect(guided.messages[0]?.content).toContain("same conversation");
    for (const name of ["agents_generate_image", "agents_generate_video", "agents_generate_audio"]) {
      const tool = guided.tools.find(candidate => candidate.function.name === name)!;
      expect(tool.function.parameters.required).toEqual(["model", "parameters"]);
      expect(tool.function.parameters.properties).toHaveProperty("model");
      expect(tool.function.parameters.properties).toHaveProperty("parameters");
    }
    expect(JSON.stringify(guided.tools[0]?.function.parameters)).toContain('"enum":["image","video","audio"]');
    expect({ messages: turn.messages, tools: turn.tools }).toEqual(original);
  });

  it("does not expose catalog model names through prompts or media schemas", () => {
    const catalog = structuredClone(FAKE_DONEBOT_CATALOG);
    catalog.models.push({ id: "unknown-image", display_name: "Unknown", media_types: ["image"], interfaces: ["openai.images"], platforms: [] });
    const guided = JSON.stringify(guideDoneBotMedia(input(), catalog));
    expect(guided).not.toContain("gpt-image-2.5-flare");
    expect(guided).not.toContain("unknown-image");
  });

  it("overrides stale failure claims without removing conversation history", () => {
    const turn = input();
    turn.messages = [
      { role: "assistant", content: "This conversation cannot generate media; open a new chat and configure a provider." },
      { role: "user", content: "Continue my image task here." },
    ];
    const guided = guideDoneBotMedia(turn, FAKE_DONEBOT_CATALOG);
    expect(guided.messages.slice(1)).toEqual(turn.messages);
    expect(guided.messages[0]?.content).toContain("supersede older assistant claims");
    expect(guided.model).toBe(turn.model);
  });

  it.each(["messages", "gemini", "responses", "chat"] as const)("sends intent tools and guidance through native %s", async protocol => {
    let body: Record<string, any> = {};
    await createDoneBotCompletion(async (_path, init) => {
      body = JSON.parse(init.body as string);
      const value = protocol === "messages" ? { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }
        : protocol === "gemini" ? { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }
          : protocol === "responses" ? { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] }
            : { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };
      return protocol === "responses"
        ? new Response(`data: ${JSON.stringify({ type: "response.completed", response: value })}\n\n`, { headers: { "content-type": "text/event-stream" } })
        : new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    }, () => protocol)(guideDoneBotMedia(input(), FAKE_DONEBOT_CATALOG));
    const tools = protocol === "gemini" ? body.tools[0].functionDeclarations : body.tools;
    const tool = protocol === "chat" ? tools[0].function : tools[0];
    expect((tool.input_schema ?? tool.parametersJsonSchema ?? tool.parameters).properties).toHaveProperty("kind");
    expect(JSON.stringify(body)).toContain("choose a locally supported public model");
    expect(JSON.stringify(body)).not.toContain("gpt-image-2.5-flare");
  });
});
