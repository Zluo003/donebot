import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { startFakeDoneBotGateway } from "./testing/fake-donebot-gateway.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { waitForExit } from "./testing/cleanup.ts";

const mediaCases = [
  ...(["completed", "failed", "stopped", "restarted"] as const).map(scenario => ({ kind: "image", scenario, mime: "image/png", path: "/v1/images/generations", parameters: { prompt: "Synthetic coordination illustration" } })),
  ...(["completed", "restarted"] as const).map(scenario => ({ kind: "video", scenario, mime: "video/mp4", path: "/v1/videos", parameters: { content: [{ type: "text", text: "Synthetic video" }], resolution: "720p", duration: 5 } })),
  ...(["completed", "restarted"] as const).map(scenario => ({ kind: "audio", scenario, mime: "audio/mpeg", path: "/v1/music/generations", parameters: { style: "Synthetic instrumental piano", instrumental: true } })),
];

it.each(mediaCases)("returns asynchronous $kind $scenario through the generating bot to its coordinator", async ({ kind, scenario, mime, path, parameters }) => {
  const outcome = scenario === "restarted" ? "completed" : scenario;
  const gateway = await startFakeDoneBotGateway();
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true }, [], undefined, undefined, gateway.origin);
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(fixture.info.url + path, { method, headers: { origin: fixture.info.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const value = await response.json();
    expect(response.status, JSON.stringify(value)).toBeLessThan(300);
    return value;
  };
  const control = (...args: string[]): Promise<any> => runControlOmb([...args, "--url", fixture.info.url]);
  try {
    await api("POST", "/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-fixture-password" });
    const { bot: chief } = await control("new-bot", "--name", "多宝");
    const { bot: artist } = await control("new-bot", "--name", "画布");
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, approvalMode: "full" });
    await api("PATCH", `/api/bots/${artist.id}`, { approvalMode: "full", toolScope: { allow: [`mcp:agents:generate_${kind}`, "mcp:agents:attach_file"] } });
    await control("set-model", "--bot", artist.id, "--instance", "donebot", "--model", "deepseek-flash");
    await control("set-model", "--bot", chief.id, "--instance", "donebot", "--model", "gpt-6.1-sol");
    gateway.setModelPlan("gpt-6.1-sol", [{ name: "coordinate_bots", arguments: { bot_ids: [artist.id], message: "Create an illustration and return the actual result." } }],
      "Assigned illustration; awaiting the real result.", "The artist returned its actual media result.");
    gateway.setMediaStatus("processing");
    gateway.setPlan([{ name: `generate_${kind}`, arguments: { parameters } }], "The image is submitted, not completed.");
    await control("send", "--bot", chief.id, "--text", "让画布生成一张配图，等结果后再向我汇报。");
    const nodes = () => readHandoffs(fixture.info.dataDir);
    const artistNode = () => nodes().find(node => node.botId === artist.id);
    await expect.poll(() => artistNode()?.continuation?.mediaJobIds?.length, { timeout: 20_000 }).toBe(1);
    const node = artistNode()!;
    if (outcome === "completed") {
      const jobId = node.continuation!.mediaJobIds![0]!;
      const extension = kind === "image" ? "png" : kind === "video" ? "mp4" : "mp3";
      gateway.setReceiptPlan("completed", [{ name: "attach_file", arguments: { path: join(fixture.info.dataDir, "donebot", "artifacts", jobId, `donebot-${jobId}-1.${extension}`) } }]);
    }
    expect(node).toMatchObject({ status: "queued", reported: false });
    expect(nodes().find(one => one.botId === chief.id)).toMatchObject({ status: "waiting" });
    const llmRequests = () => gateway.requests.filter(request => request.path === "/v1/chat/completions");
    const before = llmRequests().length;
    const mediaPosts = () => gateway.requests.filter(request => request.method === "POST" && request.path === path);
    await expect.poll(() => mediaPosts().length, { timeout: 10_000 }).toBe(1);
    if (scenario === "restarted") {
      await waitForExit(fixture.child, { signal: "SIGTERM" });
      const { url, dataDir, logPath } = fixture.info;
      const log = openSync(logPath, "a", 0o600);
      restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", log, log],
        env: { ...verificationServerEnvironment(process.env, dataDir, Number(new URL(url).port)), DONEBOT_UPSTREAM_FIXTURE: "0", DONEBOT_FIXTURE_ORIGIN: gateway.origin },
      });
      closeSync(log);
      await expect.poll(async () => {
        if (restarted?.exitCode !== null) throw new Error(readFileSync(logPath, "utf8"));
        return fetch(url + "/api/health").then(response => response.ok).catch(() => false);
      }, { timeout: 15_000 }).toBe(true);
      expect(artistNode()?.continuation?.mediaJobIds).toEqual(node.continuation!.mediaJobIds);
      expect(llmRequests()).toHaveLength(before);
      await api("POST", "/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-fixture-password" });
    }
    if (outcome === "stopped") {
      await control("interrupt", "--bot", chief.id);
      gateway.setMediaStatus("completed");
      await expect.poll(async () => (await api("GET", `/api/threads/${node.threadId}/messages`)).messages.some((message: any) => message.attachments?.length), { timeout: 20_000 }).toBe(true);
      expect(nodes().find(one => one.botId === chief.id)?.status).toBe("cancelled");
      expect(llmRequests()).toHaveLength(before);
    } else {
      gateway.setMediaStatus(outcome);
      expect((await control("wait", "--bot", chief.id, "--timeout", "30")).status).toBe("settled");
      expect(artistNode()).toMatchObject({ status: "completed", executions: 2, reported: true, result: expect.stringContaining(`Synthetic media ${outcome} receipt acknowledged.`) });
      expect(llmRequests()).toHaveLength(before + (outcome === "completed" ? 2 : 1));
      const receiptPrompt = JSON.stringify(llmRequests().at(-1)!.body);
      expect(receiptPrompt).toContain("[DoneBot media receipt: terminal]");
      expect(receiptPrompt).toContain(node.continuation!.mediaJobIds![0]);
      if (outcome === "completed") expect(receiptPrompt).toContain(mime);
      const chiefRequests = gateway.requests.filter(request => request.path === "/v1/responses");
      expect(chiefRequests).toHaveLength(3);
      expect(JSON.stringify(chiefRequests.at(-1)!.body)).toContain(`Synthetic media ${outcome} receipt acknowledged.`);
      if (outcome === "completed") {
        expect(JSON.stringify(chiefRequests.at(-1)!.body)).toContain("DoneBot returned attachments");
        expect(JSON.stringify(chiefRequests.at(-1)!.body)).toContain(mime);
      }
      if (outcome === "completed") {
        const destinations = (await api("GET", `/api/threads/${chief.activeTaskId}/messages`)).messages
          .filter((message: any) => message.attachments?.length);
        expect(destinations).toHaveLength(1);
        const sources = (await api("GET", `/api/threads/${node.threadId}/messages`)).messages
          .filter((message: any) => message.attachments?.length);
        expect(sources).toHaveLength(1);
        const producerMessages = (await api("GET", `/api/threads/${node.threadId}/messages`)).messages;
        expect(producerMessages.some((message: any) => message.tool?.ok === false)).toBe(false);
        expect(producerMessages.find((message: any) => message.tool?.name === "agents_attach_file")?.tool.output).toContain("Already attached");
        const download = async (threadId: string, message: any) => {
          const file = message.attachments[0];
          expect(file.mime).toBe(mime);
          const response = await fetch(`${fixture.info.url}/api/threads/${threadId}/messages/${message.id}/file`, {
            method: "POST", headers: { origin: fixture.info.url, "content-type": "application/json" }, body: JSON.stringify({ path: file.path }),
          });
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe(mime);
          return Buffer.from(await response.arrayBuffer());
        };
        const original = await download(node.threadId, sources[0]);
        expect(original.length).toBeGreaterThan(0);
        expect(await download(chief.activeTaskId, destinations[0])).toEqual(original);
      }
    }
    expect(mediaPosts()).toHaveLength(1);
  } finally { await waitForExit(restarted, { signal: "SIGTERM" }); await fixture.close(); await gateway.close(); }
}, hostTimeout(90_000));
