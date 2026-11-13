import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { startFakeDoneBotGateway } from "./testing/fake-donebot-gateway.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("keeps Cloud identity during a gateway outage, reports read failures and recovers models without another login", async () => {
  const installationId = randomUUID(), credential = "sk-donebot-" + randomBytes(32).toString("hex");
  const gateway = await startFakeDoneBotGateway(undefined, new Map([[credential, installationId]]));
  let offline = false;
  const proxy = createServer((req, res) => {
    if (offline) { res.destroy(); return; }
    if (req.method !== "GET") { res.writeHead(405).end(); return; }
    void fetch(gateway.origin + req.url, { headers: { authorization: String(req.headers.authorization || ""), "x-donebot-installation": String(req.headers["x-donebot-installation"] || "") } })
      .then(async response => { res.writeHead(response.status, { "content-type": "application/json" }); res.end(Buffer.from(await response.arrayBuffer())); })
      .catch(() => res.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, origin,
    { installationId, credential, user: { id: "101", email: "synthetic@example.test" } });
  const read = async (path: string) => {
    const response = await fetch(fixture.info.url + "/api/donebot/" + path, { signal: AbortSignal.timeout(15_000) });
    return { status: response.status, value: await response.json() as { authenticated?: boolean; models?: unknown[]; concurrency?: number; code?: string; error?: string } };
  };
  try {
    expect((await read("state")).value).toMatchObject({ authenticated: true, user: { id: "101" } });
    expect((await read("catalog")).value.models?.length).toBeGreaterThan(0);
    expect((await read("account")).value.concurrency).toBe(20);
    offline = true;
    for (const path of ["catalog", "account"]) {
      const result = await read(path);
      expect(result).toMatchObject({ status: 502, value: { code: "gateway_unreachable" } });
      expect(result.value.error).toContain("无法连接 DoneBot 网关");
      expect(JSON.stringify(result)).not.toContain(credential);
    }
    expect((await read("state")).value.authenticated).toBe(true);
    offline = false;
    expect((await read("catalog")).value.models?.length).toBeGreaterThan(0);
    expect((await read("account")).value.concurrency).toBe(20);
    expect(gateway.requests.every(request => request.method === "GET" && request.installation === installationId)).toBe(true);
    expect(await readFile(fixture.info.logPath, "utf8")).not.toContain(credential);
  } finally {
    await fixture.close(); proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await gateway.close();
  }
}, hostTimeout(60_000));
