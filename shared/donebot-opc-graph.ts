import type { OpcWorkflowDefinition, OpcWorkflowStep } from "./donebot-opc.ts";

export interface OpcWorkflowStepInput {
  id?: string;
  name: string;
  botId: string;
  instruction: string;
  approvalGate?: boolean;
  x?: number;
  y?: number;
  nextStepIds?: string[];
}

/** Returns true if the directed graph formed by `step.nextStepIds` contains a cycle. */
export function hasWorkflowCycle(
  steps: ReadonlyArray<Pick<OpcWorkflowStep, "id" | "nextStepIds">>,
): boolean {
  const validIds = new Set(steps.map(s => s.id));
  const nextById = new Map(steps.map(s => [s.id, (s.nextStepIds ?? []).filter(id => validIds.has(id))]));
  const color = new Map<string, 0 | 1 | 2>();

  const dfs = (id: string): boolean => {
    color.set(id, 1);
    for (const nextId of nextById.get(id) ?? []) {
      const state = color.get(nextId) ?? 0;
      if (state === 1) return true;
      if (state === 0 && dfs(nextId)) return true;
    }
    color.set(id, 2);
    return false;
  };

  for (const step of steps) {
    if ((color.get(step.id) ?? 0) === 0 && dfs(step.id)) return true;
  }
  return false;
}

/** Returns true if adding edge `fromStepId -> toStepId` would create a self-loop or cycle. */
export function wouldCreateWorkflowCycle(
  steps: ReadonlyArray<Pick<OpcWorkflowStep, "id" | "nextStepIds">>,
  fromStepId: string,
  toStepId: string,
): boolean {
  if (fromStepId === toStepId) return true;
  const patched = steps.map(step =>
    step.id === fromStepId
      ? { ...step, nextStepIds: [...new Set([...(step.nextStepIds ?? []), toStepId])] }
      : step,
  );
  return hasWorkflowCycle(patched);
}

/** Resolves deterministic DAG execution order and direct upstream parent map for a workflow. */
export function resolveWorkflowExecutionPlan(
  wf: Pick<OpcWorkflowDefinition, "steps" | "entryStepIds">,
): {
  orderedSteps: OpcWorkflowStep[];
  parentsByStepId: Map<string, string[]>;
  isExplicitGraph: boolean;
} {
  const stepById = new Map(wf.steps.map(s => [s.id, s]));
  const indexById = new Map(wf.steps.map((s, idx) => [s.id, idx]));
  const hasExplicitEdges = (wf.entryStepIds?.length ?? 0) > 0
    || wf.steps.some(s => (s.nextStepIds?.length ?? 0) > 0);

  if (!hasExplicitEdges) {
    const parentsByStepId = new Map<string, string[]>();
    wf.steps.forEach((step, idx) => {
      parentsByStepId.set(step.id, idx > 0 ? [wf.steps[idx - 1]!.id] : []);
    });
    return { orderedSteps: [...wf.steps], parentsByStepId, isExplicitGraph: false };
  }

  const fullIndegree = new Map<string, number>(wf.steps.map(s => [s.id, 0]));
  for (const step of wf.steps) {
    for (const nextId of step.nextStepIds ?? []) {
      if (stepById.has(nextId)) {
        fullIndegree.set(nextId, (fullIndegree.get(nextId) ?? 0) + 1);
      }
    }
  }
  const seeds = (wf.entryStepIds ?? []).filter(id => stepById.has(id));
  const startIds = seeds.length > 0
    ? seeds
    : wf.steps.filter(s => (fullIndegree.get(s.id) ?? 0) === 0).map(s => s.id);

  const reachable = new Set<string>();
  const bfsQueue = [...startIds];
  while (bfsQueue.length > 0) {
    const id = bfsQueue.shift()!;
    if (reachable.has(id) || !stepById.has(id)) continue;
    reachable.add(id);
    for (const nextId of stepById.get(id)?.nextStepIds ?? []) {
      if (stepById.has(nextId) && !reachable.has(nextId)) bfsQueue.push(nextId);
    }
  }
  if (reachable.size === 0) {
    for (const s of wf.steps) reachable.add(s.id);
  }

  const indegree = new Map<string, number>();
  const parentsByStepId = new Map<string, string[]>();
  for (const id of reachable) {
    indegree.set(id, 0);
    parentsByStepId.set(id, []);
  }
  for (const id of reachable) {
    for (const nextId of stepById.get(id)?.nextStepIds ?? []) {
      if (!reachable.has(nextId)) continue;
      indegree.set(nextId, (indegree.get(nextId) ?? 0) + 1);
      parentsByStepId.get(nextId)!.push(id);
    }
  }

  const compareIds = (a: string, b: string) => {
    const sa = stepById.get(a);
    const sb = stepById.get(b);
    const xa = sa?.x ?? (indexById.get(a) ?? 0) * 320;
    const xb = sb?.x ?? (indexById.get(b) ?? 0) * 320;
    if (xa !== xb) return xa - xb;
    const ya = sa?.y ?? 0;
    const yb = sb?.y ?? 0;
    if (ya !== yb) return ya - yb;
    return (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0);
  };

  const ready = [...reachable].filter(id => (indegree.get(id) ?? 0) === 0).sort(compareIds);
  const orderedSteps: OpcWorkflowStep[] = [];
  while (ready.length > 0) {
    const currentId = ready.shift()!;
    orderedSteps.push(stepById.get(currentId)!);
    for (const nextId of stepById.get(currentId)?.nextStepIds ?? []) {
      if (!reachable.has(nextId)) continue;
      const nextDeg = (indegree.get(nextId) ?? 1) - 1;
      indegree.set(nextId, nextDeg);
      if (nextDeg === 0) {
        ready.push(nextId);
        ready.sort(compareIds);
      }
    }
  }

  if (orderedSteps.length < reachable.size) {
    const done = new Set(orderedSteps.map(s => s.id));
    for (const s of wf.steps) {
      if (reachable.has(s.id) && !done.has(s.id)) orderedSteps.push(s);
    }
  }

  return { orderedSteps, parentsByStepId, isExplicitGraph: true };
}

/** Computes clean left-to-right layered coordinates for the trigger and all step nodes. */
export function autoLayoutWorkflowGraph<T extends Pick<OpcWorkflowStep, "id" | "nextStepIds" | "x" | "y">>(
  steps: readonly T[],
  entryStepIds?: readonly string[],
): { triggerPosition: { x: number; y: number }; positions: Map<string, { x: number; y: number }> } {
  const validIds = new Set(steps.map(s => s.id));
  const stepById = new Map(steps.map(s => [s.id, s]));
  const layer = new Map<string, number>();

  const seeds = (entryStepIds ?? []).filter(id => validIds.has(id));
  const incoming = new Map<string, number>(steps.map(s => [s.id, 0]));
  for (const step of steps) {
    for (const nextId of step.nextStepIds ?? []) {
      if (validIds.has(nextId)) incoming.set(nextId, (incoming.get(nextId) ?? 0) + 1);
    }
  }

  const roots = seeds.length > 0
    ? seeds
    : steps.filter(s => (incoming.get(s.id) ?? 0) === 0).map(s => s.id);

  // Assign longest-path topological layer starting at column 1 (column 0 is Trigger).
  const queue = [...roots];
  for (const id of roots) layer.set(id, 1);
  let guard = steps.length * steps.length + 16;
  while (queue.length > 0 && guard-- > 0) {
    const id = queue.shift()!;
    const currentLayer = layer.get(id) ?? 1;
    for (const nextId of stepById.get(id)?.nextStepIds ?? []) {
      if (!validIds.has(nextId)) continue;
      if ((layer.get(nextId) ?? 0) < currentLayer + 1) {
        layer.set(nextId, currentLayer + 1);
        queue.push(nextId);
      }
    }
  }

  // Place disconnected draft nodes in a tidy bottom row after layer 1.
  let maxLayer = 1;
  for (const col of layer.values()) maxLayer = Math.max(maxLayer, col);
  let disconnectedIdx = 0;
  const cols = new Map<number, string[]>();
  for (const step of steps) {
    const col = layer.get(step.id);
    if (col !== undefined) {
      const list = cols.get(col) ?? [];
      list.push(step.id);
      cols.set(col, list);
    } else {
      const list = cols.get(1 + (disconnectedIdx % Math.max(1, maxLayer))) ?? [];
      list.push(step.id);
      cols.set(1 + (disconnectedIdx % Math.max(1, maxLayer)), list);
      disconnectedIdx++;
    }
  }

  const COL_STEP = 340;
  const ROW_STEP = 190;
  const ORIGIN_X = 72;
  const CENTER_Y = 220;

  const positions = new Map<string, { x: number; y: number }>();
  for (const [col, ids] of cols.entries()) {
    const totalH = (ids.length - 1) * ROW_STEP;
    const startY = Math.max(64, Math.round(CENTER_Y - totalH / 2));
    ids.forEach((id, rowIdx) => {
      positions.set(id, {
        x: ORIGIN_X + col * COL_STEP,
        y: startY + rowIdx * ROW_STEP,
      });
    });
  }

  return {
    triggerPosition: { x: ORIGIN_X, y: CENTER_Y },
    positions,
  };
}
