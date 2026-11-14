import { describe, it, expect, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { fakeDoneBotDesktop } from "../../scripts/testing/fake-donebot-desktop.ts";
import { createDesktopRpc, desktopRelayInput } from "./desktop-rpc.ts";
import { DoneBotDesktopClient } from "./desktop-client.ts";
import { desktopFilePath, receiveDesktopFile } from "./desktop-files.ts";
import type { DoneBotGateway } from "./gateway.ts";

describe("DoneBot Cloud desktop transport", () => {
  it("submits once, correlates MCP results, exports several files and releases each temporary copy", async () => {
    const desktop = await fakeDoneBotDesktop(); vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("DONEBOT_CLOUD_DESKTOP_SOCKET", desktop.socketPath);
    const rpc = createDesktopRpc(), scope = { accountId: "fixture", installationId: randomUUID() };
    const actions: string[] = [];
    const gateway = { scope: () => scope, cloudRelay: async (_id: string, _scope: unknown, body: unknown) => {
      const input = desktopRelayInput.parse(body); actions.push(input.action); return rpc.handle(input);
    } } as unknown as DoneBotGateway;
    const client = new DoneBotDesktopClient(gateway, randomUUID(), scope);
    try {
      await client.run("ensure");
      const operation = randomUUID();
      await client.run("exec", { exec: { command: "synthetic command" } }, operation);
      await client.run("exec", { exec: { command: "synthetic command" } }, operation);
      expect(desktop.commands).toEqual(["synthetic command"]);
      await expect(client.run("exec", { exec: { command: "different command" } }, operation)).rejects.toThrow("已经被使用");
      const init = await client.run("rpc", { message: { jsonrpc: "2.0", id: 1, method: "initialize" } });
      expect(init).toMatchObject({ id: 1, result: { serverInfo: { name: "fixture-desktop" } } });
      await client.run("rpc", { message: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fixture_desktop_action", arguments: { text: "中文请求" } } } });
      expect(desktop.calls).toEqual(["中文请求"]);
      for (const length of [0, 1, 1_200_000, 7]) {
        const content = Buffer.alloc(length, 0x5a); desktop.files.set("/home/cua/workspace/fixture.bin", content);
        let temporary = "";
        await client.withFile("fixture.bin", async file => { temporary = file.root; expect(await readFile(file.path)).toEqual(content); });
        await expect(access(temporary)).rejects.toThrow();
      }
      expect(actions.filter(action => action === "release")).toHaveLength(4);
      await expect(client.withFile("missing.bin", async () => null)).rejects.toThrow();
    } finally { await client.close(); rpc.close(); await desktop.close(); vi.unstubAllEnvs(); }
  });
  it("closes immediately while remote cleanup is pending and never resubmits an unconfirmed operation", async () => {
    const scope = { accountId: "fixture", installationId: randomUUID() }, actions: string[] = [];
    let finish!: () => void;
    const gateway = { scope: () => scope, cloudRelay: async (_id: string, _scope: unknown, body: { action: string }) => {
      actions.push(body.action);
      if (body.action === "close") await new Promise<void>(resolve => { finish = resolve; });
      else throw new Error("lost submit response");
      return { ok: true };
    } } as unknown as DoneBotGateway;
    const client = new DoneBotDesktopClient(gateway, randomUUID(), scope);
    await expect(client.run("exec", { exec: { command: "external effect" } })).rejects.toThrow("lost submit");
    const closing = client.close(); expect(client.current()).toBe(false); expect(client.close()).toBe(closing);
    await expect(client.request("status")).rejects.toThrow("退出或切换");
    finish(); await closing; expect(actions).toEqual(["submit", "close"]);
  });
  it("rejects escaped paths and corrupt chunks before delivering an attachment", async () => {
    expect(() => desktopFilePath("../secret")).toThrow(); expect(() => desktopFilePath("/etc/passwd")).toThrow();
    const meta = { name: "fixture.txt", bytes: 3, sha256: createHash("sha256").update("abc").digest("hex") }, save = vi.fn();
    await expect(receiveDesktopFile(meta, async () => ({ data: Buffer.from("bad").toString("base64") }), save)).rejects.toThrow("校验失败");
    await expect(receiveDesktopFile(meta, async () => ({ data: "" }), save)).rejects.toThrow("分块无效");
    expect(save).not.toHaveBeenCalled();
  });
});
