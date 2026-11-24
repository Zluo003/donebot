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

    // 3. Full Boss Console renders KPI strip, employee table, goal card and 24h heartbeat panel
    await act(async () => {
      root!.render(createElement(OpcBossConsolePage));
    });
    expect(container.textContent).toContain("在岗员工");
    expect(container.textContent).toContain("封面视觉");
    expect(container.textContent).toContain("项目目标卡");
    expect(container.textContent).toContain("24h 静默巡检");
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
    expect(container.textContent).toContain("跨部门交接");

    // Click an employee node to open the right inspector drawer
    const empCard = container.querySelector<HTMLElement>('[data-org-node="b1"]')!;
    await act(async () => { empCard.click(); });
    expect(container.textContent).toContain("岗位、部门与协作规则");
    expect(container.textContent).toContain("设为本部门主 Bot");

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
            variables: ["主题"],
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
});
