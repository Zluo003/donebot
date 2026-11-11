import { createHash } from "node:crypto";

export function createDoneBotCredentialResponder({ read, update, available }) {
  return (proc, raw, dataDir) => {
    if (!raw || typeof raw !== "object" || raw.type !== "donebot:credentials") return false;
    if (typeof raw.requestId !== "string" || !/^[\w-]{1,100}$/.test(raw.requestId)) return true;
    const key = createHash("sha256").update(dataDir).digest("hex");
    void (async () => {
      if (!(await available())) throw new Error("Secure storage unavailable");
      if (raw.operation === "load") return read().donebotGateways?.[key] ?? null;
      if (raw.operation !== "save") throw new Error("Invalid operation");
      const value = raw.value;
      if (value !== null && (!value || typeof value !== "object" || typeof value.accessToken !== "string" ||
          typeof value.installationId !== "string" || typeof value.user?.id !== "string" ||
          typeof value.user.email !== "string" || typeof value.expiresAt !== "number" ||
          JSON.stringify(value).length > 32_768)) throw new Error("Invalid credential");
      await update(doc => {
        const entries = { ...doc.donebotGateways };
        if (value === null) delete entries[key];
        else entries[key] = value;
        return { ...doc, donebotGateways: entries };
      });
      return null;
    })().then(value => {
      try { proc.postMessage({ type: "donebot:credentials-result", requestId: raw.requestId, ok: true, value }); } catch { /* The child may exit while the OS credential store is writing. */ }
    }, () => {
      try { proc.postMessage({ type: "donebot:credentials-result", requestId: raw.requestId, ok: false }); } catch { /* The child may already have exited. */ }
    });
    return true;
  };
}
