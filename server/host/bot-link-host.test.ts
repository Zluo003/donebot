import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createBotLinkHost, type BotLinkHostDeps } from "./bot-link-host.ts";
import type { RouteContext } from "../routes/table.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); });
function fixture() {
  let personal = true, account: string | null = "account-1";
  const dataDir = mkdtempSync(join(tmpdir(), "donebot-personal-link-boundary-"));
  disposers.push(() => removeTempDir(dataDir));
  const revoke = vi.fn(), cancelDirect = vi.fn();
  const deps: BotLinkHostDeps = {
    dataDir, environmentId: "local-1", personal: () => personal, account: () => account,
    store: { bots: [], groups: [], standIns: new Map(), bot: () => null, onChange: () => () => {} } as unknown as BotLinkHostDeps["store"],
    coordinator: () => ({ cancelDirect }) as unknown as ReturnType<BotLinkHostDeps["coordinator"]>,
    kick: vi.fn(), level: () => "ask", refusal: () => null, language: () => "en", personName: () => "Fixture",
    roomLine: () => "", roomWindow: () => ({ lines: [], order: [], readable: [] }),
    sessions: { issue: vi.fn(), revoke }, local: auth => auth.kind === "loopback", owner: () => true, power: () => null,
    files: { carried: () => [], crossed: vi.fn(), sentWith: () => ({}), returnedWith: () => ({}) }, storeFile: vi.fn(), log: vi.fn(),
  };
  const make = () => { const host = createBotLinkHost(deps); disposers.push(() => host.close()); return host; };
  return { make, dataDir, revoke, set personal(value: boolean) { personal = value; }, set account(value: string | null) { account = value; } };
}

it("a persisted personal link is revoked before a shared/team workspace starts", () => {
  const f = fixture(), old = f.make();
  old.link.pair({ self: { id: "cloud-1", name: "Cloud" }, computer: { id: "mac-1", name: "Mac" }, sessionId: "old-personal-session" });
  old.close();
  f.personal = false;
  const restored = f.make(); restored.start();
  expect(restored.link.on()).toBe(false);
  expect(f.revoke).toHaveBeenCalledWith("old-personal-session");
  expect(existsSync(join(f.dataDir, "bot-link.json"))).toBe(false);
});

it.each(["/api/bot-link", "/api/bot-link/pair", "/api/bot-link/sync", "/api/bot-link/file", "/api/bot-link/bots"])("a shared/team workspace rejects %s before reading request bodies", async path => {
  const f = fixture(), host = f.make();
  f.personal = false;
  const json = vi.fn(), readBody = vi.fn(), resume = vi.fn();
  await host.routes({ path, method: "POST", url: new URL(path, "http://127.0.0.1"), auth: { kind: "loopback", scopes: ["admin", "client"] }, req: { resume }, res: {}, json, readBody } as unknown as RouteContext);
  expect(json).toHaveBeenCalledWith(expect.anything(), 403, expect.objectContaining({ error: expect.stringContaining("team or shared") }));
  expect(readBody).not.toHaveBeenCalled();
  expect(resume).toHaveBeenCalledOnce();
});

it.each([null, "account-2"])("sign-out/account switch to %s ends the computer's persisted link immediately", account => {
  const f = fixture(), host = f.make();
  host.link.turnOn({ self: { id: "mac-1", name: "Mac" }, origin: "https://cloud.example.invalid", token: "old-personal-token", account: "account-1", peer: { id: "cloud-1", name: "Cloud" } });
  f.account = account;
  host.accountChanged();
  expect(host.link.on()).toBe(false);
  expect(existsSync(join(f.dataDir, "bot-link.json"))).toBe(false);
});

it("the current account is checked again when a local enable request is admitted", async () => {
  const f = fixture(), host = f.make(), json = vi.fn();
  const readBody = async () => {
    f.account = "account-2";
    return { on: true, origin: "https://cloud.example.invalid", token: "old-personal-token", account: "account-1", name: "Mac", cloud: { id: "cloud-1", name: "Cloud" } };
  };
  await host.routes({ path: "/api/bot-link", method: "PUT", url: new URL("http://127.0.0.1/api/bot-link"), auth: { kind: "loopback", scopes: ["admin", "client"] }, req: {}, res: { setHeader: vi.fn() }, json, readBody } as unknown as RouteContext);
  expect(json).toHaveBeenCalledWith(expect.anything(), 403, expect.objectContaining({ error: expect.stringContaining("account changed") }));
  expect(host.link.on()).toBe(false);
});
