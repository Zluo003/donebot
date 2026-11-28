import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DEFAULT_DONEBOT_TURN_LIMITS,
  MAX_DONEBOT_TURN_STEPS,
  MAX_DONEBOT_TURN_TOOL_CALLS,
  MIN_DONEBOT_TURN_STEPS,
  MIN_DONEBOT_TURN_TOOL_CALLS,
  type DoneBotTurnLimits,
} from "../../shared/donebot.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";

export const doneBotTurnLimitsSchema = z.object({
  maxSteps: z.number().int().min(MIN_DONEBOT_TURN_STEPS).max(MAX_DONEBOT_TURN_STEPS),
  maxToolCalls: z.number().int().min(MIN_DONEBOT_TURN_TOOL_CALLS).max(MAX_DONEBOT_TURN_TOOL_CALLS),
}).strict().refine(
  (value) => value.maxToolCalls >= value.maxSteps,
  "单轮最大工具调用次数不能小于最大步数。",
);

export class DoneBotTurnLimitsStore {
  private readonly file: string;
  private current: DoneBotTurnLimits;

  constructor(file: string) {
    this.file = file;
    if (!existsSync(file)) {
      this.current = { ...DEFAULT_DONEBOT_TURN_LIMITS };
      return;
    }
    const content = readFileSync(file, "utf8");
    try {
      this.current = doneBotTurnLimitsSchema.parse(JSON.parse(content));
    } catch {
      renameSync(file, `${file}.invalid.${randomUUID()}`);
      this.current = { ...DEFAULT_DONEBOT_TURN_LIMITS };
      console.warn("[donebot] Invalid turn limits were preserved in a backup; using defaults.");
    }
  }

  get(): DoneBotTurnLimits {
    return { ...this.current };
  }

  save(input: DoneBotTurnLimits): DoneBotTurnLimits {
    const next = doneBotTurnLimitsSchema.parse(input);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    renameSync(temp, this.file);
    this.current = next;
    return { ...next };
  }
}

export function createDoneBotTurnLimitsRoute(store: DoneBotTurnLimitsStore): RouteHandler {
  return async ({ path, method, req, res, auth, json, readBody }) => {
    if (path !== "/api/donebot/turn-limits" || !["GET", "PUT"].includes(method)) return PASS;
    res.setHeader("Cache-Control", "no-store");
    if (!ownerOrAdmin(auth)) {
      return json(res, 403, { error: "Only the workspace owner can manage turn limits." });
    }
    try {
      if (method === "PUT") {
        const body = await readBody(req);
        const saved = store.save(doneBotTurnLimitsSchema.parse(body));
        return json(res, 200, saved);
      }
      return json(res, 200, store.get());
    } catch (error) {
      return json(res, error instanceof z.ZodError ? 400 : 500, {
        error: error instanceof z.ZodError
          ? error.issues.map((issue) => issue.message).join(" ")
          : "单轮执行上限保存失败，请重试。",
      });
    }
  };
}
