import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotRecord, Store } from "../store.ts";
import { createDoneBotOrgWorkflowRoutes, DoneBotOrgWorkflowStore } from "./opc-org-workflow.ts";

const tempDirs: string[] = [];
function makeTempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "donebot-org-wf-"));
  tempDirs.push(dir);
  return join(dir, "opc-org-workflows.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeBot(id: string, name: string): BotRecord {
  return { id, name, color: "blue", threadId: `t-${id}`, hidden: false } as unknown as BotRecord;
}

describe("OPC Org Chart, Coordination Gate & Multi-step Workflows", () => {
  it("prevents reporting cycles and enforces org-chart coordination rules cleanly", () => {
    const orgStore = new DoneBotOrgWorkflowStore(makeTempFile());
    const chief = makeBot("b-chief", "多宝主编");
    const writer = makeBot("b-writer", "文案写手");
    const designer = makeBot("b-design", "视觉设计");
    const qa = makeBot("b-qa", "质检专员");
    const bots = [chief, writer, designer, qa];

    orgStore.upsertOrgNode(writer.id, { reportsToBotId: chief.id, handoffToBotIds: [designer.id], roleTitle: "内容写手" });
    orgStore.upsertOrgNode(designer.id, { reportsToBotId: chief.id, handoffToBotIds: [qa.id], roleTitle: "封面视觉" });
    orgStore.upsertOrgNode(qa.id, { reportsToBotId: chief.id, roleTitle: "质检" });

    // Cycle prevention (self & indirect ancestor)
    expect(() => orgStore.upsertOrgNode(chief.id, { reportsToBotId: chief.id })).toThrow(/不能向自己汇报/);
    expect(() => orgStore.upsertOrgNode(chief.id, { reportsToBotId: writer.id })).toThrow(/循环汇报/);

    // Free mode allows any coordination
    expect(orgStore.evaluateCoordination(writer.id, [qa.id], false, bots)).toBeNull();

    // Enforced mode applies deterministic hierarchy & handoff gates
    orgStore.setEnforcementMode("enforced");
    // 1. Manager -> subordinate allowed
    expect(orgStore.evaluateCoordination(chief.id, [writer.id, designer.id], false, bots)).toBeNull();
    // 2. Explicit handoff pipeline (Writer -> Designer) allowed
    expect(orgStore.evaluateCoordination(writer.id, [designer.id], false, bots)).toBeNull();
    // 3. Direct upward report (Writer -> Chief) allowed
    expect(orgStore.evaluateCoordination(writer.id, [chief.id], false, bots)).toBeNull();
    // 4. Cross-branch consultation allowed when consult=true
    expect(orgStore.evaluateCoordination(writer.id, [qa.id], true, bots)).toBeNull();
    // 5. Unauthorized lateral task dispatch (Writer -> QA without handoff edge) BLOCKED
    const denied = orgStore.evaluateCoordination(writer.id, [qa.id], false, bots);
    expect(denied).toContain("组织架构约束已拦截");
    expect(denied).toContain("多宝主编");

    // Portable Studio blueprint export & import across fresh bot IDs
    const blueprint = orgStore.exportOrgBlueprint([chief.id, writer.id, designer.id, qa.id]);
    expect(blueprint?.enforcementMode).toBe("enforced");
    const importedStore = new DoneBotOrgWorkflowStore(makeTempFile());
    importedStore.importOrgBlueprint(["n1", "n2", "n3", "n4"], blueprint);
    const importedOrg = importedStore.getOrgChart();
    expect(importedOrg.enforcementMode).toBe("enforced");
    expect(importedOrg.nodes["n2"]?.reportsToBotId).toBe("n1");
    expect(importedOrg.nodes["n2"]?.handoffToBotIds).toEqual(["n3"]);
  });

  it("executes multi-step workflows with variable interpolation, approval gate pause, revision, and continuation", async () => {
    const orgStore = new DoneBotOrgWorkflowStore(makeTempFile());
    const writer = makeBot("b-writer", "脚本写手");
    const designer = makeBot("b-design", "视觉出图");
    const store = {
      bots: [writer, designer],
      bot: (id: string) => [writer, designer].find(b => b.id === id),
    } as unknown as Store;

    const prompts: string[] = [];
    const generateBotText = vi.fn(async (botId: string, prompt: string) => {
      prompts.push(prompt);
      if (botId === writer.id) {
        return prompt.includes("加强开头钩子") ? "脚本 v2：黄金前 3 秒钩子版" : "脚本 v1：初版大纲";
      }
      return "视觉终稿：已按脚本 v2 生成首图方案";
    });

    const route = createDoneBotOrgWorkflowRoutes({ orgStore, store, generateBotText, enableScheduler: false });

    const call = async (method: string, path: string, body?: unknown) => {
      let status = 200;
      let payload: unknown = null;
      await route({
        req: {} as never,
        res: { setHeader: vi.fn() } as never,
        url: new URL(`http://127.0.0.1${path}`),
        path,
        method,
        auth: { kind: "loopback", scopes: ["admin"] } as never,
        json: (_res: unknown, code: number, value: unknown) => { status = code; payload = value; },
        readBody: async () => body ?? {},
      } as never);
      return { status, payload: payload as Record<string, unknown> };
    };

    // 1. Create workflow with {{主题}} variable and approval gate on step 1
    const created = await call("POST", "/api/donebot/opc/workflows", {
      name: "每日小红书流水线",
      scheduleKind: "daily",
      dailyTime: "09:00",
      steps: [
        { name: "写爆款脚本", botId: writer.id, instruction: "围绕「{{主题}}」写一篇爆款脚本", approvalGate: true },
        { name: "配封面视觉", botId: designer.id, instruction: "根据上游脚本设计封面方案", approvalGate: false },
      ],
    });
    expect(created.status).toBe(201);
    const wf = created.payload.workflow as { id: string; variables: string[] };
    expect(wf.variables).toEqual(["主题"]);

    // 2. Run workflow -> stops at step 1 approval gate
    const started = await call("POST", `/api/donebot/opc/workflows/${wf.id}/run`, { variables: { 主题: "一人公司效率" } });
    expect(started.status).toBe(200);
    const run1 = started.payload.run as { id: string; status: string; stepResults: Array<{ output?: string; status: string }> };
    expect(run1.status).toBe("waiting_approval");
    expect(run1.stepResults[0]?.output).toContain("脚本 v1");
    expect(prompts[0]).toContain("一人公司效率");
    expect(generateBotText).toHaveBeenCalledTimes(1);

    // 3. Boss requests revision on step 1 -> re-runs step 1 and pauses again
    const revised = await call("POST", `/api/donebot/opc/workflow-runs/${run1.id}/decision`, { action: "revise", note: "加强开头钩子" });
    const run2 = revised.payload.run as { status: string; stepResults: Array<{ output?: string }> };
    expect(run2.status).toBe("waiting_approval");
    expect(run2.stepResults[0]?.output).toContain("脚本 v2");

    // 4. Boss approves -> automatically executes step 2 with step 1's v2 output and finishes
    const approved = await call("POST", `/api/donebot/opc/workflow-runs/${run1.id}/decision`, { action: "approve" });
    const run3 = approved.payload.run as { status: string; stepResults: Array<{ output?: string; status: string }> };
    expect(run3.status).toBe("completed");
    expect(run3.stepResults[1]?.status).toBe("completed");
    expect(run3.stepResults[1]?.output).toContain("视觉终稿");
    expect(prompts[2]).toContain("脚本 v2");
  });
});
