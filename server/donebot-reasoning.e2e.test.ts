import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { startFakeDoneBotGateway } from "./testing/fake-donebot-gateway.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("persists only the DeepSeek answer and keeps reasoning out of the next turn's conversation", async () => {
  const gateway = await startFakeDoneBotGateway();
  try {
    const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin);
    try {
      const api = async (method: string, path: string, body?: unknown) => {
        const response = await fetch(fixture.info.url + path, { method,
          headers: { origin: fixture.info.url, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
        });
        const result = await response.json() as Record<string, any>;
        expect(response.ok, JSON.stringify(result)).toBe(true);
        return result;
      };
      const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
      await api("POST", "/api/donebot/login", { email: "fixture@example.invalid", password: "synthetic-fixture-password" });
      const { bot } = await control("new-bot", "--name", "Reasoning fixture");
      await api("PATCH", `/api/bots/${bot.id}`, { cwd: fixture.info.dataDir, approvalMode: "full", toolScope: { allow: ["native:workspace_write"] } });
      await control("set-model", "--bot", bot.id, "--instance", "donebot", "--model", "deepseek-flash");
      const initial = new Set((await api("GET", `/api/threads/${bot.activeTaskId}/messages?limit=100`)).messages.map((message: any) => message.id));
      const messages = async () => (await api("GET", `/api/threads/${bot.activeTaskId}/messages?limit=100`)).messages.filter((message: any) => !initial.has(message.id)) as Array<Record<string, any>>;
      const answer = "Synthetic receipt written.";
      gateway.setPlan([{ name: "workspace_write", arguments: { path: "reasoning-receipt.txt", text: "written once" } }], `<thinking>Synthetic private thought.</thinking>${answer}`);
      await control("send", "--bot", bot.id, "--text", "Write the synthetic receipt once.");
      expect((await control("wait", "--bot", bot.id, "--timeout", "30")).status).toBe("settled");
      expect(await readFile(join(fixture.info.dataDir, "reasoning-receipt.txt"), "utf8")).toBe("written once");
      const first = await messages();
      expect(first.filter(message => message.role === "bot" && message.kind === "text").map(message => message.text)).toEqual([answer]);
      expect(first.filter(message => message.tool?.name === "workspace_write" && message.tool?.ok)).toHaveLength(1);
      expect(JSON.stringify(first)).not.toMatch(/<thinking>|Synthetic private thought/);
      const calls = gateway.requests.filter(request => request.path === "/v1/chat/completions");
      expect(calls).toHaveLength(2);
      gateway.setPlan([], "Synthetic followup complete.");
      await control("send", "--bot", bot.id, "--text", "Acknowledge the receipt.");
      expect((await control("wait", "--bot", bot.id, "--timeout", "30")).status).toBe("settled");
      const followup = gateway.requests.filter(request => request.path === "/v1/chat/completions").at(-1)!;
      expect(followup.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", content: answer })]));
      expect(JSON.stringify(followup.body.messages)).not.toMatch(/<thinking>|Synthetic private thought/);
      const final = await messages();
      expect(final.filter(message => message.role === "bot" && message.kind === "text").map(message => message.text)).toEqual([answer, "Synthetic followup complete."]);
      const out = join(process.cwd(), ".omb-scratch/verify-evidence/donebot-reasoning");
      await mkdir(out, { recursive: true });
      await writeFile(join(out, "result.json"), JSON.stringify({ fixture: fixture.info, gateway: gateway.origin, messages: final,
        chatRequests: gateway.requests.filter(request => request.path === "/v1/chat/completions").length,
        checks: ["one successful workspace write", "answer-only persisted bubbles", "next-turn history contains answer only"],
      }, null, 2));
    } finally { await fixture.close(); }
  } finally { await gateway.close(); }
}, hostTimeout(120_000));
