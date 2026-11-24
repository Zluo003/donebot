import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  ArrowLeft,
  Clock,
  LayoutGrid,
  Loader2,
  Maximize2,
  Minus,
  Play,
  Plus,
  Save,
  ShieldCheck,
  X,
  Zap,
} from "lucide-react";
import type {
  OpcWorkflowDefinition,
  OpcWorkflowScheduleKind,
} from "../../shared/donebot-opc";
import {
  autoLayoutWorkflowGraph,
  resolveWorkflowExecutionPlan,
  wouldCreateWorkflowCycle,
} from "../../shared/donebot-opc-graph";
import { BotAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import type { Bot } from "@/state/store";
import {
  OpcWorkflowInspector,
  WORKFLOW_TRIGGER_ID as TRIGGER_ID,
  type WorkflowDraftNode as DraftNode,
} from "./OpcWorkflowInspector";

const NODE_W = 248;
const STEP_H = 122;
const TRIGGER_H = 114;

export interface WorkflowCanvasPayload {
  name: string;
  description: string;
  scheduleKind: OpcWorkflowScheduleKind;
  dailyTime?: string;
  intervalMinutes?: number;
  triggerPosition: { x: number; y: number };
  entryStepIds: string[];
  steps: Array<{
    id: string;
    name: string;
    botId: string;
    instruction: string;
    approvalGate: boolean;
    x: number;
    y: number;
    nextStepIds: string[];
  }>;
}

interface WiringDrag {
  fromId: string;
  startX: number;
  startY: number;
  curX: number;
  curY: number;
  hoverTargetId: string | null;
  invalid: boolean;
}

function makeStepId(): string {
  return `step-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function bezierEdgePath(x1: number, y1: number, x2: number, y2: number): { d: string; midX: number; midY: number } {
  const dx = Math.abs(x2 - x1);
  const offset = Math.max(56, Math.min(180, dx * 0.48));
  const cx1 = x1 + offset;
  const cy1 = y1;
  const cx2 = x2 - offset;
  const cy2 = y2;
  const d = `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
  // Cubic bezier midpoint at t = 0.5
  const midX = 0.125 * x1 + 0.375 * cx1 + 0.375 * cx2 + 0.125 * x2;
  const midY = 0.125 * y1 + 0.375 * cy1 + 0.375 * cy2 + 0.125 * y2;
  return { d, midX, midY };
}

function buildInitialDraft(
  workflow: OpcWorkflowDefinition | null,
  bots: readonly Bot[],
): {
  name: string;
  description: string;
  scheduleKind: OpcWorkflowScheduleKind;
  dailyTime: string;
  intervalMinutes: number;
  triggerPos: { x: number; y: number };
  entryStepIds: string[];
  nodes: DraftNode[];
} {
  if (!workflow) {
    const firstBot = bots[0]?.id ?? "";
    const secondBot = bots[1]?.id ?? firstBot;
    const id1 = makeStepId();
    const id2 = makeStepId();
    return {
      name: "",
      description: "",
      scheduleKind: "daily",
      dailyTime: "09:00",
      intervalMinutes: 120,
      triggerPos: { x: 72, y: 200 },
      entryStepIds: [id1],
      nodes: [
        {
          id: id1,
          name: "信息收集与大纲",
          botId: firstBot,
          instruction: "梳理今日重点方向、关键信息与切入角度，整理成结构清晰的执行大纲。",
          approvalGate: false,
          x: 412,
          y: 196,
          nextStepIds: [id2],
        },
        {
          id: id2,
          name: "内容与成品输出",
          botId: secondBot,
          instruction: "基于上游交接的大纲润色成完整定稿，直接在对话中输出最终结果。",
          approvalGate: true,
          x: 752,
          y: 196,
          nextStepIds: [],
        },
      ],
    };
  }

  const hasExplicitGraph = (workflow.entryStepIds?.length ?? 0) > 0
    || workflow.steps.some(s => (s.nextStepIds?.length ?? 0) > 0);
  const entryStepIds = hasExplicitGraph
    ? [...(workflow.entryStepIds ?? [])]
    : workflow.steps[0]
      ? [workflow.steps[0].id]
      : [];

  const rawNodes: DraftNode[] = workflow.steps.map((s, idx) => ({
    id: s.id,
    name: s.name,
    botId: s.botId,
    instruction: s.instruction,
    approvalGate: s.approvalGate,
    x: s.x ?? 0,
    y: s.y ?? 0,
    nextStepIds: hasExplicitGraph
      ? [...(s.nextStepIds ?? [])]
      : workflow.steps[idx + 1]
        ? [workflow.steps[idx + 1]!.id]
        : [],
  }));

  const missingCoords = !workflow.triggerPosition
    || workflow.steps.some(s => typeof s.x !== "number" || typeof s.y !== "number");
  if (missingCoords) {
    const laidOut = autoLayoutWorkflowGraph(rawNodes, entryStepIds);
    return {
      name: workflow.name,
      description: workflow.description,
      scheduleKind: workflow.scheduleKind,
      dailyTime: workflow.dailyTime || "09:00",
      intervalMinutes: workflow.intervalMinutes || 120,
      triggerPos: workflow.triggerPosition ?? laidOut.triggerPosition,
      entryStepIds,
      nodes: rawNodes.map(n => {
        const pos = laidOut.positions.get(n.id);
        return pos ? { ...n, x: pos.x, y: pos.y } : n;
      }),
    };
  }

  return {
    name: workflow.name,
    description: workflow.description,
    scheduleKind: workflow.scheduleKind,
    dailyTime: workflow.dailyTime || "09:00",
    intervalMinutes: workflow.intervalMinutes || 120,
    triggerPos: workflow.triggerPosition!,
    entryStepIds,
    nodes: rawNodes,
  };
}

export function OpcWorkflowCanvasEditor({
  bots,
  workflow,
  saving,
  error,
  onCancel,
  onSave,
}: {
  bots: Bot[];
  workflow: OpcWorkflowDefinition | null;
  saving: boolean;
  error: string;
  onCancel: () => void;
  onSave: (payload: WorkflowCanvasPayload, runAfterSave: boolean) => Promise<void>;
}) {
  const initial = useMemo(() => buildInitialDraft(workflow, bots), [workflow, bots]);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [scheduleKind, setScheduleKind] = useState<OpcWorkflowScheduleKind>(initial.scheduleKind);
  const [dailyTime, setDailyTime] = useState(initial.dailyTime);
  const [intervalMinutes, setIntervalMinutes] = useState(initial.intervalMinutes);
  const [triggerPos, setTriggerPos] = useState(initial.triggerPos);
  const [entryStepIds, setEntryStepIds] = useState<string[]>(initial.entryStepIds);
  const [nodes, setNodes] = useState<DraftNode[]>(initial.nodes);
  const [selectedId, setSelectedId] = useState<string>(initial.nodes[0]?.id ?? TRIGGER_ID);
  const [localError, setLocalError] = useState("");

  // Infinite canvas pan / zoom state
  const canvasRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0.95);
  const [pan, setPan] = useState({ x: 24, y: 24 });
  const [panning, setPanning] = useState(false);
  const [wiring, setWiring] = useState<WiringDrag | null>(null);
  const [hoveredEdgeKey, setHoveredEdgeKey] = useState<string | null>(null);

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  panRef.current = pan;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const triggerPosRef = useRef(triggerPos);
  triggerPosRef.current = triggerPos;

  const botById = useMemo(() => new Map(bots.map(b => [b.id, b])), [bots]);

  const executionOrderMap = useMemo(() => {
    const plan = resolveWorkflowExecutionPlan({ steps: nodes, entryStepIds });
    return new Map(plan.orderedSteps.map((s, idx) => [s.id, idx + 1]));
  }, [nodes, entryStepIds]);

  const clientToWorld = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - panRef.current.x) / zoomRef.current,
      y: (clientY - rect.top - panRef.current.y) / zoomRef.current,
    };
  }, []);

  const fitView = useCallback((nextTrigger = triggerPosRef.current, nextNodes = nodesRef.current) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) {
      setZoom(0.95);
      setPan({ x: 24, y: 24 });
      return;
    }
    const xs = [nextTrigger.x, ...nextNodes.map(n => n.x)];
    const ys = [nextTrigger.y, ...nextNodes.map(n => n.y)];
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs) + NODE_W;
    const maxY = Math.max(...ys) + STEP_H;
    const contentW = Math.max(300, maxX - minX);
    const contentH = Math.max(200, maxY - minY);
    const pad = 64;
    const fitZoom = Math.max(0.55, Math.min(1.05, Math.min(
      (rect.width - pad * 2) / contentW,
      (rect.height - pad * 2) / contentH,
    )));
    setZoom(+fitZoom.toFixed(2));
    setPan({
      x: Math.round((rect.width - contentW * fitZoom) / 2 - minX * fitZoom),
      y: Math.round((rect.height - contentH * fitZoom) / 2 - minY * fitZoom),
    });
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => fitView(), 0);
    return () => window.clearTimeout(timer);
  }, [fitView]);

  const handleAutoLayout = useCallback(() => {
    const laid = autoLayoutWorkflowGraph(nodesRef.current, entryStepIds);
    const nextNodes = nodesRef.current.map(n => {
      const pos = laid.positions.get(n.id);
      return pos ? { ...n, x: pos.x, y: pos.y } : n;
    });
    setTriggerPos(laid.triggerPosition);
    setNodes(nextNodes);
    fitView(laid.triggerPosition, nextNodes);
  }, [entryStepIds, fitView]);

  const addNodeAfter = useCallback((sourceId?: string) => {
    const id = makeStepId();
    const defaultBot = bots[0]?.id ?? "";
    const existing = nodesRef.current;
    let x = triggerPosRef.current.x + 340;
    let y = triggerPosRef.current.y;

    if (sourceId && sourceId !== TRIGGER_ID) {
      const parent = existing.find(n => n.id === sourceId);
      if (parent) {
        const siblingCount = parent.nextStepIds.length;
        x = parent.x + 340;
        y = parent.y + siblingCount * 168;
      }
    } else if (existing.length > 0) {
      const rightmost = existing.reduce((acc, cur) => (cur.x >= acc.x ? cur : acc), existing[0]!);
      x = rightmost.x + 340;
      y = rightmost.y;
    }

    const newNode: DraftNode = {
      id,
      name: `员工节点 ${existing.length + 1}`,
      botId: defaultBot,
      instruction: "",
      approvalGate: false,
      x,
      y,
      nextStepIds: [],
    };

    setNodes(prev => {
      const updated = sourceId && sourceId !== TRIGGER_ID
        ? prev.map(n => (n.id === sourceId ? { ...n, nextStepIds: [...new Set([...n.nextStepIds, id])] } : n))
        : prev;
      return [...updated, newNode];
    });
    if (sourceId === TRIGGER_ID || (!sourceId && existing.length === 0)) {
      setEntryStepIds(prev => [...new Set([...prev, id])]);
    }
    setSelectedId(id);
    setLocalError("");
  }, [bots]);

  const removeNode = useCallback((id: string) => {
    setNodes(prev => prev
      .filter(n => n.id !== id)
      .map(n => ({ ...n, nextStepIds: n.nextStepIds.filter(nextId => nextId !== id) })),
    );
    setEntryStepIds(prev => prev.filter(eid => eid !== id));
    setSelectedId(prev => (prev === id ? TRIGGER_ID : prev));
  }, []);

  const connectEdge = useCallback((fromId: string, toId: string) => {
    if (toId === TRIGGER_ID || fromId === toId) return;
    if (fromId === TRIGGER_ID) {
      setEntryStepIds(prev => [...new Set([...prev, toId])]);
      setLocalError("");
      return;
    }
    if (wouldCreateWorkflowCycle(nodesRef.current, fromId, toId)) {
      setLocalError("不能连接形成循环回路，请连接到下游节点。");
      return;
    }
    setNodes(prev => prev.map(n =>
      n.id === fromId ? { ...n, nextStepIds: [...new Set([...n.nextStepIds, toId])] } : n,
    ));
    setLocalError("");
  }, []);

  const disconnectEdge = useCallback((fromId: string, toId: string) => {
    if (fromId === TRIGGER_ID) {
      setEntryStepIds(prev => prev.filter(id => id !== toId));
      return;
    }
    setNodes(prev => prev.map(n =>
      n.id === fromId ? { ...n, nextStepIds: n.nextStepIds.filter(id => id !== toId) } : n,
    ));
  }, []);

  // Dragging a node card freely on the infinite canvas
  const handleNodeDragStart = useCallback((e: ReactPointerEvent<HTMLDivElement>, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelectedId(id);
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const initPos = id === TRIGGER_ID
      ? triggerPosRef.current
      : (nodesRef.current.find(n => n.id === id) ?? { x: 0, y: 0 });
    const originX = initPos.x;
    const originY = initPos.y;

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startClientX) / zoomRef.current;
      const dy = (ev.clientY - startClientY) / zoomRef.current;
      const nextX = Math.round(originX + dx);
      const nextY = Math.round(originY + dy);
      if (id === TRIGGER_ID) {
        setTriggerPos({ x: nextX, y: nextY });
      } else {
        setNodes(prev => prev.map(n => (n.id === id ? { ...n, x: nextX, y: nextY } : n)));
      }
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, []);

  // Pulling a live Bezier wire from an output port
  const handlePortDragStart = useCallback((
    e: ReactPointerEvent<HTMLButtonElement>,
    fromId: string,
    startX: number,
    startY: number,
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    let latestTarget: string | null = null;
    let latestInvalid = false;

    const initialWorld = clientToWorld(e.clientX, e.clientY);
    setWiring({
      fromId,
      startX,
      startY,
      curX: initialWorld.x,
      curY: initialWorld.y,
      hoverTargetId: null,
      invalid: false,
    });

    const onMove = (ev: PointerEvent) => {
      const pt = clientToWorld(ev.clientX, ev.clientY);
      const hit = nodesRef.current.find(n =>
        n.id !== fromId
        && pt.x >= n.x - 22
        && pt.x <= n.x + NODE_W + 12
        && pt.y >= n.y - 16
        && pt.y <= n.y + STEP_H + 16,
      );
      latestTarget = hit?.id ?? null;
      latestInvalid = Boolean(
        latestTarget && fromId !== TRIGGER_ID && wouldCreateWorkflowCycle(nodesRef.current, fromId, latestTarget),
      );
      setWiring({
        fromId,
        startX,
        startY,
        curX: hit ? hit.x : pt.x,
        curY: hit ? hit.y + STEP_H / 2 : pt.y,
        hoverTargetId: latestTarget,
        invalid: latestInvalid,
      });
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setWiring(null);
      if (latestTarget && !latestInvalid) {
        connectEdge(fromId, latestTarget);
      } else if (latestTarget && latestInvalid) {
        setLocalError("不能连接形成循环回路，请连接到下游节点。");
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, [clientToWorld, connectEdge]);

  // Panning the infinite canvas background
  const handleCanvasPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const initPan = panRef.current;
    setPanning(true);

    const onMove = (ev: PointerEvent) => {
      setPan({ x: initPan.x + (ev.clientX - startX), y: initPan.y + (ev.clientY - startY) });
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setPanning(false);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, []);

  const handleWheel = useCallback((e: ReactWheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.07 : 0.07;
      setZoom(z => Math.max(0.45, Math.min(1.5, +(z + delta).toFixed(2))));
    } else {
      setPan(prev => ({ x: prev.x - e.deltaX, y: prev.y - e.deltaY }));
    }
  }, []);

  const edges = useMemo(() => {
    const list: Array<{
      key: string;
      fromId: string;
      toId: string;
      d: string;
      midX: number;
      midY: number;
    }> = [];
    const nodeById = new Map(nodes.map(n => [n.id, n]));
    for (const targetId of entryStepIds) {
      const target = nodeById.get(targetId);
      if (!target) continue;
      const curve = bezierEdgePath(
        triggerPos.x + NODE_W,
        triggerPos.y + TRIGGER_H / 2,
        target.x,
        target.y + STEP_H / 2,
      );
      list.push({ key: `${TRIGGER_ID}->${targetId}`, fromId: TRIGGER_ID, toId: targetId, ...curve });
    }
    for (const node of nodes) {
      for (const targetId of node.nextStepIds) {
        const target = nodeById.get(targetId);
        if (!target) continue;
        const curve = bezierEdgePath(
          node.x + NODE_W,
          node.y + STEP_H / 2,
          target.x,
          target.y + STEP_H / 2,
        );
        list.push({ key: `${node.id}->${targetId}`, fromId: node.id, toId: targetId, ...curve });
      }
    }
    return list;
  }, [entryStepIds, nodes, triggerPos]);

  const submitSave = async (runAfterSave: boolean) => {
    if (!name.trim()) {
      setLocalError("请先在左上角或触发器面板填写工作流名称。");
      setSelectedId(TRIGGER_ID);
      return;
    }
    const invalidNode = nodes.find(n => !n.botId || !n.instruction.trim());
    if (nodes.length === 0) {
      setLocalError("请至少添加 1 个员工节点。");
      return;
    }
    if (invalidNode) {
      setLocalError(`请完善节点「${invalidNode.name || "未命名节点"}」的负责员工与执行指令。`);
      setSelectedId(invalidNode.id);
      return;
    }
    setLocalError("");
    await onSave({
      name: name.trim(),
      description: description.trim(),
      scheduleKind,
      dailyTime: scheduleKind === "daily" ? dailyTime : undefined,
      intervalMinutes: scheduleKind === "interval" ? intervalMinutes : undefined,
      triggerPosition: triggerPos,
      entryStepIds,
      steps: nodes,
    }, runAfterSave);
  };

  const selectedNode = selectedId === TRIGGER_ID ? null : (nodes.find(n => n.id === selectedId) ?? null);
  const triggerSummary = scheduleKind === "daily"
    ? `每天 ${dailyTime} 自动运行`
    : scheduleKind === "interval"
      ? (intervalMinutes % 60 === 0 ? `每 ${intervalMinutes / 60} 小时自动运行` : `每 ${intervalMinutes} 分钟自动运行`)
      : "仅手动一键启动";

  const activeError = localError || error;

  return (
    <div data-opc-workflow-canvas="" className="flex min-h-0 flex-1 flex-col overflow-hidden bg-app text-ink">
      {/* Top minimal studio toolbar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-hairline/50 bg-panel/80 px-4 py-2.5 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[12.5px] text-ink-secondary hover:bg-ink/[0.06] hover:text-ink"
          >
            <ArrowLeft size={14} /> 返回列表
          </button>
          <span className="h-4 w-px bg-hairline/60" />
          <input
            aria-label="工作流名称"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="输入工作流名称（如：每日爆款内容流水线）"
            className="h-8 w-[240px] rounded-lg border border-transparent bg-transparent px-2 text-[14px] font-semibold text-ink outline-none placeholder:font-normal placeholder:text-ink-tertiary hover:bg-ink/[0.04] focus:border-hairline/80 focus:bg-inset sm:w-[300px]"
          />
          <span className="hidden text-[11.5px] tabular-nums text-ink-tertiary md:inline">
            {nodes.length} 节点 · {edges.length} 连线
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={bots.length === 0}
            onClick={() => addNodeAfter(selectedNode ? selectedNode.id : TRIGGER_ID)}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-ink/[0.06] px-3 text-[12px] font-medium text-ink hover:bg-ink/[0.11] disabled:opacity-40"
          >
            <Plus size={13} /> 添加员工节点
          </button>
          <button
            type="button"
            onClick={handleAutoLayout}
            className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] text-ink-secondary hover:bg-ink/[0.06] hover:text-ink"
            title="一键按拓扑层级整齐排布所有节点"
          >
            <LayoutGrid size={13} /> 自动排布
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void submitSave(false)}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[12px] font-medium text-app hover:opacity-85 disabled:opacity-45"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            保存工作流
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void submitSave(true)}
            className="hidden h-8 items-center gap-1.5 rounded-full border border-hairline/80 px-3 text-[12px] font-medium text-ink hover:bg-ink/[0.05] disabled:opacity-45 sm:inline-flex"
          >
            <Play size={12.5} /> 保存并运行
          </button>
        </div>
      </div>

      {activeError && (
        <div role="alert" className="flex shrink-0 items-center justify-between gap-3 border-b border-danger/20 bg-danger/10 px-5 py-2 text-[12px] text-danger">
          <span>{activeError}</span>
          <button type="button" onClick={() => setLocalError("")} aria-label="关闭提示" className="rounded-full p-1 hover:bg-danger/15">
            <X size={13} />
          </button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Infinite dot-grid canvas */}
        <div
          ref={canvasRef}
          onPointerDown={handleCanvasPointerDown}
          onWheel={handleWheel}
          className={cn(
            "relative min-h-0 flex-1 overflow-hidden bg-app select-none touch-none",
            panning ? "cursor-grabbing" : "cursor-grab",
          )}
          style={{
            backgroundImage: "radial-gradient(color-mix(in srgb, var(--color-ink) 9%, transparent) 1px, transparent 1px)",
            backgroundSize: `${Math.round(24 * zoom)}px ${Math.round(24 * zoom)}px`,
            backgroundPosition: `${pan.x}px ${pan.y}px`,
          }}
        >
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }}
          >
            {/* Directed Bezier edges layer */}
            <svg
              aria-hidden="true"
              width={4000}
              height={3000}
              className="pointer-events-none absolute left-0 top-0 overflow-visible"
            >
              <defs>
                <marker id="opc-wf-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="var(--color-ink-tertiary)" />
                </marker>
                <marker id="opc-wf-arrow-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="var(--color-ink)" />
                </marker>
              </defs>

              {edges.map(edge => {
                const hovered = hoveredEdgeKey === edge.key;
                return (
                  <g key={edge.key}>
                    {/* Wide invisible hit stroke */}
                    <path
                      d={edge.d}
                      fill="none"
                      stroke="transparent"
                      strokeWidth="18"
                      className="pointer-events-auto cursor-pointer"
                      onMouseEnter={() => setHoveredEdgeKey(edge.key)}
                      onMouseLeave={() => setHoveredEdgeKey(prev => (prev === edge.key ? null : prev))}
                      onClick={(e) => {
                        e.stopPropagation();
                        disconnectEdge(edge.fromId, edge.toId);
                      }}
                    />
                    <path
                      d={edge.d}
                      fill="none"
                      stroke={hovered ? "var(--color-ink)" : "var(--color-ink-tertiary)"}
                      strokeOpacity={hovered ? 0.9 : 0.55}
                      strokeWidth={hovered ? 2.2 : 1.6}
                      markerEnd={hovered ? "url(#opc-wf-arrow-active)" : "url(#opc-wf-arrow)"}
                    />
                  </g>
                );
              })}

              {/* Live preview wire while dragging from output port */}
              {wiring && (
                <path
                  d={bezierEdgePath(wiring.startX, wiring.startY, wiring.curX, wiring.curY).d}
                  fill="none"
                  stroke={wiring.invalid ? "var(--color-danger)" : "var(--color-ink)"}
                  strokeWidth="2"
                  strokeDasharray="6 4"
                />
              )}
            </svg>

            {/* Edge midpoint disconnect badges */}
            {edges.map(edge => (
              <button
                key={`cut:${edge.key}`}
                type="button"
                aria-label="断开连线"
                title="点击断开连线"
                onMouseEnter={() => setHoveredEdgeKey(edge.key)}
                onMouseLeave={() => setHoveredEdgeKey(prev => (prev === edge.key ? null : prev))}
                onPointerDown={e => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  disconnectEdge(edge.fromId, edge.toId);
                }}
                style={{ left: edge.midX - 10, top: edge.midY - 10 }}
                className={cn(
                  "absolute flex size-5 items-center justify-center rounded-full border border-hairline/80 bg-panel text-ink-tertiary shadow-xs transition-opacity hover:border-danger hover:text-danger",
                  hoveredEdgeKey === edge.key ? "opacity-100" : "opacity-0 hover:opacity-100",
                )}
              >
                <X size={10.5} />
              </button>
            ))}

            {/* Trigger start node */}
            <div
              data-wf-node={TRIGGER_ID}
              onPointerDown={(e) => handleNodeDragStart(e, TRIGGER_ID)}
              style={{ left: triggerPos.x, top: triggerPos.y, width: NODE_W, height: TRIGGER_H }}
              className={cn(
                "absolute flex cursor-grab flex-col justify-between rounded-2xl bg-ink px-4 py-3.5 text-app shadow-md active:cursor-grabbing",
                selectedId === TRIGGER_ID && "ring-2 ring-accent ring-offset-2 ring-offset-app",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-app/75">
                  {scheduleKind === "manual" ? <Zap size={12} /> : <Clock size={12} />}
                  触发起点
                </span>
                <span className="rounded-full bg-app/15 px-2 py-0.5 text-[10.5px] text-app/90">
                  {entryStepIds.length} 入口
                </span>
              </div>
              <div>
                <div className="truncate text-[14px] font-semibold">{triggerSummary}</div>
                <div className="mt-0.5 truncate text-[11.5px] text-app/70">
                  从右侧圆点拉线连接到首位员工
                </div>
              </div>

              {/* Output port */}
              <button
                type="button"
                aria-label="从触发器拉出连线"
                title="按住拖向员工节点建立连线"
                onPointerDown={(e) => handlePortDragStart(e, TRIGGER_ID, triggerPos.x + NODE_W, triggerPos.y + TRIGGER_H / 2)}
                className="absolute -right-2 top-1/2 flex size-4 -translate-y-1/2 cursor-crosshair items-center justify-center rounded-full border-2 border-app bg-ink shadow-xs transition-transform hover:scale-125"
              />
            </div>

            {/* AI Employee step nodes */}
            {nodes.map(node => {
              const bot = botById.get(node.botId);
              const selected = selectedId === node.id;
              const orderNum = executionOrderMap.get(node.id);
              const isWireTarget = wiring?.hoverTargetId === node.id;

              return (
                <div
                  key={node.id}
                  data-wf-node={node.id}
                  onPointerDown={(e) => handleNodeDragStart(e, node.id)}
                  style={{ left: node.x, top: node.y, width: NODE_W, height: STEP_H }}
                  className={cn(
                    "group absolute flex cursor-grab flex-col justify-between rounded-2xl bg-panel/95 px-3.5 py-3 text-ink ring-[0.75px] ring-hairline/80 transition-shadow active:cursor-grabbing",
                    selected && "ring-2 ring-ink shadow-lg",
                    isWireTarget && !wiring?.invalid && "ring-2 ring-accent shadow-lg",
                    isWireTarget && wiring?.invalid && "ring-2 ring-danger",
                  )}
                >
                  {/* Input port */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute -left-2 top-1/2 size-3.5 -translate-y-1/2 rounded-full border-2 border-panel bg-ink-tertiary/70 transition-transform",
                      isWireTarget && !wiring?.invalid && "scale-125 bg-accent",
                      isWireTarget && wiring?.invalid && "scale-125 bg-danger",
                    )}
                  />

                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {bot ? (
                        <BotAvatar bot={bot} size={26} motion="none" motionKey={0} animated={false} />
                      ) : (
                        <span className="flex size-6.5 shrink-0 items-center justify-center rounded-full bg-ink/[0.08] text-[11px] text-ink-tertiary">
                          ?
                        </span>
                      )}
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-semibold text-ink">{node.name || "未命名步骤"}</div>
                        <div className="truncate text-[11px] text-ink-tertiary">{bot?.name ?? "请选择员工"}</div>
                      </div>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-1.5 py-0.5 text-[10.5px] tabular-nums",
                        orderNum ? "bg-ink/[0.07] font-medium text-ink-secondary" : "bg-danger/10 text-danger",
                      )}
                    >
                      {orderNum ? `#${orderNum}` : "未接入"}
                    </span>
                  </div>

                  <p className="line-clamp-2 text-[11.5px] leading-snug text-ink-secondary">
                    {node.instruction.trim() || "点击右侧面板填写该员工本步的任务指令…"}
                  </p>

                  <div className="flex items-center justify-between gap-2 text-[10.5px] text-ink-tertiary">
                    <div className="flex items-center gap-1.5">
                      {node.approvalGate && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-ink/[0.06] px-1.5 py-0.5 text-ink-secondary">
                          <ShieldCheck size={10} /> 人工审批
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onPointerDown={e => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        addNodeAfter(node.id);
                      }}
                      className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10.5px] text-ink-tertiary opacity-0 transition-opacity hover:bg-ink/[0.07] hover:text-ink group-hover:opacity-100"
                    >
                      <Plus size={10} /> 下一棒
                    </button>
                  </div>

                  {/* Output port */}
                  <button
                    type="button"
                    aria-label={`从「${node.name}」拉出连线`}
                    title="按住拖向下一节点建立连线"
                    onPointerDown={(e) => handlePortDragStart(e, node.id, node.x + NODE_W, node.y + STEP_H / 2)}
                    className="absolute -right-2 top-1/2 flex size-4 -translate-y-1/2 cursor-crosshair items-center justify-center rounded-full border-2 border-panel bg-ink shadow-xs transition-transform hover:scale-125"
                  />
                </div>
              );
            })}
          </div>

          {/* Bottom-left zoom & hint bar */}
          <div
            onPointerDown={e => e.stopPropagation()}
            className="absolute bottom-4 left-4 z-10 flex items-center gap-3 rounded-full bg-panel/90 px-3.5 py-1.5 text-[11.5px] text-ink-tertiary ring-[0.5px] ring-hairline/70 backdrop-blur-md"
          >
            <span className="hidden md:inline">从节点右侧圆点拉线连接 · 悬浮连线点 × 断开</span>
            <span className="hidden h-3 w-px bg-hairline/60 md:inline-block" />
            <button type="button" onClick={() => setZoom(z => Math.max(0.45, +(z - 0.1).toFixed(2)))} aria-label="缩小" className="p-0.5 hover:text-ink"><Minus size={12.5} /></button>
            <span className="min-w-9 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom(z => Math.min(1.5, +(z + 0.1).toFixed(2)))} aria-label="放大" className="p-0.5 hover:text-ink"><Plus size={12.5} /></button>
            <button type="button" onClick={() => fitView()} aria-label="自适应居中" title="自适应居中" className="p-0.5 hover:text-ink"><Maximize2 size={12} /></button>
          </div>
        </div>

        {/* Right property inspector drawer */}
        <OpcWorkflowInspector
          bots={bots}
          selectedId={selectedId}
          name={name}
          description={description}
          scheduleKind={scheduleKind}
          dailyTime={dailyTime}
          intervalMinutes={intervalMinutes}
          entryStepIds={entryStepIds}
          nodes={nodes}
          onNameChange={setName}
          onDescriptionChange={setDescription}
          onScheduleKindChange={setScheduleKind}
          onDailyTimeChange={setDailyTime}
          onIntervalMinutesChange={setIntervalMinutes}
          onPatchNode={(id, patch) => setNodes(prev => prev.map(n => (n.id === id ? { ...n, ...patch } : n)))}
          onAddNodeAfter={addNodeAfter}
          onRemoveNode={removeNode}
          onConnectEdge={connectEdge}
          onDisconnectEdge={disconnectEdge}
        />
      </div>
    </div>
  );
}
