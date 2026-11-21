import { z } from "zod";
import {
  MIN_ROOM_TURN_TIMEOUT_MINUTES, MAX_ROOM_TURN_TIMEOUT_MINUTES, MIN_MCP_CALL_TIMEOUT_MINUTES, MAX_MCP_CALL_TIMEOUT_MINUTES,
  roomTurnTimeoutMinutes, mcpCallTimeoutMinutes, type AppConfig,
} from "../config.ts";
import { defaultBotThreads, MAX_CONCURRENT_BOT_THREADS } from "../bot-thread-limits.ts";
import { callRoute } from "../routes/call-route.ts";
import type { RouteHandler } from "../routes/table.ts";
import { placePath, type SettingsPlaceId } from "./places.ts";

interface Base {
  id: string;
  label: string;
  help: string;
  where: SettingsPlaceId;
  synonyms: string[];
  read(): string;
}
export type WritableEntry = Base & {
  tier: "safe";
  value: z.ZodType;
  allowed: string;
  current(value: unknown): unknown;
  write(value: unknown, assertMutationAllowed: () => void): Promise<string | null>;
  describe?(value: unknown): { change: string } | { refusal: string };
};
export type SettingEntry = WritableEntry | (Base & { tier: "owner-only" });
export const display = (value: unknown): string => value === undefined || value === null || value === "" ? "" : typeof value === "string" ? value : JSON.stringify(value);
export const personOnly = (what: string, where: SettingsPlaceId): string => `${what} is changed only by the person, in ${placePath(where)}.`;

export function createSettingsRegistry(deps: { cfg(): AppConfig; saveConfig(patch: Record<string, unknown>, assertMutationAllowed: () => void): Promise<string | null> }): SettingEntry[] {
  const cfg = deps.cfg;
  function setting<V>(id: string, label: string, help: string, synonyms: string[], value: z.ZodType<V>, allowed: string,
    current: () => V, patch: (next: V) => Record<string, unknown>): WritableEntry {
    return { id, label, help, where: "general", synonyms, tier: "safe", value, allowed, current,
      read: () => display(current()), write: (next, assertMutationAllowed) => deps.saveConfig(patch(next as V), assertMutationAllowed) };
  }
  const entries: SettingEntry[] = [
    setting("general.language", "Language", "The language of this workspace; empty follows the computer.", ["语言", "中文", "language", "locale", "translation"],
      z.string().trim().max(16).regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$|^$/i), "a language tag such as en or zh, or empty", () => cfg().language ?? "", language => ({ language })),
    setting("general.deviceName", "Device name", "The name this computer shows on the phone and in the device list.", ["设备名称", "电脑名称", "device", "computer", "rename"],
      z.string().trim().max(63), "up to 63 characters; empty uses the computer's name", () => cfg().computerName ?? "", computerName => ({ computerName })),
    setting("rooms.turnTimeoutMinutes", "Group turn timeout", "Minutes one reply in a group may run. This is a resource timeout, not a spending limit.", ["群聊", "超时", "group", "timeout"],
      z.number().int().min(MIN_ROOM_TURN_TIMEOUT_MINUTES).max(MAX_ROOM_TURN_TIMEOUT_MINUTES), `${MIN_ROOM_TURN_TIMEOUT_MINUTES} to ${MAX_ROOM_TURN_TIMEOUT_MINUTES} minutes`,
      () => roomTurnTimeoutMinutes(cfg()), turnTimeoutMinutes => ({ rooms: { turnTimeoutMinutes } })),
    setting("mcp.callTimeoutMinutes", "MCP call timeout", "Minutes one connected tool call may run.", ["工具", "超时", "mcp", "timeout"],
      z.number().int().min(MIN_MCP_CALL_TIMEOUT_MINUTES).max(MAX_MCP_CALL_TIMEOUT_MINUTES), `${MIN_MCP_CALL_TIMEOUT_MINUTES} to ${MAX_MCP_CALL_TIMEOUT_MINUTES} minutes`,
      () => mcpCallTimeoutMinutes(cfg()), callTimeoutMinutes => ({ mcp: { callTimeoutMinutes } })),
    setting("threads.maxConcurrentPerBot", "Parallel conversations", "The number of conversations each bot may run at once.", ["并发", "会话", "parallel", "concurrency", "threads"],
      z.number().int().min(1).max(MAX_CONCURRENT_BOT_THREADS), `1 to ${MAX_CONCURRENT_BOT_THREADS}`,
      () => cfg().threads?.maxConcurrentPerBot ?? defaultBotThreads(), maxConcurrentPerBot => ({ threads: { maxConcurrentPerBot } })),
    ...([
      ["account", "account.signIn", "DoneBot account", ["账户", "登录", "account", "sign in"]],
      ["pricing", "models.pricing", "Models & pricing", ["模型", "价格", "人民币", "tts", "models", "pricing", "CNY"]],
      ["updates", "app.updates", "Updates", ["更新", "版本", "version", "update"]],
    ] as const).map(([where, id, label, synonyms]): SettingEntry => ({ id, label, where, synonyms: [...synonyms], tier: "owner-only",
      help: "Managed by the person in Settings.", read: () => "managed in Settings" })),
  ];
  return entries.map(entry => ["rooms.turnTimeoutMinutes", "mcp.callTimeoutMinutes", "threads.maxConcurrentPerBot"].includes(entry.id) ? { ...entry, where: "limits" } : entry);
}

export function findSettings(entries: readonly SettingEntry[], query: string, limit = 8): SettingEntry[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}.-]+/u).filter(word => word.length > 1);
  if (!words.length) return [];
  const phrase = words.join(" ");
  return entries.map(entry => {
    const label = entry.label.toLowerCase(), id = entry.id.toLowerCase(), synonyms = entry.synonyms.map(word => word.toLowerCase());
    const loose = [entry.help, ...synonyms].join(" ").toLowerCase();
    const whole = id === phrase || label === phrase || synonyms.includes(phrase) ? 10 : 0;
    const score = words.reduce((sum, word) => sum + (id === word || label === word ? 6 : label.includes(word) || id.includes(word) ? 3 : loose.includes(word) ? 1 : 0), whole);
    return { entry, score };
  }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(hit => hit.entry);
}

export function routeBackedRegistry(cfg: () => AppConfig, route: RouteHandler): SettingEntry[] {
  return createSettingsRegistry({ cfg, saveConfig: async (patch, assertMutationAllowed) => {
    try {
      const reply = await callRoute(route, { method: "PUT", path: "/api/config", body: patch, assertMutationAllowed, auth: { kind: "loopback", scopes: ["admin", "client"] } });
      return reply.status < 300 ? null : String(reply.body.error ?? `HTTP ${reply.status}`);
    } catch (error) { return error instanceof Error ? error.message : String(error); }
  } });
}
