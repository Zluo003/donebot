import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
let ui: MountedPreview | undefined;
try {
  await fixtureApi(fixture.info.url)("PUT", "/api/config", { language: "en", onboarding: { completedAt: new Date().toISOString(), hintsSeen: ["donebot-chief-setup-v1"] } });
  const { bot } = await runControlOmb(["new-bot", "--name", "Attachment fixture", "--url", fixture.info.url]) as { bot: { id: string; activeTaskId: string } };
  writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify({ [bot.id]: { steps: [], reply: "Fixture files received." } }));
  ui = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__attachment-intake.html", title: "Isolated attachment intake" });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl, botId: bot.id, threadId: bot.activeTaskId }));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
