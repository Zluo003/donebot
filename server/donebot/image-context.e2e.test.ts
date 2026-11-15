import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../../scripts/control-omb.ts";
import { startFakeDoneBotGateway } from "../testing/fake-donebot-gateway.ts";
import { hostTimeout } from "../testing/host-timeout.ts";

it("preserves image identity and source after automatic context compaction and reopens it through the real tool loop", async () => {
  const gateway = await startFakeDoneBotGateway();
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin);
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(fixture.info.url + path, { method, headers: { origin: fixture.info.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const value = await response.json(); expect(response.ok, JSON.stringify(value)).toBe(true); return value;
  };
  const control = (...args: string[]): Promise<any> => runControlOmb([...args, "--url", fixture.info.url]);
  try {
    await api("POST", "/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-fixture-password" });
    const { bot } = await control("new-bot", "--name", "Image context fixture");
    await api("PATCH", `/api/bots/${bot.id}`, { toolScope: { allow: ["native:attachment_list", "native:attachment_read_image"] } });
    await control("set-model", "--bot", bot.id, "--instance", "donebot", "--model", "deepseek-flash");
    await api("PATCH", "/api/config", { context: { compactAt: 1 } });
    const image = new PNG({ width: 640, height: 480 }); image.data = randomBytes(640 * 480 * 4);
    for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255;
    const original = PNG.sync.write(image), originalHash = createHash("sha256").update(original).digest("hex");
    const folder = join(fixture.info.dataDir, "attachments"); await mkdir(folder, { recursive: true });
    const path = join(folder, `${randomUUID()}.png`); await writeFile(path, original);
    const send = async (text: string) => {
      await control("send", "--bot", bot.id, "--text", text);
      expect((await control("wait", "--bot", bot.id, "--timeout", "30")).status).toBe("settled");
    };
    await send(`REFERENCE_PURPOSE image 1 is the character, retain its association.\n\n<attached-image path="${path}" name="character.png" />`);
    const requests = () => gateway.requests.filter(request => request.path === "/v1/chat/completions");
    const first = JSON.stringify(requests().at(-1)!.body);
    expect(first).toContain("data:image/jpeg;base64,");
    const id = /image-[a-f0-9]{24}/.exec(first)![0];
    await send("SECOND_EXCHANGE keep the same character");
    await send("THIRD_EXCHANGE use the same scene lighting");
    await send("FOURTH_EXCHANGE continue without reuploading");
    const messages = (await api("GET", `/api/threads/${bot.activeTaskId}/messages?limit=100`)).messages;
    expect(messages.some((message: any) => message.kind === "compaction")).toBe(true);
    expect(messages.some((message: any) => message.role === "user" && message.text?.includes(path))).toBe(true);
    expect(JSON.stringify(requests().at(-1)!.body)).toContain(id);
    expect(JSON.stringify(requests().at(-1)!.body)).toContain("REFERENCE_PURPOSE");
    gateway.setPlan([{ name: "attachment_read_image", arguments: { id } }], "Reopened the original character reference.");
    const beforeRead = requests().length;
    await send("Inspect the character reference again before continuing");
    expect(requests().length - beforeRead).toBe(2);
    const last = JSON.stringify(requests().at(-1)!.body);
    expect(last).toContain("REFERENCE_PURPOSE"); expect(last).toContain("data:image/jpeg;base64,");
    expect(createHash("sha256").update(await readFile(path)).digest("hex")).toBe(originalHash);
    expect(gateway.requests.filter(request => request.method === "POST" && ["/v1/images/generations", "/v1/videos", "/v1/music/generations"].includes(request.path))).toHaveLength(0);
    const evidence = join(process.cwd(), ".omb-scratch", "verify-evidence", "donebot-image-context"); await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, "result.json"), JSON.stringify({ isolated: true, sourceBytes: original.length, sourceHash: originalHash, attachmentId: id,
      modelMime: "image/jpeg", compacted: true, rereadRequests: requests().length - beforeRead, generationRequests: 0 }, null, 2) + "\n");
  } finally { await fixture.close(); await gateway.close(); }
}, hostTimeout(120_000));
