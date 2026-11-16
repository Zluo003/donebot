import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseAudioRange } from "./attachments.ts";
import type { OpenedMessageFile } from "./message-file.ts";

export async function messageFileResponse(req: IncomingMessage, res: ServerResponse, file: OpenedMessageFile, headers: Record<string, string>): Promise<void> {
  try {
    const stat = await file.handle.stat({ bigint: true });
    if (res.destroyed) { await file.handle.close(); return; }
    const etag = `"${createHash("sha256").update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")).digest("hex")}"`;
    const range = parseAudioRange(!req.headers["if-range"] || req.headers["if-range"] === etag ? req.headers.range : undefined, file.bytes);
    const common = { ...headers, etag, "accept-ranges": "bytes" };
    if (range.kind === "unsatisfiable") {
      res.writeHead(416, { ...common, "content-range": `bytes */${file.bytes}`, "content-length": "0" });
      await file.handle.close();
      res.end();
      return;
    }
    const start = range.kind === "range" ? range.start : 0;
    const end = range.kind === "range" ? range.end : file.bytes - 1;
    res.writeHead(range.kind === "range" ? 206 : 200, {
      ...common, "content-length": String(Math.max(0, end - start + 1)),
      ...(range.kind === "range" ? { "content-range": `bytes ${start}-${end}/${file.bytes}` } : {}),
    });
    if (!file.bytes) { await file.handle.close(); res.end(); return; }
    const stream = file.handle.createReadStream({ start, end, autoClose: true });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  } catch (error) {
    await file.handle.close().catch(() => {});
    throw error;
  }
}
