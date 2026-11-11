import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { startFakeDoneBotGateway } from "./testing/fake-donebot-gateway.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { MediaJobStore } from "./donebot/media-store.ts";

it("signs in to a loopback gateway, preserves native protocols and platform tools, delivers async media and streamed speech, and blocks model bypasses", async () => {
  const gateway = await startFakeDoneBotGateway();
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin);
  const evidence: Record<string, unknown> = { fixture: fixture.info, gateway: gateway.origin };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { origin: fixture.info.url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const successful = async (method: string, path: string, body?: unknown) => { const value = await api(method, path, body); expect(value.status, JSON.stringify(value.body)).toBeLessThan(300); return value.body; };
  try {
    expect((await successful("GET", "/api/donebot/state")).authenticated).toBe(false);
    await successful("POST", "/api/donebot/verification", { email: "fixture@example.invalid" });
    await successful("POST", "/api/donebot/forgot-password", { email: "fixture@example.invalid" });
    expect((await api("POST", "/api/donebot/reset-password", { email: "fixture@example.invalid", email_code: "000000", new_password: "synthetic-new-password" })).status).toBe(400);
    await successful("POST", "/api/donebot/reset-password", { email: "fixture@example.invalid", email_code: "123456", new_password: "synthetic-new-password" });
    gateway.setAuthRequires2fa(true);
    const challenge = await successful("POST", "/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-fixture-password" });
    expect(challenge).toMatchObject({ requires2fa: true, authenticated: false });
    expect(JSON.stringify(challenge)).not.toMatch(/fixture-temp-token|fixture-access-token/);
    expect((await api("POST", "/api/donebot/2fa", { totp_code: "000000" })).status).toBe(401);
    const login = await successful("POST", "/api/donebot/2fa", { totp_code: "123456" });
    gateway.setAuthRequires2fa(false);
    expect(login.authenticated).toBe(true);
    expect(JSON.stringify(login)).not.toContain("fixture-installation-key");
    const catalog = await successful("GET", "/api/donebot/catalog");
    expect(catalog.models.map((model: { id: string }) => model.id)).toContain("gpt-6.1-sol");
    const { bot } = await control("new-bot", "--name", "DoneBot native fixture");
    evidence.bot = bot.id;
    evidence.thread = bot.activeTaskId;
    const cwd = fixture.info.dataDir;
    for (const [model, path] of [["gpt-6.1-sol", "/v1/responses"], ["claude-sonnet-5-5", "/v1/messages"], ["gemini-4-argon", "/v1beta/models/gemini-4-argon:streamGenerateContent"], ["deepseek-flash", "/v1/chat/completions"]]) {
      const file = `${model}-receipt.txt`;
      gateway.setPlan([{ name: "workspace_write", arguments: { path: file, text: `Verified fixture ${model}` } }]);
      await successful("PATCH", `/api/bots/${bot.id}`, { cwd, approvalMode: "full", toolScope: { allow: ["native:workspace_write"] } });
      await control("set-model", "--bot", bot.id, "--instance", "donebot", "--model", model!);
      await control("send", "--bot", bot.id, "--text", `Write the synthetic ${model} receipt once.`);
      const settled = await control("wait", "--bot", bot.id, "--timeout", "30");
      expect(settled.status, JSON.stringify(settled)).toBe("settled");
      expect(await readFile(join(cwd, file), "utf8")).toBe(`Verified fixture ${model}`);
      expect(gateway.requests.some((request) => request.path === path && request.authenticated)).toBe(true);
    }
    evidence.nativeProtocols = ["responses", "messages", "gemini", "chat"];
    gateway.setPlan([{ name: "list_bots", arguments: {} }], "The existing platform agents tool answered.");
    await successful("PATCH", `/api/bots/${bot.id}`, { toolScope: { allow: ["mcp:agents:list_bots"] } });
    await control("send", "--bot", bot.id, "--text", "Read the existing platform's bot list.");
    expect((await control("wait", "--bot", bot.id, "--timeout", "30")).status).toBe("settled");
    const messages = (await successful("GET", `/api/threads/${bot.activeTaskId}/messages?limit=100`)).messages;
    expect(messages.some((message: any) => message.tool?.name?.includes("list_bots") && message.tool?.ok === true)).toBe(true);
    evidence.agentsTool = "list_bots";
    gateway.setPlan([
      { name: "generate_image", arguments: { parameters: { prompt: "Synthetic offline fixture image", size: "1024x1024" } } },
    ]);
    await successful("PATCH", `/api/bots/${bot.id}`, { toolScope: { allow: ["mcp:agents:generate_image"] } });
    await control("send", "--bot", bot.id, "--text", "Generate the synthetic offline fixture image.");
    expect((await control("wait", "--bot", bot.id, "--timeout", "30")).status).toBe("settled");
    await expect.poll(async () => {
      const lines = (await successful("GET", `/api/threads/${bot.activeTaskId}/messages?limit=100`)).messages;
      return lines.some((message: any) => message.attachments?.some((attachment: any) => attachment.mime === "image/png"));
    }, { timeout: 20_000 }).toBe(true);
    const imagePosts = gateway.requests.filter(request => request.method === "POST" && request.path === "/v1/images/generations");
    expect(imagePosts).toHaveLength(1);
    expect(imagePosts[0]!.body).toMatchObject({ model: "seedream-5-5", prompt: "Synthetic offline fixture image", size: "1024x1024" });
    evidence.asyncMedia = "one task; image attachment published";
    const generatedLines = (await successful("GET", `/api/threads/${bot.activeTaskId}/messages?limit=100`)).messages;
    const generatedMessage = generatedLines.find((message: any) => message.attachments?.some((attachment: any) => attachment.mime === "image/png"));
    const generatedPath = generatedMessage?.attachments.find((attachment: any) => attachment.mime === "image/png")?.path;
    expect(generatedPath).toBeTypeOf("string");
    const artifactUrl = fixture.info.url + "/api/attachments/" + generatedPath.split(/[\\/]/).at(-1);
    const artifactBytes = await readFile(generatedPath);
    const artifact = await fetch(artifactUrl);
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get("content-type")).toBe("image/png");
    expect(artifact.headers.get("content-length")).toBe(String(artifactBytes.length));
    expect(artifact.headers.get("accept-ranges")).toBe("bytes");
    expect(artifact.headers.get("cache-control")).toBe("private, no-store");
    expect(artifact.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await artifact.arrayBuffer())).toEqual(artifactBytes);
    for (const [range, start, end] of [["bytes=1-7", 1, 7], ["bytes=8-", 8, artifactBytes.length - 1], ["bytes=-4", artifactBytes.length - 4, artifactBytes.length - 1]] as const) {
      const partial = await fetch(artifactUrl, { headers: { range } });
      expect(partial.status).toBe(206);
      expect(partial.headers.get("content-range")).toBe(`bytes ${start}-${end}/${artifactBytes.length}`);
      expect(partial.headers.get("content-length")).toBe(String(end - start + 1));
      expect(partial.headers.get("accept-ranges")).toBe("bytes");
      expect(partial.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await partial.arrayBuffer())).toEqual(artifactBytes.subarray(start, end + 1));
    }
    for (const range of [`bytes=${artifactBytes.length}-`, "bytes=-0"]) {
      const unsatisfiable = await fetch(artifactUrl, { headers: { range } });
      expect(unsatisfiable.status).toBe(416);
      expect(unsatisfiable.headers.get("content-range")).toBe(`bytes */${artifactBytes.length}`);
      expect(unsatisfiable.headers.get("content-length")).toBe("0");
      expect(unsatisfiable.headers.get("accept-ranges")).toBe("bytes");
      expect((await unsatisfiable.arrayBuffer()).byteLength).toBe(0);
    }
    for (const range of ["bytes=7-1", "bytes=bad", "bytes=0-1,3-4"]) {
      const malformed = await fetch(artifactUrl, { headers: { range } });
      expect(malformed.status).toBe(200);
      expect(malformed.headers.get("content-range")).toBeNull();
      expect(Buffer.from(await malformed.arrayBuffer())).toEqual(artifactBytes);
    }
    const { bot: otherBot } = await control("new-bot", "--name", "DoneBot private artifact fixture");
    expect((await api("POST", `/api/threads/${otherBot.activeTaskId}/messages/${generatedMessage.id}/file`, { path: generatedPath })).status).toBe(404);
    const mediaStore = new MediaJobStore(join(fixture.info.dataDir, "donebot", "media.sqlite"));
    try {
      const originalId = /donebot-([a-f0-9-]{36})-/.exec(generatedPath.split(/[\\/]/).at(-1))![1]!;
      const original = mediaStore.get(originalId)!;
      const id = randomUUID(), name = `donebot-${id}-1.png`;
      const directory = join(fixture.info.dataDir, "donebot", "artifacts", id);
      await mkdir(directory, { recursive: true });
      const path = join(directory, name);
      await copyFile(generatedPath, path);
      mediaStore.put({ ...original, id, operationKey: id, scope: { ...original.scope, accountId: "another-fixture-account" },
        artifacts: [{ ...original.artifacts[0]!, name, path }], deliveredAt: Date.now() });
      const foreign = await fetch(fixture.info.url + "/api/attachments/" + name, { headers: { range: "bytes=0-7" } });
      expect(foreign.status).toBe(404);
      expect(foreign.headers.get("content-range")).toBeNull();
      expect(await foreign.json()).toMatchObject({ error: "No such generated artifact." });
    } finally { mediaStore.close(); }
    evidence.generatedArtifactAccess = "200 full content; 206 bounded/open/suffix ranges; 416 unsatisfiable; malformed full fallback; cross-conversation and other-account refusals";
    for (const variation of ["first", "second"]) {
      gateway.setPlan([{ name: "generate_image", arguments: { operation: "generate", parameters: {
        prompt: `Synthetic ${variation} reference edit`, size: "1024x1024", image_urls: [{ local_path: generatedPath }],
      } } }]);
      await control("send", "--bot", bot.id, "--text", `Edit the generated fixture image: ${variation}.`);
      expect((await control("wait", "--bot", bot.id, "--timeout", "30")).status).toBe("settled");
      await expect.poll(() => gateway.requests.filter(request => request.method === "POST" && request.path === "/v1/images/generations" && Boolean(request.body.image_urls)).length, { timeout: 20_000 }).toBe(variation === "first" ? 1 : 2);
    }
    const uploads = gateway.requests.filter(request => request.path === "/v1/assets" && request.method === "POST");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.body).toMatchObject({ mime: "image/png", bytes: expect.any(Number) });
    expect(gateway.requests.some(request => /^\/v1\/assets\/ast_[A-Za-z0-9]+$/.test(request.path) && request.method === "GET")).toBe(true);
    const mediaEdits = gateway.requests.filter(request => request.method === "POST" && request.path === "/v1/images/generations" && Boolean(request.body.image_urls));
    expect(mediaEdits).toHaveLength(2);
    expect(mediaEdits.every(request => (request.body.image_urls as any[])?.[0] === "https://assets.example.test/fixture-reference.png")).toBe(true);
    evidence.generatedReference = "same-conversation artifact; one upload; refreshed cached asset URL";
    const videoReference = join(cwd, "synthetic-reference.mp4");
    await writeFile(videoReference, new Uint8Array(33 * 1024 * 1024));
    for (const media of [
      { tool: "generate_video", kind: "video", model: "seedance-2-5", mime: "video/mp4", path: "/v1/videos", parameters: {
        content: [{ type: "text", text: "Synthetic video" }, { type: "video_url", video_url: { url: { local_path: videoReference } }, role: "reference_video" }], resolution: "720p", duration: 5 } },
      { tool: "generate_audio", kind: "music", model: "suno", mime: "audio/mpeg", path: "/v1/music/generations", parameters: { style: "Synthetic instrumental piano", instrumental: true } },
      { tool: "generate_audio", kind: "music", model: "suno", mime: "audio/mpeg", path: "/v1/music/generations", parameters: {
        instrumental: false, prompt: "[Verse]\n保留这些歌词，不改写\n[Chorus]\n走向明天", style: "Mandarin acoustic pop", vocal_gender: "Female", duration: 60 } },
    ]) {
      const beforePosts = gateway.requests.filter(request => request.path === media.path && request.method === "POST").length;
      const beforeMessages = new Set((await successful("GET", `/api/threads/${bot.activeTaskId}/messages?limit=100`)).messages.map((message: any) => message.id));
      gateway.setPlan([{ name: media.tool, arguments: { parameters: media.parameters } }]);
      await successful("PATCH", `/api/bots/${bot.id}`, { toolScope: { allow: [`mcp:agents:${media.tool}`] } });
      await control("send", "--bot", bot.id, "--text", `Generate synthetic ${media.kind}.`);
      expect((await control("wait", "--bot", bot.id, "--timeout", "30")).status).toBe("settled");
      await expect.poll(async () => (await successful("GET", `/api/threads/${bot.activeTaskId}/messages?limit=100`)).messages.some((message: any) => !beforeMessages.has(message.id) && message.attachments?.some((file: any) => file.mime === media.mime)), { timeout: 20_000 }).toBe(true);
      const posts = gateway.requests.filter(request => request.path === media.path && request.method === "POST");
      expect(posts).toHaveLength(beforePosts + 1);
      if (media.kind === "video") expect(posts.at(-1)!.body).toMatchObject({ model: "seedance-2-5", omni_reference_task_type: "reference" });
      if (media.kind === "music") expect(posts.at(-1)!.body).toEqual({ model: "suno", version: "v6", custom: true, auto_lyrics: false, audio_format: "mp3", ...media.parameters });
    }
    expect(gateway.requests.some(request => request.path === "/v1/assets" && request.body.mime === "video/mp4" && request.body.bytes === 33 * 1024 * 1024)).toBe(true);
    evidence.videoAndMusic = "33 MiB video reference uploaded; one video, one instrumental and one lyric-song POST; native lyrics preserved and artifacts delivered in original conversation";
    evidence.mediaRequests = gateway.requests.filter(request => request.method === "POST" && ["/v1/videos", "/v1/music/generations", "/v1/assets"].includes(request.path)).map(({ path, body }) => ({ path, body }));
    const voice = await fetch(fixture.info.url + "/api/tts/speak", { method: "POST", headers: { origin: fixture.info.url, "content-type": "application/json" }, body: JSON.stringify({ text: "Synthetic voice fixture.", voiceId: "alloy" }) });
    expect(voice.status).toBe(200);
    expect(voice.headers.get("content-type")).toBe("audio/wav");
    expect((await voice.arrayBuffer()).byteLength).toBe(1004);
    expect(gateway.requests.some((request) => request.path.startsWith("/api/v1/donebot/receipts/") && request.installation)).toBe(true);
    evidence.streamedSpeech = "PCM wrapped as WAV; scoped completed receipt";
    expect((await api("PATCH", "/api/config", { tts: { provider: "elevenlabs", key: "not-a-real-key" } })).status).toBe(403);
    expect((await api("PATCH", "/api/config", { openai: { key: "synthetic-blocked-model-key" } })).status).toBe(403);
    expect((await api("POST", "/api/keys/test", { provider: "openai", key: "synthetic-blocked-model-key" })).status).toBe(403);
    expect((await api("POST", "/api/keys/test", { provider: "treg", key: "" })).status).toBe(400);
    expect((await api("GET", "/api/images/openrouter-models")).status).toBe(403);
    expect((await api("POST", "/api/images/test", { provider: "openrouter", key: "synthetic-blocked-model-key" })).status).toBe(403);
    expect((await api("POST", "/api/internal/images/generate", { prompt: "This route must not bypass DoneBot media tools." })).status).toBe(401);
    evidence.modelKeysBlocked = "model key probe, native image routes and BYOK config refused; connector key validation retained";
    expect((await api("POST", "/api/instances/openai-compat", {})).status).toBeGreaterThanOrEqual(400);
    expect((await api("POST", "/api/tts/transcribe", {})).status).toBe(409);
    expect((await api("POST", "/api/live/start", {})).status).toBe(409);
    await successful("POST", "/api/donebot/logout", {});
    expect((await successful("GET", "/api/donebot/state")).authenticated).toBe(false);
    const loggedOutArtifact = await fetch(artifactUrl, { headers: { range: "bytes=0-7" } });
    expect(loggedOutArtifact.status).toBe(404);
    expect(await loggedOutArtifact.json()).toMatchObject({ error: "No such generated artifact." });
    const before = gateway.requests.filter((request) => request.path.startsWith("/v1/") || request.path.startsWith("/v1beta/")).length;
    await control("send", "--bot", bot.id, "--text", "This logged-out fixture must not reach a model.").catch(() => {});
    await control("wait", "--bot", bot.id, "--timeout", "5").catch(() => {});
    expect(gateway.requests.filter((request) => request.path.startsWith("/v1/") || request.path.startsWith("/v1beta/")).length).toBe(before);
    evidence.loggedOutBlocked = true;
    const evidenceDir = join(process.cwd(), ".omb-scratch", "verify-evidence", "donebot-model-limits");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, "result.json"), JSON.stringify(evidence, null, 2) + "\n");
    console.info(JSON.stringify({ donebotVerification: evidence }));
  } catch (error) {
    console.info(JSON.stringify({ donebotVerificationFailure: evidence, gatewayRequests: gateway.requests.map(({ path, method }) => ({ path, method })),
      ...(typeof evidence.thread === "string" ? { messages: (await api("GET", `/api/threads/${evidence.thread}/messages?limit=20`)).body } : {}) }));
    throw error;
  } finally { await fixture.close(); await gateway.close(); }
}, hostTimeout(180_000));

it("preserves independent thread models across simultaneous turns and account reconnection", async () => {
  const gateway = await startFakeDoneBotGateway();
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin);
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { origin: fixture.info.url, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json() as Record<string, any>;
    expect(response.status, JSON.stringify(result)).toBeLessThan(300);
    return result;
  };
  try {
    const signIn = () => api("POST", "/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-fixture-password" });
    await signIn();
    const { bot } = await control("new-bot", "--name", "DoneBot independent threads");
    await control("set-model", "--bot", bot.id, "--instance", "donebot", "--model", "deepseek-flash");
    const threads = await Promise.all(["first", "second"].map(title => api("POST", `/api/bots/${bot.id}/tasks`, { title, select: false })));
    const selections = ["gpt-6.1-sol", "gemini-4-argon"];
    for (const [index, { task }] of threads.entries()) await control("set-model", "--thread", task.threadId, "--instance", "donebot", "--model", selections[index]!);
    gateway.setPlan([], "Synthetic thread isolation verified.");
    await Promise.all(threads.map(({ task }, index) => control("send", "--thread", task.threadId, "--text", `Unique independent thread ${index}`)));
    for (const { task } of threads) expect((await control("wait", "--thread", task.threadId, "--timeout", "30")).status).toBe("settled");
    for (const [index, model] of selections.entries()) {
      const request = gateway.requests.find(request => request.body.model === model || request.path.includes(model));
      expect(request?.authenticated).toBe(true);
      expect(JSON.stringify(request?.body)).toContain(`Unique independent thread ${index}`);
      const { messages } = await api("GET", `/api/threads/${threads[index]!.task.threadId}/messages?limit=100`);
      const ownMessages = messages.filter((message: any) => message.role === "user").map((message: any) => message.text);
      expect(ownMessages).toContain(`Unique independent thread ${index}`);
      expect(ownMessages).not.toContain(`Unique independent thread ${1 - index}`);
    }
    await control("set-model", "--bot", bot.id, "--instance", "donebot", "--model", "claude-sonnet-5-5");
    await api("POST", "/api/donebot/logout", {});
    await signIn();
    const { bots } = await api("GET", "/api/bots?messages=0");
    const tasks = bots.find((saved: any) => saved.id === bot.id)?.tasks ?? [];
    for (const [index, { task }] of threads.entries()) expect(tasks.find((saved: any) => saved.threadId === task.threadId)?.modelSelection).toEqual({ instanceId: "donebot", model: selections[index] });
    const publicState = JSON.stringify(await api("GET", "/api/config"));
    expect(publicState).not.toMatch(/fixture-(?:access-token|refresh-token|installation-key|temp-token)|synthetic-fixture-password/);
    expect(await readFile(fixture.info.logPath, "utf8")).not.toMatch(/fixture-(?:access-token|refresh-token|installation-key|temp-token)|synthetic-fixture-password/);
  } finally { await fixture.close(); await gateway.close(); }
}, hostTimeout(90_000));
