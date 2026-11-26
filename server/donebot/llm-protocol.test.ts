import { describe, expect, it, vi } from "vitest";
import type { CompletionTransportInput, OpenAIChatMessage } from "../drivers/openai-chat.ts";
import { createDoneBotCompletion, geminiRequest, messagesRequest, type DoneBotLlmProtocol } from "./llm-protocol.ts";

const input = (overrides: Partial<CompletionTransportInput> = {}): CompletionTransportInput => ({
  messages: [{ role: "system", content: "Fixture system" }, { role: "user", content: "Fixture prompt" }],
  model: "fixture-model", tools: [], stream: true, signal: new AbortController().signal,
  replay: () => undefined, onBytes: vi.fn(), onDelta: vi.fn(), onUsage: vi.fn(), ...overrides,
});
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const sse = (events: unknown[]) => {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, offset += 7));
  } }), { headers: { "content-type": "text/event-stream" } });
};

describe("DoneBot native LLM transports", () => {
  it.each(["推理", ""])("preserves signed Messages thinking for tool continuation (thinking=%j)", async thinking => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 3, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      ...(thinking ? [{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } }] : []),
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque-signature" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "native-1", name: "first", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"fixture.txt"}' } },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "native-2", name: "second", input: {} } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
      { type: "message_stop" },
    ];
    const request = vi.fn(async (_path: string, _init: RequestInit) => sse(events)), turn = input({ model: thinking ? "claude-sonnet-5-5" : "claude-fable-5-2" });
    const result = await createDoneBotCompletion(request, () => "messages")(turn);
    expect(request.mock.calls[0]![0]).toBe("/v1/messages");
    expect(result.toolCalls.map((call) => call.id)).toEqual(["native-1", "native-2"]);
    expect(result.reasoning).toBe(thinking);
    expect(result.usage).toEqual({ input: 15, output: 7 });
    expect(turn.onUsage).toHaveBeenCalledWith({ model: turn.model, input: 15, output: 7, cachedInput: 10 });
    const assistant: OpenAIChatMessage = { role: "assistant", content: null, tool_calls: result.toolCalls };
    const replayed = messagesRequest(input({ messages: [assistant, { role: "tool", tool_call_id: "native-1", content: "receipt" }], replay: () => result.nativeOutput }));
    expect(replayed.messages[0]!.content[0]).toEqual({ type: "thinking", thinking, signature: "opaque-signature" });
    expect(replayed.messages[0]!.content[1]).toMatchObject({ type: "tool_use", id: "native-1", input: { path: "fixture.txt" } });
    expect(replayed.messages[1]!.content[0]).toEqual({ type: "tool_result", tool_use_id: "native-1", content: "receipt" });
  });

  it("retains Gemini thought signatures and provider function IDs while accounting for thought tokens", async () => {
    const parts = [{ text: "private thought", thought: true }, { functionCall: { id: "provider-id", name: "read", args: { path: "a" } }, thoughtSignature: "opaque-gemini" }, { functionCall: { name: "list", args: {} } }];
    const request = vi.fn(async (_path: string, _init: RequestInit) => sse([
      { candidates: [{ index: 0, content: { parts: parts.slice(0, 1) } }] },
      { candidates: [{ index: 0, content: { parts: parts.slice(1) }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 5, thoughtsTokenCount: 4, cachedContentTokenCount: 3 } },
    ]));
    const turn = input(), result = await createDoneBotCompletion(request, () => "gemini")(turn);
    expect(request.mock.calls[0]![0]).toBe("/v1beta/models/fixture-model:streamGenerateContent?alt=sse");
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]!.id).toBe("provider-id");
    expect(result.usage).toEqual({ input: 11, output: 9 });
    const assistant: OpenAIChatMessage = { role: "assistant", content: null, tool_calls: result.toolCalls };
    const replayed = geminiRequest(input({ messages: [assistant, { role: "tool", tool_call_id: "provider-id", content: "first receipt" }, { role: "tool", tool_call_id: result.toolCalls[1]!.id, content: "second receipt" }], replay: (message) => message === assistant ? result.nativeOutput : undefined }));
    expect(replayed.contents[0]!.parts).toEqual(parts);
    expect(replayed.contents[1]!.parts).toEqual([{ functionResponse: { name: "read", id: "provider-id", response: { result: "first receipt" } } }, { functionResponse: { name: "list", response: { result: "second receipt" } } }]);
  });

  it.each([false, true])("preserves the media model in Gemini tool arguments and replay (stream=%s)", async stream => {
    const args = { model: "seedream-5-0-flash", operation: "generate", parameters: { prompt: "Synthetic tiger", size: "2K", output_format: "png" } };
    const payload = { candidates: [{ content: { parts: [{ functionCall: { name: "agents_generate_image", args } }] }, finishReason: "STOP" }] };
    const result = await createDoneBotCompletion(async () => stream ? sse([payload]) : json(payload), () => "gemini")(
      input({ model: "gemini-3.8-flash", stream }),
    );
    expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual(args);
    const assistant: OpenAIChatMessage = { role: "assistant", content: null, tool_calls: result.toolCalls };
    const replayed = geminiRequest(input({ model: "gemini-3.8-flash", messages: [assistant], replay: () => result.nativeOutput }));
    expect(replayed.contents[0]!.parts[0]).toEqual({ functionCall: { name: "agents_generate_image", args } });
    expect(args.model).toBe("seedream-5-0-flash");
  });

  it("advertises the complete tool contract under Gemini's gateway-compatible parameters field", () => {
    const parameters = { type: "object", additionalProperties: false, properties: {
      model: { type: "string", enum: ["muse-video"] },
      parameters: { type: "object", additionalProperties: false, properties: {
        mode: { type: "string", enum: ["text", "reference"] }, prompt: { type: "string" },
        duration: { type: "integer", minimum: 4, maximum: 10 },
        resolution: { type: "string", enum: ["720p"] },
      }, required: ["mode", "prompt", "duration", "resolution"] },
    }, required: ["model", "parameters"] };
    const tools = [{ type: "function" as const, function: { name: "agents_generate_video", description: "Generate video", parameters } }];
    const body = geminiRequest(input({ tools }));
    expect(body.tools).toEqual([{ functionDeclarations: [{ name: "agents_generate_video", description: "Generate video", parameters }] }]);
    expect(tools[0]!.function.parameters).toEqual(parameters);
  });

  it("uses Responses for helpers and requests encrypted reasoning for stateless tool continuation", async () => {
    const output = [{ type: "reasoning", id: "reasoning-1", encrypted_content: "opaque-reasoning", summary: [] }, { type: "message", id: "msg-1", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Fixture result" }] }];
    const request = vi.fn(async (_path: string, _init: RequestInit) => sse([{ type: "response.completed", response: { output, usage: { input_tokens: 5, output_tokens: 8 } } }]));
    const turn = input({ stream: false }), result = await createDoneBotCompletion(request, () => "responses")(turn);
    const body = JSON.parse(request.mock.calls[0]![1].body as string);
    expect(request.mock.calls[0]![0]).toBe("/v1/responses");
    expect(body).toMatchObject({ stream: true, store: false, include: ["reasoning.encrypted_content"] });
    expect(body.instructions).toBe("Fixture system");
    expect(body.reasoning).toBeUndefined();
    expect(result.text).toBe("Fixture result");
    expect(result.nativeOutput).toEqual({ protocol: "responses", content: output });
    expect(turn.onUsage).toHaveBeenCalledWith({ model: "fixture-model", input: 5, output: 8 });
  });

  it.each(["gpt-6.2-astra", "gpt-6.2-sol"])("puts %s stable instructions before the original tool transcript", async model => {
    const nativeOutput = [
      { type: "reasoning", encrypted_content: "opaque-reasoning", summary: [] },
      { type: "function_call", call_id: "call-1", name: "read", arguments: "{}" },
    ];
    const request = vi.fn(async (_path: string, _init: RequestInit) => sse([{ type: "response.completed", response: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixture result" }] }] } }]));
    const turn = input({ model });
    const assistant: OpenAIChatMessage = { role: "assistant", content: null };
    await createDoneBotCompletion(request, () => "responses")({ ...turn, messages: [...turn.messages, assistant, { role: "tool", tool_call_id: "call-1", content: "receipt" }], replay: message => message === assistant ? { protocol: "responses", content: nativeOutput } : undefined });
    const [path, init] = request.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(path).toBe("/v1/responses");
    expect(body).not.toHaveProperty("instructions");
    expect(body).not.toHaveProperty("reasoning");
    expect(body).toMatchObject({ model, store: false, stream: true, include: ["reasoning.encrypted_content"], input: [
      { role: "developer", content: "Fixture system" }, { role: "user", content: "Fixture prompt" }, ...nativeOutput,
      { type: "function_call_output", call_id: "call-1", output: "receipt" },
    ] });
  });

  it("preserves Chat reasoning and tool call fragments", async () => {
    const request = vi.fn(async () => sse([
      { choices: [{ index: 0, delta: { reasoning_content: "think", tool_calls: [{ index: 0, id: "chat-id", type: "function", function: { name: "read", arguments: '{"path":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"fixture"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } },
    ]));
    const result = await createDoneBotCompletion(request, () => "chat")(input());
    expect(result.toolCalls[0]).toMatchObject({ id: "chat-id", function: { name: "read", arguments: '{"path":"fixture"}' } });
    expect(result.protocolReasoning).toBe("think");
  });

  it.each([false, true])("separates leading thinking tags from Chat answers (stream=%s)", async stream => {
    const content = " \n<thinking>内部推理🙂</thinking>\n<think>继续核对</think>实际回答。";
    const turn = input({ model: "deepseek-flash", stream });
    const response = stream ? sse([
      ...Array.from(content).map(content => ({ choices: [{ index: 0, delta: { content } }] })),
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 12 } },
    ]) : json({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 12 } });
    const result = await createDoneBotCompletion(async () => response, () => "chat")(turn);
    expect(result.text).toBe("实际回答。");
    expect(result.reasoning).toBe("内部推理🙂继续核对");
    expect(result.protocolReasoning).toBe("");
    expect(result.usage).toEqual({ input: 5, output: 12 });
    const deltas = vi.mocked(turn.onDelta!).mock.calls;
    expect(deltas.filter(([, kind]) => kind === "assistant_text").map(([text]) => text).join("")).toBe(stream ? result.text : "");
    expect(deltas.filter(([, kind]) => kind === "reasoning_text").map(([text]) => text).join("")).toBe(stream ? result.reasoning : "");
  });

  it.each([
    "Explain `<thinking>example</thinking>`.",
    "```xml\n<think>example</think>\n```",
    "\"<thinking>example</thinking>\" is a literal.",
    "Answer first. <thinking>literal example</thinking>",
    "<thinker>ordinary XML</thinker>",
    "<",
  ])("keeps literal tags in an ordinary Chat answer: %s", async content => {
    const turn = input();
    const result = await createDoneBotCompletion(async () => sse([
      ...Array.from(content).map(content => ({ choices: [{ delta: { content } }] })),
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]), () => "chat")(turn);
    expect(result.text).toBe(content);
    expect(result.reasoning).toBe("");
    expect(vi.mocked(turn.onDelta!).mock.calls.map(([text]) => text).join("")).toBe(content);
  });

  it("replays tagged content and native reasoning independently during a Chat tool round", async () => {
    const content = "<thinking>Inline fixture thought</thinking>Checking the fixture.";
    const turn = input();
    const result = await createDoneBotCompletion(async () => json({ choices: [{ message: {
      content, reasoning_content: "Native fixture thought",
      tool_calls: [{ id: "read-1", type: "function", function: { name: "read", arguments: "{}" } }],
    }, finish_reason: "tool_calls" }] }), () => "chat")(turn);
    expect(result.text).toBe("Checking the fixture.");
    expect(result.reasoning).toBe("Native fixture thoughtInline fixture thought");
    expect(result.protocolReasoning).toBe("Native fixture thought");
    const assistant: OpenAIChatMessage = { role: "assistant", content: result.text, reasoning_content: result.protocolReasoning, tool_calls: result.toolCalls };
    const request = vi.fn(async (_path: string, _init: RequestInit) => json({ choices: [{ message: { content: "Done." }, finish_reason: "stop" }] }));
    await createDoneBotCompletion(request, () => "chat")(input({ messages: [...turn.messages, assistant, { role: "tool", tool_call_id: "read-1", content: "receipt" }], replay: message => message === assistant ? result.nativeOutput : undefined }));
    expect(JSON.parse(request.mock.calls[0]![1].body as string).messages).toEqual([
      ...turn.messages, { ...assistant, content }, { role: "tool", tool_call_id: "read-1", content: "receipt" },
    ]);
    expect(assistant.content).toBe(result.text);
  });

  it.each(["<think>Unfinished fixture thought", "<thinking>Only a thought</thinking>"])("refuses a Chat response with only tagged reasoning: %s", async content => {
    const turn = input();
    await expect(createDoneBotCompletion(async () => sse([
      { choices: [{ delta: { content }, finish_reason: "stop" }] },
    ]), () => "chat")(turn)).rejects.toThrow("reasoning without an assistant answer");
    expect(vi.mocked(turn.onDelta!).mock.calls.filter(([, kind]) => kind === "assistant_text")).toEqual([]);
  });

  it.each([
    ["chat", () => json({ choices: [{ message: { reasoning_content: "Only a thought" }, finish_reason: "stop" }] })],
    ["messages", () => json({ content: [{ type: "thinking", thinking: "Only a thought", signature: "opaque" }], stop_reason: "end_turn" })],
    ["gemini", () => json({ candidates: [{ content: { parts: [{ text: "Only a thought", thought: true }] }, finishReason: "STOP" }] })],
    ["responses", () => sse([{ type: "response.completed", response: { output: [{ type: "reasoning", id: "r", summary: [{ type: "summary_text", text: "Only a thought" }] }] } }])],
  ] as const)("refuses native %s reasoning without a final answer or tool call", async (protocol, response) => {
    await expect(createDoneBotCompletion(async () => response(), () => protocol)(input())).rejects.toThrow("reasoning without an assistant answer");
  });

  it("accepts omitted function types and legacy Chat function_call replies", async () => {
    const omitted = await createDoneBotCompletion(async () => sse([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "omitted-type", function: { name: "read", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
    ]), () => "chat")(input());
    const legacy = await createDoneBotCompletion(async () => sse([
      { choices: [{ index: 0, delta: { function_call: { name: "read", arguments: "{}" } }, finish_reason: "function_call" }] },
    ]), () => "chat")(input());
    expect(omitted.toolCalls).toMatchObject([{ id: "omitted-type", function: { name: "read", arguments: "{}" } }]);
    expect(legacy.toolCalls).toMatchObject([{ function: { name: "read", arguments: "{}" } }]);
  });

  it("normalizes a nonstandard Chat type across fragmented function-call deltas", async () => {
    const result = await createDoneBotCompletion(async () => sse([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "chat-id", type: "vendor-extension" }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "read", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
    ]), () => "chat")(input());
    expect(result.toolCalls).toMatchObject([{ id: "chat-id", type: "function", function: { name: "read", arguments: "{}" } }]);
  });

  it("rejects an unknown non-function Chat payload without exposing response content", async () => {
    const request = vi.fn(async () => json({
      choices: [{ message: { tool_calls: [{ id: "chat-id", type: "vendor-extension", custom: { secret: "fixture-secret" } }] }, finish_reason: "tool_calls" }],
    }));
    const result = createDoneBotCompletion(request, () => "chat")(input());
    await expect(result).rejects.toThrow('DoneBot gateway returned unsupported tool-call type "vendor-extension"');
    await expect(result).rejects.not.toThrow("fixture-secret");
  });

  it.each(["messages", "gemini", "responses", "chat"] as const)("does not change protocol or disclose response errors after %s rejection", async (protocol) => {
    const request = vi.fn(async () => new Response("secret-fixture-key", { status: 401 }));
    await expect(createDoneBotCompletion(request, () => protocol)(input())).rejects.toThrow("HTTP 401");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["messages", () => sse([{ type: "content_block_start", index: 0, content_block: { type: "text", text: "partial" } }])],
    ["gemini", () => json({ candidates: [{ content: { parts: [{ text: "partial" }] } }] })],
    ["chat", () => json({ choices: [{ message: { content: "partial" } }] })],
    ["responses", () => sse([{ type: "response.output_text.delta", item_id: "a", delta: "partial" }])],
  ] as const)("refuses incomplete %s output", async (protocol, response) => {
    await expect(createDoneBotCompletion(async () => response(), () => protocol)(input())).rejects.toThrow(/completion/);
  });

  it.each(["messages", "gemini", "responses", "chat"] as DoneBotLlmProtocol[])("Stop cancels a stalled %s stream", async (protocol) => {
    const cancelled = vi.fn(), controller = new AbortController();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), { headers: { "content-type": "text/event-stream" } });
    const result = createDoneBotCompletion(async () => response, () => protocol)(input({ signal: controller.signal }));
    await vi.waitFor(() => expect(response.body!.locked).toBe(true));
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toHaveBeenCalled();
  });

  it("normalizes unprefixed built-in tool calls to their uniquely advertised prefixed name across protocols without widening scope", async () => {
    const tools = [
      { type: "function" as const, function: { name: "agents_coordinate_bots", description: "Coordinate bots", parameters: { type: "object" } } },
      { type: "function" as const, function: { name: "browser_restart_browser", description: "Restart browser", parameters: { type: "object" } } },
      { type: "function" as const, function: { name: "agents_dup", description: "Dup A", parameters: { type: "object" } } },
      { type: "function" as const, function: { name: "data_dup", description: "Dup B", parameters: { type: "object" } } },
    ];

    // Messages (Claude): bare coordinate_bots -> agents_coordinate_bots; unadvertised vm_exec stays untouched; replay uses normalized name
    const msgRes = await createDoneBotCompletion(async () => json({
      content: [
        { type: "thinking", thinking: "plan", signature: "sig-1" },
        { type: "tool_use", id: "call-1", name: "coordinate_bots", input: { bot_ids: ["b1"], message: "hi" } },
        { type: "tool_use", id: "call-2", name: "vm_exec", input: { command: "id" } },
        { type: "tool_use", id: "call-3", name: "dup", input: {} },
      ],
      stop_reason: "tool_use",
    }), () => "messages")(input({ tools, stream: false }));
    expect(msgRes.toolCalls.map((c) => c.function.name)).toEqual(["agents_coordinate_bots", "vm_exec", "dup"]);
    const msgAssistant: OpenAIChatMessage = { role: "assistant", content: null, tool_calls: msgRes.toolCalls };
    const msgReplay = messagesRequest(input({ tools, messages: [msgAssistant], replay: () => msgRes.nativeOutput }));
    expect(msgReplay.messages[0]!.content[0]).toEqual({ type: "thinking", thinking: "plan", signature: "sig-1" });
    expect(msgReplay.messages[0]!.content[1]).toMatchObject({ type: "tool_use", id: "call-1", name: "agents_coordinate_bots" });
    expect(msgReplay.messages[0]!.content[2]).toMatchObject({ type: "tool_use", id: "call-2", name: "vm_exec" });

    // Gemini: bare restart_browser -> browser_restart_browser while preserving thoughtSignature & matching functionResponse
    const gemRes = await createDoneBotCompletion(async () => json({
      candidates: [{ content: { parts: [{ functionCall: { id: "g-1", name: "restart_browser", args: {} }, thoughtSignature: "gem-sig" }] }, finishReason: "STOP" }],
    }), () => "gemini")(input({ tools, stream: false }));
    expect(gemRes.toolCalls[0]!.function.name).toBe("browser_restart_browser");
    const gemAssistant: OpenAIChatMessage = { role: "assistant", content: null, tool_calls: gemRes.toolCalls };
    const gemReplay = geminiRequest(input({
      tools,
      messages: [gemAssistant, { role: "tool", tool_call_id: "g-1", content: "ok" }],
      replay: (m) => m === gemAssistant ? gemRes.nativeOutput : undefined,
    }));
    expect(gemReplay.contents[0]!.parts[0]).toEqual({ functionCall: { id: "g-1", name: "browser_restart_browser", args: {} }, thoughtSignature: "gem-sig" });
    expect(gemReplay.contents[1]!.parts[0]).toEqual({ functionResponse: { id: "g-1", name: "browser_restart_browser", response: { result: "ok" } } });

    // Responses & Chat
    const respRes = await createDoneBotCompletion(async () => sse([{
      type: "response.completed",
      response: { output: [{ type: "function_call", call_id: "r-1", name: "coordinate_bots", arguments: '{"bot_ids":["b1"],"message":"hi"}' }] },
    }]), () => "responses")(input({ tools, stream: false }));
    expect(respRes.toolCalls[0]!.function.name).toBe("agents_coordinate_bots");
    expect((respRes.nativeOutput as { content: Array<{ name?: string }> }).content[0]!.name).toBe("agents_coordinate_bots");

    const chatRes = await createDoneBotCompletion(async () => json({
      choices: [{ message: { tool_calls: [{ id: "c-1", type: "function", function: { name: "coordinate_bots", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
    }), () => "chat")(input({ tools, stream: false }));
    expect(chatRes.toolCalls[0]!.function.name).toBe("agents_coordinate_bots");
  });
});
