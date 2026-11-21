import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { FAKE_DONEBOT_CATALOG, startFakeDoneBotGateway } from "./testing/fake-donebot-gateway.ts";
import { teamTemplateFixture } from "./testing/team-template-fixture.ts";

it("publishes and reads inert team templates through signed isolated runtime routes with stale-review and default-off protection", async () => {
  const gateway = await startFakeDoneBotGateway(FAKE_DONEBOT_CATALOG, undefined, "1");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const config = { id: randomUUID(), name: "Template fixture", instanceId: randomUUID(),
    publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"), files: { cap: 100_000, uploadMax: 50_000, templates: true } };
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin, undefined, undefined, undefined, config);
  let other: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  try {
    type Person = { id: string; role: "owner" | "admin" | "member" };
    const owner: Person = { id: "1", role: "owner" }, admin: Person = { id: "2", role: "admin" }, alice: Person = { id: "3", role: "member" }, bob: Person = { id: "4", role: "member" };
    const call = async (method: string, path: string, actor = alice, body?: unknown, patch: Record<string, unknown> = {}, base = fixture.info.url) => {
      const payload = Buffer.from(JSON.stringify({ protocol: "donebot.teams.v1", team_id: config.id, instance_id: config.instanceId,
        user_id: actor.id, email: `member-${actor.id}@example.invalid`, role: actor.role, member_version: 1,
        expires: Math.floor(Date.now() / 1000) + 9, runtime_hash: createHash("sha256").update(`${method}\n${path}`).digest("hex"), ...patch }));
      return fetch(base + path, { method, headers: { origin: base, "content-type": "application/json",
        "x-donebot-team-grant": `${payload.toString("base64url")}.${sign(null, payload, privateKey).toString("base64url")}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    };
    const publication = (revision: string | null = null, release = "1.0.0") => ({ slug: "helper", scope: "bot", document: teamTemplateFixture(release), revision, confirm: true });
    const jsonCall = async (method: string, path: string, actor: Person, body: unknown, status: number) => {
      const response = await call(method, path, actor, body);
      const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(status); return result as any;
    };
    expect((await fetch(fixture.info.url + "/api/team-templates")).status).toBe(401);
    expect((await call("GET", "/api/team-templates", alice, undefined, { team_id: randomUUID() })).status).toBe(401);
    expect((await call("GET", "/api/team-templates", alice, undefined, { expires: Math.floor(Date.now() / 1000) - 1 })).status).toBe(401);
    for (const actor of [owner, admin, alice, bob]) {
      const response = await call("GET", "/api/team-templates", actor);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ templates: [], admin: actor.role !== "member" });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    const beforeBots = await (await call("GET", "/api/bots", owner)).json();
    expect((await call("POST", "/api/team-templates", alice, { ...publication(), admin: true, person: owner.id })).status).toBe(403);
    await jsonCall("POST", "/api/team-templates", owner, { ...publication(), confirm: false }, 400);
    const created = await jsonCall("POST", "/api/team-templates", owner, publication(), 201);
    expect(created.template.addedBy).not.toBe("admin");
    expect(created.template.revision).toMatch(/^[a-f0-9]{64}$/);
    for (const actor of [alice, bob]) {
      const response = await call("GET", "/api/team-templates/helper", actor), preview = await response.json() as any;
      expect(response.status).toBe(200); expect(preview.document).toEqual(teamTemplateFixture());
      expect(preview.template).toEqual(created.template);
      expect(JSON.stringify(preview)).not.toMatch(/private_key|member_version|authorization|credential/);
    }
    const script = await call("GET", "/api/team-files/file?path=templates%2Fhelper%2Fskills%2Freport%2Fscripts%2Freport.py", bob);
    expect(script.status).toBe(200); expect(script.headers.get("content-type")).toBe("application/octet-stream");
    expect(await script.text()).toBe(teamTemplateFixture().package.skills!.entries[0]!.files![0]!.content);
    const repeated = await jsonCall("POST", "/api/team-templates", admin, publication(created.template.revision), 201);
    expect(repeated.template).toEqual(created.template);
    expect(readdirSync(join(fixture.info.dataDir, "team-files/templates"))).toEqual(["helper"]);
    await jsonCall("POST", "/api/team-templates", owner, publication(), 409);
    const updated = await jsonCall("POST", "/api/team-templates", admin, publication(created.template.revision, "2.0.0"), 201);
    await jsonCall("DELETE", "/api/team-templates/helper", owner, { confirm: true, revision: created.template.revision }, 409);
    expect((await call("DELETE", "/api/team-templates/helper", alice, { confirm: true, revision: updated.template.revision })).status).toBe(403);
    expect(await (await call("GET", "/api/bots", owner)).json()).toEqual(beforeBots);
    other = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin, undefined, undefined, undefined, { ...config, id: randomUUID(), instanceId: randomUUID() });
    expect((await call("GET", "/api/team-templates/helper", alice, undefined, {}, other.info.url)).status).toBe(401);
    await other.close(); other = undefined;
    other = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin, undefined, undefined, undefined, { ...config, files: { ...config.files, templates: false } });
    expect((await call("GET", "/api/team-templates", owner, undefined, {}, other.info.url)).status).toBe(404);
    expect(existsSync(join(other.info.dataDir, "team-files/templates"))).toBe(false);
    expect(existsSync(join(other.info.dataDir, "share/team-library.json"))).toBe(false);
    await jsonCall("DELETE", "/api/team-templates/helper", owner, { confirm: true, revision: updated.template.revision }, 200);
    expect(await (await call("GET", "/api/team-templates", alice)).json()).toEqual({ templates: [], admin: false });
    expect(existsSync(fixture.fixtureDumpPath)).toBe(false);
    const evidence = { ok: true, logPath: fixture.info.logPath, signedMembership: true, foreignTeamDenied: true, defaultOff: true,
      adminPublication: true, staleReviewRefused: true, repeatedConfirmationPreservesPrevious: true, scriptBytesOnly: true, botsUnchanged: true };
    writeFileSync(fixture.info.logPath + ".team-templates.json", JSON.stringify(evidence, null, 2)); console.info(JSON.stringify(evidence));
  } finally { await other?.close(); await fixture.close(); await gateway.close(); }
}, 180_000);
