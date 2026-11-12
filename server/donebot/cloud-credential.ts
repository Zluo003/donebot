import { readFile } from "node:fs/promises";
import type { DoneBotCredential, DoneBotCredentialStore } from "./gateway.ts";

export function cloudCredentialStore(path: string): DoneBotCredentialStore {
  return {
    persistent: true,
    async load() {
      const source = await readFile(path, "utf8");
      if (source.length > 8192) throw new Error("Cloud installation credential is invalid.");
      const value = JSON.parse(source) as Partial<DoneBotCredential>;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.installationId ?? "") ||
          !/^sk-donebot-[a-f0-9]{64}$/.test(value.credential ?? "") || !/^[1-9][0-9]{0,19}$/.test(value.user?.id ?? "") ||
          typeof value.user?.email !== "string" || !value.user.email || value.user.email.length > 320) {
        throw new Error("Cloud installation credential is invalid.");
      }
      return { installationId: value.installationId!, credential: value.credential!, user: value.user!, mode: "installation", accessToken: "", expiresAt: 0 };
    },
    async save() { throw new Error("This Cloud account is managed from the DoneBot Cloud console."); },
  };
}
