import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { launchVerificationServer, runControlOmb } from "../../scripts/control-omb.ts";
import { FAKE_DONEBOT_CATALOG, startFakeDoneBotGateway } from "../testing/fake-donebot-gateway.ts";
import { hostTimeout } from "../testing/host-timeout.ts";

it("delivers every Seedance generation mode and preserves WebP bytes through isolated HTTP uploads", async () => {
  const models = ["seedance-2-0", "seedance-2-0-fast", "seedance-2-0-mini", "seedance-2-5", "seedance-2-5-flash"];
  const catalog = structuredClone(FAKE_DONEBOT_CATALOG);
  for (const id of models) if (!catalog.models.some(model => model.id === id)) catalog.models.push({ id, display_name: id, media_types: ["video"], interfaces: ["openai.videos"], platforms: [] });
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
  const evidence: Record<string, unknown>[] = [];
  try {
    await api("POST", "/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-fixture-password" });
    const { bot } = await control("new-bot", "--name", "Seedance mode fixture");
    const cwd = join(fixture.info.dataDir, "seedance-mode-references");
    await mkdir(cwd);
    const bytes = Buffer.from("UklGRioAAABXRUJQVlA4TB4AAAAvP8FPAAdQ6ZqXtv8BBWkbMPUvfzei/8n9v//3XwE=", "base64");
    const paths = [join(cwd, "front.webp"), join(cwd, "back.webp")];
    for (const path of paths) await writeFile(path, bytes);
    await api("PATCH", `/api/bots/${bot.id}`, { cwd, approvalMode: "full", toolScope: { allow: ["mcp:agents:generate_video"] } });
    await control("set-model", "--bot", bot.id, "--instance", "donebot", "--model", "deepseek-flash");
    gateway.setMediaStatus("completed");
    const scenarios = [
      { name: "text", text: "用文字描述生成海浪视频", mode: "text", roles: [] },
      { name: "one_reference", text: "参考这张衣服图片生成咖啡厅视频", mode: "reference", roles: ["reference"] },
      { name: "two_references", text: "参考衣服正面和背面两张图生成视频，不使用首尾帧", mode: "reference", roles: ["reference", "reference"] },
      { name: "i2v", text: "使用这张图做图生视频", mode: "first_frame", roles: ["first_frame"] },
      { name: "first_frame", text: "将这张图片用作首帧生成视频", mode: "first_frame", roles: ["first_frame"] },
      { name: "first_last_frame", text: "这两张图片分别是首帧和尾帧，使用首尾帧生成", mode: "first_last_frame", roles: ["first_frame", "last_frame"] },
    ];
    for (const model of models) {
      const preferences = { image: { primary: "seedream-5-5", fallback: "" }, video: { primary: model, fallback: "" } };
      await api("PUT", "/api/donebot/media-settings", { accountId: "fixture-user", preferences });
      for (const scenario of scenarios) {
        const { task } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: `${model} ${scenario.name}`, select: false });
        const references = scenario.roles.map((role, index) => ({ type: "image", role, url: { local_path: paths[index]! } }));
        const parameters = { mode: scenario.mode, prompt: scenario.text, duration: 5, resolution: "720p", output_format: "mp4",
          aspect_ratio: scenario.mode.startsWith("first") ? "adaptive" : "16:9", ...(references.length ? { references } : {}) };
        const offset = gateway.requests.length;
        gateway.setPlan([{ name: "generate_video", arguments: { model, parameters } }]);
        await control("send", "--bot", bot.id, "--task", task.threadId, "--text", scenario.text);
        await vi.waitFor(async () => {
          const { messages } = await api("GET", `/api/threads/${task.threadId}/messages?limit=100`);
          expect(messages.some((message: any) => message.attachments?.some((file: any) => file.mime === "video/mp4"))).toBe(true);
        }, { timeout: 20_000 });
        expect((await control("wait", "--bot", bot.id, "--task", task.threadId, "--timeout", "30")).status).toBe("settled");
        const requests = gateway.requests.slice(offset);
        const posts = requests.filter(request => request.method === "POST" && request.path === "/v1/videos");
        expect(posts, `${model} ${scenario.name}`).toHaveLength(1);
        expect(posts[0]!.body).toMatchObject({ ...parameters, model, protocol: "donebot.media.v1", ...(references.length ? { references: scenario.roles.map(role => ({ type: "image", role, url: expect.stringMatching(/^https:/) })) } : {}) });
        expect(posts[0]!.body).not.toHaveProperty("omni_reference_task_type");
        const llm = requests.find(request => request.path === "/v1/chat/completions")!;
        const tool = (llm.body.tools as any[]).find(entry => entry.function?.name === "agents_generate_video").function;
        expect(tool.description).toContain("image count never selects a frame mode");
        expect(tool.parameters.properties.parameters.properties.mode.description).toContain("图生视频/image-to-video/i2v");
        expect(requests.some(request => request.path.endsWith("/content"))).toBe(true);
        evidence.push({ model, scenario: scenario.name, mode: posts[0]!.body.mode, referenceRoles: scenario.roles, generationRequests: posts.length, delivered: true });
      }
    }
    const uploads = gateway.requests.filter(request => request.method === "POST" && request.path === "/v1/assets");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.body).toEqual({ name: "front.webp", mime: "image/webp", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    const folder = join(process.cwd(), ".omb-scratch", "verify-evidence", "seedance-modes");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "result.json"), JSON.stringify({ fixture: fixture.info, scenarios: evidence, uploads: uploads.map(request => request.body), scriptedLlm: true, paidProvidersContacted: false }, null, 2) + "\n");
  } finally { await fixture.close(); await gateway.close(); }
}, hostTimeout(240_000));
