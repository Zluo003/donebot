import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaAssetCache } from "./media-assets.ts";
import type { MediaScope, MediaContext } from "./media.ts";
import { nativeModel } from "./capabilities.ts";
import { seedanceReferencePolicy } from "./seedance-capabilities.ts";

const roots: string[] = [], caches: MediaAssetCache[] = [];
const context: MediaContext = { botId: "bot", threadId: "thread", turnId: "turn", active: () => true };
const scope: MediaScope = { accountId: "fixture-account", installationId: "fixture-install" };
afterEach(async () => { for (const cache of caches.splice(0)) cache.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(mimeForPath = (_path: string) => "image/png") {
  const root = await mkdtemp(join(tmpdir(), "donebot-assets-fixture-")); roots.push(root);
  const dbPath = join(root, "assets.sqlite");
  let current = scope, bytes = Buffer.from("fixture-image"), lookupStatus = 200, count = 0;
  const send = vi.fn(async (_path: string, init: RequestInit) => {
    if (init.method === "GET" && lookupStatus !== 200) return new Response(null, { status: lookupStatus });
    if (init.method === "POST") count++;
    const id = init.method === "POST" ? `asset-${count}` : _path.split("/").at(-1)!;
    return Response.json({ id, url: `https://fixture-bucket.invalid/ref-${id.slice(6)}?signature=${init.method === "POST" ? "initial" : "refreshed"}` });
  });
  const cache = new MediaAssetCache({ dbPath, scope: () => current, fetchGateway: send, resolveReference: async (_context, path) => ({ bytes, mime: mimeForPath(path), name: "fixture.png" }) }); caches.push(cache);
  const prepare = () => cache.prepare(context, current, { prompt: "Fixture https://example.invalid/in-prompt", image_urls: [{ local_path: "/fixture.png" }] });
  return { cache, send, prepare, dbPath, setBytes: (value: string | Uint8Array) => { bytes = Buffer.from(value); }, setStatus: (status: number) => { lookupStatus = status; }, setScope: (value: MediaScope) => { current = value; } };
}

describe("DoneBot gateway reference uploads", () => {
  it("uploads a valid video above 32 MiB using the model policy and refuses mismatched native fields", async () => {
    const f = await fixture(() => "video/mp4");
    f.setBytes(new Uint8Array(33 * 1024 * 1024));
    const policy = seedanceReferencePolicy(nativeModel("seedance-2-5")!);
    const parameters = { content: [{ type: "video_url", video_url: { url: { local_path: "/fixture.mp4" } }, role: "reference_video" }] };
    await expect(f.cache.prepare(context, scope, parameters)).rejects.toThrow("size");
    await expect(f.cache.prepare(context, scope, parameters, undefined, policy)).resolves.toMatchObject({ parameters: { content: [{ video_url: { url: expect.stringContaining("https://") } }] } });
    expect(f.send.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
    await expect(f.cache.prepare(context, scope, { image_urls: [{ local_path: "/fixture.mp4" }] }, undefined, policy)).rejects.toThrow("native image field");
    expect(f.send.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });

  it("prepares all 50 Seedance 2.5 references through scoped cache lookups without raising other models' limits", async () => {
    const f = await fixture(path => path.endsWith(".mp4") ? "video/mp4" : path.endsWith(".mp3") ? "audio/mpeg" : "image/png");
    const parameters = { image_urls: Array.from({ length: 30 }, () => ({ local_path: "/fixture.png" })),
      video_urls: Array.from({ length: 10 }, () => ({ local_path: "/fixture.mp4" })), audio_urls: Array.from({ length: 10 }, () => ({ local_path: "/fixture.mp3" })) };
    const prepared = await f.cache.prepare(context, scope, parameters, undefined, seedanceReferencePolicy(nativeModel("seedance-2-5")!));
    expect(prepared.parameters.image_urls).toHaveLength(30);
    expect(prepared.parameters.video_urls).toHaveLength(10);
    expect(prepared.parameters.audio_urls).toHaveLength(10);
    expect(f.send.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(3);
    expect(f.send.mock.calls.filter(([, init]) => init.method === "GET")).toHaveLength(47);
    await expect(f.cache.prepare(context, scope, parameters)).rejects.toThrow("Too many");
  });

  it("rejects Seedance file types and byte limits before uploading an invalid reference", async () => {
    const f = await fixture();
    const policy = seedanceReferencePolicy(nativeModel("seedance-2-5")!);
    const check = (mime: string, size: number) => policy.validateFile!({ mime, name: "fixture", bytes: new Uint8Array(size) });
    expect(() => check("audio/mpeg", 15 * 1024 * 1024)).not.toThrow();
    expect(() => check("audio/mpeg", 15 * 1024 * 1024 + 1)).toThrow("file-size");
    expect(() => check("image/png", 30 * 1024 * 1024 - 1)).not.toThrow();
    expect(() => check("image/png", 30 * 1024 * 1024)).toThrow("file-size");
    for (const mime of ["image/svg+xml", "video/webm", "audio/mp4"]) expect(() => check(mime, 1)).toThrow("format");
    await expect(f.cache.prepare(context, scope, { image_urls: [{ local_path: "/fixture.png" }] }, undefined,
      { ...policy, validateFile: () => { throw new Error("Invalid fixture metadata"); } })).rejects.toThrow("Invalid fixture metadata");
    expect(f.send).not.toHaveBeenCalled();
  });

  it("uploads content once, refreshes cached metadata and keeps signed URLs out of the database", async () => {
    const f = await fixture();
    const first = await f.prepare(), second = await f.prepare();
    expect(first.parameters.image_urls).toEqual(["https://fixture-bucket.invalid/ref-1?signature=initial"]);
    expect(second.parameters.image_urls).toEqual(["https://fixture-bucket.invalid/ref-1?signature=refreshed"]);
    expect(first.fingerprint).toEqual(second.fingerprint);
    expect(f.send.mock.calls.map(([path, init]) => [path, init.method])).toEqual([["/v1/assets", "POST"], ["/v1/assets/asset-1", "GET"]]);
    expect(f.send.mock.calls[0]![1].body).toBeInstanceOf(FormData);
    expect((await readFile(f.dbPath)).includes(Buffer.from("signature="))).toBe(false);
  });

  it("reuploads missing cache entries and changed content, without reusing another account's ID", async () => {
    const f = await fixture(); await f.prepare(); f.setStatus(404); await f.prepare();
    f.setStatus(200); f.setBytes("different fixture content"); await f.prepare();
    f.setScope({ ...scope, accountId: "other-account" }); await f.prepare();
    expect(f.send.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(4);
    expect(f.send.mock.calls.filter(([, init]) => init.method === "GET")).toHaveLength(1);
  });

  it.each([401, 429, 500])("does not turn a cached HTTP %i into another upload", async status => {
    const f = await fixture(); await f.prepare(); f.setStatus(status);
    await expect(f.prepare()).rejects.toThrow(String(status));
    expect(f.send.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });

  it("rejects direct URLs, data, asset IDs and bare paths while preserving prompt text", async () => {
    const f = await fixture();
    for (const value of ["https://external.invalid/ref", "data:image/png;base64,AAAA", "asset://supplier-id", "/tmp/ref.png", "ref.png"]) await expect(f.cache.prepare(context, scope, { image_urls: [value] })).rejects.toThrow("local_path");
    await expect(f.cache.prepare(context, scope, { prompt: "asset://supplier-id" })).rejects.toThrow("local_path");
    expect(f.send).not.toHaveBeenCalled();
    expect((await f.cache.prepare(context, scope, { content: [{ type: "image_url", image_url: { url: { local_path: "/fixture.png" }, detail: "high" }, role: "first_frame" }] })).parameters).toMatchObject({ content: [{ type: "image_url", role: "first_frame" }] });
  });
});
