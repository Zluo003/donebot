import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { MESSAGE_MEDIA_RANGE_MAX_BYTES } from "./message-media-links.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("streams large audio and video only to their original signed-in viewer and rechecks the file on every request", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const base = fixture.info.url;
  const cli = (...args: string[]) => runControlOmb([...args, "--url", base]) as Promise<any>;
  const json = async <T,>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.ok, await response.clone().text()).toBe(true);
    return response.json() as Promise<T>;
  };
  const pair = async () => {
    const pairing = await json<{ code: string }>("/api/auth/pairing", { scopes: ["client"] });
    const response = await fetch(`${base}/api/auth/pair`, {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.30", "x-forwarded-proto": "https" },
      body: JSON.stringify({ code: pairing.code, cookie: true }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { session: { id: string } };
    return { id: body.session.id, headers: { cookie: response.headers.get("set-cookie")!.split(";", 1)[0]!, origin: base.replace(/^http:/, "https:"), "x-forwarded-for": "198.51.100.30", "x-forwarded-proto": "https" } };
  };
  try {
    const { bot } = await cli("new-bot", "--name", "Media stream fixture");
    const folder = join(fixture.info.dataDir, "workspaces", bot.id);
    mkdirSync(folder, { recursive: true });
    const size = 30 * 1024 * 1024 + 13;
    const data = Buffer.alloc(size, 29);
    data.write("HEAD", 0); data.write("TAIL", size - 4);
    const assets = ["film.mp4", "sound.mp3"].map(name => ({ name, path: join(folder, name) }));
    const document = join(folder, "brief.txt");
    writeFileSync(document, "fixture document");
    for (const asset of assets) writeFileSync(asset.path, data);
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify({ [bot.id]: {
      steps: [], reply: [...assets.map(asset => `[${asset.name}](${asset.path})`), `[brief](${document})`].join("\n"),
    } }));
    await cli("send", "--bot", bot.id, "--text", "Return the media links.");
    expect((await cli("wait", "--bot", bot.id, "--timeout", "30")).status).toBe("settled");
    const messages = await fetch(`${base}/api/threads/${bot.activeTaskId}/messages`).then(r => r.json()) as { messages: { id: string; role: string; text?: string }[] };
    const reply = messages.messages.find(message => message.role === "bot" && message.text?.includes(assets[0]!.path));
    expect(reply).toBeDefined();
    const route = `/api/threads/${bot.activeTaskId}/messages/${reply!.id}/file`;
    const a = await pair(), b = await pair();
    for (const asset of assets) {
      const issued = await fetch(`${base}${route}`, {
        method: "POST", headers: { ...a.headers, "content-type": "application/json" }, body: JSON.stringify({ path: asset.path, media: true }),
      });
      expect(issued.status).toBe(200);
      expect(issued.headers.get("x-donebot-media")).toBe("1");
      const link = await issued.json() as { url: string; bytes: number };
      expect(link.bytes).toBe(size);
      expect(link.url).not.toContain(asset.name);
      const get = (headers: Record<string, string> = {}, url = link.url) => fetch(`${base}${url}`, { headers: { ...a.headers, ...headers } });
      const first = await get({ range: "bytes=0-" });
      expect(first.status).toBe(206);
      expect(first.headers.get("content-range")).toBe(`bytes 0-${MESSAGE_MEDIA_RANGE_MAX_BYTES - 1}/${size}`);
      expect(first.headers.get("content-disposition")).toContain(`inline; filename="${asset.name}"`);
      expect(first.headers.get("cache-control")).toBe("private, no-store");
      expect(first.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(first.headers.get("referrer-policy")).toBe("no-referrer");
      expect(Buffer.from(await first.arrayBuffer()).equals(data.subarray(0, MESSAGE_MEDIA_RANGE_MAX_BYTES))).toBe(true);
      const tag = first.headers.get("etag")!;
      const tail = await get({ range: "bytes=-4", "if-range": tag });
      expect(tail.status).toBe(206); expect(await tail.text()).toBe("TAIL");
      const past = await get({ range: `bytes=${size}-` });
      expect(past.status).toBe(416); await past.arrayBuffer();
      const whole = await get();
      expect(whole.status).toBe(200); expect(whole.headers.get("content-length")).toBe(String(size));
      expect(Buffer.from(await whole.arrayBuffer()).equals(data)).toBe(true);
      for (const headers of [b.headers, {}, { "x-forwarded-for": "198.51.100.30" }]) {
        const denied = await fetch(`${base}${link.url}`, { headers });
        expect(denied.status).toBeGreaterThanOrEqual(400); await denied.text();
      }
      const wrongMessage = await get({}, link.url.replace(reply!.id, messages.messages.find(message => message.role === "user")!.id));
      expect(wrongMessage.status).toBe(404); await wrongMessage.text();
      writeFileSync(asset.path, "replacement");
      const changed = await get({ range: "bytes=4-", "if-range": tag });
      expect(changed.status).toBe(200); expect(changed.headers.get("etag")).not.toBe(tag);
      expect(await changed.text()).toBe("replacement");
      rmSync(asset.path);
      if (process.platform !== "win32") {
        symlinkSync(join(fixture.info.dataDir, "config.json"), asset.path);
        const outside = await get({ range: "bytes=0-3" });
        expect(outside.status).toBe(403); await outside.text();
        rmSync(asset.path);
      }
      const missing = await get();
      expect(missing.status).toBe(404); await missing.text();
      writeFileSync(asset.path, data);
      const revoked = await fetch(`${base}/api/auth/sessions/${a.id}`, { method: "DELETE", headers: { origin: base } });
      expect(revoked.status).toBe(200); await revoked.text();
      const ended = await get();
      expect(ended.status).toBeGreaterThanOrEqual(400); await ended.text();
      Object.assign(a, await pair());
    }
    const unsupported = await fetch(`${base}${route}`, {
      method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ path: document, media: true }),
    });
    expect(unsupported.status).toBe(415); await unsupported.text();
  } finally { await fixture.close(); }
}, hostTimeout(90_000));
