import { launchVerificationServer } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal } from "./testing/preview-fixture.ts";
import { startFakeDoneBotGateway } from "../server/testing/fake-donebot-gateway.ts";

const gateway = await startFakeDoneBotGateway();
const cloud = process.argv.includes("--cloud");
const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin);
try {
  const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
  await api("POST", "/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-password" });
  await api("PUT", "/api/config", { language: "zh-CN", onboarding: { completedAt: "", version: 0, hintsSeen: [], reelSeen: false } });
  const { bots } = await api("GET", "/api/bots");
  const chief = bots.find((bot: { defaultBot?: unknown; chiefOfStaff?: boolean }) => bot.defaultBot && bot.chiefOfStaff);
  if (!chief) throw new Error("Fixture has no default Chief");
  await api("PATCH", `/api/bots/${chief.id}`, { welcomed: false });
  let failSave = false;
  const preview = await mountPreview(fixture, {
    entry: "/scripts/testing/donebot-chief-setup-preview.tsx", route: "/__donebot-chief-setup.html", title: "Isolated DoneBot Chief setup", logLevel: "error",
    extraRoutes: [
      ...(cloud ? [{ path: "/api/auth/session", method: "GET", handler: async (_req: unknown, res: import("node:http").ServerResponse) => {
        const session = await api("GET", "/api/auth/session");
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ...session, cloudHome: true, scopes: ["admin"] }));
      } }] : []),
      { path: "/api/config", method: "PUT", handler: async (req, res) => {
        if (failSave) { failSave = false; res.statusCode = 503; res.end(JSON.stringify({ error: "Synthetic completion failure" })); return; }
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const response = await api("PUT", "/api/config", JSON.parse(Buffer.concat(chunks).toString()));
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify(response));
      } },
      { path: "/__fixture/fail-save", method: "POST", handler: (_req, res) => { failSave = true; res.end("ok"); } },
      { path: "/__fixture/evidence", method: "GET", handler: async (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ cloud, bots: await api("GET", "/api/bots"), config: await api("GET", "/api/config") }));
      } },
    ],
  });
  try { console.info(JSON.stringify({ previewUrl: preview.previewUrl, chiefId: chief.id, cloud, logPath: fixture.info.logPath })); await parkUntilSignal(); }
  finally { await preview.close(); }
} finally { await fixture.close(); await gateway.close(); }
