import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import type { DoneBotCredential, DoneBotCredentialStore } from "./gateway.ts";

export interface DoneBotPrivatePort {
  on(event: "message", listener: (event: { data?: object }) => void): void;
  postMessage(message: object): void;
}

export function createDoneBotCredentialStore(port?: DoneBotPrivatePort, sessionFile?: string): DoneBotCredentialStore {
  if (!port) {
    let value: DoneBotCredential | null = null;
    return { persistent: false, load: async () => value, save: async next => { value = next; } };
  }
  const pending = new Map<string, { resolve: (value: DoneBotCredential | null) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  port.on("message", event => {
    const message = event.data as { type?: string; requestId?: string; ok?: boolean; value?: DoneBotCredential | null } | undefined;
    if (message?.type !== "donebot:credentials-result" || !message.requestId) return;
    const call = pending.get(message.requestId);
    if (!call) return;
    pending.delete(message.requestId);
    clearTimeout(call.timer);
    if (message.ok) call.resolve(message.value ?? null);
    else call.reject(new Error("DoneBot secure credential storage is unavailable."));
  });
  function request(operation: "load" | "save", value?: DoneBotCredential | null): Promise<DoneBotCredential | null> {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("DoneBot secure credential storage timed out.")); }, 10_000);
      pending.set(requestId, { resolve, reject, timer });
      try { port!.postMessage({ type: "donebot:credentials", requestId, operation, ...(operation === "save" ? { value } : {}) }); }
      catch { clearTimeout(timer); pending.delete(requestId); reject(new Error("DoneBot secure credential storage is unavailable.")); }
    });
  }
  let persistent = true;
  let memory: DoneBotCredential | null = null;
  type BoundCredential = DoneBotCredential & { localSessionId?: string };
  const readSession = () => {
    if (!sessionFile) return undefined;
    try { return readFileSync(sessionFile, "utf8").trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
  };
  let writes: Promise<void> = Promise.resolve();
  return {
    get persistent() { return persistent; },
    async load() {
      if (!persistent) return memory;
      try {
        const saved = await request("load") as BoundCredential | null;
        memory = saved && (!sessionFile || saved.localSessionId && saved.localSessionId === readSession()) ? saved : null;
      }
      catch { persistent = false; }
      return memory;
    },
    save(value) {
      const write = writes.catch(() => {}).then(async () => {
        const localSessionId = randomUUID();
        if (sessionFile) {
          mkdirSync(dirname(sessionFile), { recursive: true, mode: 0o700 });
          writeFileAtomic(sessionFile, localSessionId + "\n", { mode: 0o600 });
        }
        if (persistent) {
          try { await request("save", value ? { ...value, localSessionId } as BoundCredential : null); }
          catch { persistent = false; }
        }
        memory = value;
      });
      writes = write;
      return write;
    },
  };
}
