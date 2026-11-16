import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("serves versioned ranges for all attachment types through the original message scope", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  try {
    const { bot } = await cli("new-bot", "--name", "Range fixture");
    const folder = join(fixture.info.dataDir, "workspaces", bot.id);
    mkdirSync(folder, { recursive: true });
    const assets = ["image.png", "film.mp4", "sound.mp3", "brief.pdf"].map(name => ({ name, path: join(folder, name), bytes: Buffer.alloc(2 * 1024 * 1024 + 91, 31) }));
    for (const asset of assets) writeFileSync(asset.path, asset.bytes);
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify({ [bot.id]: {
      steps: assets.map(asset => ({ tool: "attach_file", arguments: { path: asset.path } })), reply: "Files ready.",
    } }));
    await cli("send", "--bot", bot.id, "--text", "Return the files.");
    expect((await cli("wait", "--bot", bot.id, "--timeout", "30")).status).toBe("settled");
    const { messages } = await request(`/api/threads/${bot.activeTaskId}/messages`, {}, fixture.info.url) as any;
    const attachments = messages.flatMap((message: any) => (message.attachments ?? []).map((file: any) => ({ message, file })));
    expect(attachments).toHaveLength(4);
    for (const { message, file } of attachments) {
      const asset = assets.find(asset => file.name === asset.name)!;
      const fetchFile = (headers: Record<string, string>, path = file.path) => fetch(`${fixture.info.url}/api/threads/${bot.activeTaskId}/messages/${message.id}/file`, {
        method: "POST", headers: { origin: fixture.info.url, "content-type": "application/json", ...headers }, body: JSON.stringify({ path }),
      });
      const first = await fetchFile({ range: "bytes=0-1048575" });
      expect(first.status).toBe(206);
      expect(first.headers.get("accept-ranges")).toBe("bytes");
      expect(first.headers.get("content-range")).toBe(`bytes 0-1048575/${asset.bytes.length}`);
      const tag = first.headers.get("etag")!;
      expect(tag).toMatch(/^"[a-f0-9]{64}"$/);
      expect(Buffer.from(await first.arrayBuffer())).toEqual(asset.bytes.subarray(0, 1048576));
      const next = await fetchFile({ range: "bytes=1048576-", "if-range": tag });
      expect(next.status).toBe(206); expect(next.headers.get("etag")).toBe(tag);
      expect(Buffer.from(await next.arrayBuffer())).toEqual(asset.bytes.subarray(1048576));
      const suffix = await fetchFile({ range: "bytes=-17" });
      expect(suffix.status).toBe(206); expect(Buffer.from(await suffix.arrayBuffer())).toEqual(asset.bytes.subarray(-17));
      const invalid = await fetchFile({ range: `bytes=${asset.bytes.length}-` });
      expect(invalid.status).toBe(416); expect(invalid.headers.get("content-range")).toBe(`bytes */${asset.bytes.length}`);
      await invalid.arrayBuffer();
      const denied = await fetchFile({ range: "bytes=0-10" }, join(fixture.info.dataDir, "config.json"));
      expect(denied.status).toBe(403); await denied.text();
      const replacement = Buffer.alloc(asset.bytes.length, 97);
      writeFileSync(file.path, replacement);
      const changed = await fetchFile({ range: "bytes=1048576-", "if-range": tag });
      expect(changed.status).toBe(200); expect(changed.headers.get("etag")).not.toBe(tag);
      expect(Buffer.from(await changed.arrayBuffer())).toEqual(replacement);
    }
  } finally { await fixture.close(); }
}, hostTimeout(90_000));
