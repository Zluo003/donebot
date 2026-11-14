import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { startRelayManagement } from "../src/management.ts";
import { startRelay } from "../src/server.ts";
import { Close } from "../src/wire.ts";
import { Client, fakeHost, keysJson, mintToken, phoneHello, sleep, splicedPair, startTestRelay, testKey } from "./helpers.ts";

test("one host and two phone sessions use five sockets; capacity refuses only the next session", async (t) => {
  const fixture = await startTestRelay({ nodeSessionsMax: 2, nodeHostsMax: 1 });
  t.after(fixture.stop);
  const pair = await splicedPair(fixture.url, fixture.key);
  const second = await phoneHello(fixture.url, pair.host.hidText, pair.adm);
  await pair.host.acceptPhone();
  assert.equal((await second.json()).t, "ready");
  assert.deepEqual(fixture.relay.stats(), { hosts: 1, sessions: 2, sockets: 5 });
  const third = await phoneHello(fixture.url, pair.host.hidText, pair.adm);
  assert.equal(await third.closeCode(), Close.Unavailable);
  const otherHost = await Client.open(fixture.url, "/v1/host");
  otherHost.send({ t: "auth", v: 1, token: mintToken(fixture.key) });
  assert.equal(await otherHost.closeCode(), Close.Unavailable);
  pair.phone.sendBinary(Buffer.from("existing session"));
  assert.equal((await pair.data.next()).data.toString(), "existing session");
});

test("lowering policy and disabling a node preserve established encrypted transports", async (t) => {
  const fixture = await startTestRelay();
  t.after(fixture.stop);
  const pair = await splicedPair(fixture.url, fixture.key);
  fixture.relay.setPolicy({ enabled: false, maxHosts: 1, maxSessions: 1, maxSockets: 4 });
  pair.phone.sendBinary(Buffer.from("still connected"));
  assert.equal((await pair.data.next()).data.toString(), "still connected");
  const refused = await phoneHello(fixture.url, pair.host.hidText, pair.adm);
  assert.equal(await refused.closeCode(), Close.Unavailable);
  assert.equal((await fetch(fixture.url.replace("ws:", "http:") + "/healthz")).status, 503);
  fixture.relay.setPolicy({ enabled: true, maxHosts: 1, maxSessions: 1, maxSockets: 4 });
  const full = await phoneHello(fixture.url, pair.host.hidText, pair.adm);
  assert.equal(await full.closeCode(), Close.Unavailable);
});

test("DoneBot mobile origins are explicit and arbitrary browser origins remain forbidden", async (t) => {
  const key = testKey();
  const config = loadConfig({ RELAY_NODE: "relay1", RELAY_PORT: "0", RELAY_TOKEN_KEYS: keysJson(key), RELAY_MOBILE_CLIENTS: "1" });
  const relay = await startRelay(config, { log: () => {} });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  const adm = randomBytes(32);
  const host = await fakeHost(url, key, [adm]);
  const phone = await phoneHello(url, host.hidText, adm, { headers: { origin: "capacitor://localhost" } });
  await host.acceptPhone();
  assert.equal((await phone.json()).t, "ready");
  assert.equal(await Client.refusal(url, "/v1/phone", { headers: { origin: "https://localhost" } }), 101);
  for (const origin of ["https://attacker.test", "capacitor://localhost.attacker.test", "null"]) {
    assert.equal(await Client.refusal(url, "/v1/phone", { headers: { origin } }), 403);
  }
  const original = await startTestRelay();
  t.after(original.stop);
  assert.equal(await Client.refusal(original.url, "/v1/phone", { headers: { origin: "capacitor://localhost" } }), 403);
});

test("a managed relay starts closed, reports counts and applies gateway policy; stale policy stops new connections", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_700_000_000_000 });
  const key = testKey();
  const config = loadConfig({ RELAY_NODE: "relay1", RELAY_PORT: "0", RELAY_TOKEN_KEYS: keysJson(key), RELAY_NODE_TOKEN: "dbr_" + "a".repeat(43) });
  const relay = await startRelay(config, { log: () => {} });
  t.after(() => relay.close());
  const url = `http://127.0.0.1:${relay.port}/healthz`;
  assert.equal((await fetch(url)).status, 503);
  let fail = false;
  const reports: unknown[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://donebot.cn/v1/donebot/relay/nodes/relay1/heartbeat");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${config.management!.token}`);
    reports.push(JSON.parse(String(init?.body)));
    if (fail) throw new Error("synthetic outage");
    return Response.json({ code: 0, data: { enabled: true, maxHosts: 128, maxSessions: 5, maxSockets: 394 } });
  };
  const stop = startRelayManagement(relay, config, fetcher);
  t.after(stop);
  await sleep(1);
  assert.deepEqual(reports[0], { hosts: 0, sessions: 0, sockets: 0 });
  assert.equal((await fetch(url)).status, 200);
  assert.equal(relay.ctx.limits.nodeSessionsMax, 5);
  fail = true;
  t.mock.timers.tick(50_000);
  await sleep(1);
  assert.equal((await fetch(url)).status, 503);
});
