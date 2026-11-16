import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";
import { startFakeDoneBotGateway } from "../server/testing/fake-donebot-gateway.ts";

const gateway = await startFakeDoneBotGateway();
const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true }, [], undefined, undefined, gateway.origin);
let preview: MountedPreview | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  await api("POST", "/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-fixture-password" });
  await api("PATCH", "/api/config", { language: "zh" });
  const { bot } = await control("new-bot", "--name", "产物测试员");
  await control("set-model", "--bot", bot.id, "--instance", "donebot", "--model", "deepseek-flash");
  await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "full" });
  const folder = join(fixture.info.dataDir, "workspaces", bot.id);
  mkdirSync(folder, { recursive: true });
  const paths = ["a8e65778-14ec-408c-9719-a17bf033d40e.png", "d94b59fe-bd2b-4234-a2bc-0b65483b625c.mp4", "62e6f6a6-c7b9-4e40-ae5a-104f1148db4a.mp3", "draft.md", "metrics.csv"];
  const ffmpeg = (args: string[]) => {
    const out = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
    if (out.status !== 0) throw new Error(`Fixture media creation failed: ${out.stderr || out.error}`);
  };
  ffmpeg(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=1", "-frames:v", "1", join(folder, paths[0]!)]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=10", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(folder, paths[1]!)]);
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", join(folder, paths[2]!)]);
  writeFileSync(join(folder, "draft.md"), "# Synthetic creative brief\n\nA friendly 3D cartoon donkey.\n");
  writeFileSync(join(folder, "metrics.csv"), "Asset,Count\nImage,1\nVideo,1\n");
  gateway.setModelPlan("deepseek-flash", paths.map(path => ({ name: "attach_file", arguments: { path: join(folder, path) } })), "已交付图片、视频、音频与文档。", "已交付。");
  await control("send", "--bot", bot.id, "--text", "画一个皮克斯 3D 卡通风格的驴子");
  await control("wait", "--bot", bot.id, "--timeout", "30");
  const { bots } = await api("GET", "/api/bots");
  for (const entry of bots.filter((entry: any) => entry.defaultBot)) await api("PATCH", `/api/bots/${entry.id}`, { welcomed: true });
  preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__artifacts.html", title: "Isolated DoneBot artifacts", logLevel: "warn" });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: preview.previewUrl, botId: bot.id }));
  await parkUntilSignal();
} finally { await preview?.close(); await fixture.close(); await gateway.close(); }
