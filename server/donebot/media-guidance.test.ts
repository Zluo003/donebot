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

describe("DoneBot fixed local media contracts", () => {
  it("exposes direct generation without discovery or a model argument, preserving other tools and chat history", () => {
    const turn = input();
    turn.tools.push({ type: "function", function: { name: "agents_media_center", description: "Legacy", parameters: {} } },
      { type: "function", function: { name: "workspace_read", description: "Read", parameters: {} } });
    const original = structuredClone({ messages: turn.messages, tools: turn.tools });
    const guided = guideDoneBotMedia(turn, FAKE_DONEBOT_CATALOG);
    expect(guided.tools.map(tool => tool.function.name)).toEqual([
      "agents_generate_image", "agents_generate_video", "agents_generate_audio", "agents_media_job_status", "agents_media_stop_waiting", "workspace_read",
    ]);
    expect(guided.model).toBe(turn.model);
    expect(guided.messages.slice(1)).toEqual(turn.messages);
    expect({ messages: turn.messages, tools: turn.tools }).toEqual(original);
    for (const kind of ["image", "video", "audio"]) {
      const tool = guided.tools.find(tool => tool.function.name === `agents_generate_${kind}`)!;
      expect(tool.function.parameters).toMatchObject({ required: ["parameters"] });
      expect(tool.function.parameters.properties).not.toHaveProperty("model");
    }
    expect(guided.messages[0]?.content).toContain("submit directly");
    expect(guided.messages[0]?.content).toContain("existing voice tools");
    const image = guided.tools[0]!.function;
    expect(image.description).toContain("seedream-5-5");
    expect(image.parameters).toMatchObject({ properties: { parameters: { additionalProperties: false,
      properties: { layer_decomposition_options: { properties: { max_images: { maximum: 100 } } } } } } });
  });

  it.each([FAKE_DONEBOT_CATALOG, null])("preserves external media tools, CLI execution and saved instructions with catalog %j", catalog => {
    const turn = input();
    const external = ["dreamina_generate_image", "studio_generate_video", "studio_generate_music", "workspace_run", "agents_propose_profile"]
      .map(name => ({ type: "function" as const, function: { name, description: "External fixture tool", parameters: { type: "object" } } }));
    turn.tools.push(...external);
    turn.messages.unshift({ role: "system", content: "For this bot, default image generation to Dreamina CLI; keep video on DoneBot." });
    const guided = guideDoneBotMedia(turn, catalog);
    for (const tool of external) expect(guided.tools).toContainEqual(tool);
    expect(guided.messages.slice(1)).toEqual(turn.messages);
    expect(guided.messages[0]?.content).toContain("the user's explicit choice for this request, the saved preference for this bot and media kind, then the built-in DoneBot gateway");
    expect(guided.messages[0]?.content).toContain("use propose_profile");
    expect(guided.messages[0]?.content).toContain("Do not silently switch providers");
  });

  it("uses local media rules even when gateway media metadata is absent or contradictory", () => {
    const catalog = structuredClone(FAKE_DONEBOT_CATALOG);
    for (const model of catalog.models) model.media_parameters = { protocol: { adapter: "unsupported" }, resolutions: ["4K"] };
    const guided = guideDoneBotMedia(input(), catalog);
    expect(guided.tools.some(tool => tool.function.name === "agents_generate_image")).toBe(true);
    expect(JSON.stringify(guided.tools)).not.toContain('"enum":["4K"]');
    expect(JSON.stringify(guided.tools)).not.toContain("gpt-image-2.5-flare");
    expect(JSON.stringify(guided.tools)).not.toContain("seedance-2-0");
    const music = guided.tools.find(tool => tool.function.name === "agents_generate_audio")!;
    expect(music.function.parameters).toMatchObject({ properties: { parameters: { required: ["instrumental"], properties: {
      version: { enum: ["v6"] }, custom: { enum: [true] }, prompt: { maxLength: 5000 }, title: { maxLength: 80 }, style: { maxLength: 1000 }, vocal_gender: { enum: ["Male", "Female"] },
    } } } });
    const musicSchema = (music.function.parameters.properties as any).parameters.properties;
    for (const field of ["persona_id", "custom_model_id", "audio_url", "nsfw_check"]) expect(musicSchema).not.toHaveProperty(field);
    const video = guided.tools.find(tool => tool.function.name === "agents_generate_video")!;
    for (const constraint of ["200 MiB", "407696..8295044", "24..60 FPS", "combined video <=30s", "combined audio <=30s", "portrait authorization"]) expect(video.function.description).toContain(constraint);
  });

  it("omits a disabled model's tool and keeps job controls available after sign-out", () => {
    const catalog = structuredClone(FAKE_DONEBOT_CATALOG);
    catalog.models = catalog.models.filter(model => model.id !== "seedream-5-5");
    expect(guideDoneBotMedia(input(), catalog).tools.map(tool => tool.function.name)).not.toContain("agents_generate_image");
    expect(guideDoneBotMedia(input(), null).tools.map(tool => tool.function.name)).toEqual(["agents_media_job_status", "agents_media_stop_waiting"]);
  });

  it.each(["messages", "gemini", "responses", "chat"] as const)("sends native parameter schemas over %s without an image model argument", async protocol => {
    let body: Record<string, any> = {};
    await createDoneBotCompletion(async (_path, init) => {
      body = JSON.parse(init.body as string);
      const value = protocol === "messages" ? { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }
        : protocol === "gemini" ? { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }
          : protocol === "responses" ? { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] }
            : { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };
      return protocol === "responses" ? new Response(`data: ${JSON.stringify({ type: "response.completed", response: value })}\n\n`, { headers: { "content-type": "text/event-stream" } }) : Response.json(value);
    }, () => protocol)(guideDoneBotMedia(input(), FAKE_DONEBOT_CATALOG));
    const tools = protocol === "gemini" ? body.tools[0].functionDeclarations : body.tools;
    const generation = tools.map((tool: any) => protocol === "chat" ? tool.function : tool).find((tool: any) => tool.name === "agents_generate_image");
    const schema = generation.input_schema ?? generation.parametersJsonSchema ?? generation.parameters;
    expect(schema.properties).not.toHaveProperty("model");
    expect(schema.properties.parameters.properties).toHaveProperty("prompt");
    expect(JSON.stringify(body)).not.toContain("agents_media_model_capabilities");
  });
});
