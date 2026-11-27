import type { IncomingMessage } from "node:http";
import type { DoneBotVoiceCapabilities } from "../../shared/donebot.ts";
import { DONEBOT_ASR_WS_PATH } from "../../shared/donebot-voice.ts";
import type { DoneBotScope } from "../donebot/gateway.ts";
import type { VoiceAsrProxy } from "../donebot/voice-asr.ts";
import { isSameOrigin, type RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";
import type { Upgrades } from "./upgrades.ts";

export interface VoiceRouteDeps {
  upgrades: Upgrades;
  asrProxy: VoiceAsrProxy | null;
  capabilities(): DoneBotVoiceCapabilities;
  asrTarget(): { scope: DoneBotScope; model: string } | null;
  authenticated(): boolean;
  /** Returns active bot names visible to `auth` for instant ASR hotword injection. */
  hotwordsFor(auth: RequestAuth): string[];
  /** Optional live check for session validity during an open ASR WebSocket. */
  isCurrent?(auth: RequestAuth): boolean;
  /** Optional hosted-workspace re-authorization before upgrading. */
  authorize?(req: IncomingMessage, auth: RequestAuth): Promise<{ status: number; error: string } | null>;
}

export function createVoiceRoutes(deps: VoiceRouteDeps): RouteHandler {
  deps.upgrades.route((path) => path === DONEBOT_ASR_WS_PATH);
  return async ({ req, res, url, path, method, auth, json }) => {
    if (path !== "/api/voice/capabilities" && path !== DONEBOT_ASR_WS_PATH) return PASS;
    res.setHeader("cache-control", "no-store");

    if (path === "/api/voice/capabilities") {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      return json(res, 200, deps.capabilities());
    }

    if (method !== "GET") return json(res, 405, { error: "method not allowed" });
    const pending = deps.upgrades.pending(req);
    if (!pending) return json(res, 426, { error: "WebSocket upgrade required" });
    if (!isSameOrigin(req)) return json(res, 403, { error: "forbidden: cross-origin request" });

    if (deps.authorize) {
      const failure = await deps.authorize(req, auth);
      if (failure) return json(res, failure.status, { error: failure.error });
    }
    if (!deps.asrProxy || !deps.authenticated()) {
      return json(res, 401, { error: "请先登录 DoneBot 账号后再使用云端实时语音识别。" });
    }
    const target = deps.asrTarget();
    if (!target) {
      return json(res, 503, { error: "当前网关账号尚未启用实时流式语音识别模型。" });
    }
    if (pending.socket.destroyed) return;
    const botNames = deps.hotwordsFor(auth);
    pending.release();
    deps.asrProxy.open({
      req,
      socket: pending.socket,
      head: pending.head,
      scope: target.scope,
      model: target.model,
      botNames,
      params: url.searchParams,
      ...(deps.isCurrent ? { isCurrent: () => deps.isCurrent!(auth) } : {}),
    });
    res.detachSocket(pending.socket);
    return;
  };
}
