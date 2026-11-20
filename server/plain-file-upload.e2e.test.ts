import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("keeps archive aliases and unknown uploads inert through retry, chat delivery and download", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const base = fixture.info.url;
  const cli = (...args: string[]) => runControlOmb([...args, "--url", base]) as Promise<any>;
  try {
    const { bot } = await cli("new-bot", "--name", "Plain file fixture");
    const specs = [
      ["project.zip", "application/x-zip-compressed", ".zip", "application/zip"],
      ["logs.tar.gz", "application/x-gzip", ".gz", "application/gzip"],
      ["photos.rar", "application/x-rar-compressed", ".rar", "application/vnd.rar"],
      ["page.html", "text/html", ".bin", "application/octet-stream"],
      ["logo.svg", "image/svg+xml", ".bin", "application/octet-stream"],
      ["tool.exe", "application/x-msdownload", ".bin", "application/octet-stream"],
    ];
    const saved: { path: string; name: string; mime: string; bytes: number; content: Buffer; extension: string }[] = [];
    for (const [name, mime, extension, downloadMime] of specs) {
      const content = Buffer.from(`<script>throw new Error("inert fixture: ${name}")</script>`);
      const url = `${base}/api/files?name=${name}&uploadId=${randomUUID()}`;
      const upload = (body: Uint8Array = content) => fetch(url, { method: "POST", headers: { "content-type": mime! }, body });
      const response = await upload();
      expect(response.status).toBe(201);
      const file = await response.json() as Omit<(typeof saved)[number], "content" | "extension">;
      expect(file).toMatchObject({ name, mime: extension === ".bin" ? "application/octet-stream" : mime, bytes: content.byteLength });
      expect(file.path.endsWith(extension!)).toBe(true);
      const retried = await upload();
      expect(retried.status).toBe(201); expect(await retried.json()).toEqual(file);
      const conflict = await upload(Buffer.from("different"));
      expect(conflict.status).toBe(409); await conflict.text();
      const unbound = await fetch(`${base}/api/attachments/${basename(file.path)}`);
      expect(unbound.status).toBe(404); await unbound.text();
      saved.push({ ...file, mime: downloadMime!, content, extension: extension! });
    }
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify({ [bot.id]: {
      steps: [], reply: saved.map(file => `[${file.name}](${file.path})`).join("\n"),
    } }));
    await cli("send", "--bot", bot.id, "--text", `Return these files.\n${saved.map(file => `<attached-file path="${file.path}" name="${file.name}" />`).join("\n")}`);
    expect((await cli("wait", "--bot", bot.id, "--timeout", "30")).status).toBe("settled");
    const { messages } = await fetch(`${base}/api/threads/${bot.activeTaskId}/messages`).then(r => r.json()) as { messages: { id: string; role: string; text?: string }[] };
    const reply = messages.find(message => message.role === "bot" && message.text?.includes(saved[0]!.path));
    expect(reply).toBeDefined();
    for (const file of saved) {
      const route = `${base}/api/threads/${bot.activeTaskId}/messages/${reply!.id}/file`;
      const read = (body: unknown) => fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const downloaded = await read({ path: file.path });
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get("content-type")).toBe(file.mime);
      expect(downloaded.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await downloaded.arrayBuffer()).equals(file.content)).toBe(true);
      const inline = await fetch(`${route}?preview=1&path=${encodeURIComponent(file.path)}`);
      expect(inline.status).toBe(415); await inline.text();
      const media = await read({ path: file.path, media: true });
      expect(media.status).toBe(415); await media.text();
    }
  } finally { await fixture.close(); }
}, hostTimeout(60_000));
