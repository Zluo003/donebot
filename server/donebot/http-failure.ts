import type { ServerResponse } from "node:http";

export function finishStartedResponse(res: ServerResponse, method: string, path: string, error: unknown): boolean {
  if (!res.headersSent && !res.writableEnded && !res.destroyed) return false;
  const route = path.split("/").map(part => /^[a-z][a-z-]{0,31}$/.test(part) ? part : part ? ":id" : "").join("/");
  const code = (error as { code?: unknown } | null)?.code;
  console.warn("HTTP response interrupted", /^[A-Z]{3,10}$/.test(method) ? method : "UNKNOWN", route,
    typeof code === "string" && /^[A-Z_]{3,50}$/.test(code) ? code : "RESPONSE_ERROR");
  if (!res.writableEnded && !res.destroyed) res.destroy();
  return true;
}
