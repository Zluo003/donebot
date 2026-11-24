// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DONEBOT_HUMAN_TEAM_COLLAB_ENABLED } from "./services";
import { isCollabEligible, isHumanTeamCollabVisible } from "./collab-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockApi = vi.hoisted(() => vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>());
const mockDispatch = vi.hoisted(() => vi.fn());

vi.mock("@/state/api", () => ({ api: mockApi }));
vi.mock("@/state/inbox", () => ({ closeInbox: vi.fn() }));
vi.mock("@/components/DesktopCapabilities", () => ({ useCaptionChrome: () => ({ dragProps: {} }) }));
vi.mock("@/state/store", () => ({
  openBot: vi.fn(),
  useStore: () => ({
    state: {
      activeView: "boss",
      bots: [{ id: "b1", name: "封面视觉", color: "blue", hidden: false, modelSelection: { instanceId: "i1", model: "m1" } }],
      groups: [],
      instances: [],
      config: { donebot: { enabled: true, authenticated: true } },
    },
    dispatch: mockDispatch,
  }),
}));

const { OpcBossDashboard } = await import("./OpcBossDashboard");
const { OpcBossConsolePage } = await import("./OpcBossConsolePage");
const { OpcBossSidebarRow } = await import("./OpcBossSidebarRow");
const { OpcOrgChartView } = await import("./OpcOrgChartView");
const { OpcWorkflowsView } = await import("./OpcWorkflowsView");
const { OpcNativeDialog } = await import("./paperclip-ui");
const {
  layoutOrganization,
  routeReportingEdges,
  layoutTopDownOrgChart,
  computeDepartmentClusters,
  DEFAULT_ORG_GEOMETRY,
} = await import("./paperclip-org-layout");
const { reconcileOrgChartWithBots } = await import("../../shared/donebot-opc-org-sync");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) { act(() => root!.unmount()); root = null; }
  if (container) { container.remove(); container = null; }
  mockApi.mockReset();
  mockDispatch.mockReset();
});

describe("OPC Studio Frontend & Human Team Soft-Sunset", () => {
  it("soft-hides human team collab while preserving personal profile eligibility", () => {
    expect(DONEBOT_HUMAN_TEAM_COLLAB_ENABLED).toBe(false);
    const cfg = { donebot: { enabled: true, authenticated: true, modelCount: 1, persistent: true } } as never;
    expect(isCollabEligible(cfg)).toBe(true);
    expect(isHumanTeamCollabVisible(cfg)).toBe(false);
  });

  it("renders Boss Approval Dashboard, expands real per-bot spend table, and approves pending artifacts", async () => {
    mockApi.mockImplementation(async (path, init) => {
      if (path.startsWith("/api/donebot/opc/overview")) {
        return {
          pendingArtifactCount: 1,
          activeHeartbeatCount: 2,
          trippedCircuitBreakerCount: 0,
          activeGoalCount: 1,
          spend: {
            available: true,
            days: 30,
            totalCost: 14.5,
            llmCost: 10,
            imageCost: 4.5,
            videoCost: 0,
            musicCost: 0,
            bots: [{ botId: "b1", botName: "封面视觉", botColor: "blue", totalCost: 14.5, llmCost: 10, imageCost: 4.5, videoCost: 0, musicCost: 0, eventCount: 3, lastUsedAt: "2026-11-24T01:00:00Z" }],
          },
          pendingArtifacts: [{
            id: "art-1",
            title: "小红书首图",
            name: "cover.png",
            path: "/tmp/cover.png",
            kind: "image",
            at: 2000,
            threadId: "t1",
            threadTitle: "12月爆款",
            messageId: "m1",
            reportMessageId: "m1",
            previewUrl: "/api/preview/cover.png",
            botId: "b1",
            botName: "封面视觉",
            botColor: "blue",
            version: 2,
            reviewStatus: "pending",
          }],
          heartbeats: [],
        };
      }
      if (path === "/api/donebot/opc/artifacts/art-1/review" && init?.method === "POST") {
        return { ok: true, dispatched: false };
      }
      return {};
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(createElement(OpcBossDashboard)); });

    expect(container.textContent).toContain("待我拍板");
    expect(container.textContent).toContain("¥14.50");
    expect(container.textContent).toContain("小红书首图");

    // Click 30日算力 card to reveal semantic per-bot spend table
    const spendBtn = [...container.querySelectorAll("button")].find(b => b.textContent?.includes("30日算力"))!;
    await act(async () => { spendBtn.click(); });
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.textContent).toContain("封面视觉");

    // Click 通过 to approve pending artifact
    const approveBtn = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "通过")!;
    await act(async () => { approveBtn.click(); });
    expect(mockApi).toHaveBeenCalledWith(
      "/api/donebot/opc/artifacts/art-1/review",
      expect.objectContaining({ method: "POST" }),
    );
    expect(container.textContent).not.toContain("小红书首图");
  });

  it("wires native <dialog> close listener when transitioning from closed to open", async () => {
    const onClose = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(createElement(OpcNativeDialog, { open: false, onClose, ariaLabel: "测试弹窗", children: "内容" }));
    });
    expect(container.querySelector("dialog")).toBeNull();

    await act(async () => {
      root!.render(createElement(OpcNativeDialog, { open: true, onClose, ariaLabel: "测试弹窗", children: "内容" }));
    });
    const dialog = container.querySelector("dialog");
    expect(dialog).not.toBeNull();
    await act(async () => {
      dialog!.dispatchEvent(new Event("close"));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Boss Dashboard visible on zero-activity cold start and renders full Boss Console page", async () => {
    mockApi.mockImplementation(async (path) => {
      if (path.startsWith("/api/donebot/opc/overview")) {
        return {
          pendingArtifactCount: 0,
          activeHeartbeatCount: 0,
          trippedCircuitBreakerCount: 0,
          activeGoalCount: 0,
          spend: { available: true, days: 30, totalCost: 0, llmCost: 0, imageCost: 0, videoCost: 0, musicCost: 0, bots: [] },
          pendingArtifacts: [],
          heartbeats: [],
        };
      }
      if (path === "/api/donebot/opc/goals") return { goals: [] };
      if (path === "/api/donebot/opc/heartbeats") return { heartbeats: [] };
      return {};
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    // 1. Sidebar entry always visible
    await act(async () => {
      root!.render(createElement(OpcBossSidebarRow, { icons: false, large: true }));
    });
    expect(container.textContent).toContain("老板台");

    // 2. Inbox compact dashboard does not vanish when all counts are zero
    await act(async () => {
      root!.render(createElement(OpcBossDashboard));
    });
    expect(container.textContent).toContain("老板批示台");
    expect(container.textContent).toContain("打开完整老板台");

    // 3. Full Boss Console renders KPI strip, employee table, and formal expandable reports without removed Goal Card or 24h Heartbeat
    await act(async () => {
      root!.render(createElement(OpcBossConsolePage));
    });
    expect(container.textContent).toContain("在岗员工");
    expect(container.textContent).toContain("封面视觉");
    expect(container.textContent).not.toContain("项目目标卡");
    expect(container.textContent).not.toContain("24h 静默巡检");
  });

  it("expands formal Boss report with Markdown body & attachment preview/download and approves in a single click", async () => {
    mockApi.mockImplementation(async (path, init) => {
      if (path.startsWith("/api/donebot/opc/overview")) {
        return {
          pendingArtifactCount: 2,
          pendingReportCount: 1,
          activeHeartbeatCount: 0,
          trippedCircuitBreakerCount: 0,
          activeGoalCount: 0,
          activeWorkflowCount: 1,
          waitingWorkflowCount: 0,
          spend: { available: true, days: 30, totalCost: 3.2, llmCost: 3.2, imageCost: 0, videoCost: 0, musicCost: 0, bots: [] },
          pendingArtifacts: [],
          pendingReports: [{
            id: "msg:t1:m1",
            source: "bot_report",
            title: "独立站首月投放复盘报告",
            summary: "ROI 达到 3.4，建议加大美区短视频预算。",
            body: "# 独立站首月投放复盘报告\n\n## 核心结论\n\n- ROI 达到 **3.4**，超出目标预期。\n",
            botId: "b1",
            botName: "封面视觉",
            botColor: "blue",
            department: "独立站",
            roleTitle: "增长负责人",
            at: 2000,
            threadId: "t1",
            reportMessageId: "m1",
            attachments: [
              { id: "a1", name: "report.md", path: "/tmp/report.md", kind: "document", threadId: "t1", messageId: "m1", previewUrl: "/api/threads/t1/messages/m1/file?preview=1&path=%2Ftmp%2Freport.md" },
              { id: "a2", name: "chart.png", path: "/tmp/chart.png", kind: "image", threadId: "t1", messageId: "m1", previewUrl: "/api/threads/t1/messages/m1/file?preview=1&path=%2Ftmp%2Fchart.png" },
            ],
            artifactIds: ["a1", "a2"],
          }],
          heartbeats: [],
        };
      }
      if (path === "/api/donebot/opc/reports/review" && init?.method === "POST") {
        return { ok: true, reviewedCount: 2, dispatched: false };
      }
      return {};
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(createElement(OpcBossConsolePage)); });

    expect(container.textContent).toContain("独立站首月投放复盘报告");
    expect(container.textContent).toContain("2 份附件");
    expect(container.textContent).not.toContain("汇报附件（2）");

    // Click report header to expand full Markdown report & attachments
    const expandBtn = [...container.querySelectorAll("button")].find(b => b.getAttribute("aria-expanded") === "false")!;
    await act(async () => { expandBtn.click(); });
    expect(expandBtn.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("汇报附件（2）");
    expect(container.textContent).toContain("report.md");
    expect(container.textContent).toContain("chart.png");
    expect(container.textContent).toContain("预览");
    expect(container.textContent).toContain("下载");

    // Single click on 通过 approves all bundled attachments in one request
    const approveBtn = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "通过")!;
    await act(async () => { approveBtn.click(); });
    expect(mockApi).toHaveBeenCalledWith(
      "/api/donebot/opc/reports/review",
      expect.objectContaining({ method: "POST" }),
    );
    expect(container.textContent).not.toContain("独立站首月投放复盘报告");
  });

  it("lays out org chart via Paperclip layout engine and renders OrgChart + Workflows views", async () => {
    const block = layoutOrganization([
      {
        id: "__boss__",
        name: "你（老板）",
        role: "最终拍板",
        status: "owner",
        reports: [
          {
            id: "b1",
            name: "多宝",
            role: "主编",
            status: "idle",
            reports: [{ id: "b2", name: "视觉", role: "设计师", status: "idle", reports: [] }],
          },
        ],
      },
    ], { width: 960, height: 560 }, DEFAULT_ORG_GEOMETRY);
    const edges = routeReportingEdges(block.roots, DEFAULT_ORG_GEOMETRY.gap);
    expect(edges.length).toBe(2);

    // Top-down straight center-to-center orthogonal layout & department clusters
    const topDown = layoutTopDownOrgChart({
      id: "__boss__",
      name: "你（老板）",
      role: "最终拍板",
      status: "owner",
      section: "",
      reports: [
        {
          id: "b1",
          name: "多宝",
          role: "主编",
          status: "idle",
          section: "",
          reports: [
            { id: "b2", name: "视觉", role: "设计师", status: "idle", section: "设计部", reports: [] },
          ],
        },
      ],
    });
    expect(topDown.edges.length).toBe(2);
    // Single child directly beneath parent yields a pure straight vertical center line (M x y1 L x y2)
    expect(topDown.edges[0]!.path).toMatch(/^M \d+ \d+ L \d+ \d+$/);
    expect(topDown.edges[1]!.crossDepartment).toBe(true);
    const clusters = computeDepartmentClusters(topDown.nodes, ["", "设计部", "空部门"], topDown.width);
    expect(clusters.some(c => c.sectionKey === "设计部")).toBe(true);
    expect(clusters.some(c => c.sectionKey === "空部门" && c.empty)).toBe(true);

    mockApi.mockImplementation(async (path) => {
      if (path.startsWith("/api/donebot/opc/spend")) return { available: true, days: 30, totalCost: 0, llmCost: 0, imageCost: 0, videoCost: 0, musicCost: 0, bots: [] };
      if (path === "/api/donebot/opc/workflows") return { workflows: [], runs: [] };
      return {};
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const bots = [
      { id: "b1", name: "多宝", color: "amber", hidden: false, chiefOfStaff: true, section: "", modelSelection: { instanceId: "i1", model: "deepseek-flash" } },
      { id: "b2", name: "视觉", color: "blue", hidden: false, section: "设计部", modelSelection: { instanceId: "i1", model: "gemini" } },
    ] as never;
    const sections = [
      { key: "", name: "通用", chiefs: [bots[0]], members: [] },
      { key: "设计部", name: "设计部", chiefs: [], members: [bots[1]] },
    ] as never;
    const org = {
      enforcementMode: "enforced" as const,
      allowChiefCrossDispatch: false,
      generalDepartmentName: "总控中心",
      nodes: {
        b1: { botId: "b1", reportsToBotId: null, handoffToBotIds: ["b2"], roleTitle: "总控主编" },
        b2: { botId: "b2", reportsToBotId: "b1", handoffToBotIds: [], requireBossApproval: true },
      },
      updatedAt: 1,
    };

    await act(async () => {
      root!.render(createElement(OpcOrgChartView, {
        bots,
        sections,
        org,
        onOrgChange: vi.fn(),
        onMoveToDepartment: vi.fn(async () => {}),
        onToggleChief: vi.fn(async () => {}),
        onRenameGeneralDepartment: vi.fn(),
        onEditTeam: vi.fn(),
        onInstructions: vi.fn(),
        onMemory: vi.fn(),
        onDeleteTeam: vi.fn(),
      }));
    });
    expect(container.textContent).toContain("你（老板）");
    expect(container.textContent).toContain("总控主编");
    expect(container.textContent).toContain("总控中心");
    expect(container.textContent).toContain("设计部");
    expect(container.textContent).not.toContain("跨部门交接");
    expect(container.textContent).not.toContain("右圆点拉交接线");

    // Click system chief (General section) -> shows "设为系统总协调" and collaboration summary (no pipeline handoff checkboxes)
    const empCard = container.querySelector<HTMLElement>('[data-org-node="b1"]')!;
    await act(async () => { empCard.click(); });
    expect(container.textContent).toContain("岗位、部门与协作规则");
    expect(container.textContent).toContain("设为系统总协调");
    expect(container.textContent).toContain("协作与交接规则");
    expect(container.textContent).not.toContain("流水线交接下一棒");

    // Click named department bot -> shows "设为部门负责人"
    const deptBotCard = container.querySelector<HTMLElement>('[data-org-node="b2"]')!;
    await act(async () => { deptBotCard.click(); });
    expect(container.textContent).toContain("设为部门负责人");

    // Workflows list -> open full-workspace infinite-canvas node-graph editor
    mockApi.mockImplementation(async (path, init) => {
      if (path === "/api/donebot/opc/workflows" && (!init?.method || init.method === "GET")) {
        return { workflows: [], runs: [] };
      }
      if (path === "/api/donebot/opc/workflows" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return {
          workflow: {
            id: "wf-new",
            ...body,
            enabled: true,
            variables: [],
            maxConsecutiveFailures: 3,
            consecutiveFailures: 0,
            pausedByCircuitBreaker: false,
            createdAt: 1,
            updatedAt: 1,
          },
        };
      }
      return {};
    });

    await act(async () => {
      root!.render(createElement(OpcWorkflowsView, { bots }));
    });
    expect(container.textContent).toContain("固定与定时工作流");
    const createBtn = [...container.querySelectorAll("button")].find(b => b.textContent?.includes("新建工作流"))!;
    await act(async () => { createBtn.click(); });

    expect(container.querySelector("[data-opc-workflow-canvas]")).not.toBeNull();
    expect(container.textContent).toContain("触发起点");
    expect(container.querySelectorAll("[data-wf-node]").length).toBe(3); // 1 trigger + 2 default step nodes

    // Add a 3rd employee node on canvas
    const addNodeBtn = [...container.querySelectorAll("button")].find(b => b.textContent?.includes("添加员工节点"))!;
    await act(async () => { addNodeBtn.click(); });
    expect(container.querySelectorAll("[data-wf-node]").length).toBe(4);
  });

  it("renders peer layout for chief-less departments and allows multi-tier selection inside headed departments", async () => {
    mockApi.mockImplementation(async (path) => {
      if (path.startsWith("/api/donebot/opc/spend")) return { available: true, days: 30, totalCost: 0, llmCost: 0, imageCost: 0, videoCost: 0, musicCost: 0, bots: [] };
      return {};
    });

    const duobao = { id: "g1", name: "多宝", color: "amber", hidden: false, chiefOfStaff: true, section: "", modelSelection: { instanceId: "i1", model: "m" } };
    const devA = { id: "d1", name: "码匠", color: "blue", hidden: false, chiefOfStaff: false, section: "开发部", modelSelection: { instanceId: "i1", model: "m" } };
    const devB = { id: "d2", name: "DeepSeek", color: "cyan", hidden: false, chiefOfStaff: false, section: "开发部", modelSelection: { instanceId: "i1", model: "m" } };
    const devC = { id: "d3", name: "前端C", color: "green", hidden: false, chiefOfStaff: false, section: "开发部", modelSelection: { instanceId: "i1", model: "m" } };

    // 1. Chief-less department flattens stale d2 -> d1 into peers under g1 and disables same-dept manager options.
    const flatOrg = reconcileOrgChartWithBots({
      enforcementMode: "enforced",
      nodes: {
        g1: { botId: "g1", reportsToBotId: null, handoffToBotIds: [] },
        d1: { botId: "d1", reportsToBotId: "g1", handoffToBotIds: [] },
        d2: { botId: "d2", reportsToBotId: "d1", handoffToBotIds: [] },
      },
      updatedAt: 1,
    }, [duobao, devA, devB]).org;
    expect(flatOrg.nodes.d1?.reportsToBotId).toBe("g1");
    expect(flatOrg.nodes.d2?.reportsToBotId).toBe("g1");

    const flatSections = [
      { key: "", name: "通用", chiefs: [duobao], members: [] },
      { key: "开发部", name: "开发部", chiefs: [], members: [devA, devB] },
    ] as never;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(createElement(OpcOrgChartView, {
        bots: [duobao, devA, devB] as never,
        sections: flatSections,
        org: flatOrg,
        onOrgChange: vi.fn(),
        onMoveToDepartment: vi.fn(async () => {}),
        onToggleChief: vi.fn(async () => {}),
        onRenameGeneralDepartment: vi.fn(),
        onEditTeam: vi.fn(),
        onInstructions: vi.fn(),
        onMemory: vi.fn(),
        onDeleteTeam: vi.fn(),
      }));
    });

    const d2Card = container.querySelector<HTMLElement>('[data-org-node="d2"]')!;
    await act(async () => { d2Card.click(); });
    const flatSelects = container.querySelectorAll("select");
    const flatReportsSelect = flatSelects[1]!;
    const peerOpt = [...flatReportsSelect.querySelectorAll("option")].find(o => o.value === "d1")!;
    expect(peerOpt.disabled).toBe(true);
    expect(container.textContent).toContain("暂无负责人，成员保持平级");

    // 2. Designating d1 as department chief lets d3 pick either d1 (chief) or d2 (sub-lead) while disabling Boss root.
    const headedBots = [duobao, { ...devA, chiefOfStaff: true }, devB, devC];
    const headedOrg = reconcileOrgChartWithBots(flatOrg, headedBots).org;
    expect(headedOrg.nodes.d2?.reportsToBotId).toBe("d1");
    expect(headedOrg.nodes.d3?.reportsToBotId).toBe("d1");

    await act(async () => {
      root!.render(createElement(OpcOrgChartView, {
        bots: headedBots as never,
        sections: [
          { key: "", name: "通用", chiefs: [duobao], members: [] },
          { key: "开发部", name: "开发部", chiefs: [headedBots[1]], members: [devB, devC] },
        ] as never,
        org: headedOrg,
        onOrgChange: vi.fn(),
        onMoveToDepartment: vi.fn(async () => {}),
        onToggleChief: vi.fn(async () => {}),
        onRenameGeneralDepartment: vi.fn(),
        onEditTeam: vi.fn(),
        onInstructions: vi.fn(),
        onMemory: vi.fn(),
        onDeleteTeam: vi.fn(),
      }));
    });

    const d3Card = container.querySelector<HTMLElement>('[data-org-node="d3"]')!;
    await act(async () => { d3Card.click(); });
    const headedReportsSelect = container.querySelectorAll("select")[1]!;
    const bossOpt = [...headedReportsSelect.querySelectorAll("option")].find(o => o.value === "__boss__")!;
    const chiefOpt = [...headedReportsSelect.querySelectorAll("option")].find(o => o.value === "d1")!;
    const leadOpt = [...headedReportsSelect.querySelectorAll("option")].find(o => o.value === "d2")!;
    expect(bossOpt.disabled).toBe(true);
    expect(chiefOpt.disabled).toBe(false);
    expect(leadOpt.disabled).toBe(false);
  });

  it("encloses the system chief and all unassigned general-department bots inside one unified general box without overlapping other departments", () => {
    const tree = layoutTopDownOrgChart({
      id: "__boss__",
      name: "你（老板）",
      role: "最终拍板",
      status: "owner",
      section: "",
      reports: [
        {
          id: "g-chief",
          name: "多宝",
          role: "系统总协调",
          status: "idle",
          section: "",
          reports: [
            {
              id: "dev-1",
              name: "码匠",
              role: "部门负责人",
              status: "idle",
              section: "开发部",
              reports: [
                { id: "dev-2", name: "前端", role: "AI 员工", status: "idle", section: "开发部", reports: [] },
                { id: "dev-3", name: "后端", role: "AI 员工", status: "idle", section: "开发部", reports: [] },
              ],
            },
            { id: "gen-1", name: "DeepSeek", role: "AI 员工", status: "idle", section: "", reports: [] },
            { id: "gen-2", name: "通用助理", role: "AI 员工", status: "idle", section: "", reports: [] },
          ],
        },
      ],
    });

    const boxes = computeDepartmentClusters(tree.nodes, ["", "开发部"], tree.width);
    const generalBoxes = boxes.filter(b => b.sectionKey === "");
    const devBoxes = boxes.filter(b => b.sectionKey === "开发部");
    expect(generalBoxes).toHaveLength(1);
    expect(generalBoxes[0]!.empty).toBe(false);
    expect(generalBoxes[0]!.nodeIds).toEqual(["g-chief", "gen-1", "gen-2"]);
    expect(devBoxes).toHaveLength(1);
    expect(devBoxes[0]!.nodeIds).toEqual(["dev-1", "dev-2", "dev-3"]);
    // General box and Dev box must remain horizontally disjoint (non-overlapping)
    expect(generalBoxes[0]!.x + generalBoxes[0]!.width).toBeLessThan(devBoxes[0]!.x);
    // Edge from general chief to Dev chief is cross-department; edges to general members are intra-department
    expect(tree.edges.find(e => e.parent.id === "g-chief" && e.child.id === "dev-1")?.crossDepartment).toBe(true);
    expect(tree.edges.find(e => e.parent.id === "g-chief" && e.child.id === "gen-1")?.crossDepartment).toBe(false);

    // When general only has the system chief and no other general bots, chief stays in one general box above Dev.
    const chiefOnlyTree = layoutTopDownOrgChart({
      id: "__boss__",
      name: "你（老板）",
      role: "最终拍板",
      status: "owner",
      section: "",
      reports: [
        {
          id: "g-chief",
          name: "多宝",
          role: "系统总协调",
          status: "idle",
          section: "",
          reports: [
            { id: "dev-1", name: "码匠", role: "部门负责人", status: "idle", section: "开发部", reports: [] },
          ],
        },
      ],
    });
    const chiefOnlyBoxes = computeDepartmentClusters(chiefOnlyTree.nodes, ["", "开发部"], chiefOnlyTree.width);
    const chiefOnlyGeneral = chiefOnlyBoxes.filter(b => b.sectionKey === "");
    expect(chiefOnlyGeneral).toHaveLength(1);
    expect(chiefOnlyGeneral[0]!.empty).toBe(false);
    expect(chiefOnlyGeneral[0]!.nodeIds).toEqual(["g-chief"]);
  });
});
