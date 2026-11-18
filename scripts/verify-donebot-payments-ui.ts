import { launchVerificationServer } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal } from "./testing/preview-fixture.ts";
import { startFakeDoneBotGateway } from "../server/testing/fake-donebot-gateway.ts";

const gateway = await startFakeDoneBotGateway();
const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin);
try {
  const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
  await api("POST", "/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-password" });
  await api("PATCH", "/api/config", { language: "zh-CN" });
  const preview = await mountPreview(fixture, {
    entry: "/scripts/testing/donebot-payments-preview.tsx", route: "/__donebot-payments.html", title: "DoneBot synthetic payments", logLevel: "error",
    extraRoutes: [
      { path: "/__fixture/payments/complete", method: "POST", handler: (_req, res) => {
        const order = gateway.payments.orders.findLast(order => order.status === "PENDING");
        if (order) gateway.payments.paid.add(Number(order.id));
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ paid: order?.id ?? null }));
      } },
      { path: "/__fixture/payments/evidence", method: "GET", handler: (_req, res) => {
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ logPath: fixture.info.logPath, orders: gateway.payments.orders,
          balance_cents: gateway.cloud.balanceCents, creates: gateway.requests.filter(request => request.path === "/api/v1/payment/orders").map(request => request.body) }));
      } },
    ],
  });
  try {
    console.info(JSON.stringify({ previewUrl: preview.previewUrl, logPath: fixture.info.logPath }));
    await parkUntilSignal();
  } finally { await preview.close(); }
} finally { await fixture.close(); await gateway.close(); }
