import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DEFAULT_DONEBOT_MEDIA_PREFERENCES, type DoneBotMediaPreferences, type DoneBotMediaSettings, type DoneBotCatalog } from "../../shared/donebot.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import type { DoneBotGateway } from "./gateway.ts";
import { doneBotClientMediaCatalog } from "./media-registry.ts";

const modelId = z.string().max(200).regex(/^(?:[A-Za-z0-9][A-Za-z0-9._/-]*)?$/);
const choice = z.object({ primary: modelId, fallback: modelId }).strict().refine(value => !value.fallback || value.primary !== value.fallback, "首选和备用模型不能相同。");
const preferencesSchema = z.object({ image: choice, video: choice }).strict();
const settingsInput = z.object({ accountId: z.string().min(1), preferences: preferencesSchema }).strict();

export class DoneBotMediaPreferencesStore {
  private readonly file: string;
  private readonly accounts: Record<string, DoneBotMediaPreferences>;

  constructor(file: string) {
    this.file = file;
    if (!existsSync(file)) { this.accounts = {}; return; }
    const content = readFileSync(file, "utf8");
    try { this.accounts = z.record(z.string(), preferencesSchema).parse(JSON.parse(content)); }
    catch {
      renameSync(file, `${file}.invalid.${randomUUID()}`);
      this.accounts = {};
      console.warn("[donebot] Invalid media preferences were preserved in a backup; using defaults.");
    }
  }

  get(accountId?: string): DoneBotMediaPreferences {
    return structuredClone(accountId && Object.hasOwn(this.accounts, accountId) ? this.accounts[accountId]! : DEFAULT_DONEBOT_MEDIA_PREFERENCES);
  }

  save(accountId: string, preferences: DoneBotMediaPreferences): void {
    const next = { ...this.accounts, [accountId]: preferencesSchema.parse(preferences) };
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    renameSync(temp, this.file);
    Object.assign(this.accounts, next);
  }
}

export function selectedMediaModels(catalog: DoneBotCatalog | null, preferences: DoneBotMediaPreferences, kind: "image" | "video" | "music"): { primary: string; fallback: string } {
  const local = doneBotClientMediaCatalog(catalog);
  const choices = local?.models.filter(model => model.media_types.includes(kind)) ?? [];
  const saved = kind === "music" ? { primary: "suno", fallback: "" } : preferences[kind];
  const available = (id: string) => choices.some(model => model.id === id);
  const configured = saved.primary || choices.find(model => model.id === catalog?.defaults[kind])?.id || choices[0]?.id || "";
  const primary = available(configured) ? configured : saved.fallback && available(saved.fallback) ? saved.fallback
    : kind !== "music" && saved.primary === DEFAULT_DONEBOT_MEDIA_PREFERENCES[kind].primary
      ? choices.find(model => model.id === catalog?.defaults[kind])?.id ?? choices[0]?.id ?? "" : "";
  return { primary, fallback: saved.fallback !== primary && available(saved.fallback) ? saved.fallback : "" };
}

export function createDoneBotMediaSettingsRoute(gateway: DoneBotGateway, store: DoneBotMediaPreferencesStore): RouteHandler {
  return async ({ path, method, req, res, auth, json, readBody }) => {
    if (path !== "/api/donebot/media-settings" || !["GET", "PUT"].includes(method)) return PASS;
    res.setHeader("Cache-Control", "no-store");
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only the workspace owner can change media defaults." });
    const scope = gateway.scope();
    if (!scope) return json(res, 401, { error: "请先登录 DoneBot。" });
    try {
      const catalog = doneBotClientMediaCatalog(await gateway.refreshCatalog());
      const sameAccount = () => gateway.scope()?.accountId === scope.accountId && gateway.scope()?.installationId === scope.installationId;
      if (!sameAccount()) return json(res, 409, { error: "账号已切换，请重新打开设置。" });
      const models: DoneBotMediaSettings["models"] = (catalog?.models ?? []).flatMap(model => model.media_types
        .filter((kind): kind is "image" | "video" => kind === "image" || kind === "video")
        .map(kind => ({ id: model.id, name: model.display_name || model.id, kind })));
      if (method === "PUT") {
        const input = settingsInput.parse(await readBody(req));
        if (!sameAccount() || input.accountId !== scope.accountId) return json(res, 409, { error: "账号已切换，请重新打开设置。" });
        const previous = store.get(scope.accountId);
        for (const kind of ["image", "video"] as const) for (const key of ["primary", "fallback"] as const) {
          const id = input.preferences[kind][key];
          if (id && !models.some(model => model.id === id && model.kind === kind) && id !== previous[kind][key]) return json(res, 400, { error: "该模型已停用或当前客户端尚未支持，请刷新模型列表。" });
        }
        store.save(scope.accountId, input.preferences);
      }
      return json(res, 200, { accountId: scope.accountId, preferences: store.get(scope.accountId), models } satisfies DoneBotMediaSettings);
    } catch (error) {
      return json(res, error instanceof z.ZodError ? 400 : 502, { error: error instanceof z.ZodError ? error.issues.map(issue => issue.message).join(" ") : "媒体设置暂时无法同步，请重试。" });
    }
  };
}
