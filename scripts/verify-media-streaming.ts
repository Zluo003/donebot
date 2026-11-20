import { copyFileSync, mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
let ui: MountedPreview | undefined;
try {
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  await fixtureApi(fixture.info.url)("PUT", "/api/config", { language: "en", onboarding: { completedAt: new Date().toISOString(), hintsSeen: ["donebot-chief-setup-v1"] } });
  const { bot } = await control("new-bot", "--name", "Media fixture");
  const folder = join(fixture.info.dataDir, "workspaces", bot.id);
  mkdirSync(folder, { recursive: true });
  const film = join(folder, "large-film.mp4"), audio = join(folder, "large-audio.wav");
  copyFileSync(join(root, "docs/screenshots/composer-dock-after.mp4"), film);
  truncateSync(film, 30 * 1024 * 1024);
  const samples = 16_000 * 60 * 16;
  const wave = Buffer.alloc(44 + samples * 2);
  wave.write("RIFF", 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(16_000, 24); wave.writeUInt32LE(32_000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
  wave.write("data", 36); wave.writeUInt32LE(wave.length - 44, 40);
  writeFileSync(audio, wave);
  writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify({ [bot.id]: {
    steps: [], reply: `Isolated streaming fixture\n\n[Video](${film})\n\n[Audio](${audio})`,
  } }));
  await control("send", "--bot", bot.id, "--text", "Return the fixture media.");
  const settled = await control("wait", "--bot", bot.id, "--timeout", "30");
  ui = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__media-streaming.html", title: "Isolated media streaming" });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl, botId: bot.id, settled }));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
