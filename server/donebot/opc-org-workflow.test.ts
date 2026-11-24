import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchRoutes } from "../routes/table.ts";
import type { BotRecord, Store } from "../store.ts";
import { createDoneBotAccountRoutes } from "./routes.ts";
import { DoneBotOpcStore } from "./opc-store.ts";
import { createDoneBotOpcRoutes } from "./opc-routes.ts";
import { createDoneBotOrgWorkflowRoutes, DoneBotOrgWorkflowStore } from "./opc-org-workflow.ts";
import { handleDoneBotOpcWorkflowInternal } from "./opc-workflow-tools.ts";

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

  it("never double-reads request bodies when chained after DoneBot account & OPC routes", async () => {
    const orgStore = new DoneBotOrgWorkflowStore(makeTempFile());
    const opcStore = new DoneBotOpcStore(makeTempFile());
    const writer = makeBot("b1", "文案写手");
    const store = {
      bots: [writer],
      bot: (id: string) => (id === writer.id ? writer : undefined),
    } as unknown as Store;

    const accountRoutes = createDoneBotAccountRoutes({} as never);
    const opcRoutes = createDoneBotOpcRoutes({
      opcStore,
      orgStore,
      gateway: {} as never,
      store,
      listBotSkills: () => [],
      readBotSkill: () => null,
      installBotSkill: () => ({ error: "noop" }),
      removeBotSkill: () => {},
      setBotSkillEnabled: () => ({ error: "noop" }),
      publicBot: b => b,
      broadcast: () => {},
      startTurn: async () => {},
      generateBotText: async () => "ok",
    });
    const orgRoutes = createDoneBotOrgWorkflowRoutes({
      orgStore,
      store,
      generateBotText: async () => "ok",
      enableScheduler: false,
    });
    const chain = [accountRoutes, opcRoutes, orgRoutes];

    const dispatchStrict = async (method: string, path: string, body: unknown) => {
      let readCount = 0;
      let status = 0;
      let payload: unknown = null;
      const handled = await dispatchRoutes(chain, {
        req: {} as never,
        res: { setHeader: vi.fn(), headersSent: false, destroy: vi.fn() } as never,
        url: new URL(`http://127.0.0.1${path}`),
        path,
        method,
        auth: { kind: "loopback", scopes: ["admin"] } as never,
        json: (_res: unknown, code: number, value: unknown) => { status = code; payload = value; },
        readBody: async () => {
          readCount += 1;
          if (readCount > 1) {
            throw new Error(`readBody was called ${readCount} times for ${method} ${path} (would hang real HTTP stream!)`);
          }
          return body;
        },
      } as never);
      expect(handled).toBe(true);
      expect(readCount).toBe(1);
      return { status, payload: payload as Record<string, unknown> };
    };

    const modeRes = await dispatchStrict("PUT", "/api/donebot/opc/org/mode", { enforcementMode: "enforced" });
    expect(modeRes.status).toBe(200);
    expect(modeRes.payload.enforcementMode).toBe("enforced");

    const nodeRes = await dispatchStrict("PUT", "/api/donebot/opc/org/nodes/b1", { roleTitle: "总主编" });
    expect(nodeRes.status).toBe(200);

    const wfRes = await dispatchStrict("POST", "/api/donebot/opc/workflows", {
      name: "防卡死测试流程",
      scheduleKind: "manual",
      steps: [{ id: "s1", name: "第一步", botId: "b1", instruction: "执行测试", x: 300, y: 120, nextStepIds: [] }],
      entryStepIds: ["s1"],
      triggerPosition: { x: 60, y: 120 },
    });
    expect(wfRes.status).toBe(201);
    const createdId = (wfRes.payload.workflow as { id: string }).id;

    const patchRes = await dispatchStrict("PATCH", `/api/donebot/opc/workflows/${createdId}`, { enabled: false });
    expect(patchRes.status).toBe(200);
    opcRoutes.stopScheduler();
  });

  it("executes branched DAG workflows in topological order and rejects cyclic node edges", async () => {
    const orgStore = new DoneBotOrgWorkflowStore(makeTempFile());
    const scout = makeBot("b-scout", "选题侦察");
    const writer = makeBot("b-writer", "脚本写手");
    const designer = makeBot("b-design", "视觉出图");
    const editor = makeBot("b-editor", "终审汇编");
    const bots = [scout, writer, designer, editor];
    const store = {
      bots,
      bot: (id: string) => bots.find(b => b.id === id),
    } as unknown as Store;

    // Cyclic graph must be rejected cleanly.
    expect(() => orgStore.createWorkflow({
      name: "非法环路",
      steps: [
        { id: "a", name: "节点A", botId: scout.id, instruction: "A", nextStepIds: ["b"] },
        { id: "b", name: "节点B", botId: writer.id, instruction: "B", nextStepIds: ["a"] },
      ],
      entryStepIds: ["a"],
    })).toThrow(/循环回路/);

    // Diamond DAG: Trigger -> [sA, sB] -> sC, plus an unlinked draft node sDraft that should NOT run.
    const executedOrder: string[] = [];
    const promptByBot = new Map<string, string>();
    const route = createDoneBotOrgWorkflowRoutes({
      orgStore,
      store,
      generateBotText: async (botId, prompt) => {
        executedOrder.push(botId);
        promptByBot.set(botId, prompt);
        return `产出(${botId})`;
      },
      enableScheduler: false,
    });

    const wf = orgStore.createWorkflow({
      name: "并行汇聚流水线",
      scheduleKind: "manual",
      triggerPosition: { x: 40, y: 200 },
      entryStepIds: ["sA", "sB"],
      steps: [
        { id: "sC", name: "终审汇总", botId: editor.id, instruction: "汇总上游两路产出", x: 760, y: 200, nextStepIds: [] },
        { id: "sA", name: "写文字脚本", botId: writer.id, instruction: "产出文字脚本", x: 380, y: 120, nextStepIds: ["sC"] },
        { id: "sB", name: "做视觉配图", botId: designer.id, instruction: "产出视觉配图", x: 380, y: 300, nextStepIds: ["sC"] },
        { id: "sDraft", name: "未连线草稿", botId: scout.id, instruction: "草稿节点", x: 380, y: 500, nextStepIds: [] },
      ],
    });

    let status = 0;
    let payload: Record<string, unknown> = {};
    await route({
      req: {} as never,
      res: { setHeader: vi.fn() } as never,
      url: new URL(`http://127.0.0.1/api/donebot/opc/workflows/${wf.id}/run`),
      path: `/api/donebot/opc/workflows/${wf.id}/run`,
      method: "POST",
      auth: { kind: "loopback", scopes: ["admin"] } as never,
      json: (_res: unknown, code: number, value: unknown) => { status = code; payload = value as Record<string, unknown>; },
      readBody: async () => ({ variables: {} }),
    } as never);

    expect(status).toBe(200);
    expect(executedOrder).toEqual([writer.id, designer.id, editor.id]);
    const editorPrompt = promptByBot.get(editor.id) ?? "";
    expect(editorPrompt).toContain("产出(b-writer)");
    expect(editorPrompt).toContain("产出(b-design)");
    const run = payload.run as { status: string; stepResults: Array<{ stepId: string }> };
    expect(run.status).toBe("completed");
    expect(run.stepResults.map(s => s.stepId)).toEqual(["sA", "sB", "sC"]);
  });

  it("supports department chiefs, optional allowChiefCrossDispatch toggle, general department rename, and chief-created cross-dept workflows overriding org chart", async () => {
    const orgStore = new DoneBotOrgWorkflowStore(makeTempFile());
    const contentChief = { ...makeBot("b-c1", "内容主编"), section: "内容部", chiefOfStaff: true } as BotRecord;
    const contentWriter = { ...makeBot("b-w1", "文案写手"), section: "内容部" } as BotRecord;
    const designChief = { ...makeBot("b-d1", "设计主管"), section: "设计部", chiefOfStaff: true } as BotRecord;
    const generalBot = { ...makeBot("b-g1", "多宝"), section: "", chiefOfStaff: true } as BotRecord;
    const bots = [generalBot, contentChief, contentWriter, designChief];
    const store = { bots, bot: (id: string) => bots.find(b => b.id === id) } as unknown as Store;

    orgStore.updateOrgSettings({ enforcementMode: "enforced", generalDepartmentName: "总控中心" });
    expect(orgStore.getOrgChart(bots).generalDepartmentName).toBe("总控中心");
    expect(orgStore.orgPromptForBot(generalBot.id, bots)).toContain("总控中心");
    expect(orgStore.orgPromptForBot(generalBot.id, bots)).toContain("opc_save_workflow");

    // 1. Department Chief can dispatch own department members without explicit manual reportsTo
    expect(orgStore.evaluateCoordination(contentChief.id, [contentWriter.id], false, bots)).toBeNull();
    // 2. Default strict mode blocks peer department Chiefs from dispatching directly without a wire
    const strictDenied = orgStore.evaluateCoordination(contentChief.id, [designChief.id], false, bots);
    expect(strictDenied).toContain("部门负责人直通");
    // 3. Enabling allowChiefCrossDispatch opens direct cross-department Chief dispatch
    orgStore.updateOrgSettings({ allowChiefCrossDispatch: true });
    expect(orgStore.evaluateCoordination(contentChief.id, [designChief.id], false, bots)).toBeNull();
    // Re-lock strict mode to verify fixed workflow STILL overrides org chart!
    orgStore.updateOrgSettings({ allowChiefCrossDispatch: false });

    const executed: string[] = [];
    const routes = createDoneBotOrgWorkflowRoutes({
      orgStore,
      store,
      generateBotText: async (botId, prompt) => {
        executed.push(`${botId}:${prompt.includes("固定工作流优先于日常组织架构约束") ? "priority" : "plain"}`);
        return `完成-${botId}`;
      },
      enableScheduler: false,
    });

    const callInternal = async (botId: string, path: string, body: unknown) => {
      let status = 0;
      let payload: Record<string, unknown> = {};
      const handled = await handleDoneBotOpcWorkflowInternal({
        orgStore,
        store,
        triggerWorkflow: routes.triggerWorkflow,
        method: "POST",
        path,
        res: {} as never,
        json: (_res, code, value) => { status = code; payload = value as Record<string, unknown>; },
        readBody: async () => body,
        botId,
      });
      expect(handled).toBe(true);
      return { status, payload };
    };

    // 4. Non-chief specialist cannot create fixed workflows
    const deniedCreate = await callInternal(contentWriter.id, "/api/internal/donebot/opc/workflows/save", {
      name: "越权流程",
      steps: [{ name: "步1", bot_id: contentWriter.id, instruction: "写稿" }],
    });
    expect(deniedCreate.status).toBe(403);

    // 5. Chief bot creates a cross-department fixed workflow (auto-generates canvas coords)
    const saved = await callInternal(generalBot.id, "/api/internal/donebot/opc/workflows/save", {
      name: "跨部门爆款生产流",
      schedule_kind: "daily",
      daily_time: "09:00",
      steps: [
        { name: "内容写稿", bot_id: contentWriter.id, instruction: "写出初稿" },
        { name: "设计出图", bot_id: designChief.id, instruction: "根据初稿做封面" },
      ],
    });
    expect(saved.status).toBe(201);
    const createdWf = saved.payload.workflow as { id: string; triggerPosition?: { x: number; y: number }; steps: Array<{ x?: number; y?: number }> };
    expect(createdWf.triggerPosition).toBeDefined();
    expect(typeof createdWf.steps[0]?.x).toBe("number");

    // 6. Running this cross-department fixed workflow succeeds EVEN under strict org enforcement with zero handoff edges
    const ran = await callInternal(generalBot.id, "/api/internal/donebot/opc/workflows/run", {
      workflow_id: createdWf.id,
    });
    expect(ran.status).toBe(200);
    expect((ran.payload.run as { status: string }).status).toBe("completed");
    expect(executed).toEqual([`${contentWriter.id}:priority`, `${designChief.id}:priority`]);
  });
});
