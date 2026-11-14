import type { CloudBackend } from "./wire.ts";

export function effectiveCloudBackend(backend: CloudBackend | undefined, donebot: boolean): CloudBackend {
  if (backend === "vps") return "vps";
  return donebot ? "donebot" : backend ?? "box";
}
