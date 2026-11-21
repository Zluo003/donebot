import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createTemplateRoutes, type TemplateRouteDeps } from "./templates.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function serve(auth: RequestAuth, live: () => boolean = () => true, accounts: TemplateRouteDeps["github"]["accounts"] = async () => []) {
  const connect = vi.fn(async () => { throw new Error("must not connect"); });
  const routes = [createTemplateRoutes({ accessLive: live, github: { accounts, connect } })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method!, auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { connect, call: (path: string, body?: unknown) => fetch(origin + path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) };
}

it.each(["member", "service"])("refuses %s template access before touching a connected account", async kind => {
  const auth = kind === "service" ? { kind: "loopback", scopes: ["client"], trust: "service" } : { kind: "session", scopes: ["client"], via: "cookie", session: {} };
  const accounts = vi.fn(async () => [{ id: "PRIVATE_ACCOUNT" }]);
  const { call, connect } = await serve(auth as RequestAuth, () => true, accounts);
  expect((await call("/api/templates/github/accounts")).status).toBe(403);
  expect((await call("/api/templates/github", { url: "https://github.com/fixture/private", private: true })).status).toBe(403);
  expect((await call("/api/templates/folder", { files: {} })).status).toBe(403);
  expect(accounts).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});

it("does not release account names after the session ends during discovery", async () => {
  let live = true;
  const { call } = await serve({ kind: "loopback", scopes: ["admin"] }, () => live, async () => {
    live = false;
    return [{ id: "PRIVATE_ACCOUNT", alias: "PRIVATE_ALIAS" }];
  });
  const response = await call("/api/templates/github/accounts");
  expect(response.status).toBe(403);
  expect(await response.text()).not.toMatch(/PRIVATE_ACCOUNT|PRIVATE_ALIAS/);
});

it("refuses malformed folders, arbitrary hosts and unknown identity fields", async () => {
  const { call, connect } = await serve({ kind: "loopback", scopes: ["admin"] });
  for (const body of [{ url: "https://example.invalid/repo" }, { url: "https://github.com/fixture/private", private: true, ownerId: "someone-else" }]) {
    expect((await call("/api/templates/github", body)).status).toBe(400);
  }
  expect((await call("/api/templates/folder", { files: {}, cwd: "/Users/another-person" })).status).toBe(400);
  expect((await call("/api/templates/folder", { files: { "bot.md": "not a template" } })).status).toBe(400);
  expect(connect).not.toHaveBeenCalled();
});
