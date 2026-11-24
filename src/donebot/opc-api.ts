import type {
  OpcArtifactItem,
  OpcArtifactReviewStatus,
  OpcBossOverview,
  OpcBotEvalState,
  OpcConfigSnapshot,
  OpcEvalRun,
  OpcHeartbeatConfig,
  OpcOrgChartState,
  OpcOrgEnforcementMode,
  OpcOrgNodeConfig,
  OpcProjectGoal,
  OpcSpendResponse,
  OpcWorkflowDefinition,
  OpcWorkflowRun,
  OpcWorkflowScheduleKind,
} from "../../shared/donebot-opc";
import type { MarketEvalSample } from "../../shared/donebot-market";
import { api } from "@/state/api";

export const OPC_OVERVIEW_CHANGED_EVENT = "donebot:opc-overview-changed";

export function notifyOpcOverviewChanged(source?: string): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(OPC_OVERVIEW_CHANGED_EVENT, { detail: { source } }));
  }
}

export const opcApi = {
  getOverview(days = 30): Promise<OpcBossOverview> {
    return api<OpcBossOverview>(`/api/donebot/opc/overview?days=${days}`);
  },

  getSpend(days = 30): Promise<OpcSpendResponse> {
    return api<OpcSpendResponse>(`/api/donebot/opc/spend?days=${days}`);
  },

  async listGoals(botId?: string): Promise<OpcProjectGoal[]> {
    const qs = botId ? `?botId=${encodeURIComponent(botId)}` : "";
    const res = await api<{ goals?: OpcProjectGoal[] }>(`/api/donebot/opc/goals${qs}`);
    return Array.isArray(res?.goals) ? res.goals : [];
  },

  async saveGoal(input: {
    id?: string;
    botId: string;
    title: string;
    objective: string;
    redlines: string[];
    deliverables: Array<{ id?: string; title: string; done: boolean; artifactId?: string }>;
    status?: "active" | "completed" | "archived";
  }): Promise<OpcProjectGoal> {
    const res = await api<{ goal: OpcProjectGoal }>("/api/donebot/opc/goals", {
      method: "PUT",
      body: JSON.stringify(input),
    });
    return res.goal;
  },

  async toggleDeliverable(goalId: string, deliverableId: string, done: boolean): Promise<OpcProjectGoal> {
    const res = await api<{ goal: OpcProjectGoal }>(
      `/api/donebot/opc/goals/${encodeURIComponent(goalId)}/deliverables/${encodeURIComponent(deliverableId)}`,
      { method: "PATCH", body: JSON.stringify({ done }) },
    );
    return res.goal;
  },

  deleteGoal(goalId: string): Promise<{ ok: boolean }> {
    return api<{ ok: boolean }>(`/api/donebot/opc/goals/${encodeURIComponent(goalId)}`, { method: "DELETE" });
  },

  async listArtifacts(params: { botId?: string; status?: OpcArtifactReviewStatus } = {}): Promise<OpcArtifactItem[]> {
    const qs = new URLSearchParams();
    if (params.botId) qs.set("botId", params.botId);
    if (params.status) qs.set("status", params.status);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const res = await api<{ items?: OpcArtifactItem[] }>(`/api/donebot/opc/artifacts${suffix}`);
    return Array.isArray(res?.items) ? res.items : [];
  },

  reviewArtifact(
    artifactId: string,
    payload: {
      botId: string;
      status: OpcArtifactReviewStatus;
      note?: string;
      deliverableId?: string;
      threadId?: string;
      artifactTitle?: string;
      dispatchRevision?: boolean;
    },
  ): Promise<{ ok: boolean; dispatched: boolean }> {
    return api<{ ok: boolean; dispatched: boolean }>(
      `/api/donebot/opc/artifacts/${encodeURIComponent(artifactId)}/review`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  },

  reviewReport(payload: {
    botId: string;
    status: "approved" | "changes_requested";
    artifactIds: string[];
    note?: string;
    threadId?: string;
    reportTitle?: string;
    dispatchRevision?: boolean;
  }): Promise<{ ok: boolean; reviewedCount: number; dispatched: boolean }> {
    return api<{ ok: boolean; reviewedCount: number; dispatched: boolean }>(
      "/api/donebot/opc/reports/review",
      { method: "POST", body: JSON.stringify(payload) },
    );
  },

  async listSnapshots(botId: string): Promise<OpcConfigSnapshot[]> {
    const res = await api<{ snapshots?: OpcConfigSnapshot[] }>(
      `/api/donebot/opc/bots/${encodeURIComponent(botId)}/snapshots`,
    );
    return Array.isArray(res?.snapshots) ? res.snapshots : [];
  },

  async createSnapshot(botId: string, label?: string): Promise<OpcConfigSnapshot> {
    const res = await api<{ snapshot: OpcConfigSnapshot }>(
      `/api/donebot/opc/bots/${encodeURIComponent(botId)}/snapshots`,
      { method: "POST", body: JSON.stringify(label ? { label } : {}) },
    );
    return res.snapshot;
  },

  restoreSnapshot(botId: string, snapshotId: string): Promise<{ ok: boolean; backup: OpcConfigSnapshot }> {
    return api<{ ok: boolean; backup: OpcConfigSnapshot }>(
      `/api/donebot/opc/bots/${encodeURIComponent(botId)}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },

  deleteSnapshot(botId: string, snapshotId: string): Promise<{ ok: boolean }> {
    return api<{ ok: boolean }>(
      `/api/donebot/opc/bots/${encodeURIComponent(botId)}/snapshots/${encodeURIComponent(snapshotId)}`,
      { method: "DELETE" },
    );
  },

  getEvals(botId: string): Promise<OpcBotEvalState> {
    return api<OpcBotEvalState>(`/api/donebot/opc/bots/${encodeURIComponent(botId)}/evals`);
  },

  async saveEvalCases(
    botId: string,
    cases: Array<{ id?: string; title: string; prompt: string; expectation?: string }>,
  ) {
    const res = await api<{ cases: OpcBotEvalState["cases"] }>(
      `/api/donebot/opc/bots/${encodeURIComponent(botId)}/evals/cases`,
      { method: "PUT", body: JSON.stringify({ cases }) },
    );
    return res.cases;
  },

  runEvals(botId: string, snapshotLabel?: string): Promise<{ run: OpcEvalRun; verifiedSamples: MarketEvalSample[] }> {
    return api<{ run: OpcEvalRun; verifiedSamples: MarketEvalSample[] }>(
      `/api/donebot/opc/bots/${encodeURIComponent(botId)}/evals/run`,
      { method: "POST", body: JSON.stringify(snapshotLabel ? { snapshotLabel } : {}), timeoutMs: 180_000 },
    );
  },

  async listHeartbeats(botId?: string): Promise<OpcHeartbeatConfig[]> {
    const qs = botId ? `?botId=${encodeURIComponent(botId)}` : "";
    const res = await api<{ heartbeats?: OpcHeartbeatConfig[] }>(`/api/donebot/opc/heartbeats${qs}`);
    return Array.isArray(res?.heartbeats) ? res.heartbeats : [];
  },

  async createHeartbeat(input: {
    botId: string;
    name: string;
    prompt: string;
    intervalMinutes: number;
    silentWhenOk?: boolean;
    enabled?: boolean;
    maxConsecutiveFailures?: number;
  }): Promise<OpcHeartbeatConfig> {
    const res = await api<{ heartbeat: OpcHeartbeatConfig }>("/api/donebot/opc/heartbeats", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return res.heartbeat;
  },

  async updateHeartbeat(
    id: string,
    patch: Partial<Pick<OpcHeartbeatConfig, "name" | "prompt" | "intervalMinutes" | "silentWhenOk" | "enabled" | "maxConsecutiveFailures">>,
  ): Promise<OpcHeartbeatConfig> {
    const res = await api<{ heartbeat: OpcHeartbeatConfig }>(`/api/donebot/opc/heartbeats/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return res.heartbeat;
  },

  deleteHeartbeat(id: string): Promise<{ ok: boolean }> {
    return api<{ ok: boolean }>(`/api/donebot/opc/heartbeats/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  runHeartbeatNow(id: string): Promise<{ ok: boolean; heartbeat: OpcHeartbeatConfig; error?: string }> {
    return api<{ ok: boolean; heartbeat: OpcHeartbeatConfig; error?: string }>(
      `/api/donebot/opc/heartbeats/${encodeURIComponent(id)}/run`,
      { method: "POST", body: JSON.stringify({}), timeoutMs: 120_000 },
    );
  },

  resetCircuitBreaker(id: string, reenable = true): Promise<{ heartbeat: OpcHeartbeatConfig }> {
    return api<{ heartbeat: OpcHeartbeatConfig }>(
      `/api/donebot/opc/heartbeats/${encodeURIComponent(id)}/reset-breaker`,
      { method: "POST", body: JSON.stringify({ reenable }) },
    );
  },

  getOrg(): Promise<OpcOrgChartState> {
    return api<OpcOrgChartState>("/api/donebot/opc/org");
  },

  setOrgMode(enforcementMode: OpcOrgEnforcementMode): Promise<OpcOrgChartState> {
    return api<OpcOrgChartState>("/api/donebot/opc/org/mode", {
      method: "PUT",
      body: JSON.stringify({ enforcementMode }),
    });
  },

  updateOrgSettings(patch: {
    enforcementMode?: OpcOrgEnforcementMode;
    allowChiefCrossDispatch?: boolean;
    generalDepartmentName?: string | null;
  }): Promise<OpcOrgChartState> {
    return api<OpcOrgChartState>("/api/donebot/opc/org/mode", {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  },

  saveOrgNode(
    botId: string,
    patch: Partial<Omit<OpcOrgNodeConfig, "botId">>,
  ): Promise<{ node: OpcOrgNodeConfig; org: OpcOrgChartState }> {
    return api<{ node: OpcOrgNodeConfig; org: OpcOrgChartState }>(
      `/api/donebot/opc/org/nodes/${encodeURIComponent(botId)}`,
      { method: "PUT", body: JSON.stringify(patch) },
    );
  },

  listWorkflows(): Promise<{ workflows: OpcWorkflowDefinition[]; runs: OpcWorkflowRun[] }> {
    return api<{ workflows: OpcWorkflowDefinition[]; runs: OpcWorkflowRun[] }>("/api/donebot/opc/workflows");
  },

  async createWorkflow(input: {
    name: string;
    description?: string;
    enabled?: boolean;
    scheduleKind?: OpcWorkflowScheduleKind;
    intervalMinutes?: number;
    dailyTime?: string;
    silentWhenOk?: boolean;
    triggerPosition?: { x: number; y: number };
    entryStepIds?: string[];
    steps: Array<{
      id?: string;
      name: string;
      botId: string;
      instruction: string;
      approvalGate?: boolean;
      x?: number;
      y?: number;
      nextStepIds?: string[];
    }>;
    maxConsecutiveFailures?: number;
  }): Promise<OpcWorkflowDefinition> {
    const res = await api<{ workflow: OpcWorkflowDefinition }>("/api/donebot/opc/workflows", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return res.workflow;
  },

  async updateWorkflow(
    id: string,
    patch: Partial<{
      name: string;
      description: string;
      enabled: boolean;
      scheduleKind: OpcWorkflowScheduleKind;
      intervalMinutes: number;
      dailyTime: string;
      silentWhenOk: boolean;
      triggerPosition: { x: number; y: number };
      entryStepIds: string[];
      steps: Array<{
        id?: string;
        name: string;
        botId: string;
        instruction: string;
        approvalGate?: boolean;
        x?: number;
        y?: number;
        nextStepIds?: string[];
      }>;
      pausedByCircuitBreaker: boolean;
      consecutiveFailures: number;
      circuitBreakerReason: string | undefined;
    }>,
  ): Promise<OpcWorkflowDefinition> {
    const res = await api<{ workflow: OpcWorkflowDefinition }>(`/api/donebot/opc/workflows/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return res.workflow;
  },

  deleteWorkflow(id: string): Promise<{ ok: boolean }> {
    return api<{ ok: boolean }>(`/api/donebot/opc/workflows/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  async runWorkflow(id: string, variables: Record<string, string> = {}): Promise<OpcWorkflowRun> {
    const res = await api<{ run: OpcWorkflowRun }>(`/api/donebot/opc/workflows/${encodeURIComponent(id)}/run`, {
      method: "POST",
      body: JSON.stringify({ variables }),
      timeoutMs: 180_000,
    });
    return res.run;
  },

  async decideWorkflowRun(
    runId: string,
    payload: { action: "approve" | "revise" | "cancel"; note?: string },
  ): Promise<OpcWorkflowRun> {
    const res = await api<{ run: OpcWorkflowRun }>(
      `/api/donebot/opc/workflow-runs/${encodeURIComponent(runId)}/decision`,
      { method: "POST", body: JSON.stringify(payload), timeoutMs: 180_000 },
    );
    return res.run;
  },
};
