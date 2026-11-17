import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readBody, json } from "../harness/http.ts";
import type { DoneBotCodingEngine } from "../../shared/donebot-coding.ts";
import type { DoneBotGateway, DoneBotScope } from "./gateway.ts";
import { codingModels } from "./coding-models.ts";

const sameScope = (a: DoneBotScope | null, b: DoneBotScope | null) => a?.accountId === b?.accountId && a?.installationId === b?.installationId;

export async function startCodingProxy(gateway: Pick<DoneBotGateway, "scope" | "codingCatalog" | "requestForScope">, engine: DoneBotCodingEngine, scope: DoneBotScope | null) {
  const token = randomBytes(32).toString("base64url");
  const active = new Set<AbortController>();
  let revoked = false;
  const revoke = () => { revoked = true; for (const controller of active) controller.abort(); };
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    active.add(controller);
    res.on("close", () => controller.abort());
    try {
      const supplied = String(req.headers.authorization ?? "").replace(/^Bearer /i, "") || String(req.headers["x-api-key"] ?? "");
      if (revoked || !scope || !sameScope(scope, gateway.scope()) || req.headers.origin || Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return json(res, 401, { error: { message: "DoneBot coding access expired." } });
      const paths = engine === "codex" ? ["/v1/responses"] : ["/v1/messages", "/v1/messages/count_tokens"];
      if (req.method !== "POST" || !paths.includes(req.url ?? "")) return json(res, 404, { error: { message: "Unsupported coding operation." } });
      if (!String(req.headers["content-type"]).toLowerCase().startsWith("application/json")) return json(res, 415, { error: { message: "Expected JSON." } });
      const body = await readBody(req, 16 * 1024 * 1024);
      if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.model !== "string" ||
        !codingModels(engine, gateway.codingCatalog(engine)).options.some(model => model.id === body.model)) return json(res, 403, { error: { message: "Choose a permitted DoneBot coding model." } });
      controller.signal.throwIfAborted();
      if (revoked || !sameScope(scope, gateway.scope())) return json(res, 401, { error: { message: "DoneBot coding access expired." } });
      const headers = new Headers({ "content-type": "application/json" });
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string" && (/^(?:anthropic-|openai-|x-codex-)/.test(key) || ["user-agent", "originator", "session_id"].includes(key))) headers.set(key, value);
      }
      const response = await gateway.requestForScope(scope, req.url!, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal }, engine);
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (!res.write(chunk.value)) await once(res, "drain", { signal: controller.signal });
          }
        } finally { await reader.cancel().catch(() => {}); }
      }
      res.end();
    } catch (error) {
      if (res.headersSent || controller.signal.aborted) res.destroy();
      else json(res, typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 502,
        { error: { message: "DoneBot coding request failed. Check the account and gateway connection." } });
    } finally { active.delete(controller); }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  server.unref();
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token, revoke,
    async close() { revoke(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
