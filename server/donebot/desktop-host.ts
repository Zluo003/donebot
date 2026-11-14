import { z } from "zod";
import type { DoneBotGateway } from "./gateway.ts";
import { DoneBotDesktopClient } from "./desktop-client.ts";
import { createDesktopRpc, desktopRelayInput } from "./desktop-rpc.ts";
import { cloudDesktopCall, cloudDesktopSocket } from "../cloud-desktop.ts";
import { containerComputerMcp } from "../container-computer.ts";
import { withCloudDesktopFile } from "../cloud-desktop.ts";
import { SHARED_LOCAL_VM_TARGET } from "../container-computer.ts";
import { desktopFilePath } from "./desktop-files.ts";
import { doneBotDesktopViewer } from "./desktop-viewer.ts";
import { localDesktopTarget } from "../desktop-viewer-targets.ts";
import type { ContainerComputerStatus } from "../container-computer.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";

interface Owner { threadId: string; generation: string }
export function createDoneBotDesktopHost(gateway: DoneBotGateway) {
  const rpc = createDesktopRpc(), mounts = new Map<string, { generation: string; close(): void; client?: DoneBotDesktopClient }>();
  const remoteViewer = doneBotDesktopViewer(gateway, async () => {
    const scope = gateway.scope(), snapshot = await gateway.cloudSnapshot();
    if (!scope || snapshot.instance?.actual !== "running") throw new Error("Cloud unavailable");
    return { scope, instance: snapshot.instance.id };
  });
  const mountedFor = (owner: Owner) => { const mounted = mounts.get(owner.threadId); return mounted?.generation === owner.generation ? mounted : undefined; };
  const client = async () => {
    const scope = gateway.scope(); if (!scope) throw new Error("请先登录 DoneBot。 ");
    const snapshot = await gateway.cloudSnapshot(), instance = snapshot.instance;
    if (!instance || instance.actual !== "running" || instance.desired !== "running") throw new Error("请先在 Cloud 服务中启动自己的实例。 ");
    return new DoneBotDesktopClient(gateway, instance.id, scope);
  };
  const status = async () => {
    if (cloudDesktopSocket()) return cloudDesktopCall("/status");
    const remote = await client(); try { return await remote.request("status"); } finally { await remote.close(); }
  };
  const release = (owner: Owner) => {
    const mounted = mounts.get(owner.threadId);
    if (mounted?.generation === owner.generation) { mounts.delete(owner.threadId); mounted.close(); }
  };
  const route: RouteHandler = async ({ path, method, auth, req, res, json, readBody }) => {
    if (!["/api/donebot/desktop", "/api/donebot/desktop/frame", "/api/donebot/relay/v1/desktop"].includes(path)) return PASS;
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "只有工作空间所有者可以使用此云桌面。" });
    res.setHeader("Cache-Control", "no-store");
    try {
      if (path === "/api/donebot/relay/v1/desktop") {
        if (!cloudDesktopSocket() || method !== "POST") return json(res, 404, { error: "Cloud desktop relay unavailable" });
        const input = desktopRelayInput.parse(await readBody(req, 8 * 1024 * 1024));
        if (!gateway.scope() || input.accountId !== gateway.scope()!.accountId) return json(res, 403, { error: "Cloud account mismatch" });
        return json(res, 200, await rpc.handle(input));
      }
      if (path === "/api/donebot/desktop" && method === "GET") return json(res, 200, await status());
      if (path === "/api/donebot/desktop/frame" && method === "GET") {
        if (cloudDesktopSocket()) return json(res, 200, await cloudDesktopCall("/frame"));
        const remote = await client(); try { return json(res, 200, await remote.run("frame")); } finally { await remote.close(); }
      }
      if (path !== "/api/donebot/desktop" || method !== "POST") return json(res, 405, { error: "Method unavailable" });
      const { action } = z.object({ action: z.enum(["start", "stop"]) }).strict().parse(await readBody(req, 1024));
      if (cloudDesktopSocket()) await cloudDesktopCall("/action", { action: action === "start" ? "run" : "stop" });
      else { const remote = await client(); try { await remote.run(action === "start" ? "ensure" : "stop"); } finally { await remote.close(); } }
      return json(res, 200, await status());
    } catch (error) { return json(res, error instanceof z.ZodError ? 400 : 409, { error: error instanceof Error ? error.message : "Cloud 桌面暂不可用。" }); }
  };
  return { route, status, release,
    async selection(supportsComputer: boolean) {
      if (!supportsComputer) return { ready: false, canStart: false, reason: "此模型不支持云桌面工具。" };
      const current = await status() as { ready: boolean; control?: { review_required: boolean } };
      return { ready: current.ready && !current.control?.review_required, canStart: !current.ready && !current.control?.review_required,
        reason: current.control?.review_required ? "云桌面有中断操作，请核对后停止桌面再启动。" : "请先启动 DoneBot 云桌面。" };
    },
    viewer: () => cloudDesktopSocket() ? localDesktopTarget(SHARED_LOCAL_VM_TARGET, { status: () => cloudDesktopCall<ContainerComputerStatus>("/status"), touch() {} })
      : remoteViewer,
    has: (owner: Owner) => Boolean(mountedFor(owner)),
    async exec(owner: Owner, command: string, timeout_seconds?: number) {
      const mounted = mountedFor(owner); if (!mounted) throw new Error("此任务未持有云桌面。 ");
      const input = { command, timeout_seconds };
      return mounted.client ? mounted.client.run("exec", { exec: input }) : cloudDesktopCall("/exec", input);
    },
    async withFile<T>(owner: Owner, path: string, save: (local?: { root: string; path: string }) => Promise<T>): Promise<T> {
      const mounted = mountedFor(owner); if (!mounted) return save();
      if (path.startsWith("/") && !path.startsWith("/home/cua/workspace/")) return save();
      path = desktopFilePath(path);
      return mounted.client ? mounted.client.withFile(path, save) : withCloudDesktopFile(SHARED_LOCAL_VM_TARGET, path, save);
    },
    async mount(owner: Owner, control: { url: string; token: string }, active: () => boolean) {
      mounts.get(owner.threadId)?.close(); mounts.delete(owner.threadId);
      if (cloudDesktopSocket()) {
        const current = await cloudDesktopCall<{ ready: boolean }>("/status");
        if (!current.ready) await cloudDesktopCall("/action", { action: "run" });
        if (!active()) throw new Error("任务已结束。 ");
        mounts.set(owner.threadId, { generation: owner.generation, close() {} });
        return { integration: containerComputerMcp("docker", control), frame: () => cloudDesktopCall<{ png: string; format: string }>("/frame") };
      }
      const remote = await client();
      try {
        const current = z.object({ ready: z.boolean() }).passthrough().parse(await remote.request("status"));
        if (!current.ready) await remote.run("ensure");
        if (!active()) throw new Error("任务已结束。 ");
        const mounted = await remote.mount(control, active); mounts.set(owner.threadId, { generation: owner.generation, close: mounted.close, client: remote });
        return { integration: mounted.integration, frame: () => remote.run("frame").then(value => z.object({ png: z.string(), format: z.string() }).parse(value)) };
      } catch (error) { await remote.close(); throw error; }
    },
    close() { rpc.close(); remoteViewer.close(); for (const mount of mounts.values()) mount.close(); mounts.clear(); },
  };
}
