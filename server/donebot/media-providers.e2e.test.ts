import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../../scripts/control-omb.ts";
import { startFakeDoneBotGateway } from "../testing/fake-donebot-gateway.ts";
import { startFakeHttpMcp } from "../testing/fake-http-mcp-server.ts";
import { hostTimeout } from "../testing/host-timeout.ts";

it("keeps media CLI/MCP available with gateway-only LLM access and saves media defaults through the existing profile tool", async () => {
  const gateway = await startFakeDoneBotGateway();
  const studio = await startFakeHttpMcp({
    tools: [{ name: "generate_image", description: "Generate an offline fixture image", inputSchema: {
      type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"], additionalProperties: false,
    } }],
    callError: params => (params as { arguments?: { prompt?: string } }).arguments?.prompt === "fail"
      ? { code: -32000, message: "Synthetic external provider is unavailable" } : undefined,
  });
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin);
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
    const { bot } = await control("new-bot", "--name", "External media fixture");
    const cwd = join(fixture.info.dataDir, "external-media-fixture");
    await mkdir(cwd);
    const initialSoul = "Keep responses concise.";
    await api("PATCH", `/api/bots/${bot.id}`, { cwd, soul: initialSoul, approvalMode: "full", toolScope: { allow: [
      "native:workspace_run", "mcp:agents:generate_image", "mcp:agents:propose_profile", "mcp:studio:generate_image",
    ] } });
    await control("set-model", "--bot", bot.id, "--instance", "donebot", "--model", "deepseek-flash");
    const preference = `${initialSoul}\nDefault image generation to the installed fixture-media.mjs CLI. Keep video and music on the DoneBot gateway. An explicit provider for one request overrides this preference without changing it.`;
    gateway.setPlan([{ name: "propose_profile", arguments: { soul: preference, reason: "The user requested a default image provider" } }]);
    await control("send", "--bot", bot.id, "--text", "以后图片默认使用已安装的 fixture-media.mjs CLI；视频、音乐保留 DoneBot。");
    expect((await control("wait", "--bot", bot.id, "--timeout", "30")).status).toBe("settled");
    const savedBot = () => api("GET", "/api/bots?messages=0").then(result => result.bots.find((entry: any) => entry.id === bot.id));
    expect((await savedBot()).soul).toBe(preference);

    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2Cj8AAAAASUVORK5CYII=";
    await writeFile(join(cwd, "fixture-media.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync("cli-image.png", Buffer.from(${JSON.stringify(png)}, "base64")); console.log("Created cli-image.png");\n`);
    const { task } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Saved media default", select: false });
    const turn = async (text: string, expected = "settled") => {
      await control("send", "--bot", bot.id, "--task", task.threadId, "--text", text);
      expect((await control("wait", "--bot", bot.id, "--task", task.threadId, "--timeout", "30")).status).toBe(expected);
    };
    gateway.setPlan([{ name: "workspace_run", arguments: { executable: process.execPath, args: ["fixture-media.mjs"] } }]);
    const requestOffset = gateway.requests.length;
    await turn("按我保存的默认渠道画一张图片。");
    expect(await readFile(join(cwd, "cli-image.png"))).toEqual(Buffer.from(png, "base64"));
    const cliRequest = gateway.requests.slice(requestOffset).find(request => request.path === "/v1/chat/completions")!;
    expect((cliRequest.body.messages as { content: unknown }[]).some(message => typeof message.content === "string" && message.content.includes(preference))).toBe(true);
    expect(JSON.stringify(cliRequest.body.messages)).toContain("LLM access must");

    await api("POST", "/api/mcp/servers", { name: "studio", type: "http", url: studio.url });
    await api("PATCH", "/api/mcp/servers/studio", { enabled: true });
    await api("PATCH", `/api/bots/${bot.id}`, { mcpServers: ["studio"] });
    gateway.setPlan([{ name: "studio_generate_image", arguments: { prompt: "Synthetic tiger" } }]);
    await turn("这一次使用 studio MCP 画老虎，不更改默认渠道。");
    expect(studio.calls).toContainEqual({ name: "generate_image", arguments: { prompt: "Synthetic tiger" } });
    expect((await savedBot()).soul).toBe(preference);
    gateway.setPlan([{ name: "studio_generate_image", arguments: { prompt: "fail" } }], "The selected external provider is unavailable; no other generation was submitted.");
    await turn("这一次仍使用 studio MCP，故障时不要切换渠道。", "failed");
    const messages = (await api("GET", `/api/threads/${task.threadId}/messages?limit=100`)).messages;
    expect(messages.some((message: any) => message.tool?.name?.includes("studio") && message.tool?.ok === false)).toBe(true);
    expect(gateway.requests.filter(request => request.method === "POST" && ["/v1/images/generations", "/v1/videos", "/v1/music/generations"].includes(request.path))).toEqual([]);
    expect((await savedBot()).soul).toBe(preference);
    const evidenceDir = join(process.cwd(), ".omb-scratch", "verify-evidence", "donebot-media-providers");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, "result.json"), JSON.stringify({ fixture: fixture.info, cliFile: "cli-image.png", savedPreference: preference,
      mcpCalls: studio.calls, gatewayGenerationRequests: 0, llmEndpoint: "/v1/chat/completions", scriptedLlm: true }, null, 2) + "\n");
  } finally {
    await fixture.close();
    await studio.close();
    await gateway.close();
  }
}, hostTimeout(90_000));
