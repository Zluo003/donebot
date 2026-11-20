import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { startFakeHttpMcp } from "./testing/fake-http-mcp-server.ts";
import { startFakeOAuth } from "./testing/fake-oauth-server.ts";

it("keeps a web connection with its bot through sign-in, edits, other bots' turns and deletion", async () => {
  const oauth = await startFakeOAuth();
  const remote = await startFakeHttpMcp({ acceptBearer: oauth.isValid, wwwAuthenticate: oauth.challenge });
  const scratch = mkdtempSync(join(tmpdir(), "mcp-ownership-"));
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: join(scratch, "finish") });
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result).slice(0, 400)}`).toBe(expected);
    return result;
  };
  const stored = () => JSON.parse(readFileSync(join(fixture.info.dataDir, "mcp-oauth.json"), "utf8"));
  try {
    const iris = (await api("POST", "/api/bots", { name: "Iris" }, 201)).bot;
    const paul = (await api("POST", "/api/bots", { name: "Paul" }, 201)).bot;
    for (const [name, bot] of [["iris_notes", iris], ["paul_notes", paul]] as const) {
      await api("POST", "/api/mcp/servers", { name, url: remote.url }, 201);
      await api("PUT", `/api/mcp/servers/${name}`, { url: remote.url, bot: bot.id });
      await api("PATCH", `/api/mcp/servers/${name}`, { enabled: true });
    }
    const [a, b] = await Promise.all(["iris_notes", "paul_notes"].map((name) => api("POST", `/api/mcp/servers/${name}/sign-in`)));
    expect(new URL(a.auth.authorizationUrl).searchParams.get("redirect_uri"))
      .toBe(new URL(b.auth.authorizationUrl).searchParams.get("redirect_uri"));
    await Promise.all([a, b].map(async (started) => {
      expect((await fetch(started.auth.authorizationUrl)).status).toBe(200);
    }));
    await expect.poll(async () => (await api("GET", "/api/mcp/servers")).servers.every((s: any) => s.auth === "signed-in")).toBe(true);
    const irisToken = stored().servers.iris_notes.tokens.access;
    const paulToken = stored().servers.paul_notes.tokens.access;
    expect(irisToken).not.toBe(paulToken);
    const edited = await api("PUT", "/api/mcp/servers/iris_notes", { url: remote.url, resultBudget: 4096 });
    expect(edited.servers.find((s: any) => s.name === "iris_notes")).toMatchObject({ bot: iris.id, auth: "signed-in" });
    expect(stored().servers.iris_notes.tokens.access).toBe(irisToken);

    for (const [bot, own, other, ownToken, otherToken] of [
      [iris, "iris_notes", "paul_notes", irisToken, paulToken],
      [paul, "paul_notes", "iris_notes", paulToken, irisToken],
    ] as const) {
      rmSync(fixture.fixtureDumpPath, { force: true });
      await api("POST", `/api/bots/${bot.id}/messages`, { text: `Inspect ${own}`, threadId: bot.threadId }, 202);
      let dump: any;
      await expect.poll(() => {
        try { dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); return JSON.stringify(dump.prompt).includes(`Inspect ${own}`); }
        catch { return false; }
      }, { timeout: 20_000 }).toBe(true);
      expect(JSON.stringify(dump.mcpConfig.mcpServers[own])).toContain(ownToken);
      expect(JSON.stringify(dump.mcpConfig.mcpServers[own])).toContain(remote.url);
      expect(dump.mcpConfig.mcpServers[other]).toBeUndefined();
      expect(JSON.stringify(dump)).not.toContain(otherToken);
      const token = dump.mcpConfig.mcpServers.agents.env.DONEBOT_COMMS_TOKEN;
      const listed = await api("POST", "/api/internal/mcp-servers", { action: "list" }, 200, token);
      expect(JSON.stringify(listed)).not.toContain(other);
      const callsBefore = remote.seenHeaders.length;
      for (const action of ["test", "sign_in", "sign_out", "update", "remove", "enable", "disable", "restart"]) {
        const refused = await api("POST", "/api/internal/mcp-servers", { action, name: other, bot: bot.id, url: remote.url }, 403, token);
        expect(refused.error).toMatch(/another bot/i);
      }
      expect(remote.seenHeaders.length).toBe(callsBefore);
      await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
      await expect.poll(async () => (await api("GET", "/api/bots")).bots.every((s: any) => !s.busy), { timeout: 20_000 }).toBe(true);
      const messages = await api("GET", `/api/threads/${bot.threadId}/messages`);
      for (const secret of [irisToken, paulToken]) expect(JSON.stringify(messages)).not.toContain(secret);
    }

    const pending = await api("POST", "/api/mcp/servers/iris_notes/sign-in");
    const redirect = (await fetch(pending.auth.authorizationUrl, { redirect: "manual" })).headers.get("location")!;
    await api("DELETE", `/api/bots/${iris.id}`);
    await expect.poll(() => stored().servers.iris_notes).toBeUndefined();
    expect(stored().servers.paul_notes.tokens.access).toBe(paulToken);
    await expect(fetch(redirect)).rejects.toThrow();
    const replacement = await api("POST", "/api/mcp/servers", { name: "iris_notes", url: remote.url }, 201);
    expect(replacement.servers.find((s: any) => s.name === "iris_notes").auth).toBeUndefined();
    expect(stored().servers.iris_notes).toBeUndefined();
    for (const secret of [irisToken, paulToken]) expect(JSON.stringify(replacement)).not.toContain(secret);
  } finally {
    await fixture.close();
    await remote.close();
    await oauth.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
