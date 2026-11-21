import { createServer, request } from "node:http";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { json, readBody } from "../harness/http.ts";
import { createTeamFiles, type TeamFilesActor } from "../host/team-files.ts";
import { createTeamFilesRoutes } from "./team-files.ts";
import { PASS } from "./table.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "donebot-team-files-http-"));
  const files = createTeamFiles({ dataDir: root, cap: 64, uploadMax: 32 });
  let actor: TeamFilesActor | null = { person: "alice", admin: false };
  let checks = 0;
  const route = createTeamFilesRoutes({ files, actor: () => { checks++; return actor; }, personName: person => person, botName: () => undefined });
  const errors: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://127.0.0.1");
      const result = await route({ req, res, url, path: url.pathname, method: req.method!, auth: { kind: "loopback", scopes: ["client"] }, json, readBody });
      if (result === PASS) json(res, 404, {});
    } catch (error) { errors.push(error); if (!res.headersSent) json(res, 500, {}); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(async () => {
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    rmSync(root, { force: true, recursive: true });
    expect(errors).toEqual([]);
  });
  const staging = () => {
    try { return readdirSync(join(root, "tmp/team-files-uploads")).map(name => statSync(join(root, "tmp/team-files-uploads", name)).size); }
    catch { return []; }
  };
  const send = (method: string, path: string) => {
    const req = request(origin + path, { method, headers: { "content-type": "application/octet-stream" } });
    const answer = new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      req.on("error", reject);
      req.on("response", res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
    });
    void answer.catch(() => undefined);
    return { req, answer };
  };
  return { origin, files, staging, send, checks: () => checks, actor: (value: TeamFilesActor | null) => { actor = value; } };
}

it("returns a usable refusal for oversized chunked uploads and accepts a subsequent request", async () => {
  const f = await fixture();
  const upload = f.send("PUT", "/api/team-files/file?name=too-large");
  upload.req.write("x".repeat(33)); upload.req.end();
  expect(await upload.answer).toMatchObject({ status: 413, body: { code: "too_large" } });
  expect(f.staging()).toEqual([]);
  expect((await fetch(f.origin + "/api/team-files/file?name=small", { method: "PUT", body: "ok" })).status).toBe(201);
});

it("refuses a member revoked during an upload without publishing staged bytes", async () => {
  const f = await fixture(), upload = f.send("PUT", "/api/team-files/file?name=held");
  upload.req.write("first");
  await expect.poll(() => f.staging().some(size => size > 0)).toBe(true);
  f.actor(null); upload.req.end("last");
  expect(await upload.answer).toMatchObject({ status: 403, body: { code: "forbidden" } });
  expect(f.staging()).toEqual([]);
  expect(f.files.list("", { person: "admin", admin: true }).entries).toEqual([]);
});

it("removes interrupted staging and releases its reservation", async () => {
  const f = await fixture(), upload = f.send("PUT", "/api/team-files/file?name=held");
  upload.req.write("first");
  await expect.poll(() => f.staging().some(size => size > 0)).toBe(true);
  upload.req.destroy(new Error("fixture abort"));
  await expect(upload.answer).rejects.toThrow("fixture abort");
  await expect.poll(f.staging).toEqual([]);
  expect((await fetch(f.origin + "/api/team-files/file?name=held", { method: "PUT", body: "x".repeat(32) })).status).toBe(201);
});

it("checks role and membership again after reading mutation JSON", async () => {
  const f = await fixture(), change = f.send("POST", "/api/team-files/folder");
  change.req.write('{"path":"new');
  await expect.poll(f.checks).toBe(2);
  f.actor({ person: "bob", admin: true }); change.req.end('"}');
  expect(await change.answer).toMatchObject({ status: 403 });
  expect(f.files.list("", { person: "admin", admin: true }).entries).toEqual([]);
});
