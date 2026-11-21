import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { appendFileSync } from "node:fs";
import { launchVerificationServer } from "./control-omb.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";
import { FAKE_DONEBOT_CATALOG, startFakeDoneBotGateway } from "../server/testing/fake-donebot-gateway.ts";

const gateway = await startFakeDoneBotGateway(FAKE_DONEBOT_CATALOG, undefined, "1");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const team = { id: randomUUID(), name: "File fixture", instanceId: randomUUID(),
  publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
  files: { cap: 16 * 1024 ** 2, uploadMax: 10 * 1024 ** 2 } };
let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
let ui: MountedPreview | undefined;
let actor: "member" | "admin" | "revoked" = "member";
const headers = (method: string, path: string, role = actor) => {
  const payload = Buffer.from(JSON.stringify({ protocol: "donebot.teams.v1", team_id: team.id, instance_id: team.instanceId,
    user_id: role === "admin" ? "2" : "3", email: `${role}@fixture.invalid`, role: role === "admin" ? "admin" : "member", member_version: 1,
    expires: Math.floor(Date.now() / 1000) + (role === "revoked" ? -1 : 9), runtime_hash: createHash("sha256").update(`${method}\n${path}`).digest("hex") }));
  return { "x-donebot-team-grant": `${payload.toString("base64url")}.${sign(null, payload, privateKey).toString("base64url")}` };
};
try {
  fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin, undefined, undefined, undefined, team);
  const call = async (method: string, path: string, body: string, role: "member" | "admin" = "admin") => {
    const response = await fetch(fixture!.info.url + path, { method, body, headers: { ...headers(method, path, role), origin: fixture!.info.url,
      "content-type": method === "PUT" ? "application/octet-stream" : "application/json" } });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  };
  await call("POST", "/api/team-files/folder", JSON.stringify({ path: "templates" }));
  await call("PUT", "/api/team-files/file?path=templates&name=readme.md", "# Reviewed templates\nAdministrator-owned fixture.\n");
  await call("PUT", "/api/team-files/file?name=handbook.md", "# Team handbook\nSynthetic shared content.\n");
  await call("PUT", "/api/team-files/file?name=member.txt", "Member-owned fixture.\n", "member");
  await call("PUT", "/api/team-files/file?name=large.txt", "x".repeat(1024 ** 2 + 1));
  ui = await mountPreview(fixture, { entry: "/scripts/testing/team-files-preview.tsx", route: "/__team-files.html", title: "Team files fixture", logLevel: "error",
    proxyHeaders: { origin: fixture.info.url }, proxyRequestHeaders: headers,
    extraRoutes: [{ path: "/__fixture/actor", method: "POST", handler(req, res) {
      const role = new URL(req.url!, "http://fixture.invalid").searchParams.get("role");
      if (role !== "admin" && role !== "member" && role !== "revoked") { res.statusCode = 400; res.end(); return; }
      actor = role; res.end("ok");
    } }],
  });
  appendFileSync(fixture.info.logPath + ".team-files-ui.jsonl", JSON.stringify({ stage: "started", ui: ui.previewUrl, fixture: fixture.info }) + "\n");
  console.log(JSON.stringify({ ui: ui.previewUrl, ...fixture.info }));
  await parkUntilSignal();
  appendFileSync(fixture.info.logPath + ".team-files-ui.jsonl", JSON.stringify({ stage: "stopped" }) + "\n");
} finally { await ui?.close(); await fixture?.close(); await gateway.close(); }
