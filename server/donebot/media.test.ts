import { mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DoneBotMediaService, type DoneBotMediaDeps, type MediaContext, type MediaScope } from "./media.ts";
import { openMediaArtifact, publicArtifactResponse, publicMediaAddress, safeMediaArtifact, saveMediaArtifact } from "./media-download.ts";
import { MediaJobStore } from "./media-store.ts";
import type { MediaKind } from "./media-store.ts";
import { doneBotMediaModel } from "./catalog.ts";
import { FAKE_DONEBOT_CATALOG } from "../testing/fake-donebot-gateway.ts";

const roots: string[] = [], services: DoneBotMediaService[] = [];
const context: MediaContext = { botId: "fixture-bot", threadId: "fixture-thread", turnId: "fixture-turn", active: () => true };
const initialScope: MediaScope = { accountId: "fixture-account", installationId: "fixture-install" };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const animatedGif = Buffer.from("R0lGODlhAgABAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAFAAAACwAAAAAAgABAAAIBQABAAgIACH5BAEUAAEALAAAAAACAAEAgQAA/wAAAAAAAAAAAAgFAAEACAgAOw==", "base64");
const json = (value: unknown, status = 200) => Response.json(value, { status });
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

async function fixture(overrides: Partial<DoneBotMediaDeps> = {}) {
  const root = await mkdtemp(join(tmpdir(), "donebot-media-fixture-")); roots.push(root);
  let scope: MediaScope | null = initialScope;
  const publish = vi.fn(async () => {});
  const fetchGateway = vi.fn(async (_path: string, init: RequestInit) => init.method === "POST"
    ? json({ id: "fixture-task" }, 202)
    : json({ status: "completed", result: { data: [{ url: "https://artifact.invalid/fixture.png" }] } }));
  const deps: DoneBotMediaDeps = {
    dbPath: join(root, "media.sqlite"), artifactDir: join(root, "artifacts"), scope: () => scope, concurrency: async () => 20,
    fetchGateway, resolveModel: async (id, kind) => ({ id, kind, adapter: "donebot.images.async.v1" }),
    authorize: async () => {}, capabilities: async () => [], publish,
    fetchArtifact: async () => new Response(png, { headers: { "content-type": "image/png" } }),
    pollMs: 60_000, ...overrides,
  };
  const open = () => { const service = new DoneBotMediaService(deps); services.push(service); return service; };
  const service = open();
  return { root, deps, service, open, publish, fetchGateway, setScope: (next: MediaScope | null) => { scope = next; } };
}

const input = { kind: "image" as const, model: "fixture-image", parameters: { prompt: "A synthetic fixture" } };
async function submitted(service: DoneBotMediaService, id: string) {
  await vi.waitFor(async () => expect(["queued", "submitting"]).not.toContain((await service.status(context, id)).status));
}

describe("DoneBot persistent paid media operations", () => {
  it("submits the exact public model selected by the caller", async () => {
    const resolveModel = vi.fn(async (id: string, kind: MediaKind) => ({ id, kind, adapter: "donebot.images.async.v1" }));
    const f = await fixture({ resolveModel, concurrency: async () => 0 });
    const job = await f.service.submit(context, input);
    expect(resolveModel).toHaveBeenCalledExactlyOnceWith("fixture-image", "image");
    expect(job.model).toBe("fixture-image");
    expect(f.fetchGateway).not.toHaveBeenCalled();
  });

  it("does not use legacy model-based submission errors to create another generation", async () => {
    let now = Date.now(), posts = 0;
    const f = await fixture({ now: () => now, concurrency: async () => 3,
      fetchGateway: async (_path, init) => {
        if (init.method === "POST") { posts++; return json({ id: "legacy-task" }, 202); }
        return json({ status: "failed", error: { code: "model_unavailable" } });
      },
      receipt: async id => ({ receipt_id: id, installation_id: initialScope.installationId, status: "refunded", media_type: "image",
        model: "fixture-image", currency: "CNY", payment_state: "refunded", prepaid_cents: 425, refunded_cents: 425,
        actual_cents: 0, diagnostic: { code: "model_unavailable" } }),
    });
    const job = await f.service.submit(context, input);
    await submitted(f.service, job.id);
    await f.service.tick();
    expect(await f.service.status(context, job.id)).toMatchObject({ status: "failed", model: "fixture-image" });
    expect(posts).toBe(1);
  });

  it.each(["seedance-2-0", "seedance-2-5"])("sends %s default references with fixed audio and persists the authorized mode across restart", async model => {
    let now = Date.now();
    const authorize = vi.fn<DoneBotMediaDeps["authorize"]>(async () => {});
    const f = await fixture({ now: () => now, authorize, concurrency: async () => 0,
      resolveReference: async () => ({ bytes: png, mime: "image/png", name: "reference.png" }),
      resolveModel: async (id, kind) => doneBotMediaModel(FAKE_DONEBOT_CATALOG, id, kind),
      fetchGateway: vi.fn(async (path, init) => path.startsWith("/v1/assets") ? json({ id: "ref", url: "https://assets.example.test/ref.png" })
        : init.method === "POST" ? json({ id: "video-task" }, 202) : json({ status: "processing" })),
    });
    const parameters = { content: [{ type: "text", text: "Animate 图片1" }, { type: "image_url", image_url: { url: { local_path: "/fixture/reference.png" } } }], resolution: "720p" };
    const job = await f.service.submit(context, { kind: "video", model, parameters });
    expect(authorize.mock.calls[0]![1]).toMatchObject({ parameters: { generate_audio: true,
      content: [{ type: "text" }, { role: "reference_image" }], ...(model === "seedance-2-5" ? { omni_reference_task_type: "reference" } : {}) } });
    expect(parameters.content[1]).not.toHaveProperty("role");
    expect((await f.service.status(context, job.id)).status).toBe("queued");
    await f.service.close(); services.splice(services.indexOf(f.service), 1);
    f.deps.concurrency = async () => 20; now += 1001;
    const restored = f.open(); await restored.tick(); await submitted(restored, job.id);
    const posts = vi.mocked(f.deps.fetchGateway).mock.calls.filter(([path, init]) => path === "/v1/videos" && init.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]![1].body))).toMatchObject({ model, generate_audio: true,
      content: [{ type: "text" }, { role: "reference_image", image_url: { url: "https://assets.example.test/ref.png" } }],
      ...(model === "seedance-2-5" ? { omni_reference_task_type: "reference" } : {}) });
    if (model === "seedance-2-0") expect(JSON.parse(String(posts[0]![1].body))).not.toHaveProperty("omni_reference_task_type");
    await expect(restored.submit(context, { kind: "video", model, parameters: { ...parameters, generate_audio: false } })).rejects.toThrow("fixed by DoneBot");
    expect(vi.mocked(f.deps.fetchGateway).mock.calls.filter(([path]) => path === "/v1/videos")).toHaveLength(1);
  });

  it("requires authorization before uploading references or submitting a paid call", async () => {
    const resolveReference = vi.fn(async () => ({ bytes: png, mime: "image/png", name: "ref.png" }));
    const f = await fixture({ authorize: async () => { throw new Error("denied"); }, resolveReference });
    await expect(f.service.submit(context, { ...input, parameters: { image_urls: [{ local_path: "/fixture/ref.png" }] } })).rejects.toThrow("denied");
    expect(f.fetchGateway).not.toHaveBeenCalled();
    expect(resolveReference).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent same-turn calls and only creates explicit variations", async () => {
    let now = Date.now();
    const f = await fixture({ now: () => now });
    const jobs = await Promise.all([f.service.submit(context, input), f.service.submit(context, input)]);
    expect(jobs[0].id).toBe(jobs[1].id);
    await submitted(f.service, jobs[0].id);
    expect(f.fetchGateway).toHaveBeenCalledTimes(1);
    expect(new Headers(f.fetchGateway.mock.calls[0]![1].headers).get("Idempotency-Key")).toBe(jobs[0].operationKey);
    now += 1000;
    const variation = await f.service.submit(context, { ...input, variationKey: "requested-variation" });
    await submitted(f.service, variation.id);
    expect(variation.id).not.toBe(jobs[0].id);
    expect(f.fetchGateway.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(2);
  });

  it("recovers accepted jobs after reopening without another generation and publishes once", async () => {
    const f = await fixture();
    const job = await f.service.submit(context, input); await submitted(f.service, job.id);
    await f.service.close(); services.splice(services.indexOf(f.service), 1);
    const restored = f.open();
    await restored.tick(); await restored.tick();
    const result = await restored.status(context, job.id);
    expect(result.status).toBe("completed");
    expect(await readFile(result.artifacts[0]!.path)).toEqual(png);
    expect(f.fetchGateway.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
    expect(f.publish).toHaveBeenCalledTimes(1);
  });

  it.each(["url", "b64_json"])("preserves animated GIF bytes and publishes the original %s artifact", async (delivery) => {
    const fetchArtifact = vi.fn(async () => new Response(animatedGif, { headers: { "content-type": "image/gif" } }));
    const send = vi.fn(async (_path: string, init: RequestInit) => init.method === "POST"
      ? json({ id: "gif-task" }, 202)
      : json({ status: "completed", result: { data: [delivery === "url" ? { url: "https://artifact.invalid/animation.gif" } : { b64_json: animatedGif.toString("base64") }] } }));
    const f = await fixture({ fetchGateway: send, fetchArtifact });
    const job = await f.service.submit(context, { ...input, model: "gpt-image-2.6-flare", parameters: { prompt: "A synthetic loop", output_format: "gif" } });
    await submitted(f.service, job.id); await f.service.tick();
    const result = await f.service.status(context, job.id);
    const artifact = result.artifacts[0]!;
    expect(result.status).toBe("completed");
    expect(artifact).toMatchObject({ mime: "image/gif", name: `donebot-${job.id}-1.gif`, bytes: animatedGif.length });
    expect(await readFile(artifact.path)).toEqual(animatedGif);
    expect(send.mock.calls.map(([path]) => path)).toEqual(["/v1/images/generations/async", "/v1/images/tasks/gif-task"]);
    expect(fetchArtifact).toHaveBeenCalledTimes(delivery === "url" ? 1 : 0);
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "completed", artifacts: [artifact] }));
  });

  it("flattens native APIMart image URL arrays and resumes a partial download after restart", async () => {
    let now = Date.now();
    const urls = ["https://artifact.invalid/first.png", "https://artifact.invalid/second.png", "https://artifact.invalid/third.png"];
    const fetchArtifact = vi.fn(async (url: string) => {
      if (url === urls[1] && fetchArtifact.mock.calls.length === 2) throw new Error("network error with sensitive URL");
      return new Response(png, { headers: { "content-type": "image/png" } });
    });
    const f = await fixture({ now: () => now, resolveModel: async (id, kind) => ({ id, kind, adapter: "apimart.images.v1" }), fetchArtifact,
      fetchGateway: async (_path, init) => init.method === "POST" ? json({ data: [{ task_id: "native-images" }] }, 202)
        : json({ data: { status: "completed", result: { images: [{ url: urls.slice(0, 2) }, { url: urls[2] }] } } }),
    });
    const job = await f.service.submit(context, input); await submitted(f.service, job.id); await f.service.tick();
    expect(await f.service.status(context, job.id)).toMatchObject({ status: "downloading", attempts: 1, artifacts: [{ mime: "image/png" }],
      error: expect.stringContaining("The gateway completed this task, but its artifacts could not be retrieved.") });
    expect(f.publish).not.toHaveBeenCalled();
    await f.service.close(); services.splice(services.indexOf(f.service), 1);
    now += 30_001;
    const restored = f.open(); await restored.tick(); await restored.tick();
    expect((await restored.status(context, job.id)).artifacts).toHaveLength(3);
    expect((await restored.status(context, job.id)).status).toBe("completed");
    expect(fetchArtifact.mock.calls.map(([url]) => url)).toEqual([urls[0], urls[1], urls[1], urls[2]]);
    expect(f.publish).toHaveBeenCalledOnce();
  });

  it("retains all 17 decomposition files and their matching reconstruction data across interrupted retrieval", async () => {
    let now = Date.now(), posts = 0, interrupted = false;
    const urls = Array.from({ length: 17 }, (_, index) => `https://artifact.invalid/layer-${index}.png?signature=private`);
    const layers = urls.map((_, index) => ({ z_index: index, name: index === 0 ? "底图" : `图层 ${index}`,
      ...(index ? { description: "待编辑元素", bounding_box: { absolute: [32, 48, 160, 304], normalized: [31, 47, 156, 297] } } : {}),
      private_url: urls[index],
    }));
    const fetchArtifact = vi.fn(async (url: string) => {
      if (url === urls[5] && !interrupted) { interrupted = true; throw new Error("Interrupted layer retrieval"); }
      return new Response(png, { headers: { "content-type": "image/png" } });
    });
    const f = await fixture({ now: () => now, resolveModel: async (id, kind) => ({ id, kind, adapter: "apimart.images.v1" }), fetchArtifact,
      fetchGateway: async (_path, init) => {
        if (init.method === "POST") { posts++; return json({ data: [{ task_id: "decomposition" }] }, 202); }
        return json({ data: { status: "completed", result: { images: [{ url: urls, layer_decomposition: true,
          sizes: urls.map((_, index) => index === 0 ? "1024x1024" : "128x256"), output_formats: urls.map(() => "png"), layers }] } } });
      },
    });
    const job = await f.service.submit(context, { ...input, model: "seedream-5-0-flash", parameters: { layer_decomposition: true, size: "1.5K" } });
    await submitted(f.service, job.id); await f.service.tick();
    const partial = await f.service.status(context, job.id);
    expect(partial).toMatchObject({ status: "downloading", artifacts: layers.slice(0, 5).map(({ private_url: _private, ...layer }, index) => ({
      layer: { ...layer, size: index === 0 ? "1024x1024" : "128x256", output_format: "png" },
    })) });
    expect(f.publish).not.toHaveBeenCalled();
    await f.service.close(); services.splice(services.indexOf(f.service), 1);
    now += 30_001;
    const restored = f.open();
    expect((await restored.status(context, job.id)).artifacts).toEqual(partial.artifacts);
    await restored.tick(); await restored.tick();
    const result = await restored.status(context, job.id);
    expect(result.status).toBe("completed");
    expect(result.artifacts).toHaveLength(17);
    expect(result.artifacts.map(file => file.layer?.z_index)).toEqual(Array.from({ length: 17 }, (_, index) => index));
    expect(result.artifacts[16]?.layer).toMatchObject({ name: "图层 16", description: "待编辑元素", size: "128x256", output_format: "png",
      bounding_box: { absolute: [32, 48, 160, 304], normalized: [31, 47, 156, 297] } });
    expect(await Promise.all(result.artifacts.map(file => readFile(file.path)))).toEqual(urls.map(() => png));
    const prompt = JSON.stringify(result.artifacts);
    expect(prompt).toContain('"z_index":16');
    expect(prompt).toContain('"absolute":[32,48,160,304]');
    expect(prompt).not.toMatch(/artifact\.invalid|signature=private|private_url/);
    expect(posts).toBe(1);
    expect(fetchArtifact.mock.calls.map(([url]) => url)).toEqual([...urls.slice(0, 6), ...urls.slice(5)]);
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ artifacts: result.artifacts }));
  });

  it("downloads decomposition files while excluding malformed or unbounded reconstruction metadata", async () => {
    const invalidLayers = [
      { z_index: 0, bounding_box: { absolute: [100, 0, 50, 10] } },
      { z_index: 1, bounding_box: { normalized: [0, 0, 1001, 1000] } },
      { z_index: 100 },
      { z_index: 3, description: "x".repeat(2049) },
    ];
    const f = await fixture({ resolveModel: async (id, kind) => ({ id, kind, adapter: "apimart.images.v1" }),
      fetchGateway: async (_path, init) => init.method === "POST" ? json({ data: [{ task_id: "bad-metadata" }] }, 202)
        : json({ status: "completed", result: { images: [{ url: invalidLayers.map((_, index) => `https://artifact.invalid/${index}.png`),
          layer_decomposition: true, layers: invalidLayers }] } }),
    });
    const job = await f.service.submit(context, input); await submitted(f.service, job.id); await f.service.tick();
    const result = await f.service.status(context, job.id);
    expect(result.status).toBe("completed");
    expect(result.artifacts).toHaveLength(4);
    expect(result.artifacts.every(file => file.layer === undefined)).toBe(true);
    expect(f.publish).toHaveBeenCalledOnce();
  });

  it("persists a failed receipt until its conversation delivery succeeds after restart", async () => {
    let now = Date.now();
    const publish = vi.fn(async () => { if (publish.mock.calls.length === 1) throw new Error("delivery interrupted"); });
    const f = await fixture({ now: () => now, publish, fetchGateway: async (_path, init) => init.method === "POST"
      ? json({ id: "failed-task" }, 202) : json({ status: "failed" }) });
    const job = await f.service.submit(context, input); await submitted(f.service, job.id); await f.service.tick();
    expect(await f.service.status(context, job.id)).toMatchObject({ status: "failed", error: "Media task ended with failed." });
    expect((await f.service.status(context, job.id)).deliveredAt).toBeUndefined();
    await f.service.close(); services.splice(services.indexOf(f.service), 1);
    now += 30_001;
    const restored = f.open(); await restored.tick(); await restored.tick();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]).toEqual([expect.objectContaining({ id: job.id, status: "failed" })]);
    expect((await restored.status(context, job.id)).deliveredAt).toBe(now);
  });

  it("notifies an unconfirmed 503 once, retains its safe cause and settles by receipt without another paid POST", async () => {
    let now = Date.now(), settled = false, posts = 0;
    const receipt = vi.fn(async () => ({ receipt_id: "fixture-receipt", status: settled ? "failed" : "uncertain" }));
    const f = await fixture({ now: () => now, receipt, fetchGateway: async () => {
      posts++;
      return Response.json({ error: { type: "api_error", message: "No eligible APIMart accounts", unsafe: "secret-prompt-token" } },
        { status: 503, headers: { "X-DoneBot-Receipt-ID": "fixture-receipt" } });
    } });
    const job = await f.service.submit(context, input); await submitted(f.service, job.id);
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
    expect(await f.service.status(context, job.id)).toMatchObject({ status: "uncertain", uncertainNotifiedAt: now,
      error: expect.stringContaining("No eligible APIMart account") });
    expect(JSON.stringify(f.publish.mock.calls)).not.toContain("secret-prompt-token");
    await f.service.tick();
    await f.service.close(); services.splice(services.indexOf(f.service), 1);
    settled = true; now += 30_001;
    const restored = f.open(); await restored.tick(); await restored.tick();
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", error: expect.stringContaining("No eligible APIMart account") }));
    expect(posts).toBe(1);
    expect(restored.activeCount(initialScope.accountId)).toBe(0);
  });

  it("persists native uncertain diagnostics across restart and sends the original bot its safe cause without regenerating", async () => {
    let now = Date.now(), posts = 0;
    const f = await fixture({ now: () => now, fetchGateway: async (_path, init) => {
      if (init.method === "POST") { posts++; return json({ id: "unknown-native-task" }, 202); }
      return json({ status: "uncertain", http_status: 502, error: { code: "dispatch_unknown", type: "upstream_error", request_id: "req-native-123",
        message: "Connection closed after image dispatch; the provider did not confirm a result. https://provider.invalid/private?token=secret api_key=privatekey" } });
    } });
    const job = await f.service.submit(context, input); await submitted(f.service, job.id); await f.service.tick();
    const expected = { http_status: 502, code: "dispatch_unknown", type: "upstream_error", request_id: "req-native-123",
      message: expect.stringContaining("Connection closed after image dispatch") };
    expect(await f.service.status(context, job.id)).toMatchObject({ status: "uncertain", taskId: "unknown-native-task", diagnostic: expected,
      error: expect.stringContaining("HTTP 502; dispatch_unknown; Request ID: req-native-123") });
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: job.id, status: "uncertain", diagnostic: expected }));
    expect(JSON.stringify(f.publish.mock.calls)).not.toMatch(/provider\.invalid|privatekey|token=secret/);
    await f.service.close(); services.splice(services.indexOf(f.service), 1);
    now += 30_001; const restored = f.open(); await restored.tick();
    expect(await restored.status(context, job.id)).toMatchObject({ status: "uncertain", diagnostic: expected });
    expect(f.publish).toHaveBeenCalledTimes(1); expect(posts).toBe(1);
    expect(await restored.submit(context, input)).toMatchObject({ id: job.id });
  });

  it("keeps concrete failure details returned by an existing task and a recovered receipt", async () => {
    const f = await fixture({ fetchGateway: async (_path, init) => init.method === "POST" ? json({ id: "rejected-task" }, 202)
      : json({ status: "failed", http_status: 400, error: { code: "invalid_size", message: "Image size 4096x4096 is unsupported; choose 1024x1024.", request_id: "req-size-123" } }) });
    const job = await f.service.submit(context, input); await submitted(f.service, job.id); await f.service.tick();
    expect(await f.service.status(context, job.id)).toMatchObject({ status: "failed", diagnostic: { code: "invalid_size", http_status: 400, request_id: "req-size-123" },
      error: expect.stringContaining("Image size 4096x4096 is unsupported") });
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ diagnostic: expect.objectContaining({ code: "invalid_size" }) }));

    const recovery = await fixture({ fetchGateway: async () => new Response("invalid-json", { status: 202, headers: { "X-DoneBot-Receipt-ID": "receipt-rejected" } }),
      receipt: async () => ({ receipt_id: "receipt-rejected", status: "refunded", diagnostic: { http_status: 422, code: "model_unavailable", request_id: "req-receipt-123", message: "The selected model does not accept this image format." } }) });
    const recovered = await recovery.service.submit(context, input); await submitted(recovery.service, recovered.id); await recovery.service.tick();
    expect(await recovery.service.status(context, recovered.id)).toMatchObject({ status: "failed", diagnostic: { code: "model_unavailable", http_status: 422 },
      error: expect.stringContaining("The selected model does not accept this image format.") });
    expect(recovery.publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", diagnostic: expect.objectContaining({ request_id: "req-receipt-123" }) }));
  });

  it("retains safe task lookup diagnostics without interpreting a lookup error as task rejection", async () => {
    const f = await fixture({ fetchGateway: async (_path, init) => init.method === "POST" ? json({ id: "lookup-task" }, 202)
      : Response.json({ error: { code: "task_store_unavailable", message: "Task lookup storage is temporarily unavailable." } },
        { status: 503, headers: { "x-request-id": "req-poll-123" } }) });
    const job = await f.service.submit(context, input); await submitted(f.service, job.id); await f.service.tick();
    expect(await f.service.status(context, job.id)).toMatchObject({ status: "submitted", diagnostic: { code: "task_store_unavailable", http_status: 503, request_id: "req-poll-123" },
      error: expect.stringContaining("Task lookup storage is temporarily unavailable.") });
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("retries a pending submission notice after restart even without a gateway receipt or task ID", async () => {
    let now = Date.now();
    const publish = vi.fn(async () => { if (publish.mock.calls.length === 1) throw new Error("fixture delivery failure"); });
    const fetchGateway = vi.fn(async () => { throw Object.assign(new Error("sensitive URL and key"), { code: "ETIMEDOUT" }); });
    const f = await fixture({ now: () => now, publish, fetchGateway });
    const job = await f.service.submit(context, input); await submitted(f.service, job.id);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect((await f.service.status(context, job.id)).uncertainNotifiedAt).toBeUndefined();
    await f.service.close(); services.splice(services.indexOf(f.service), 1);
    now += 30_001;
    const restored = f.open(); await restored.tick(); now += 30_001; await restored.tick();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(await restored.status(context, job.id)).toMatchObject({ status: "uncertain", uncertainNotifiedAt: expect.any(Number) });
    expect(JSON.stringify(publish.mock.calls)).not.toContain("sensitive URL");
    expect(fetchGateway).toHaveBeenCalledOnce();
    expect(restored.activeCount(initialScope.accountId)).toBe(1);
  });

  it("notifies this bot once about stalled retrieval and later delivers the recovered result without generating again", async () => {
    let now = Date.now(), available = false, posts = 0;
    const f = await fixture({ now: () => now, fetchArtifact: async () => {
      if (!available) throw new Error("unavailable");
      return new Response(png, { headers: { "content-type": "image/png" } });
    }, fetchGateway: async (_path, init) => {
      if (init.method === "POST") { posts++; return json({ id: "completed-task" }, 202); }
      return json({ status: "completed", result: { data: [{ url: "https://artifact.invalid/fixture.png" }] } });
    } });
    const job = await f.service.submit(context, input); await submitted(f.service, job.id);
    for (let attempt = 0; attempt < 4; attempt++) { now += 30_001; await f.service.tick(); }
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ status: "downloading", attempts: 3 }));
    expect((await f.service.status(context, job.id)).retrievalNotifiedAt).toBeTypeOf("number");
    await f.service.close(); services.splice(services.indexOf(f.service), 1);
    const restored = f.open(); now += 30_001; await restored.tick();
    expect(f.publish).toHaveBeenCalledOnce();
    available = true; now += 30_001; await restored.tick(); await restored.tick();
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: "completed", artifacts: [expect.objectContaining({ mime: "image/png" })] }));
    expect(posts).toBe(1);
  });

  it("delivers historical attachment-only successes without requesting another generation", async () => {
    const f = await fixture();
    const job = await f.service.submit(context, input); await submitted(f.service, job.id); await f.service.tick();
    const complete = await f.service.status(context, job.id);
    await f.service.close(); services.splice(services.indexOf(f.service), 1);
    const store = new MediaJobStore(f.deps.dbPath);
    store.put({ ...complete, deliveredAt: undefined }); store.close();
    const restored = f.open(); await restored.tick(); await restored.tick();
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(f.fetchGateway.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
    expect(f.fetchGateway.mock.calls.filter(([, init]) => init.method === "GET")).toHaveLength(1);
  });

  it("suppresses terminal delivery when the original conversation was removed", async () => {
    let exists = true;
    const f = await fixture({ conversationExists: () => exists });
    const job = await f.service.submit(context, input); await submitted(f.service, job.id);
    exists = false; await f.service.tick();
    expect(await f.service.status(context, job.id)).toMatchObject({ status: "completed", waitingStopped: true });
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("never replays an ambiguous submission, including after restart", async () => {
    const send = vi.fn(async () => { throw new Error("connection dropped"); });
    const f = await fixture({ fetchGateway: send });
    const job = await f.service.submit(context, input); await submitted(f.service, job.id);
    expect((await f.service.status(context, job.id)).status).toBe("uncertain");
    await f.service.close(); services.splice(services.indexOf(f.service), 1);
    const restored = f.open(); await restored.tick();
    expect((await restored.submit(context, input)).id).toBe(job.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ status: "uncertain" }));
  });

  it("recovers a lost task response by its saved receipt after restart without a paid POST", async () => {
    const receipt = vi.fn(async () => ({ receipt_id: "receipt-fixture", status: "accepted", task_id: "recovered-task" }));
    const send = vi.fn(async (_path: string, init: RequestInit) => init.method === "POST"
      ? new Response("invalid-json", { status: 202, headers: { "X-DoneBot-Receipt-ID": "receipt-fixture" } })
      : json({ status: "completed", result: { data: [{ url: "https://artifact.invalid/fixture.png" }] } }));
    const f = await fixture({ fetchGateway: send, receipt });
    const job = await f.service.submit(context, input); await submitted(f.service, job.id);
    expect((await f.service.status(context, job.id)).status).toBe("uncertain");
    await f.service.close(); services.splice(services.indexOf(f.service), 1);
    const restored = f.open(); await restored.tick();
    expect(await restored.status(context, job.id)).toMatchObject({ status: "completed", taskId: "recovered-task" });
    expect(receipt).toHaveBeenCalledOnce();
    expect(send.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });

  it("binds job access to bot, conversation and account and pauses old-account work", async () => {
    const f = await fixture();
    const job = await f.service.submit(context, input); await submitted(f.service, job.id);
    for (const other of [{ ...context, botId: "other" }, { ...context, threadId: "other" }]) {
      await expect(f.service.status(other, job.id)).rejects.toMatchObject({ status: 404 });
    }
    f.setScope({ ...initialScope, accountId: "another-account" });
    await expect(f.service.status(context, job.id)).rejects.toMatchObject({ status: 404 });
    await f.service.tick();
    expect(f.fetchGateway).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
    f.setScope(initialScope); await f.service.tick();
    expect(f.publish).toHaveBeenCalledTimes(1);
  });

  it("does not publish under a switched account while submission is in flight", async () => {
    let finish!: (response: Response) => void;
    const f = await fixture({ fetchGateway: async () => new Promise(resolve => { finish = resolve; }) });
    const job = await f.service.submit(context, input);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    f.setScope(null); finish(json({ id: "accepted-before-logout" }, 202));
    await vi.waitFor(() => expect(f.publish).not.toHaveBeenCalled());
    f.setScope(initialScope); await submitted(f.service, job.id);
    expect((await f.service.status(context, job.id)).taskId).toBe("accepted-before-logout");
  });

  it("stops notification while retaining and downloading the paid supplier task", async () => {
    const f = await fixture();
    const job = await f.service.submit(context, input); await submitted(f.service, job.id);
    await f.service.stopWaiting(context, job.id); await f.service.tick();
    expect(await f.service.status(context, job.id)).toMatchObject({ status: "completed", waitingStopped: true, artifacts: [{ mime: "image/png" }] });
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("honors stop-waiting while completion is checking its account before publication", async () => {
    let service: DoneBotMediaService | undefined, id: string | undefined, blocked = false;
    let release!: () => void, reached!: () => void;
    const checked = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ scope: async () => {
      if (!blocked && id && service?.deliveryJob(id)?.status === "completed") {
        blocked = true; reached(); await gate;
      }
      return initialScope;
    } });
    service = f.service;
    const job = await service.submit(context, input); id = job.id;
    await submitted(service, id);
    const completing = service.tick();
    await checked;
    await service.stopWaiting(context, id); release(); await completing;
    expect(await service.status(context, id)).toMatchObject({ status: "completed", waitingStopped: true });
    expect(f.publish).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "image" as const, adapter: "apimart.images.v1", post: "/v1/images/generations", poll: "/v1/tasks/native-task", complete: { data: { status: "completed", result: { images: ["https://artifact.invalid/image"] } } }, mime: "image/png" },
    { kind: "music" as const, adapter: "apimart.music.v1", post: "/v1/music/generations", poll: "/v1/music/tasks/native-task", complete: { data: { status: "completed", result: { music: [{ audio_url: "https://artifact.invalid/audio" }] } } }, mime: "audio/mpeg" },
    { kind: "video" as const, adapter: "seedance.videos.v1", post: "/v1/videos", poll: "/v1/videos/native-task", complete: { status: "completed" }, mime: "video/mp4" },
  ])("parses $adapter and downloads its artifact", async ({ kind, adapter, post, poll, complete, mime }) => {
    const send = vi.fn(async (path: string, init: RequestInit) => {
      if (path.endsWith("/content")) return new Response("fixture-video", { headers: { "content-type": mime } });
      if (init.method === "POST") return json(adapter.startsWith("apimart") ? { data: [{ task_id: "native-task" }] } : { id: "native-task" }, 202);
      return json(complete);
    });
    const f = await fixture({ fetchGateway: send, resolveModel: async (id, kind) => ({ id, kind, adapter }), fetchArtifact: async () => new Response("fixture-artifact", { headers: { "content-type": mime } }) });
    const job = await f.service.submit(context, { ...input, kind }); await submitted(f.service, job.id); await f.service.tick();
    expect(send.mock.calls.map(([path]) => path)).toEqual(kind === "video" ? [post, poll, poll + "/content"] : [post, poll]);
    expect((await f.service.status(context, job.id)).artifacts[0]?.mime).toBe(mime);
    expect(f.publish).toHaveBeenCalledTimes(1);
  });

  it("persists and publishes every output of a 100-image Seedream 5.5 layer task", async () => {
    const urls = Array.from({ length: 100 }, (_, i) => `https://artifact.invalid/layer-${i}.png`);
    const send = vi.fn(async (_path: string, init: RequestInit) => init.method === "POST"
      ? json({ data: [{ task_id: "layers-task" }] })
      : json({ data: { status: "completed", result: { images: [{ url: urls, layer_decomposition: true, layers: urls.map((_, z_index) => ({ z_index })) }] } } }));
    const f = await fixture({ fetchGateway: send, resolveModel: async (id, kind) => ({ id, kind, adapter: "apimart.images.v1" }) });
    const job = await f.service.submit(context, { ...input, model: "seedream-5-5", parameters: { layer_decomposition: true } });
    await submitted(f.service, job.id); await f.service.tick();
    const completed = await f.service.status(context, job.id);
    expect(completed.status).toBe("completed");
    expect(completed.artifacts).toHaveLength(100);
    expect(completed.artifacts[99]?.layer?.z_index).toBe(99);
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });
});

describe("DoneBot artifact confinement", () => {
  it("opens only the registered regular artifact and refuses replaced files or symlinks", async () => {
    const f = await fixture();
    const artifact = await saveMediaArtifact({ directory: f.deps.artifactDir, jobId: "fixture", index: 0, kind: "image", maxBytes: 100, response: new Response(png, { headers: { "content-type": "image/png" } }) });
    const handle = await openMediaArtifact(artifact, f.deps.artifactDir);
    try { expect(await handle.readFile()).toEqual(png); } finally { await handle.close(); }
    await writeFile(artifact.path, "changed");
    await expect(openMediaArtifact(artifact, f.deps.artifactDir)).rejects.toThrow("changed");
    await rm(artifact.path); await symlink(join(f.root, "secret"), artifact.path);
    await expect(openMediaArtifact(artifact, f.deps.artifactDir)).rejects.toThrow("unavailable");
  });
  it("rejects private, special and mapped addresses while allowing public ranges", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.20.1.1", "192.168.1.1", "100.64.0.1", "198.19.0.1", "192.0.2.1", "203.0.113.2", "::1", "::ffff:8.8.8.8", "fc00::1", "fe80::1", "2001:db8::1", "2002:a00:1::1"]) expect(publicMediaAddress(address), address).toBe(false);
    for (const address of ["8.8.8.8", "192.12.1.1", "169.1.1.1", "2606:4700::1111", "2001:4860:4860::8888"]) expect(publicMediaAddress(address), address).toBe(true);
  });

  it("refuses local hosts and insecure URLs before receiving artifact content", async () => {
    for (const url of ["https://127.0.0.1/artifact", "https://[::1]/artifact", "http://example.com/file", "https://user:password@example.com/file"]) await expect(publicArtifactResponse(url, AbortSignal.timeout(1000))).rejects.toThrow();
  });

  it.each([
    { headers: { "content-type": "text/html" }, body: "html", limit: 100 },
    { headers: { "content-type": "image/png", "content-length": "30" }, body: "short", limit: 100 },
    { headers: { "content-type": "image/png" }, body: "too many bytes", limit: 4 },
  ])("cleans partial downloads on unsupported, truncated or oversized responses", async ({ headers, body, limit }) => {
    const f = await fixture();
    await expect(saveMediaArtifact({ directory: f.deps.artifactDir, jobId: "fixture", index: 0, kind: "image", maxBytes: limit, response: new Response(body, { headers }) })).rejects.toThrow();
    const files = await readdir(join(f.deps.artifactDir, "fixture")).catch(() => []);
    expect(files).toEqual([]);
  });

  it("rejects symlink artifact directories and symlink publication paths", async () => {
    const f = await fixture(), outside = join(f.root, "outside");
    await mkdir(outside); await mkdir(f.deps.artifactDir); await writeFile(join(outside, "secret.png"), png);
    await symlink(outside, join(f.deps.artifactDir, "fixture"), "dir");
    await expect(saveMediaArtifact({ directory: f.deps.artifactDir, jobId: "fixture", index: 0, kind: "image", maxBytes: 100, response: new Response(png, { headers: { "content-type": "image/png" } }) })).rejects.toThrow("private");
    expect(await safeMediaArtifact(join(f.deps.artifactDir, "fixture", "secret.png"), f.deps.artifactDir)).toBe(false);
  });
});
