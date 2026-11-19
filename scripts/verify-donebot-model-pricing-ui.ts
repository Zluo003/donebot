import { launchVerificationServer } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal } from "./testing/preview-fixture.ts";
import { startFakeDoneBotGateway } from "../server/testing/fake-donebot-gateway.ts";
import { MODEL_PRICING_CATALOG } from "./testing/donebot-model-pricing-fixture.ts";

const gateway = await startFakeDoneBotGateway(MODEL_PRICING_CATALOG);
const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin);
try {
  const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
  await api("POST", "/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-password" });
  await api("PATCH", "/api/config", { language: "zh-CN" });
  const preview = await mountPreview(fixture, {
    entry: "/scripts/testing/donebot-model-pricing-preview.tsx", route: "/__donebot-model-pricing.html", title: "DoneBot synthetic model prices", logLevel: "error",
    extraRoutes: [{ path: "/__fixture/model-pricing/evidence", method: "GET", handler: (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ logPath: fixture.info.logPath, catalog: MODEL_PRICING_CATALOG,
        catalogReads: gateway.requests.filter(request => request.path === "/api/v1/donebot/models").length }));
    } }],
  });
  try {
    console.info(JSON.stringify({ previewUrl: preview.previewUrl, logPath: fixture.info.logPath }));
    await parkUntilSignal();
  } finally { await preview.close(); }
} finally { await fixture.close(); await gateway.close(); }
