import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { OpcWorkflowDefinition, OpcWorkflowRun } from "../../shared/donebot-opc.ts";
import { autoLayoutWorkflowGraph } from "../../shared/donebot-opc-graph.ts";
import type { ToolCallContext, ToolCallResult } from "../drivers/agents-call.ts";
import type { Json } from "../drivers/agents-client.ts";
import type { Store } from "../store.ts";
import type { DoneBotOrgWorkflowStore } from "./opc-org-workflow.ts";

export const DONEBOT_OPC_WORKFLOW_TOOL_DEFINITIONS = [
  {
    name: "opc_list_workflows",
    description: "List existing fixed/scheduled multi-bot workflows and all visible workspace bots (with exact bot_id, name, department, and chiefOfStaff status). Fixed workflows take priority over organization chart enforcement and can span across departments directly. Call this before opc_save_workflow or opc_run_workflow to get exact bot IDs and workflow IDs.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "opc_save_workflow",
    description: "Chief of Staff only: create or update a fixed/scheduled multi-bot workflow (supports cross-department steps, daily/interval/manual schedules, {{variable}} placeholders, optional Boss approval gates, and DAG branching via step id + next_step_ids). Automatically lays out clean infinite-canvas node coordinates so the Boss can inspect or edit it visually under 组织与流程 -> 固定工作流. Fixed workflows always override org-chart enforcement.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workflow_id: { type: "string", maxLength: 128, description: "Omit to create a new workflow; pass existing id to update." },
        name: { type: "string", minLength: 1, maxLength: 120 },
        description: { type: "string", maxLength: 600 },
        schedule_kind: { type: "string", enum: ["manual", "daily", "interval"] },
        daily_time: { type: "string", pattern: "^\\d{2}:\\d{2}$", description: "Local HH:mm when schedule_kind='daily', e.g. '09:00'." },
        interval_minutes: { type: "integer", minimum: 15, maximum: 10080, description: "Minutes when schedule_kind='interval'." },
        enabled: { type: "boolean", description: "Default true." },
        entry_step_ids: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 12 },
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", maxLength: 80 },
              name: { type: "string", minLength: 1, maxLength: 80 },
              bot_id: { type: "string", minLength: 1, maxLength: 128 },
              instruction: { type: "string", minLength: 1, maxLength: 4000 },
              approval_gate: { type: "boolean", description: "Pause after this step and wait for Boss approval before continuing." },
              next_step_ids: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 12 },
            },
            required: ["name", "bot_id", "instruction"],
          },
        },
      },
      required: ["name", "steps"],
    },
  },
  {
    name: "opc_run_workflow",
    description: "Chief of Staff only: trigger an existing fixed workflow immediately with optional {{variable}} values. Runs cross-department steps directly, taking priority over org-chart constraints.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workflow_id: { type: "string", minLength: 1, maxLength: 128 },
        variables: { type: "object", additionalProperties: { type: "string", maxLength: 2000 } },
      },
      required: ["workflow_id"],
    },
  },
];

export const DONEBOT_OPC_WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set(
  DONEBOT_OPC_WORKFLOW_TOOL_DEFINITIONS.map(t => t.name),
);

const TOOL_PATHS: Record<string, string> = {
  opc_list_workflows: "/api/internal/donebot/opc/workflows/list",
  opc_save_workflow: "/api/internal/donebot/opc/workflows/save",
  opc_run_workflow: "/api/internal/donebot/opc/workflows/run",
};

export async function callDoneBotOpcWorkflowTool(
  name: string,
  args: Json,
  context: ToolCallContext,
): Promise<ToolCallResult> {
  const path = TOOL_PATHS[name];
  if (!path) return { text: `未知工作流工具：${name}`, isError: true };
  const payload = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const { ok, body } = await context.client.apiResponse(path, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return ok
    ? { text: JSON.stringify(body) }
    : { text: String(body.error ?? "固定工作流操作失败。"), isError: true };
}

const saveWorkflowInputSchema = z.object({
  workflow_id: z.string().trim().min(1).max(128).optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(600).optional(),
  schedule_kind: z.enum(["manual", "daily", "interval"]).default("manual"),
  daily_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  interval_minutes: z.number().int().min(15).max(10080).optional(),
  enabled: z.boolean().optional(),
  entry_step_ids: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  steps: z.array(z.object({
    id: z.string().trim().min(1).max(80).optional(),
    name: z.string().trim().min(1).max(80),
    bot_id: z.string().trim().min(1).max(128),
    instruction: z.string().trim().min(1).max(4000),
    approval_gate: z.boolean().optional(),
    next_step_ids: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  }).strict()).min(1).max(12),
}).strict();

const runWorkflowInputSchema = z.object({
  workflow_id: z.string().trim().min(1).max(128),
  variables: z.record(z.string(), z.string().max(2000)).optional(),
}).strict();

export async function handleDoneBotOpcWorkflowInternal(deps: {
  orgStore: DoneBotOrgWorkflowStore;
  store: Store;
  triggerWorkflow: (wf: OpcWorkflowDefinition, trigger: "manual" | "schedule", variables: Record<string, string>) => Promise<OpcWorkflowRun>;
  method: string;
  path: string;
  res: ServerResponse;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readBody: () => Promise<unknown>;
  botId: string;
}): Promise<boolean> {
  if (deps.method !== "POST" || !deps.path.startsWith("/api/internal/donebot/opc/workflows/")) {
    return false;
  }

  const sender = deps.store.bot(deps.botId);
  const org = deps.orgStore.getOrgChart(deps.store.bots);
  const generalDept = org.generalDepartmentName || "通用";

  if (deps.path === "/api/internal/donebot/opc/workflows/list") {
    const bots = deps.store.bots
      .filter(b => !b.hidden)
      .map(b => ({
        bot_id: b.id,
        name: b.name,
        title: b.title ?? "",
        department: b.section?.trim() || generalDept,
        chief_of_staff: Boolean(b.chiefOfStaff),
      }));
    deps.json(deps.res, 200, {
      can_manage_workflows: Boolean(sender?.chiefOfStaff),
      workflows: deps.orgStore.listWorkflows(),
      bots,
    });
    return true;
  }

  if (!sender?.chiefOfStaff) {
    deps.json(deps.res, 403, {
      error: "只有主协调 Bot（总控主管或部门主 Bot）才能创建、修改或启动固定工作流，请向主协调 Bot 汇报并由其编排。",
    });
    return true;
  }

  try {
    if (deps.path === "/api/internal/donebot/opc/workflows/save") {
      const parsed = saveWorkflowInputSchema.safeParse(await deps.readBody());
      if (!parsed.success) {
        deps.json(deps.res, 400, { error: "工作流参数无效，请提供名称以及至少 1 个包含有效 bot_id 和 instruction 的步骤。" });
        return true;
      }
      const data = parsed.data;
      const visibleBots = new Set(deps.store.bots.filter(b => !b.hidden).map(b => b.id));
      for (const step of data.steps) {
        if (!visibleBots.has(step.bot_id)) {
          deps.json(deps.res, 404, { error: `未找到员工 bot_id="${step.bot_id}"，请先调用 opc_list_workflows 核对准确的 bot_id。` });
          return true;
        }
      }

      const assigned = data.steps.map((step, idx) => ({
        id: step.id || `step-${idx + 1}-${randomUUID().slice(0, 6)}`,
        name: step.name,
        botId: step.bot_id,
        instruction: step.instruction,
        approvalGate: Boolean(step.approval_gate),
        nextStepIds: step.next_step_ids,
      }));
      const explicitGraph = Boolean(data.entry_step_ids?.length) || assigned.some(s => (s.nextStepIds?.length ?? 0) > 0);
      const entryStepIds = explicitGraph
        ? (data.entry_step_ids?.length ? data.entry_step_ids : [assigned[0]!.id])
        : [assigned[0]!.id];
      const wiredSteps = assigned.map((step, idx) => ({
        ...step,
        nextStepIds: explicitGraph
          ? (step.nextStepIds ?? [])
          : (assigned[idx + 1] ? [assigned[idx + 1]!.id] : []),
      }));
      const layout = autoLayoutWorkflowGraph(wiredSteps, entryStepIds);
      const positionedSteps = wiredSteps.map(step => {
        const pos = layout.positions.get(step.id);
        return pos ? { ...step, x: pos.x, y: pos.y } : step;
      });

      const payload = {
        name: data.name,
        description: data.description ?? "",
        enabled: data.enabled ?? true,
        scheduleKind: data.schedule_kind,
        dailyTime: data.schedule_kind === "daily" ? (data.daily_time ?? "09:00") : undefined,
        intervalMinutes: data.schedule_kind === "interval" ? (data.interval_minutes ?? 60) : undefined,
        triggerPosition: layout.triggerPosition,
        entryStepIds,
        steps: positionedSteps,
      };

      const workflow = data.workflow_id
        ? deps.orgStore.updateWorkflow(data.workflow_id, payload)
        : deps.orgStore.createWorkflow(payload);
      if (!workflow) {
        deps.json(deps.res, 404, { error: `未找到要更新的工作流（${data.workflow_id}）。` });
        return true;
      }
      deps.json(deps.res, data.workflow_id ? 200 : 201, {
        ok: true,
        workflow,
        note: "固定工作流已保存并自动完成画布排布，用户可在「组织与流程 → 固定工作流」查看或调整；执行时将优先于组织架构约束直接跨部门运行。",
      });
      return true;
    }

    if (deps.path === "/api/internal/donebot/opc/workflows/run") {
      const parsed = runWorkflowInputSchema.safeParse(await deps.readBody());
      if (!parsed.success) {
        deps.json(deps.res, 400, { error: "请提供有效的 workflow_id。" });
        return true;
      }
      const wf = deps.orgStore.getWorkflow(parsed.data.workflow_id);
      if (!wf) {
        deps.json(deps.res, 404, { error: "指定的工作流不存在。" });
        return true;
      }
      const run = await deps.triggerWorkflow(wf, "manual", parsed.data.variables ?? {});
      deps.json(deps.res, 200, { ok: true, run });
      return true;
    }
  } catch (err) {
    deps.json(deps.res, 400, { error: err instanceof Error ? err.message : "固定工作流操作失败。" });
    return true;
  }

  return false;
}
