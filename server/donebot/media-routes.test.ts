import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { READ_ONLY_ANNOTATIONS } from "../agent-tool-policy.ts";
import { availableTools, catalogProfileFromEnv, fullInputSchema } from "../drivers/agents-catalog.ts";
import { callTool, type ToolCallContext } from "../drivers/agents-call.ts";
import type { HelperToolContext } from "../routes/helper-tools.ts";
import { PASS } from "../routes/table.ts";
import { createDoneBotMediaRoutes } from "./media-routes.ts";
import type { MediaJob } from "./media-store.ts";
import type { DoneBotMediaService, MediaContext } from "./media.ts";

describe("DoneBot media capability routes", () => {
  const trusted: MediaContext = { botId: "trusted-bot", threadId: "trusted-thread", turnId: "trusted-turn", active: () => true };
  const service = { submit: vi.fn(), status: vi.fn(), stopWaiting: vi.fn(), capabilities: vi.fn(async () => []) };
  const context = (body: unknown): HelperToolContext & { threadId: string } => ({
    method: "POST", path: "/api/internal/donebot/media/generate", res: {} as ServerResponse,
    json: vi.fn(), botId: trusted.botId, threadId: trusted.threadId, readBody: async () => body, folders: async () => ({ roots: [], vmWorkspace: null }),
  } as HelperToolContext & { threadId: string });

  it("rejects bot and conversation spoofing in strict generation parameters", async () => {
    const route = createDoneBotMediaRoutes(service as unknown as DoneBotMediaService, () => trusted);
    for (const extra of [{ botId: "another-bot" }, { threadId: "another-thread" }, { turnId: "another-turn" }]) {
      const ctx = context({ kind: "image", model: "fixture", parameters: { prompt: "fixture" }, ...extra });
      await route(ctx); expect(ctx.json).toHaveBeenCalledWith(ctx.res, 400, expect.anything());
    }
    expect(service.submit).not.toHaveBeenCalled();
  });

  it("refuses a stale or mismatched capability before reading or invoking the service", async () => {
    for (const capability of [{ ...trusted, botId: "other" }, { ...trusted, threadId: "other" }, { ...trusted, active: () => false }]) {
      const ctx = context({}); ctx.readBody = vi.fn(async () => ({}));
      await createDoneBotMediaRoutes(service as unknown as DoneBotMediaService, () => capability)(ctx);
      expect(ctx.json).toHaveBeenCalledWith(ctx.res, 403, expect.anything()); expect(ctx.readBody).not.toHaveBeenCalled();
    }
  });

  it("rechecks turn lifetime after the request body is read", async () => {
    let active = true;
    const ctx = context({}); ctx.readBody = async () => { active = false; return {}; };
    await createDoneBotMediaRoutes(service as unknown as DoneBotMediaService, () => ({ ...trusted, active: () => active }))(ctx);
    expect(ctx.json).toHaveBeenCalledWith(ctx.res, 403, expect.anything());
  });

  it("passes the client-selected model and native request parameters to the local job service", async () => {
    const job: MediaJob = { ...pending, model: "gpt-image-2.6-flare", parameters: { prompt: "Photo", size: "1024x1024" } };
    const localService = { ...service, submit: vi.fn(async () => job) };
    const body = { kind: "image", model: job.model, operation: "generate", parameters: job.parameters };
    const ctx = context(body);
    await createDoneBotMediaRoutes(localService as unknown as DoneBotMediaService, () => trusted)(ctx);
    expect(localService.submit).toHaveBeenCalledExactlyOnceWith(trusted, { kind: "image", model: job.model, operation: "generate", parameters: job.parameters, variationKey: undefined });
    expect(ctx.json).toHaveBeenCalledWith(ctx.res, 202, expect.objectContaining({ job: expect.objectContaining({ status: "queued", kind: "image" }) }));
  });

  it("does not accept the removed gateway-owned intent route", async () => {
    const ctx = context({ intent: "image" }); ctx.path = "/api/internal/donebot/media/intent";
    expect(await createDoneBotMediaRoutes(service as unknown as DoneBotMediaService, () => trusted)(ctx)).toBe(PASS);
  });

  it("passes other methods and unrelated paths to the original platform", async () => {
    const route = createDoneBotMediaRoutes(service as unknown as DoneBotMediaService, () => trusted), ctx = context({});
    ctx.method = "GET"; expect(await route(ctx)).toBe(PASS);
    ctx.method = "POST"; ctx.path = "/api/internal/helpers/decide"; expect(await route(ctx)).toBe(PASS);
  });

  it("adds media tools only for the DoneBot product and marks only local reads read-only", () => {
    const upstream = availableTools(catalogProfileFromEnv({}));
    const donebot = availableTools(catalogProfileFromEnv({ DONEBOT_MEDIA: "1" }));
    const added = donebot.filter(tool => !upstream.some(original => tool.name === original.name));
    expect(added.map(tool => tool.name).sort()).toEqual(["media_model_capabilities", "generate_image", "generate_video", "generate_audio", "media_job_status", "media_stop_waiting"].sort());
    expect(donebot.map(tool => tool.name)).not.toContain("media_center");
    expect(donebot.map(tool => tool.name)).not.toContain("model_capabilities");
    expect(donebot.map(tool => tool.name)).not.toContain("generate_music");
    for (const tool of added) expect((tool as { annotations?: typeof READ_ONLY_ANNOTATIONS }).annotations).toEqual(["media_job_status", "media_model_capabilities"].includes(tool.name) ? READ_ONLY_ANNOTATIONS : undefined);
  });

  it("selects exactly one image tool and its matching schema when both capability flags are present", () => {
    const upstream = availableTools(catalogProfileFromEnv({ DONEBOT_IMAGE_GENERATION: "1" }));
    const product = availableTools(catalogProfileFromEnv({ DONEBOT_IMAGE_GENERATION: "1", DONEBOT_MEDIA: "1" }));
    for (const tools of [upstream, product]) expect(tools.filter(tool => tool.name === "generate_image")).toHaveLength(1);
    expect(upstream.find(tool => tool.name === "generate_image")?.inputSchema).toMatchObject({ required: ["prompt"] });
    expect(product.find(tool => tool.name === "generate_image")?.inputSchema).toMatchObject({ required: ["parameters"], properties: { parameters: { type: "object" } } });
    expect(product.find(tool => tool.name === "generate_image")?.inputSchema.properties).not.toHaveProperty("model");
    expect(fullInputSchema("generate_image", true)).toMatchObject({ required: ["parameters"] });
    expect(fullInputSchema("generate_image")).toMatchObject({ required: ["prompt"] });
    expect(fullInputSchema("generate_audio", true)).toMatchObject({ required: ["parameters"] });
  });

  it("dispatches native image requests only in the DoneBot product context", async () => {
    const apiResponse = vi.fn(async (_path: string, _init?: RequestInit) => ({ ok: true, status: 202, body: { text: "fixture" } }));
    const ctx: ToolCallContext = { botId: trusted.botId, threadId: trusted.threadId, depth: 0, externalRuntime: false,
      sharedComputers: false, client: { api: async () => ({}), apiResponse } };
    await callTool("generate_image", { parameters: { prompt: "fixture", size: "1024x1024" } }, { ...ctx, donebotMedia: true });
    expect(apiResponse.mock.calls[0]?.[0]).toBe("/api/internal/donebot/media/generate");
    expect(JSON.parse(String(apiResponse.mock.calls[0]![1]!.body))).toEqual({ kind: "image", model: "seedream-5-5", parameters: { prompt: "fixture", size: "1024x1024" } });
    await callTool("generate_image", { prompt: "fixture", aspect: "1:1" }, ctx);
    expect(apiResponse.mock.calls[1]?.[0]).toBe("/api/internal/images/generate");
  });

  it("maps standalone audio requests to the music adapter kind", async () => {
    const apiResponse = vi.fn(async (_path: string, _init?: RequestInit) => ({ ok: true, status: 202, body: {} }));
    const input = { parameters: { version: "v6", custom: true, instrumental: true, auto_lyrics: false, style: "Gentle piano" } };
    await callTool("generate_audio", input, { botId: trusted.botId, threadId: trusted.threadId, depth: 0, externalRuntime: false,
      sharedComputers: false, donebotMedia: true, client: { api: async () => ({}), apiResponse } });
    expect(apiResponse).toHaveBeenCalledTimes(1);
    expect(apiResponse.mock.calls[0]?.[0]).toBe("/api/internal/donebot/media/generate");
    expect(JSON.parse(String(apiResponse.mock.calls[0]![1]!.body))).toEqual({ kind: "music", model: "suno", ...input });
    expect(fullInputSchema("generate_audio", true)).toMatchObject({ required: ["parameters"] });
  });

  const pending: MediaJob = {
    version: 1, id: "00000000-0000-4000-8000-000000000001", operationKey: "fixture-operation", fingerprint: "fixture-fingerprint",
    scope: { accountId: "fixture-account", installationId: "fixture-installation" },
    botId: trusted.botId, threadId: trusted.threadId, turnId: trusted.turnId,
    kind: "image", model: "fixture", adapter: "fixture", operation: "generate", status: "queued",
    artifacts: [], waitingStopped: false, createdAt: 1, updatedAt: 1, nextPollAt: 1, attempts: 0,
  };

  async function reply(job: MediaJob, action: "generate" | "status" | "stop-waiting" = "generate") {
    const localService = { submit: vi.fn(async () => job), status: vi.fn(async () => job), stopWaiting: vi.fn(async () => job) };
    const ctx = context(action === "generate" ? { kind: "image", model: "fixture", parameters: { prompt: "fixture" } } : { job_id: job.id });
    ctx.path = `/api/internal/donebot/media/${action}`;
    await createDoneBotMediaRoutes(localService as unknown as DoneBotMediaService, () => trusted)(ctx);
    expect(ctx.json).toHaveBeenCalledWith(ctx.res, action === "generate" ? 202 : 200, expect.anything());
    return vi.mocked(ctx.json).mock.calls[0]![2] as {
      job: { status: MediaJob["status"]; error?: string; artifacts: MediaJob["artifacts"]; waiting_stopped: boolean; notice?: string };
      reply_context: { intent: string; guidance: string };
      notice?: string;
    };
  }

  it.each(["queued", "submitting", "submitted", "running", "downloading"] as const)("acknowledges a pending generation without turning its %s snapshot into the reply", async status => {
    const result = await reply({ ...pending, status });
    expect(result.reply_context.intent).toBe("acknowledge_request");
    expect(result.job.status).toBe(status);
    expect(result.notice).toBeUndefined();
  });

  it("reports a requested progress observation rather than another acceptance", async () => {
    const result = await reply(pending, "status");
    expect(result.reply_context.intent).toBe("report_status");
    expect(result.job.status).toBe("queued");
  });

  it.each(["uncertain", "failed", "cancelled"] as const)("preserves an existing %s outcome on a repeated generation call", async status => {
    const result = await reply({ ...pending, status, error: "Fixture outcome needs attention" });
    expect(result.reply_context.intent).toBe("report_status");
    expect(result.job).toMatchObject({ status, error: "Fixture outcome needs attention" });
  });

  it("returns existing completed artifacts rather than implying a new generation", async () => {
    const artifacts = [{ id: "fixture-file", path: "/fixture/output.png", mime: "image/png", name: "output.png", bytes: 7 }];
    const result = await reply({ ...pending, status: "completed", artifacts });
    expect(result.reply_context.intent).toBe("report_status");
    expect(result.job).toMatchObject({ status: "completed", artifacts });
  });

  it("preserves retrieval problems instead of promising an unqualified pending result", async () => {
    const result = await reply({ ...pending, status: "downloading", error: "Fixture file retrieval delayed" });
    expect(result.reply_context.intent).toBe("report_status");
    expect(result.job.error).toBe("Fixture file retrieval delayed");
  });

  it.each(["queued", "running", "completed"] as const)("keeps a stopped wait visible even when the saved task is %s", async status => {
    const result = await reply({ ...pending, status, waitingStopped: true });
    expect(result.reply_context.intent).toBe("report_status");
    expect(result.job.waiting_stopped).toBe(true);
    expect(result.job.notice).toContain("Automatic follow-up is stopped");
    expect(result.job.notice).not.toContain("monitoring");
  });

  it("reports the stop result while retaining the provider's running state", async () => {
    const result = await reply({ ...pending, status: "running", waitingStopped: true }, "stop-waiting");
    expect(result.reply_context.intent).toBe("report_stop_result");
    expect(result.job).toMatchObject({ status: "running", waiting_stopped: true });
  });
});
