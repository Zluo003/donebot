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
  useStore: () => ({
    state: {
      activeView: "boss",
      bots: [{ id: "b1", name: "封面视觉", color: "blue", hidden: false }],
      groups: [],
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
const { layoutOrganization, routeReportingEdges, DEFAULT_ORG_GEOMETRY } = await import("./paperclip-org-layout");

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

    mockApi.mockImplementation(async (path) => {
      if (path.startsWith("/api/donebot/opc/spend")) return { available: true, days: 30, totalCost: 0, llmCost: 0, imageCost: 0, videoCost: 0, musicCost: 0, bots: [] };
      if (path === "/api/donebot/opc/workflows") return { workflows: [], runs: [] };
      return {};
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const bots = [
      { id: "b1", name: "多宝", color: "amber", hidden: false },
      { id: "b2", name: "视觉", color: "blue", hidden: false },
    ] as never;
    const org = {
      enforcementMode: "enforced" as const,
      nodes: {
        b1: { botId: "b1", reportsToBotId: null, handoffToBotIds: ["b2"], roleTitle: "总控主编" },
        b2: { botId: "b2", reportsToBotId: "b1", handoffToBotIds: [], requireBossApproval: true },
      },
      updatedAt: 1,
    };

    await act(async () => {
      root!.render(createElement(OpcOrgChartView, { bots, org, onOrgChange: vi.fn() }));
    });
    expect(container.textContent).toContain("你（老板）");
    expect(container.textContent).toContain("总控主编");
    expect(container.textContent).toContain("需拍板");

    await act(async () => {
      root!.render(createElement(OpcWorkflowsView, { bots }));
    });
    expect(container.textContent).toContain("固定与定时工作流");
    expect(container.textContent).toContain("新建工作流");
  });
});
