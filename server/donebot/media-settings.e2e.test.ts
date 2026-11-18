import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { launchVerificationServer, runControlOmb } from "../../scripts/control-omb.ts";
import { FAKE_DONEBOT_CATALOG, startFakeDoneBotGateway } from "../testing/fake-donebot-gateway.ts";
import { hostTimeout } from "../testing/host-timeout.ts";

it.each(["muse-video", "seedance-2-5-flash"])("delivers a video with one unified Gemini request, primary %s", async primary => {
  const catalog = structuredClone(FAKE_DONEBOT_CATALOG);
  catalog.models.push({ id: "muse-video", display_name: "Muse", media_types: ["video"], interfaces: ["openai.videos"], platforms: [] });
  catalog.models.push({ id: "seedance-2-5-flash", display_name: "Seedance 2.5 Flash", media_types: ["video"], interfaces: ["openai.videos"], platforms: [] });
  catalog.models.push({ id: "gemini-4-hydrogen", display_name: "Gemini 4 Hydrogen", media_types: ["text"], interfaces: ["gemini.generate_content"], platforms: ["gemini"], capabilities: { tool_calling: true } });
  const gateway = await startFakeDoneBotGateway(catalog);
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin);
  const request = (method: string, path: string, body?: unknown) => fetch(fixture.info.url + path, { method,
    headers: { origin: fixture.info.url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await request(method, path, body), value = await response.json();
    expect(response.status, JSON.stringify(value)).toBeLessThan(300);
    return value;
  };
  const control = (...args: string[]): Promise<any> => runControlOmb([...args, "--url", fixture.info.url]);
  try {
    expect((await request("GET", "/api/donebot/media-settings")).status).toBe(401);
    await api("POST", "/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-fixture-password" });
    const initial = await api("GET", "/api/donebot/media-settings");
    expect(initial.models).toContainEqual({ id: "muse-video", name: "Muse", kind: "video" });
    const preferences = { image: { primary: "gpt-image-2.6-flare", fallback: "seedream-5-5" }, video: { primary, fallback: primary === "muse-video" ? "seedance-2-5-flash" : "seedance-2-5" } };
    expect((await request("PUT", "/api/donebot/media-settings", { accountId: "previous-account", preferences })).status).toBe(409);
    expect((await request("PUT", "/api/donebot/media-settings", { accountId: "fixture-user", preferences: { ...preferences, video: { primary: "not-enabled", fallback: "" } } })).status).toBe(400);
    const saved = await api("PUT", "/api/donebot/media-settings", { accountId: "fixture-user", preferences });
    expect(saved.preferences).toEqual(preferences);
    expect((await api("GET", "/api/donebot/media-settings")).preferences).toEqual(preferences);
    const { bot } = await control("new-bot", "--name", "Muse fallback fixture");
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "full", toolScope: { allow: ["mcp:agents:generate_video"] } });
    await control("set-model", "--bot", bot.id, "--instance", "donebot", "--model", "gemini-4-hydrogen");
    const { task } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Muse fallback", select: false });
    gateway.setMediaStatus("processing");
    gateway.setPlan([{ name: "generate_video", arguments: { model: primary, parameters: { mode: "text", prompt: "Synthetic waves", duration: 6, resolution: "720p", aspect_ratio: "16:9" } } }]);
    await control("send", "--bot", bot.id, "--task", task.threadId, "--text", "生成一段海浪视频，首选失败后使用备用模型。");
    await vi.waitFor(async () => expect((await api("GET", "/api/bots?messages=0")).bots.find((value: any) => value.id === bot.id)?.busy).toBe(false), { timeout: 15_000 });
    const posts = () => gateway.requests.filter(entry => entry.method === "POST" && entry.path === "/v1/videos");
    await vi.waitFor(async () => expect(posts(), JSON.stringify((await api("GET", `/api/threads/${task.threadId}/messages?limit=100`)).messages)).toHaveLength(1), { timeout: 15_000 });
    expect(posts()[0]!.body).toMatchObject({ model: primary, protocol: "donebot.media.v1", mode: "text", prompt: "Synthetic waves", duration: 6, resolution: "720p" });
    gateway.setMediaStatus("failed");
    await vi.waitFor(() => expect(posts()).toHaveLength(2), { timeout: 20_000 });
    expect(posts()[1]!.body).toMatchObject({ model: preferences.video.fallback, protocol: "donebot.media.v1", mode: "text", prompt: "Synthetic waves", duration: 6, aspect_ratio: "16:9" });
    expect(posts()[1]!.body).not.toHaveProperty("omni_reference_task_type");
    expect(posts()[1]!.idempotencyKey).not.toBe(posts()[0]!.idempotencyKey);
    gateway.setMediaStatus("completed");
    let messages: any[] = [];
    await vi.waitFor(async () => {
      messages = (await api("GET", `/api/threads/${task.threadId}/messages?limit=100`)).messages;
      expect(messages.some(message => message.attachments?.some((file: any) => file.mime === "video/mp4"))).toBe(true);
    }, { timeout: 20_000 });
    expect(messages.some(message => typeof message.text === "string" && message.text.includes(primary) && message.text.includes("备用"))).toBe(true);
    expect(posts().map(entry => entry.body.model)).toEqual([primary, preferences.video.fallback]);
    const evidenceDir = join(process.cwd(), ".omb-scratch", "verify-evidence", "donebot-media-settings");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, "result.json"), JSON.stringify({ fixture: fixture.info, preferences,
      generationPosts: posts().map(entry => ({ model: entry.body.model, key: entry.idempotencyKey })), videoAttachmentDelivered: true,
      scriptedLlm: true, paidProvidersContacted: false }, null, 2) + "\n");
  } finally { await fixture.close(); await gateway.close(); }
}, hostTimeout(100_000));

it.each(["image", "video-allow", "video-deny", "video-revoked"] as const)("reports the primary failure and obeys the fallback confirmation policy for %s", async scenario => {
  const catalog = structuredClone(FAKE_DONEBOT_CATALOG);
  catalog.models.push({ id: "muse-video", display_name: "Muse", media_types: ["video"], interfaces: ["openai.videos"], platforms: [] });
  const gateway = await startFakeDoneBotGateway(catalog);
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin);
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(fixture.info.url + path, { method, headers: { origin: fixture.info.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json(); expect(response.status, JSON.stringify(result)).toBeLessThan(300); return result;
  };
  const control = (...args: string[]): Promise<any> => runControlOmb([...args, "--url", fixture.info.url]);
  try {
    await api("POST", "/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-fixture-password" });
    const preferences = { image: { primary: "gpt-image-2.6-flare", fallback: "seedream-5-5" }, video: { primary: "muse-video", fallback: "seedance-2-5" } };
    await api("PUT", "/api/donebot/media-settings", { accountId: "fixture-user", preferences });
    const kind = scenario === "image" ? "image" : "video", primary = preferences[kind].primary, backup = preferences[kind].fallback;
    const { bot } = await control("new-bot", "--name", "Fallback confirmation fixture");
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "full", toolScope: { allow: [`mcp:agents:generate_${kind}`] } });
    await control("set-model", "--bot", bot.id, "--instance", "donebot", "--model", "deepseek-flash");
    gateway.setMediaStatus("processing");
    gateway.setPlan([{ name: `generate_${kind}`, arguments: { model: primary,
      parameters: kind === "image" ? { mode: "text", prompt: "Synthetic scene" } : { mode: "text", prompt: "Synthetic scene", duration: 6, resolution: "720p", aspect_ratio: "16:9" } } }]);
    await control("send", "--bot", bot.id, "--text", "Generate the synthetic scene.");
    await vi.waitFor(async () => expect((await api("GET", "/api/bots?messages=0")).bots.find((value: any) => value.id === bot.id)?.busy).toBe(false), { timeout: 15_000 });
    const posts = () => gateway.requests.filter(entry => entry.method === "POST" && ["/v1/videos", "/v1/images/generations/async", "/v1/images/generations"].includes(entry.path));
    await vi.waitFor(() => expect(posts()).toHaveLength(1), { timeout: 10_000 });
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.activeTaskId}`, { approvalMode: "ask" });
    gateway.setMediaStatus("failed");
    const messages = () => api("GET", `/api/threads/${bot.activeTaskId}/messages?limit=100`).then(value => value.messages as any[]);
    await vi.waitFor(async () => expect((await messages()).some(message => message.kind === "text" && !message.tool && message.text?.includes(primary) && message.text.includes(backup))).toBe(true), { timeout: 15_000 });
    if (scenario === "image") {
      await vi.waitFor(() => expect(posts()).toHaveLength(2), { timeout: 15_000 });
      expect((await messages()).some(message => message.card?.tool === "donebot_media")).toBe(false);
    } else {
      let card: any;
      await vi.waitFor(async () => { card = (await messages()).find(message => message.card?.tool === "donebot_media"); expect(card).toBeTruthy(); }, { timeout: 10_000 });
      await new Promise(resolve => setTimeout(resolve, 3500));
      expect(posts()).toHaveLength(1);
      if (scenario === "video-revoked") await api("PATCH", `/api/bots/${bot.id}`, { toolScope: { allow: ["mcp:agents:generate_image"] } });
      const result = await api("POST", `/api/threads/${bot.activeTaskId}/respond`, { requestId: card.card.requestId, behavior: scenario === "video-deny" ? "deny" : "allow" });
      expect(result.outcome).toBe(scenario === "video-allow" ? "allowed-once" : "rejected");
      if (scenario === "video-allow") await vi.waitFor(() => expect(posts()).toHaveLength(2), { timeout: 15_000 });
      else {
        await vi.waitFor(async () => expect((await messages()).some(message => message.text?.includes("Backup generation was declined"))).toBe(true), { timeout: 10_000 });
        expect(posts()).toHaveLength(1);
      }
    }
    expect(posts().map(entry => entry.body.model)).toEqual(scenario === "video-deny" || scenario === "video-revoked" ? [primary] : [primary, backup]);
  } finally { await fixture.close(); await gateway.close(); }
}, hostTimeout(100_000));
