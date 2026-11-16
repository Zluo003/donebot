import { createHash } from "node:crypto";
import { keptPrivate } from "./acting-person.ts";
import type { Message, Store } from "../store.ts";
import { extensionForMime, FILE_MAX_BYTES, IMAGE_MAX_BYTES, saveFile, saveImage } from "../attachments.ts";
import { messageReferencesFile, openMessageFile } from "../message-file.ts";
import type { CoordinatorHost, HandoffView, HostTurnResult } from "../coordinator.ts";

type Attachment = NonNullable<Message["attachments"]>[number];
type AttachmentAddress = Pick<HandoffView, "threadId" | "botId">;
type FileSource = { message: Message; attachment: Attachment };

export function createHandoffAttachments(deps: {
  store: Pick<Store, "activePath" | "appendMessage" | "bot" | "messagesFor" | "patchMessage" | "onChange">;
  attachmentsDir: string;
  parent(node: HandoffView): HandoffView | undefined;
  allowed(node: HandoffView, parent: HandoffView): boolean;
  privateTo(threadId: string): string | null;
  wrote(botId: string, threadId: string): void;
  openGenerated(threadId: string, messageId: string, path: string): Promise<Awaited<ReturnType<typeof openMessageFile>> | null>;
}) {
  const { store } = deps;
  const filesIn = (messages: readonly Message[]): FileSource[] => messages.flatMap(message =>
    (message.attachments ?? []).filter(attachment => !(attachment.kind === "image" && attachment.fromTool))
      .map(attachment => ({ message, attachment })));

  async function deliver(from: AttachmentAddress, to: AttachmentAddress, sources: FileSource[], sendId: string, live: () => boolean, assignmentId?: string, publish = true): Promise<Attachment[]> {
    const permitted = () => live() && !keptPrivate({ child: deps.privateTo(from.threadId), parent: deps.privateTo(to.threadId) });
    if (!sources.length || !permitted()) return [];
    const existing = store.activePath(to.threadId).find(message => message.sendId === sendId);
    if (existing) return existing.attachments ?? [];
    const attachments: Attachment[] = [];
    const seen = new Set<string>();
    for (const { message, attachment } of sources) {
      if (!permitted()) return [];
      let file: Awaited<ReturnType<typeof openMessageFile>> | null = null;
      try {
        file = await deps.openGenerated(from.threadId, message.id, attachment.path);
        const generated = Boolean(file);
        file ??= await openMessageFile(attachment.path, [deps.attachmentsDir], FILE_MAX_BYTES);
        const image = generated && from.threadId !== to.threadId && extensionForMime(file.mime);
        if (image && file.bytes > IMAGE_MAX_BYTES) throw new Error("Generated image exceeds the attachment size limit");
        const imageChunks: Buffer[] = [];
        const hash = createHash("sha256");
        for await (const chunk of file.handle.createReadStream({ start: 0, autoClose: false })) {
          hash.update(chunk);
          if (image) imageChunks.push(chunk);
        }
        const digest = hash.digest("hex");
        const key = `${attachment.mime}:${digest}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { source: _source, ...clean } = attachment.kind === "audio" ? { ...attachment, source: undefined } : attachment;
        if (!generated || from.threadId === to.threadId) {
          attachments.push(clean);
          continue;
        }
        const uploadId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
        const stored = extensionForMime(file.mime)
          ? { ...saveImage(Buffer.concat(imageChunks), file.mime, uploadId), name: file.name }
          : await saveFile(file.handle.createReadStream({ start: 0, autoClose: false }), file.name, file.mime, { expectedBytes: file.bytes, uploadId });
        attachments.push(attachment.kind === "audio" ? { ...clean, path: stored.path }
          : { kind: attachment.kind, path: stored.path, mime: stored.mime, name: "name" in attachment ? attachment.name ?? file.name : file.name });
      } finally {
        await file?.handle.close().catch(() => undefined);
      }
    }
    if (!attachments.length || !permitted()) return [];
    if (!publish) return attachments;
    if (from.threadId !== to.threadId) {
      const bot = store.bot(from.botId);
      store.appendMessage(to.threadId, {
        role: "bot", kind: "text", text: "", sendId, attachments, ...(assignmentId ? { handoffAssignmentIds: [assignmentId] } : {}),
        ...(bot ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}),
      });
      deps.wrote(to.botId, to.threadId);
    } else if (assignmentId) {
      for (const { message } of sources) {
        const assignments = message.handoffAssignmentIds ?? [];
        if (!assignments.includes(assignmentId)) store.patchMessage(from.threadId, message.id, { handoffAssignmentIds: [...assignments, assignmentId] });
      }
    }
    return attachments;
  }

  const references = (threadId: string, text: string) => filesIn(store.activePath(threadId)).filter(({ attachment }) =>
    messageReferencesFile(text, attachment.path) || "source" in attachment && Boolean(attachment.source && messageReferencesFile(text, attachment.source)));

  return {
    async referenced(from: AttachmentAddress, to: AttachmentAddress, text: string, live: () => boolean): Promise<Attachment[]> {
      return deliver(from, to, references(from.threadId, text), "", live, undefined, false);
    },
    watch(node: HandoffView): () => void {
      const previous = new Set(store.activePath(node.threadId).map(message => message.id));
      return store.onChange(change => {
        if ((change.type !== "message" && change.type !== "message.patch") || change.threadId !== node.threadId) return;
        const message = change.message;
        if (previous.has(message.id)) return;
        if (message.role === "bot" && (message.from?.botId === node.botId || !node.groupId && !message.from) &&
          message.attachments?.length && !message.sendId?.startsWith("handoff_inputs_") && !message.handoffAssignmentIds?.length) {
          store.patchMessage(node.threadId, message.id, { handoffAssignmentIds: [node.id] });
        }
      });
    },
    async incoming(node: HandoffView, signal: AbortSignal): Promise<Attachment[]> {
      const parent = deps.parent(node);
      if (!parent) return [];
      const sources = references(parent.threadId, node.text);
      return deliver(parent, node, sources, `handoff_inputs_${node.id}`, () => !signal.aborted && deps.allowed(node, parent));
    },
    async shared(first: HandoffView, node: HandoffView, signal: AbortSignal, outcome: HostTurnResult): Promise<HostTurnResult> {
      const firstParent = deps.parent(first), parent = deps.parent(node);
      if (!firstParent || !parent) return outcome;
      const sources = filesIn(store.activePath(firstParent.threadId).filter(message => message.sendId === `handoff_attachments_${first.id}`));
      try {
        const attachments = await deliver(firstParent, parent, sources, `handoff_attachments_${node.id}`,
          () => !signal.aborted && deps.allowed(first, firstParent) && deps.allowed(node, parent), parent.id);
        return { ...outcome, text: withFiles(outcome.text, attachments) };
      } catch (error) {
        return deliveryFailure(outcome, error);
      }
    },
    async returned(node: HandoffView, signal: AbortSignal, outcome: HostTurnResult): Promise<HostTurnResult> {
      const parent = deps.parent(node);
      if (!outcome.ok || outcome.cap || outcome.cards || outcome.stalled || outcome.approvalAsk || outcome.privateQuestion ||
        !parent || node.mode === "notify" || node.reply === "none") return outcome;
      const sources = filesIn(store.activePath(node.threadId).filter(message => message.handoffAssignmentIds?.includes(node.id) && message.role === "bot"));
      try {
        const attachments = await deliver(node, parent, sources, `handoff_attachments_${node.id}`,
          () => !signal.aborted && deps.allowed(node, parent), parent.id);
        return { ...outcome, text: withFiles(outcome.text, attachments) };
      } catch (error) {
        return deliveryFailure(outcome, error);
      }
    },
  };
}

function deliveryFailure(outcome: HostTurnResult, error: unknown): HostTurnResult {
  return { ...outcome, ok: false, text: `${outcome.text}\n\nAttachment delivery failed: ${error instanceof Error ? error.message : String(error)}. The original files remain in the producing conversation; do not regenerate them.` };
}

function withFiles(text: string, attachments: readonly Attachment[]): string {
  if (!attachments.length) return text;
  const files = attachments.map(attachment => ({ path: attachment.path, mime: attachment.mime,
    ...("name" in attachment ? { name: attachment.name } : {}) }));
  return `${text}\n\n[DoneBot returned attachments]\n${JSON.stringify(files)}\nDoneBot has already delivered these files into this conversation for preview and download. Delivery is complete; reply directly to acknowledge or summarize the result. Do not call attach_file, copy files, request another transfer or regenerate them just to deliver them here. These paths identify the delivered files for further work only; they are not pending attachment instructions. If you create a new or edited file, attach that new output once.`;
}

export function withHandoffAttachments(host: () => ReturnType<typeof createHandoffAttachments>, run: CoordinatorHost["run"]): CoordinatorHost["run"] {
  const handoff: CoordinatorHost["run"] = async (node, resumed, signal, composed) => {
    const attachments = host();
    const unwatch = attachments.watch(node);
    try {
      let incoming: Attachment[];
      try { incoming = await attachments.incoming(node, signal); }
      catch (error) { return deliveryFailure({ ok: false, text: "Could not deliver the request attachments." }, error); }
      const input = incoming.length ? { ...composed, text: withFiles(composed.text, incoming), note: withFiles(composed.note, incoming) } : composed;
      const outcome = await run(node, resumed, signal, input);
      return await attachments.returned(node, signal, outcome);
    } finally {
      unwatch();
    }
  };
  return (node, resumed, signal, composed) => node.parentId ? handoff(node, resumed, signal, composed) : run(node, resumed, signal, composed);
}
