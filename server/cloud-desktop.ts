import { request } from "node:http";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { tmpdir } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FILE_MAX_BYTES } from "../shared/upload-limits.ts";
import type { ContainerComputerStatus, ContainerExecResult, LocalVmTarget } from "./container-computer.ts";

export function cloudDesktopSocket(): string | null {
  const path = process.env.DONEBOT_CLOUD_DESKTOP_SOCKET;
  if (!path) return null;
  if (path !== "/run/donebot/cloud-desktop.sock" && !(process.env.NODE_ENV === "test" && /^\/tmp\/dbc-[\w/-]+\.sock$/.test(path))) {
    throw new Error("Invalid Cloud desktop socket.");
  }
  return path;
}

export function cloudDesktopTarget(target: LocalVmTarget): void {
  if (target.key !== "shared") throw Object.assign(new Error("Cloud provides one private desktop per user. Select shared Local VM mode."), { status: 409 });
}

export async function cloudDesktopCall<T>(path: string, input?: unknown): Promise<T> {
  const socketPath = cloudDesktopSocket();
  if (!socketPath) throw new Error("Cloud desktop is disabled.");
  return await new Promise<T>((resolve, reject) => {
    const req = request({ socketPath, agent: false, path, method: input === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, timeout: 330_000 }, res => {
      let bytes = 0; const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 20 * 1024 * 1024) req.destroy(new Error("Cloud desktop response too large")); else chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (!res.statusCode || res.statusCode >= 400) throw Object.assign(new Error(value.error ?? "Cloud desktop unavailable"), { status: res.statusCode ?? 502 });
          resolve(value as T);
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("Cloud desktop timeout")));
    req.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

export async function cloudDesktopStatus(target: LocalVmTarget): Promise<ContainerComputerStatus> {
  cloudDesktopTarget(target);
  const status = await cloudDesktopCall<ContainerComputerStatus>("/status");
  return { ...status, target_key: target.key, container_name: target.containerName, workspace_path: target.workspaceDir };
}

export async function cloudDesktopExec(target: LocalVmTarget, command: string, timeoutSeconds?: number): Promise<ContainerExecResult> {
  cloudDesktopTarget(target);
  return cloudDesktopCall("/exec", { command, timeout_seconds: timeoutSeconds });
}

export async function withCloudDesktopFile<T>(target: LocalVmTarget | undefined, path: string,
  save: (local?: { path: string; root: string }) => Promise<T>): Promise<T> {
  if (!target || !cloudDesktopSocket()) return save();
  path = posix.resolve("/home/cua/workspace", path.trim());
  if (!path.startsWith("/home/cua/workspace/")) return save();
  cloudDesktopTarget(target);
  const root = await mkdtemp(join(tmpdir(), "dbc-desktop-file-"));
  const local = join(root, basename(path));
  try {
    await new Promise<void>((resolve, reject) => {
      const req = request({ socketPath: cloudDesktopSocket()!, path: "/file", method: "POST", agent: false,
        headers: { "content-type": "application/json" }, timeout: 120_000 }, res => {
        if (res.statusCode !== 200) { res.resume(); reject(Object.assign(new Error("Cloud desktop file unavailable"), { status: res.statusCode ?? 502 })); return; }
        let bytes = 0;
        const limit = new Transform({ transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.length; done(bytes > FILE_MAX_BYTES ? new Error("Cloud desktop file too large") : null, chunk);
        } });
        void pipeline(res, limit, createWriteStream(local, { flags: "wx", mode: 0o600 })).then(resolve, reject);
      });
      req.on("error", reject); req.on("timeout", () => req.destroy(new Error("Cloud desktop file timeout")));
      req.end(JSON.stringify({ path }));
    });
    return await save({ path: local, root });
  } finally { await rm(root, { recursive: true, force: true }); }
}
