import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { MediaJobStore } from "./donebot/media-store.ts";
import { startFakeDoneBotGateway } from "./testing/fake-donebot-gateway.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("survives a disconnected generated-media download through the production request handler", async () => {
  const gateway = await startFakeDoneBotGateway();
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin);
  try {
    const login = await fetch(fixture.info.url + "/api/donebot/login", { method: "POST", headers: { origin: fixture.info.url, "content-type": "application/json" }, body: JSON.stringify({ email: "fixture@example.invalid", password: "synthetic-fixture-password" }) });
    expect(login.status).toBe(200);
    const { bot } = await runControlOmb(["new-bot", "--name", "Interrupted download fixture", "--url", fixture.info.url]) as { bot: { id: string; activeTaskId: string } };
    const installation = gateway.requests.find(value => value.path === "/api/v1/donebot/installations/claim")!.body.installation_id;
    const id = randomUUID(), name = `donebot-${id}-0.mp4`, bytes = 64 * 1024 * 1024;
    const directory = join(fixture.info.dataDir, "donebot", "artifacts");
    await mkdir(directory, { recursive: true });
    const path = join(directory, name), file = await open(path, "w");
    try { await file.truncate(bytes); } finally { await file.close(); }
    const store = new MediaJobStore(join(fixture.info.dataDir, "donebot", "media.sqlite"));
    try {
      store.put({ version: 1, id, operationKey: id, fingerprint: id, scope: { accountId: "fixture-user", installationId: String(installation) },
        botId: bot.id, threadId: bot.activeTaskId, turnId: id, kind: "video", operation: "generate", status: "completed",
        artifacts: [{ id: "0", path, mime: "video/mp4", name, bytes }], waitingStopped: false, createdAt: Date.now(), updatedAt: Date.now(),
        deliveredAt: Date.now(), nextPollAt: Date.now(), attempts: 0 });
    } finally { store.close(); }
    for (let n = 0; n < 2; n++) {
      await new Promise<void>((resolve, reject) => {
        const sent = request(fixture.info.url + "/api/attachments/" + name + "?token=synthetic-private-query", response => {
          if (response.statusCode !== 200) { response.resume(); reject(new Error(`download status ${response.statusCode}`)); return; }
          response.once("data", () => response.destroy());
          response.on("error", () => {});
          response.once("close", resolve);
        });
        sent.on("error", reject); sent.end();
      });
    }
    await expect.poll(async () => (await readFile(fixture.info.logPath, "utf8")).includes("HTTP response interrupted GET /api/attachments/:id"), { timeout: 5000 }).toBe(true);
    expect((await fetch(fixture.info.url + "/api/health")).status).toBe(200);
    const bots = await runControlOmb(["bots", "--url", fixture.info.url]);
    expect(JSON.stringify(bots)).toContain("Interrupted download fixture");
    const log = await readFile(fixture.info.logPath, "utf8");
    expect(log).not.toMatch(/ERR_HTTP_HEADERS_SENT|synthetic-private-query|fixture-installation-key|synthetic-fixture-password/);
    const evidence = join(process.cwd(), ".omb-scratch", "verify-evidence", "donebot-http-failure");
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, "result.json"), JSON.stringify({ passed: true, logPath: fixture.info.logPath, cancelledDownloads: 2, healthyAfterDisconnect: true, liveDataTouched: false }, null, 2) + "\n");
  } finally { await fixture.close(); await gateway.close(); }
}, hostTimeout(90_000));
