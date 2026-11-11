import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { basename, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MediaArtifact, MediaKind } from "./media-store.ts";

const MIMES: Readonly<Record<string, string>> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
  "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav",
  "audio/ogg": ".ogg", "audio/opus": ".opus", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/flac": ".flac",
};

export function publicMediaAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return a !== 0 && a !== 10 && a !== 127 && !(a === 169 && b === 254) && !(a === 192 && b === 168) &&
      !(a === 172 && b! >= 16 && b! <= 31) && !(a === 100 && b! >= 64 && b! <= 127) && a! < 224 &&
      !(a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) &&
      !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) && !(a === 203 && b === 0 && c === 113);
  }
  const value = address.toLowerCase();
  return isIP(address) === 6 && /^[23]/.test(value) && !/^2001:(?:0{0,3}[0-9a-f]{1,3}:|db8:)/.test(value) && !value.startsWith("2002:");
}

/** DNS is resolved and pinned once; no credentials or redirects reach an artifact host. */
export async function publicArtifactResponse(input: string, signal: AbortSignal): Promise<Response> {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("Media artifact must use public HTTPS.");
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
  if (!addresses.length || addresses.some(address => !publicMediaAddress(address.address))) throw new Error("Media artifact host is not public.");
  const pinned = addresses[0]!;
  return new Promise((done, fail) => {
    const req = request(url, {
      method: "GET", signal, agent: false,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
        else callback(null, pinned.address, pinned.family);
      },
      headers: { accept: "image/*, video/*, audio/*" },
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        fail(new Error(`Media artifact host returned HTTP ${res.statusCode ?? 502}.`));
        return;
      }
      const headers = new Headers();
      for (const name of ["content-type", "content-length"]) {
        const value = res.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      done(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status: res.statusCode ?? 502, headers }));
    });
    req.on("error", fail);
    req.end();
  });
}

export function artifactInDirectory(path: string, directory: string): boolean {
  const root = resolve(directory);
  const file = resolve(path);
  return file.startsWith(root + sep) && basename(file) !== "";
}

export async function safeMediaArtifact(path: string, directory: string): Promise<boolean> {
  if (!artifactInDirectory(path, directory)) return false;
  try {
    const [root, file, info] = await Promise.all([realpath(directory), realpath(path), lstat(path)]);
    return info.isFile() && !info.isSymbolicLink() && artifactInDirectory(file, root);
  } catch { return false; }
}

export async function openMediaArtifact(artifact: MediaArtifact, directory: string) {
  if (!await safeMediaArtifact(artifact.path, directory)) throw new Error("Generated artifact is unavailable.");
  const canonical = await realpath(artifact.path);
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const [opened, current] = await Promise.all([handle.stat(), lstat(artifact.path)]);
    if (!await safeMediaArtifact(artifact.path, directory) || !opened.isFile() || opened.size !== artifact.bytes ||
        opened.dev !== current.dev || opened.ino !== current.ino) throw new Error("Generated artifact changed.");
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

export async function saveMediaArtifact(options: {
  directory: string; jobId: string; index: number; kind: MediaKind; response: Response; maxBytes: number;
}): Promise<MediaArtifact> {
  const { response, kind } = options;
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Media artifact download failed (HTTP ${response.status}).`);
  }
  const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const extension = MIMES[mime];
  const prefix = kind === "music" ? "audio/" : kind + "/";
  if (!extension || !mime.startsWith(prefix)) {
    await response.body.cancel();
    throw new Error("Media artifact has an unsupported content type.");
  }
  const declared = Number(response.headers.get("content-length"));
  if (declared > options.maxBytes) {
    await response.body.cancel();
    throw new Error("Media artifact exceeds the local size limit.");
  }
  const directory = join(options.directory, options.jobId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const [root, actualDirectory, directoryInfo] = await Promise.all([realpath(options.directory), realpath(directory), lstat(directory)]);
  if (directoryInfo.isSymbolicLink() || !artifactInDirectory(actualDirectory, root)) throw new Error("Media artifact directory is not private.");
  const name = `donebot-${options.jobId}-${options.index + 1}${extension}`;
  const target = join(directory, name);
  const partial = join(directory, `.${randomUUID()}.partial`);
  let bytes = 0;
  const hash = createHash("sha256");
  const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.byteLength;
    if (bytes > options.maxBytes) return callback(new Error("Media artifact exceeds the local size limit."));
    hash.update(chunk);
    callback(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), limit, createWriteStream(partial, { flags: "wx", mode: 0o600 }));
    if (!bytes || (Number.isFinite(declared) && declared > 0 && declared !== bytes)) throw new Error("Media artifact download was incomplete.");
    await rename(partial, target);
    return { id: hash.digest("hex"), path: target, mime, name, bytes: (await stat(target)).size };
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}
