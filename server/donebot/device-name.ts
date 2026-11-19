import { hostname } from "node:os";

export function doneBotDeviceName(configured?: string): string {
  return (configured?.trim() || hostname().trim() || "DoneBot").slice(0, 63);
}
