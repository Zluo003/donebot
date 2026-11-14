import { createReadStream } from "node:fs";
import { copyFile, mkdtemp, open, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import { z } from "zod";
import { FILE_MAX_BYTES } from "../../shared/upload-limits.ts";
import { withCloudDesktopFile } from "../cloud-desktop.ts";
import { SHARED_LOCAL_VM_TARGET } from "../container-computer.ts";

export interface DesktopFile { root: string; path: string; bytes: number; sha256: string; name: string }
export const desktopFileMeta = z.object({ bytes: z.number().int().min(0).max(FILE_MAX_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().regex(/^[^/\\\0]{1,255}$/).refine(value => value !== "." && value !== "..") });
const CHUNK = 512 * 1024;
export function desktopFilePath(path: string) {
  const normalized = posix.resolve("/home/cua/workspace", path.trim());
  if (!normalized.startsWith("/home/cua/workspace/") || normalized.includes("\0") || normalized.length > 8192) throw new Error("只能交付云桌面工作文件夹中的普通文件。 ");
  return normalized;
}
async function digest(path: string) {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function copyDesktopFile(path: string): Promise<DesktopFile> {
  path = desktopFilePath(path);
  const root = await mkdtemp(join(tmpdir(), "dbc-file-export-")), target = join(root, "content");
  try {
    await withCloudDesktopFile(SHARED_LOCAL_VM_TARGET, path, async local => {
      if (!local) throw new Error("云桌面文件不可用。 ");
      await copyFile(local.path, target);
    });
    const info = await stat(target); if (info.size > FILE_MAX_BYTES) throw new Error("云桌面文件过大。 ");
    return { root, path: target, bytes: info.size, sha256: await digest(target), name: basename(path) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
export async function desktopFileChunk(file: DesktopFile, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.bytes) throw new Error("无效的文件位置。 ");
  const handle = await open(file.path, "r");
  try { const buffer = Buffer.alloc(Math.min(CHUNK, file.bytes - offset)), { bytesRead } = await handle.read(buffer, 0, buffer.length, offset); return { data: buffer.subarray(0, bytesRead).toString("base64") }; }
  finally { await handle.close(); }
}
export async function receiveDesktopFile<T>(meta: z.infer<typeof desktopFileMeta>, chunk: (offset: number) => Promise<unknown>, save: (local: { path: string; root: string }) => Promise<T>) {
  meta = desktopFileMeta.parse(meta);
  const root = await mkdtemp(join(tmpdir(), "dbc-file-import-")), path = join(root, meta.name), output = await open(path, "wx", 0o600);
  try {
    const hash = createHash("sha256"); let offset = 0;
    while (offset < meta.bytes) {
      const { data } = z.object({ data: z.string().max(Math.ceil(CHUNK / 3) * 4) }).parse(await chunk(offset));
      const buffer = Buffer.from(data, "base64");
      if (!buffer.length || buffer.length > CHUNK || offset + buffer.length > meta.bytes || buffer.toString("base64") !== data) throw new Error("云桌面文件分块无效。 ");
      hash.update(buffer); offset += buffer.length;
      let written = 0;
      while (written < buffer.length) { const result = await output.write(buffer, written, buffer.length - written); if (!result.bytesWritten) throw new Error("云桌面文件写入中断。 "); written += result.bytesWritten; }
    }
    await output.close();
    if (hash.digest("hex") !== meta.sha256) throw new Error("云桌面文件校验失败。 ");
    return await save({ root, path });
  } finally { await output.close().catch(() => {}); await rm(root, { recursive: true, force: true }); }
}
