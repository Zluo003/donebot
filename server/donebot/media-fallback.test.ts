import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DoneBotMediaService, type DoneBotMediaDeps, type MediaContext } from "./media.ts";

const context: MediaContext = { botId: "fixture-bot", threadId: "fixture-thread", turnId: "fixture-turn", active: () => true };
const scope = { accountId: "fixture-user", installationId: "fixture-installation" };
const input = { kind: "image" as const, model: "primary", parameters: { prompt: "Same scene" }, fallback: { model: "backup", parameters: { prompt: "Same scene" } } };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work(); });

async function fixture(patch: Partial<DoneBotMediaDeps> = {}) {
  const root = await mkdtemp(join(tmpdir(), "donebot-fallback-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let now = 100_000, state = "failed", currentScope: typeof scope | null = scope, exists = true;
  const posts: { model: string; key: string }[] = [];
  const publish = vi.fn(async () => {});
  const deps: DoneBotMediaDeps = {
    dbPath: join(root, "media.sqlite"), artifactDir: join(root, "artifacts"), scope: () => currentScope, now: () => now,
    concurrency: async () => 10, authorize: async () => {}, capabilities: async () => [], publish, conversationExists: () => exists,
    resolveModel: async (id, kind) => ({ id, kind, adapter: "donebot.images.async.v1" }), pollMs: 60_000,
    fetchGateway: async (path, init) => {
      if (path.startsWith("/v1/assets")) return Response.json({ id: "fixture-asset", url: "https://assets.invalid/reference.png" });
      if (init.method === "POST") {
        const body = JSON.parse(String(init.body));
        posts.push({ model: body.model, key: new Headers(init.headers).get("Idempotency-Key")! });
        return Response.json({ id: body.model + "-task" }, { status: 202, headers: { "X-DoneBot-Receipt-ID": body.model + "-receipt" } });
      }
      const status = path.includes("primary-task") ? state : "completed";
      return Response.json({ status, ...(status === "completed" ? { result: { data: [{ url: "https://artifact.invalid/image.png" }] } } : {}),
        ...(status === "processing" ? { generation_status: "completed" } : {}) });
    },
    fetchArtifact: async () => new Response(png, { headers: { "content-type": "image/png" } }), ...patch,
  };
  let service = new DoneBotMediaService(deps);
  cleanup.push(() => service.close());
  const submitted = async (id: string) => vi.waitFor(async () => expect((await service.status(context, id)).status).toBe("submitted"));
  return { get service() { return service; }, posts, publish, submitted,
    state: (value: string) => { state = value; }, advance: () => { now += 60_000; }, account: (present: boolean) => { currentScope = present ? scope : null; },
    remove: () => { exists = false; }, restart: async () => { await service.close(); service = new DoneBotMediaService(deps); } };
}

it("persists one logical job and both receipts, switches once with a distinct idempotency key, and resumes across restart", async () => {
  const f = await fixture();
  const job = await f.service.submit(context, input); await f.submitted(job.id);
  await f.service.tick();
  expect(await f.service.status(context, job.id)).toMatchObject({ status: "queued", model: "backup", previousAttempts: [{ model: "primary", taskId: "primary-task", receiptId: "primary-receipt" }] });
  await f.restart(); f.advance(); await f.service.tick(); await f.submitted(job.id);
  await f.service.tick();
  expect(await f.service.status(context, job.id)).toMatchObject({ status: "completed", model: "backup", receiptId: "backup-receipt", artifacts: [{ mime: "image/png" }] });
  expect(f.posts.map(post => post.model)).toEqual(["primary", "backup"]);
  expect(new Set(f.posts.map(post => post.key)).size).toBe(2);
  expect((await f.service.submit(context, input)).id).toBe(job.id);
  await f.service.tick(); expect(f.posts).toHaveLength(2);
  expect(f.publish).toHaveBeenCalledTimes(1);
});

it("validates backup parameters before any primary paid request", async () => {
  const f = await fixture({ resolveModel: async (id, kind) => ({ id, kind, adapter: "donebot.images.async.v1",
    validate: parameters => { if (id === "backup" && parameters.prompt === "invalid") throw new Error("Invalid backup prompt"); } }) });
  await expect(f.service.submit(context, { ...input, fallback: { model: "backup", parameters: { prompt: "invalid" } } })).rejects.toThrow("Invalid backup prompt");
  expect(f.posts).toHaveLength(0);
});

it("does not repeat the primary generation when only the backup plan changes", async () => {
  const f = await fixture();
  const job = await f.service.submit(context, input); await f.submitted(job.id);
  expect((await f.service.submit(context, { ...input, fallback: { model: "another-backup", parameters: { prompt: "Same scene" } } })).id).toBe(job.id);
  expect((await f.service.submit(context, { ...input, fallback: undefined })).id).toBe(job.id);
  expect(f.posts.map(post => post.model)).toEqual(["primary"]);
});

it("requires a fallback to keep all reference files before either generation is submitted", async () => {
  const f = await fixture({ resolveReference: async () => ({ bytes: png, mime: "image/png", name: "reference.png" }) });
  await expect(f.service.submit(context, { ...input, parameters: { prompt: "Same scene", images: [{ image_url: { local_path: "/fixture.png" } }] } })).rejects.toThrow("preserve");
  expect(f.posts).toHaveLength(0);
});

it("does not submit the backup if a reference file changes while the primary is running", async () => {
  let bytes = png;
  const f = await fixture({ resolveReference: async () => ({ bytes, mime: "image/png", name: "reference.png" }) });
  const parameters = { prompt: "Same scene", images: [{ image_url: { local_path: "/fixture.png" } }] };
  const job = await f.service.submit(context, { ...input, parameters, fallback: { model: "backup", parameters } });
  await f.submitted(job.id);
  bytes = Buffer.concat([png, Buffer.from([4])]);
  await f.service.tick(); f.advance(); await f.service.tick();
  expect(await f.service.status(context, job.id)).toMatchObject({ status: "failed", model: "backup", error: expect.stringContaining("reference changed") });
  expect(f.posts.map(post => post.model)).toEqual(["primary"]);
});

it("uses the backup after an explicit 422 rejection without recursively retrying", async () => {
  const posts: string[] = [];
  const f = await fixture({ fetchGateway: async (_path, init) => {
    if (init.method === "POST") { posts.push(JSON.parse(String(init.body)).model); return Response.json({ error: "Synthetic rejection" }, { status: 422 }); }
    throw new Error("No task should be polled");
  } });
  const job = await f.service.submit(context, input);
  await vi.waitFor(async () => expect((await f.service.status(context, job.id)).model).toBe("backup"));
  f.advance(); await f.service.tick();
  await vi.waitFor(async () => expect((await f.service.status(context, job.id)).status).toBe("failed"));
  expect(posts).toEqual(["primary", "backup"]);
});

it.each(["uncertain", "processing"])("continues the original %s task without spending on a backup", async state => {
  const f = await fixture(); f.state(state);
  const job = await f.service.submit(context, input); await f.submitted(job.id);
  await f.service.tick(); await f.restart(); f.advance(); await f.service.tick();
  expect(f.posts.map(post => post.model)).toEqual(["primary"]);
  expect(await f.service.status(context, job.id)).toMatchObject({ model: "primary", taskId: "primary-task" });
});

it("retries downloading the completed primary instead of generating a backup", async () => {
  const f = await fixture({ fetchArtifact: async () => Response.json({ error: "not ready" }, { status: 409 }) }); f.state("completed");
  const job = await f.service.submit(context, input); await f.submitted(job.id);
  await f.service.tick(); f.advance(); await f.service.tick();
  expect(f.posts).toHaveLength(1);
  expect(await f.service.status(context, job.id)).toMatchObject({ status: "downloading", model: "primary" });
});

it.each(["stop", "removed", "account", "cancelled"])("suppresses backup dispatch after %s", async action => {
  const f = await fixture();
  const job = await f.service.submit(context, input); await f.submitted(job.id);
  if (action === "stop") await f.service.stopWaiting(context, job.id);
  if (action === "removed") f.remove();
  if (action === "account") f.account(false);
  if (action === "cancelled") f.state("cancelled");
  await f.service.tick(); f.advance(); await f.service.tick();
  expect(f.posts.map(post => post.model)).toEqual(["primary"]);
});

it("records a failed backup without recursively retrying either model", async () => {
  const posts: string[] = [];
  const f = await fixture({ fetchGateway: async (_path, init) => {
    if (init.method === "POST") { const body = JSON.parse(String(init.body)); posts.push(body.model); return Response.json({ id: body.model + "-task" }); }
    return Response.json({ status: "failed" });
  } });
  const job = await f.service.submit(context, input); await f.submitted(job.id); await f.service.tick();
  f.advance(); await f.service.tick(); await f.submitted(job.id); await f.service.tick();
  f.advance(); await f.service.tick();
  expect(await f.service.status(context, job.id)).toMatchObject({ status: "failed", model: "backup" });
  expect(posts).toEqual(["primary", "backup"]);
});

it("keeps a failed video pending across restart, then dispatches only after confirmation", async () => {
  let decision: "pending" | "approved" | "declined" = "pending";
  const review = vi.fn(async () => decision);
  const f = await fixture({ reviewFallback: review, resolveModel: async (id, kind) => ({ id, kind, adapter: "seedance.videos.v1" }),
    fetchGateway: async (_path, init) => {
      if (init.method === "POST") return Response.json({ id: JSON.parse(String(init.body)).model + "-task" });
      return Response.json({ status: "failed" });
    } });
  const job = await f.service.submit(context, { ...input, kind: "video" }); await f.submitted(job.id);
  await f.service.tick();
  expect(await f.service.status(context, job.id)).toMatchObject({ status: "failed", model: "primary", fallbackDecision: "pending" });
  expect(review).toHaveBeenCalledTimes(1);
  await f.restart(); f.advance(); await f.service.tick();
  expect((await f.service.status(context, job.id)).model).toBe("primary");
  decision = "approved"; f.advance(); await f.service.tick();
  expect(await f.service.status(context, job.id)).toMatchObject({ model: "backup", fallbackDecision: "approved" });
  await f.submitted(job.id);
});

it("ends a declined fallback without submitting it", async () => {
  const review = vi.fn(async () => "declined" as const);
  const f = await fixture({ reviewFallback: review });
  const job = await f.service.submit(context, input); await f.submitted(job.id);
  await f.service.tick(); f.advance(); await f.service.tick();
  expect(f.posts.map(post => post.model)).toEqual(["primary"]);
  expect(await f.service.status(context, job.id)).toMatchObject({ status: "failed", model: "primary", fallbackDecision: "declined" });
  expect(review).toHaveBeenCalledTimes(1);
});
