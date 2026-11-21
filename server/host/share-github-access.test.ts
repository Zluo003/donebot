import { expect, it, vi } from "vitest";
import type { AppConfig } from "../config.ts";
import { createShareGithubAccess } from "./share-github-access.ts";

function setup() {
  const cfg = { composio: { apiKey: "fixture-project", userId: "fixture-user" } } as AppConfig;
  const state = { refusal: null as string | null, complete: true, account: "ca_first", token: "a".repeat(64) };
  const connectedServicesInventory = vi.fn(async () => ({ complete: state.complete, services: { github: {
    connected: true, pending: false, status: "ACTIVE", accounts: [{ id: state.account, alias: "work", status: "ACTIVE" }],
  } } }));
  const relayMcp = vi.fn(async (_cfg: AppConfig, _payload: unknown, _session?: string, beforeSend?: () => void) => {
    beforeSend?.();
    return { status: 200, bytes: new Uint8Array(), contentType: "application/json" };
  });
  const host = createShareGithubAccess({ cfg: () => cfg, refusal: () => state.refusal, composio: {
    configured: () => true, connectedServicesInventory, relayMcp,
    brokerAccess: () => ({ url: "http://127.0.0.1:1234", token: state.token }),
  } });
  return { cfg, state, host, connectedServicesInventory, relayMcp };
}

it("requires a complete inventory and never selects a foreign account", async () => {
  const { host, state, relayMcp } = setup();
  await expect(host.connect("ca_foreign")).rejects.toThrow("Choose an active");
  state.complete = false;
  await expect(host.accounts()).rejects.toThrow("incomplete");
  expect(relayMcp).not.toHaveBeenCalled();
});

it("pins the account and rechecks its connection on every call", async () => {
  const { host, state, relayMcp } = setup();
  const connection = await host.connect();
  expect(connection.account).toBe("ca_first");
  await connection.relay({}, undefined, AbortSignal.timeout(1_000));
  state.account = "ca_replacement";
  await expect(connection.relay({}, undefined, AbortSignal.timeout(1_000))).rejects.toThrow("no longer connected");
  expect(relayMcp).toHaveBeenCalledOnce();
});

it.each(["policy", "project", "broker", "session"])("refuses a %s change before dispatch", async mode => {
  const { host, cfg, state, relayMcp } = setup();
  let live = true;
  const connection = await host.connect(undefined, () => { if (!live) throw new Error("session ended"); });
  if (mode === "policy") state.refusal = "disabled";
  if (mode === "project") cfg.composio!.userId = "replacement-user";
  if (mode === "broker") state.token = "b".repeat(64);
  if (mode === "session") live = false;
  await expect(connection.relay({}, undefined, AbortSignal.timeout(1_000))).rejects.toThrow();
  expect(relayMcp).not.toHaveBeenCalled();
});

it("rechecks policy after inventory waits and before releasing a response", async () => {
  const first = setup();
  const connection = await first.host.connect();
  first.connectedServicesInventory.mockImplementationOnce(async () => {
    first.state.refusal = "disabled during inventory";
    return { complete: true, services: { github: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "ca_first", alias: "work", status: "ACTIVE" }] } } };
  });
  await expect(connection.relay({}, undefined, AbortSignal.timeout(1_000))).rejects.toThrow("cannot use");
  expect(first.relayMcp).not.toHaveBeenCalled();
  const second = setup();
  const later = await second.host.connect();
  second.relayMcp.mockImplementationOnce(async () => {
    second.state.refusal = "disabled while reading";
    return { status: 200, bytes: new TextEncoder().encode("PRIVATE_TEMPLATE"), contentType: "application/json" };
  });
  await expect(later.relay({}, undefined, AbortSignal.timeout(1_000))).rejects.toThrow("cannot use");
});

it("discards private content when the account is revoked while it is being read", async () => {
  const { host, state, relayMcp } = setup();
  const connection = await host.connect();
  relayMcp.mockImplementationOnce(async () => {
    state.account = "ca_different";
    return { status: 200, bytes: new TextEncoder().encode("PRIVATE_CONTENT"), contentType: "application/json" };
  });
  await expect(connection.relay({}, undefined, AbortSignal.timeout(1_000))).rejects.toThrow("no longer connected");
});
