import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { parseAudioRange } from "../attachments.ts";
import { bindDoneBotAvatar } from "../avatar-image.ts";
import { messageAttachmentName, openMessageFile } from "../message-file.ts";
import type { RequestAuth } from "../request-auth.ts";
import { allowsTool } from "../../shared/tool-scope.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import type { Store } from "../store.ts";
import { doneBotClientMediaCatalog } from "./media-registry.ts";
import { modelCapabilities } from "./capabilities.ts";
import { doneBotMediaModel, doneBotModelCapabilities } from "./catalog.ts";
import type { DoneBotGateway } from "./gateway.ts";
import { createMediaApproval } from "./media-approval.ts";
import { mediaReferenceMime } from "./media-assets.ts";
import { openMediaArtifact } from "./media-download.ts";
import { createDoneBotMediaRoutes } from "./media-routes.ts";
import { DoneBotMediaService, type MediaContext } from "./media.ts";

interface DoneBotMediaHostDeps {
  store: Store;
  gateway: DoneBotGateway;
  dataDir: string;
  attachmentsDir: string;
  enabled: boolean;
  fullAccess(botId: string, threadId: string): boolean;
  messageFileRootsForThread(botId: string, threadId: string): string[];
  canReadThread(auth: RequestAuth, threadId: string): boolean;
  wrote(bot: NonNullable<ReturnType<Store["bot"]>>, threadId: string): void;
  fetchArtifact?: (url: string, signal: AbortSignal) => Promise<Response>;
}

export function createDoneBotMediaHost(deps: DoneBotMediaHostDeps) {
  const { store, gateway: donebot } = deps;
  const donebotMediaApproval = createMediaApproval({ store, full: deps.fullAccess });
  const donebotMedia: DoneBotMediaService = new DoneBotMediaService({
    dbPath: join(deps.dataDir, "donebot", "media.sqlite"), artifactDir: join(deps.dataDir, "donebot", "artifacts"),
    concurrency: scope => donebot.concurrency(scope),
    activeModelCount: accountId => donebot.activeModelCount(accountId),
    scope: () => donebot.scope(), fetchGateway: (path, init, scope) => donebot.requestForScope(scope, path, init),
    receipt: (id, scope, signal) => donebot.receipt(id, scope, signal),
    ...(deps.fetchArtifact ? { fetchArtifact: deps.fetchArtifact } : {}),
    conversationExists: (botId, threadId) => threadId.startsWith("avatar-") && botId === "donebot-avatar" || Boolean(store.bot(botId) && (store.botByThread(threadId) || store.groupByThread(threadId))),
    resolveModel: async (id, kind) => doneBotMediaModel(doneBotClientMediaCatalog(donebot.models()), id, kind),
    capabilities: async query => doneBotModelCapabilities(doneBotClientMediaCatalog(donebot.models()), query),
    authorize: (context, input) => {
      if (context.turnId.startsWith("avatar:")) return Promise.resolve();
      const bot = store.bot(context.botId);
      const kind = input.kind === "music" ? "audio" : input.kind;
      if (!bot || !allowsTool(bot.toolScope, { kind: "mcp", server: "agents", name: `generate_${kind}` })) throw Object.assign(new Error("This media operation is outside the bot's tool selection."), { status: 403 });
      return donebotMediaApproval.authorize(context, input);
    },
    resolveReference: async (context, path, maxBytes) => {
      if (!context.active()) throw new Error("This media turn has ended.");
      const messages = store.messagesFor(context.threadId);
      const attachment = messages.some(message => message.attachments?.some(file => file.path === path));
      const generated = /^donebot-([a-f0-9-]{36})-\d+\.[a-z0-9]+$/.exec(path.split(/[\\/]/).at(-1) ?? "");
      if (generated) {
        const found = attachment ? await donebotMedia.artifact(generated[1]!, path) : null;
        if (!found || found.job.threadId !== context.threadId || found.artifact.bytes > maxBytes) throw new Error("No usable generated reference exists in this conversation.");
        const handle = await openMediaArtifact(found.artifact, join(deps.dataDir, "donebot", "artifacts"));
        try { return { bytes: await handle.readFile(), mime: found.artifact.mime, name: found.artifact.name }; }
        finally { await handle.close(); }
      }
      const attached = attachment || messages.some(message => Boolean(message.text && messageAttachmentName(message.text, path)));
      const roots = deps.messageFileRootsForThread(context.botId, context.threadId).filter(root => root !== deps.attachmentsDir);
      const file = await openMessageFile(path, attached ? [...roots, deps.attachmentsDir] : roots, maxBytes);
      try {
        const mime = mediaReferenceMime(file.mime, file.name);
        if (!/^(image|audio|video)\//.test(mime)) throw new Error("Reference must be image, audio or video.");
        const bytes = await file.handle.readFile();
        if (!context.active()) throw new Error("This media turn has ended.");
        return { bytes, mime, name: file.name };
      } finally { await file.handle.close(); }
    },
    async publish(job) {
      const scope = donebot.scope();
      if (!scope || scope.accountId !== job.scope.accountId || scope.installationId !== job.scope.installationId) throw new Error("DoneBot media account changed.");
      if (job.waitingStopped || job.turnId.startsWith("avatar:")) return;
      const bot = store.bot(job.botId), group = store.groupByThread(job.threadId);
      if (!bot || bot.hidden || (group ? !group.memberIds.includes(bot.id) : store.botByThread(job.threadId)?.id !== bot.id)) return;
      const sendId = `donebot_media_${job.id}_${job.status}`;
      if (store.messagesFor(job.threadId).some(message => message.sendId === sendId)) return;
      const text = job.status === "completed" ? `${job.kind} · ${job.model}` : `${job.kind} · ${job.model} · ${job.status}${job.error ? `: ${job.error}` : ""}`;
      store.appendMessage(job.threadId, { role: "bot", kind: "text", text, sendId,
        ...(job.status === "completed" ? { attachments: job.artifacts.map(file => ({ kind: file.mime.startsWith("image/") ? "image" as const : "file" as const, path: file.path, mime: file.mime, name: file.name })) } : {}),
        ...(group ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}),
      });
      if (group) store.patchGroup(group.id, { unread: true });
      else store.patchTask(bot.id, job.threadId, { unread: true });
      deps.wrote(bot, job.threadId);
    },
  });
  const mediaRouteContexts = new AsyncLocalStorage<MediaContext>();
  donebot.bindMediaActivity(accountId => donebotMedia.activeCount(accountId));
  const donebotMediaRoutes = createDoneBotMediaRoutes(donebotMedia, () => {
    const context = mediaRouteContexts.getStore();
    if (!context) throw new Error("No active media turn.");
    return context;
  });
  const artifactRoute: RouteHandler = async ({ path, method, req, res, json, auth }) => {
    const match = /^\/api\/attachments\/(donebot-([a-f0-9-]{36})-\d+\.[a-z0-9]+)$/.exec(path);
    if (!match || method !== "GET") return PASS;
    const found = await donebotMedia.artifact(match[2]!, match[1]!);
    if (!found || !deps.canReadThread(auth, found.job.threadId)) return json(res, 404, { error: "No such generated artifact." });
    const file = await openMediaArtifact(found.artifact, join(deps.dataDir, "donebot", "artifacts"));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== found.artifact.bytes) return json(res, 404, { error: "Generated artifact changed." });
      const headers = { "content-type": found.artifact.mime, "accept-ranges": "bytes", "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
      const range = parseAudioRange(Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range, info.size);
      if (range.kind === "unsatisfiable") {
        res.writeHead(416, { ...headers, "content-length": "0", "content-range": `bytes */${info.size}` });
        res.end();
        return;
      }
      if (range.kind === "range") {
        res.writeHead(206, { ...headers, "content-length": String(range.end - range.start + 1), "content-range": `bytes ${range.start}-${range.end}/${info.size}` });
        await pipeline(file.createReadStream({ autoClose: false, start: range.start, end: range.end }), res);
      } else {
        res.writeHead(200, { ...headers, "content-length": String(info.size) });
        await pipeline(file.createReadStream({ autoClose: false }), res);
      }
    } finally { await file.close(); }
  };
  if (deps.enabled) bindDoneBotAvatar({
    available: () => Boolean(donebot.scope()),
    model: () => "DoneBot",
    generate: async (prompt, signal) => {
      const id = randomUUID();
      const context = { botId: "donebot-avatar", threadId: `avatar-${id}`, turnId: `avatar:${id}`, active: () => !signal.aborted };
      const catalog = doneBotClientMediaCatalog(donebot.models());
      const configured = catalog?.defaults.image;
      const model = catalog?.models.find(candidate => candidate.id === configured && modelCapabilities(candidate).availability.usable)
        ?? catalog?.models.find(candidate => candidate.media_types.includes("image") && modelCapabilities(candidate).availability.usable);
      if (!model) throw new Error("No locally supported image model is available for avatar generation.");
      let job = await donebotMedia.submit(context, { kind: "image", model: model.id, parameters: { prompt } });
      for (;;) {
        signal.throwIfAborted();
        job = await donebotMedia.status(context, job.id);
        if (job.status === "failed" || job.status === "uncertain") throw new Error(job.error ?? "Avatar generation could not be confirmed. Do not repeat before checking the task.");
        if (job.status === "completed") {
          const file = job.artifacts[0];
          if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.mime)) throw new Error("Avatar output has an unsupported format.");
          if (file.bytes > 15 * 1024 * 1024) throw new Error("Avatar is too large.");
          const handle = await openMediaArtifact(file, join(deps.dataDir, "donebot", "artifacts"));
          try { const bytes = await handle.readFile(); if (bytes.length > 15 * 1024 * 1024) throw new Error("Avatar is too large."); return { bytes, mime: file.mime as "image/png" | "image/jpeg" | "image/webp" }; }
          finally { await handle.close(); }
        }
        await new Promise<void>((resolve, reject) => {
          const aborted = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, 1000);
          signal.addEventListener("abort", aborted, { once: true });
        });
      }
    },
  });
  if (deps.enabled) donebotMedia.start();
  async function generatedFile(threadId: string, messageId: string, path: string): Promise<Awaited<ReturnType<typeof openMessageFile>> | null> {
    const name = path.split(/[\\/]/).at(-1) ?? "";
    const match = /^donebot-([a-f0-9-]{36})-\d+\.[a-z0-9]+$/.exec(name);
    if (!match) return null;
    const found = await donebotMedia.artifact(match[1]!, path);
    const message = store.messagesFor(threadId).find(message => message.id === messageId);
    if (!found || found.job.threadId !== threadId || !message?.attachments?.some(file => file.path === found.artifact.path)) throw Object.assign(new Error("No such generated file."), { status: 404 });
    const handle = await openMediaArtifact(found.artifact, join(deps.dataDir, "donebot", "artifacts"));
    const info = await handle.stat();
    if (!info.isFile() || info.size !== found.artifact.bytes) { await handle.close(); throw new Error("Generated artifact changed."); }
    return { handle, path: found.artifact.path, bytes: info.size, name: found.artifact.name, mime: found.artifact.mime };
  }

  return {
    generatedFile, artifactRoute, internalRoute: donebotMediaRoutes, answerApproval: donebotMediaApproval.answer,
    withContext<T>(context: MediaContext, work: () => T): T { return mediaRouteContexts.run(context, work); },
    async close() { donebotMediaApproval.close(); await donebotMedia.close(); },
  };
}
