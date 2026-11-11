import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { MediaJobStore } from "./donebot/media-store.ts";
import { FAKE_DONEBOT_CATALOG, startFakeDoneBotGateway } from "./testing/fake-donebot-gateway.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("submits Seedream 5.5 directly without capability discovery and delivers one asynchronous image", async () => {
  const catalog = structuredClone(FAKE_DONEBOT_CATALOG);
  catalog.models.push(
    { id: "gemini-3.8-flash", display_name: "Gemini chat", media_types: ["text"], platforms: ["gemini"], interfaces: ["gemini.generate_content"], capabilities: { tool_calling: true } },

  );
  const gateway = await startFakeDoneBotGateway(catalog);
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin);
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(fixture.info.url + path, { method, headers: { origin: fixture.info.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const value = await response.json();
    expect(response.status, JSON.stringify(value)).toBeLessThan(300);
    return value;
  };
  const control = (...args: string[]): Promise<any> => runControlOmb([...args, "--url", fixture.info.url]);
  try {
    await api("POST", "/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-fixture-password" });
    const { bot } = await control("new-bot", "--name", "Media model isolation fixture");
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "full", toolScope: { allow: ["mcp:agents:generate_image"] } });
    await control("set-model", "--bot", bot.id, "--instance", "donebot", "--model", "gemini-3.8-flash");
    const parameters = { prompt: "Synthetic 3D cartoon tiger", size: "2K", output_format: "png" };
    gateway.setMediaStatus("processing");
    gateway.setPlan([
      { name: "generate_image", arguments: { parameters } },
      { name: "generate_image", arguments: { parameters } },
    ], "The fixture image job is saved; waiting for its existing task.");
    await control("send", "--bot", bot.id, "--text", "使用 seedream 5.5 画一只 3D 卡通老虎。");
    expect((await control("wait", "--bot", bot.id, "--timeout", "30")).status).toBe("settled");
    const posts = () => gateway.requests.filter(request => request.method === "POST" && request.path === "/v1/images/generations");
    await expect.poll(() => posts().length, { timeout: 15_000 }).toBe(1);
    expect(posts()[0]!.body).toEqual({ model: "seedream-5-5", ...parameters });
    expect(gateway.requests.some(request => request.path === "/v1/images/generations/async")).toBe(false);
    await expect.poll(() => gateway.requests.some(request => request.path === "/v1/tasks/fixture-seedream-task-1"), { timeout: 15_000 }).toBe(true);
    const messages = await api("GET", `/api/threads/${bot.activeTaskId}/messages?limit=100`);
    expect(messages.messages.some((message: any) => message.attachments?.length)).toBe(false);
    const native = gateway.requests.filter(request => request.path.startsWith("/v1beta/models/gemini-3.8-flash:"));
    const declarations = (native[0]!.body.tools as any[])[0].functionDeclarations;
    const generation = declarations.find((tool: any) => tool.name === "agents_generate_image");
    expect(generation.parametersJsonSchema.properties).not.toHaveProperty("model");
    expect(generation.parametersJsonSchema.properties.parameters.properties).toHaveProperty("prompt");
    expect(declarations.some((tool: any) => tool.name === "agents_media_model_capabilities")).toBe(false);
    expect(native.length).toBeLessThanOrEqual(3);
    const media = new MediaJobStore(join(fixture.info.dataDir, "donebot", "media.sqlite"));
    try {
      expect(media.pending()).toHaveLength(1);
      expect(media.pending()[0]).toMatchObject({ model: "seedream-5-5", taskId: "fixture-seedream-task-1", threadId: bot.activeTaskId });
    } finally { media.close(); }
    gateway.setMediaStatus("completed");
    await expect.poll(async () => {
      const completed = await api("GET", `/api/threads/${bot.activeTaskId}/messages?limit=100`);
      return completed.messages.some((message: any) => message.attachments?.some((file: any) => file.mime === "image/png"));
    }, { timeout: 20_000 }).toBe(true);
    expect(posts()).toHaveLength(1);
    const evidence = { fixture: fixture.info, chatModel: "gemini-3.8-flash", imageModel: "seedream-5-5",
      generationRequests: posts().map(request => ({ path: request.path, body: request.body })),
      llmRequestsBeforeCompletion: native.length, capabilityQueries: 0,
      task: "fixture-seedream-task-1", result: "pending job, native polling, same-conversation PNG attachment" };
    const evidenceDir = join(process.cwd(), ".omb-scratch", "verify-evidence", "donebot-media-selection");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, "result.json"), JSON.stringify(evidence, null, 2) + "\n");
  } finally { await fixture.close(); await gateway.close(); }
}, hostTimeout(90_000));
