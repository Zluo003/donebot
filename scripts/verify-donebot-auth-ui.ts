import { launchVerificationServer } from "./control-omb.ts";
import { mountPreview, parkUntilSignal } from "./testing/preview-fixture.ts";
import { startFakeDoneBotGateway } from "../server/testing/fake-donebot-gateway.ts";

const gateway = await startFakeDoneBotGateway();
if (process.env.DONEBOT_FIXTURE_CLOUD === "1") { gateway.cloud.enabled = true; gateway.cloud.balanceCents = 5000; }
gateway.setAuthSettings({ registration_enabled: true, email_verify_enabled: true, password_reset_enabled: true, invitation_code_enabled: true });
gateway.setAuthRequires2fa(process.env.DONEBOT_FIXTURE_2FA === "1");
const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin);
try {
  const preview = await mountPreview(fixture, { entry: "/scripts/testing/donebot-auth-preview.tsx", route: "/__donebot-auth.html", title: "DoneBot account verification", logLevel: "error" });
  try {
    console.info(JSON.stringify({ previewUrl: preview.previewUrl, logPath: fixture.info.logPath }));
    await parkUntilSignal();
  } finally { await preview.close(); }
} finally { await fixture.close(); await gateway.close(); }
