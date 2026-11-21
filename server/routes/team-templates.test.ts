import { createServer, request } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { json, readBody } from "../harness/http.ts";
import { createTeamFiles, type TeamFilesActor } from "../host/team-files.ts";
import { createTeamTemplates } from "../team-templates.ts";
import { teamTemplateFixture } from "../testing/team-template-fixture.ts";
import { createTeamTemplateRoutes } from "./team-templates.ts";
import { PASS } from "./table.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(options: { cap?: number; uploadMax?: number; enabled?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "donebot-team-templates-http-"));
  const files = createTeamFiles({ dataDir: root, cap: options.cap ?? 100_000, uploadMax: options.uploadMax ?? options.cap ?? 100_000 });
  const templates = options.enabled === false ? null : createTeamTemplates(root, files);
  let actor: TeamFilesActor | null = { person: "admin", admin: true }, checks = 0;
  const errors: unknown[] = [];
  const route = createTeamTemplateRoutes({ templates, actor: () => { checks++; return actor; } });
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
    rmSync(root, { recursive: true, force: true }); expect(errors).toEqual([]);
  });
  const call = async (method: string, path = "", body?: unknown) => {
    const response = await fetch(origin + "/api/team-templates" + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
    return { status: response.status, body: await response.json() as any, cache: response.headers.get("cache-control") };
  };
  return { root, files, templates, origin, call, checks: () => checks, actor: (value: TeamFilesActor | null) => { actor = value; } };
}
const publication = (revision: string | null = null, release = "1.0.0") => ({ slug: "helper", scope: "bot", document: teamTemplateFixture(release), revision, confirm: true });

it("keeps disabled routes absent and permits no anonymous, forged, or member publication", async () => {
  const off = await fixture({ enabled: false });
  expect((await off.call("GET")).status).toBe(404);
  const f = await fixture();
  f.actor(null); expect((await f.call("GET")).status).toBe(403);
  f.actor({ person: "member", admin: false });
  expect((await f.call("GET")).body).toEqual({ templates: [], admin: false });
  expect((await f.call("POST", "", { ...publication(), admin: true, person: "admin" })).status).toBe(403);
  expect((await f.call("DELETE", "/helper", { confirm: true, revision: "a".repeat(64) })).status).toBe(403);
  expect(f.templates!.list()).toEqual([]);
});

it("requires confirmation and the reviewed revision; members can read exact inert content", async () => {
  const f = await fixture();
  for (const body of [{ ...publication(), confirm: false }, { ...publication(), revision: undefined }, { ...publication(), admin: true }, { ...publication(), slug: "../helper" }]) {
    expect((await f.call("POST", "", body)).status).toBe(400);
  }
  const created = await f.call("POST", "", publication());
  expect(created.status).toBe(201);
  expect(created.cache).toBe("private, no-store");
  const revision = created.body.template.revision;
  f.actor({ person: "member", admin: false });
  const preview = await f.call("GET", "/helper");
  expect(preview.body.document).toEqual(teamTemplateFixture());
  expect(preview.body.template.revision).toBe(revision);
  expect(preview.cache).toBe("private, no-store");
  f.actor({ person: "admin", admin: true });
  expect((await f.call("POST", "", publication())).status).toBe(409);
  expect((await f.call("POST", "", publication(revision))).body.template).toEqual(created.body.template);
  expect(readdirSync(join(f.root, "team-files/templates"))).toEqual(["helper"]);
  const updated = await f.call("POST", "", publication(revision, "2.0.0"));
  expect(updated.status).toBe(201);
  expect((await f.call("DELETE", "/helper", { confirm: true, revision })).status).toBe(409);
  expect((await f.call("DELETE", "/helper", { confirm: true, revision: updated.body.template.revision })).status).toBe(200);
  expect((await f.call("GET", "/helper")).status).toBe(404);
  expect(readFileSync(join(f.root, "team-files/templates/helper.previous/bot.md"), "utf8")).toContain("2.0.0");
});

it("rechecks the actual actor after receiving a delayed mutation body", async () => {
  const f = await fixture();
  const req = request(f.origin + "/api/team-templates", { method: "POST", headers: { "content-type": "application/json" } });
  const result = new Promise<number>((resolve, reject) => {
    req.on("error", reject);
    req.on("response", res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
  });
  const body = JSON.stringify(publication());
  req.write(body.slice(0, 100));
  await expect.poll(f.checks).toBe(2);
  f.actor({ person: "another-admin", admin: true }); req.end(body.slice(100));
  expect(await result).toBe(403);
  expect(f.templates!.list()).toEqual([]);
});

it("reports limits and corrupt data without leaking internal paths or publishing partial content", async () => {
  const small = await fixture({ cap: 100_000, uploadMax: 20 });
  expect((await small.call("POST", "", publication())).status).toBe(413);
  const full = await fixture();
  writeFileSync(join(full.root, "team-files/occupied"), "x".repeat(99_999));
  expect((await full.call("POST", "", publication())).status).toBe(507);
  const f = await fixture();
  writeFileSync(join(f.root, "share/team-library.json"), "corrupt");
  const answer = await f.call("GET");
  expect(answer.status).toBe(503);
  expect(JSON.stringify(answer.body)).not.toContain(f.root);
  expect((await f.call("GET", "/bad/path")).status).toBe(404);
  expect((await f.call("PATCH")).status).toBe(405);
});

it("returns a bounded JSON refusal for oversized and malformed request bodies", async () => {
  const f = await fixture();
  const malformed = await fetch(f.origin + "/api/team-templates", { method: "POST", body: "not json" });
  expect(malformed.status).toBe(400);
  const oversized = await fetch(f.origin + "/api/team-templates", { method: "POST", body: "x".repeat(10 * 1024 * 1024 + 1) });
  expect(oversized.status).toBe(413);
  expect(f.templates!.list()).toEqual([]);
});
