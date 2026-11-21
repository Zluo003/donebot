import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { FAKE_DONEBOT_CATALOG, startFakeDoneBotGateway } from "./testing/fake-donebot-gateway.ts";
import type { TeamFilesListing } from "../shared/team-files.ts";

it("keeps team files behind signed membership and configured quotas in real isolated services", async () => {
  const gateway = await startFakeDoneBotGateway(FAKE_DONEBOT_CATALOG, undefined, "1");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const config = { id: randomUUID(), name: "File fixture", instanceId: randomUUID(),
    publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"), files: { cap: 128, uploadMax: 64 } };
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin, undefined, undefined, undefined, config);
  let other: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  try {
    type Person = { id: string; role: "owner" | "admin" | "member" };
    const owner: Person = { id: "1", role: "owner" }, admin: Person = { id: "2", role: "admin" }, alice: Person = { id: "3", role: "member" }, bob: Person = { id: "4", role: "member" };
    const call = async (method: string, path: string, actor = alice, body?: string, patch: Record<string, unknown> = {}, base = fixture.info.url) => {
      const payload = Buffer.from(JSON.stringify({ protocol: "donebot.teams.v1", team_id: config.id, instance_id: config.instanceId,
        user_id: actor.id, email: `member-${actor.id}@example.invalid`, role: actor.role, member_version: 1,
        expires: Math.floor(Date.now() / 1000) + 9, runtime_hash: createHash("sha256").update(`${method}\n${path}`).digest("hex"), ...patch }));
      return fetch(base + path, { method, headers: { origin: base, "content-type": method === "PUT" ? "application/octet-stream" : "application/json",
        "x-donebot-team-grant": `${payload.toString("base64url")}.${sign(null, payload, privateKey).toString("base64url")}` }, body });
    };
    const jsonCall = (method: string, path: string, actor: Person, body: unknown) => call(method, path, actor, JSON.stringify(body));
    const enabledConfig = await call("GET", "/api/config", owner);
    expect(enabledConfig.status).toBe(200);
    expect((await enabledConfig.json() as { team?: unknown }).team).toMatchObject({ id: config.id, name: config.name, sharedFiles: true, sharedTemplates: false });
    for (const method of ["GET", "PUT"]) expect((await fetch(fixture.info.url + "/api/team-files/file?name=hidden", { method })).status).toBe(401);
    expect((await call("GET", "/api/team-files", owner, undefined, { team_id: randomUUID() })).status).toBe(401);
    expect((await call("GET", "/api/team-files", alice, undefined, { expires: Math.floor(Date.now() / 1000) - 1 })).status).toBe(401);
    for (const actor of [owner, admin, alice, bob]) {
      const response = await call("GET", "/api/team-files", actor);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ entries: [], used: 0, cap: 128, uploadMax: 64, admin: actor.role !== "member" });
    }
    expect((await jsonCall("POST", "/api/team-files/folder", alice, { path: "reports" })).status).toBe(201);
    const bytes = "const script = 'SCRIPT_MUST_NOT_RUN';\r\n";
    expect((await call("PUT", "/api/team-files/file?path=reports&name=report.js", alice, bytes)).status).toBe(201);
    const listing = await (await call("GET", "/api/team-files?path=reports", bob)).json() as TeamFilesListing;
    expect(listing.entries[0]).toMatchObject({ name: "report.js", canDelete: false, mine: false });
    expect(JSON.stringify(listing)).not.toMatch(/private_key|authorization|credential|member_version/);
    const download = await call("GET", "/api/team-files/file?path=reports%2Freport.js", bob);
    expect(download.status).toBe(200); expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toContain("attachment"); expect(await download.text()).toBe(bytes);
    expect((await call("PUT", "/api/team-files/file?path=reports&name=report.js", bob, "changed")).status).toBe(409);
    for (const op of ["delete", "rename"]) {
      const response = await jsonCall("POST", `/api/team-files/${op}`, bob, op === "delete" ? { path: "reports/report.js" } : { from: "reports/report.js", to: "reports/stolen.js" });
      expect(response.status).toBe(403);
    }
    expect((await jsonCall("POST", "/api/team-files/folder", alice, { path: "templates" })).status).toBe(403);
    expect((await jsonCall("POST", "/api/team-files/folder", admin, { path: "templates" })).status).toBe(201);
    expect((await call("PUT", "/api/team-files/file?path=templates&name=team.md", alice, "no")).status).toBe(403);
    expect((await call("PUT", "/api/team-files/file?path=templates&name=team.md", owner, "team")).status).toBe(201);
    expect((await call("PUT", "/api/team-files/file?name=too-big", alice, "x".repeat(65))).status).toBe(413);
    for (const name of ["..", "../private", "a/b", "a\\b"]) expect((await call("PUT", `/api/team-files/file?name=${encodeURIComponent(name)}`, alice, "x")).status).toBe(400);
    expect((await jsonCall("POST", "/api/team-files/delete", alice, { path: "reports/report.js", person: "owner", admin: true })).status).toBe(400);
    expect((await jsonCall("POST", "/api/team-files/rename", admin, { from: "reports/report.js", to: "reports/renamed.js" })).status).toBe(200);
    expect(await (await call("GET", "/api/team-files/file?path=reports%2Frenamed.js", alice)).text()).toBe(bytes);
    const templatesConfig = { ...config, id: randomUUID(), instanceId: randomUUID(), files: { ...config.files, templates: true } };
    other = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin, undefined, undefined, undefined, templatesConfig);
    expect((await call("GET", "/api/team-files", alice, undefined, {}, other.info.url)).status).toBe(401);
    const templatesConfigResponse = await call("GET", "/api/config", owner, undefined, { team_id: templatesConfig.id, instance_id: templatesConfig.instanceId }, other.info.url);
    expect(templatesConfigResponse.status).toBe(200);
    expect((await templatesConfigResponse.json() as { team?: unknown }).team).toMatchObject({ id: templatesConfig.id, sharedFiles: true, sharedTemplates: true });
    expect(existsSync(join(other.info.dataDir, "team-files"))).toBe(true);
    await other.close(); other = undefined;
    const { files: _files, ...disabled } = config;
    other = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin, undefined, undefined, undefined, disabled);
    expect((await call("GET", "/api/team-files", owner, undefined, {}, other.info.url)).status).toBe(404);
    const disabledConfig = await call("GET", "/api/config", owner, undefined, { team_id: disabled.id, instance_id: disabled.instanceId }, other.info.url);
    expect(disabledConfig.status).toBe(200);
    expect((await disabledConfig.json() as { team?: unknown }).team).toMatchObject({ id: disabled.id, sharedFiles: false, sharedTemplates: false });
    expect(existsSync(join(other.info.dataDir, "team-files"))).toBe(false);
    expect((await jsonCall("POST", "/api/team-files/delete", alice, { path: "reports/renamed.js" })).status).toBe(200);
    expect(readdirSync(join(fixture.info.dataDir, "tmp/team-files-uploads"))).toEqual([]);
    expect(existsSync(join(fixture.info.dataDir, "fake-claude-dump.json"))).toBe(false);
    const evidence = { ok: true, logPath: fixture.info.logPath, grants: true, quotas: true, memberOwnership: true, adminTemplates: true, foreignTeamDenied: true, defaultOff: true, scriptExecuted: false };
    writeFileSync(fixture.info.logPath + ".team-files.json", JSON.stringify(evidence, null, 2)); console.info(JSON.stringify(evidence));
  } finally { await other?.close(); await fixture.close(); await gateway.close(); }
}, 180_000);
