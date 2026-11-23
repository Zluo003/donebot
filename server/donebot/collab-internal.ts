import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { DONEBOT_COLLAB_MAX_FILE_BYTES } from "../../shared/donebot-collab.ts";
import { boundedResponseText } from "./bounded-response.ts";
import { DoneBotGatewayError, type DoneBotGateway } from "./gateway.ts";

const uuidV4 = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

const invokeFolderSchema = z.object({
  action: z.enum(["list_files", "read_file", "write_file", "edit_file", "append_file", "delete_file"]),
  path: z.string().max(2048).optional(),
  content: z.string().max(350_000).optional(),
  encoding: z.enum(["utf8", "base64"]).optional(),
  old_text: z.string().min(1).max(350_000).optional(),
  new_text: z.string().max(350_000).optional(),
  expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

const internalTransferSchema = z.discriminatedUnion("action", [
  z.object({
    folder_id: uuidV4,
    action: z.literal("download_file"),
    path: z.string().min(1).max(2048),
    save_to: z.string().min(1).max(4096),
  }).strict(),
  z.object({
    folder_id: uuidV4,
    action: z.literal("upload_file"),
    path: z.string().min(1).max(2048),
    local_path: z.string().min(1).max(4096),
  }).strict(),
]);

const internalInvokeSchema = invokeFolderSchema.extend({ folder_id: uuidV4 }).strict();

function cleanRelativeFilePath(raw: string | null): string | null {
  const value = (raw ?? "").trim().replace(/^\/+/, "");
  if (!value || value.length > 2048 || /[\\:\0]/.test(value)) return null;
  if (value.split("/").some(part => part === "..")) return null;
  return value;
}

async function readUpstreamError(response: Response, fallback: string): Promise<string> {
  try {
    const text = await boundedResponseText(response, 16_384);
    if (!text) return fallback;
    try {
      const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
      if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    } catch { /* plain text */ }
    return text.slice(0, 300);
  } catch {
    return fallback;
  }
}

async function handleInternalFileTransfer(
  gateway: DoneBotGateway,
  input: z.infer<typeof internalTransferSchema>,
): Promise<unknown> {
  const relPath = cleanRelativeFilePath(input.path);
  if (!relPath) throw new DoneBotGatewayError(400, "invalid_path", "Invalid remote relative file path.");

  if (input.action === "download_file") {
    const dest = input.save_to.trim();
    if (!dest || dest.includes("\0") || !path.isAbsolute(dest)) {
      throw new DoneBotGatewayError(400, "invalid_path", "save_to must be an absolute local file path.");
    }
    const existing = await fs.lstat(dest).catch(() => null);
    if (existing?.isSymbolicLink() || existing?.isDirectory()) {
      throw new DoneBotGatewayError(400, "invalid_path", "save_to must point to a regular file path.");
    }
    const upstream = await gateway.collabDownloadFile(input.folder_id, relPath);
    if (!upstream.ok) {
      throw new DoneBotGatewayError(upstream.status >= 400 ? upstream.status : 502, "download_failed", await readUpstreamError(upstream, "下载远程共享文件失败。"));
    }
    if (!upstream.body) throw new DoneBotGatewayError(502, "download_failed", "远程文件流为空。");
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.${randomUUID()}.part`;
    const hasher = createHash("sha256");
    let bytes = 0;
    const reader = upstream.body.getReader();
    const out = createWriteStream(tmp, { flags: "wx", mode: 0o644 });
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > DONEBOT_COLLAB_MAX_FILE_BYTES) {
          throw new DoneBotGatewayError(413, "file_too_large", "远程文件超过 100 MB 限制。");
        }
        hasher.update(next.value);
        if (!out.write(next.value)) {
          await new Promise<void>((resolve, reject) => {
            out.once("drain", resolve);
            out.once("error", reject);
          });
        }
      }
      await new Promise<void>((resolve, reject) => {
        out.once("error", reject);
        out.end(() => resolve());
      });
      await fs.rename(tmp, dest);
      return { result: { saved: true, path: dest, bytes, sha256: hasher.digest("hex") } };
    } catch (error) {
      out.destroy();
      await reader.cancel().catch(() => {});
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
  }

  const src = input.local_path.trim();
  if (!src || src.includes("\0") || !path.isAbsolute(src)) {
    throw new DoneBotGatewayError(400, "invalid_path", "local_path must be an absolute local file path.");
  }
  const stat = await fs.lstat(src).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new DoneBotGatewayError(400, "invalid_path", "local_path must be an existing regular file.");
  }
  if (stat.size > DONEBOT_COLLAB_MAX_FILE_BYTES) {
    throw new DoneBotGatewayError(413, "file_too_large", "上传文件不能超过 100 MB。");
  }
  const fileStream = Readable.toWeb(createReadStream(src)) as unknown as ReadableStream<Uint8Array>;
  const upstream = await gateway.collabUploadFile(input.folder_id, relPath, fileStream, {
    "content-type": "application/octet-stream",
    "content-length": String(stat.size),
  });
  if (!upstream.ok) {
    throw new DoneBotGatewayError(upstream.status >= 400 ? upstream.status : 502, "upload_failed", await readUpstreamError(upstream, "上传文件到远程共享文件夹失败。"));
  }
  const payload = await upstream.json() as { code?: number; data?: unknown };
  return payload?.code === 0 && "data" in payload ? payload.data : payload;
}

export async function handleDoneBotCollabInternal(
  gateway: DoneBotGateway,
  method: string,
  reqPath: string,
  res: ServerResponse,
  json: (res: ServerResponse, status: number, value: unknown) => void,
  readInternalBody: () => Promise<Record<string, unknown>>,
): Promise<boolean> {
  if (method !== "POST" || !reqPath.startsWith("/api/internal/donebot/collab/")) return false;
  try {
    if (reqPath === "/api/internal/donebot/collab/folders") {
      const snapshot = await gateway.collabFolders() as { shared_with_me?: unknown[] };
      json(res, 200, { folders: snapshot?.shared_with_me ?? [] });
      return true;
    }
    if (reqPath === "/api/internal/donebot/collab/invoke") {
      const body = await readInternalBody();
      const transferParsed = internalTransferSchema.safeParse(body);
      if (transferParsed.success) {
        const answer = await handleInternalFileTransfer(gateway, transferParsed.data);
        json(res, 200, answer);
        return true;
      }
      const parsed = internalInvokeSchema.safeParse(body);
      if (!parsed.success) {
        json(res, 400, { error: "Invalid collab_folder arguments." });
        return true;
      }
      const { folder_id, ...operation } = parsed.data;
      const answer = await gateway.collabInvokeFolder(folder_id, operation);
      json(res, 200, answer);
      return true;
    }
    json(res, 404, { error: "unknown collab endpoint" });
    return true;
  } catch (error) {
    if (error instanceof DoneBotGatewayError) {
      json(res, error.status, { error: error.message });
      return true;
    }
    json(res, 502, { error: error instanceof Error ? error.message : "远程共享文件夹调用失败。" });
    return true;
  }
}
