import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import {
  Crown,
  FlaskConical,
  GitBranch,
  GripVertical,
  Maximize2,
  MessageSquare,
  Minus,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";
import type { OpcOrgChartState, OpcOrgNodeConfig } from "../../shared/donebot-opc";
import { BotAvatar } from "@/components/Avatar";
import { Switch } from "@/components/SettingsPrimitives";
import { cn } from "@/lib/cn";
import { useStore, type Bot } from "@/state/store";
import { formatCny } from "./market-api";
import { opcApi } from "./opc-api";
import { OpcSkillStudioModal } from "./OpcSkillStudioModal";
import {
  DEFAULT_ORG_GEOMETRY,
  flattenLayout,
  layoutOrganization,
  routeReportingEdges,
  type LayoutNode,
  type PaperclipOrgNode,
} from "./paperclip-org-layout";

const BOSS_ROOT_ID = "__boss__";
const DRAG_THRESHOLD_PX = 6;

function buildOrgTree(bots: readonly Bot[], org: OpcOrgChartState): PaperclipOrgNode[] {
  const byId = new Map(bots.map(b => [b.id, b]));
  const childrenByParent = new Map<string, Bot[]>();

  for (const bot of bots) {
    const rawParent = org.nodes[bot.id]?.reportsToBotId ?? null;
    const parentId = rawParent && rawParent !== bot.id && byId.has(rawParent) ? rawParent : BOSS_ROOT_ID;
    const list = childrenByParent.get(parentId) ?? [];
    list.push(bot);
    childrenByParent.set(parentId, list);
  }

  const visited = new Set<string>();
  const toNode = (bot: Bot): PaperclipOrgNode => {
    visited.add(bot.id);
    const children = (childrenByParent.get(bot.id) ?? []).filter(c => !visited.has(c.id));
    return {
      id: bot.id,
      name: bot.name,
      role: org.nodes[bot.id]?.roleTitle || bot.title || (bot.chiefOfStaff ? "总控主管" : "AI 员工"),
      status: bot.busy ? "working" : "idle",
      reports: children.map(toNode),
    };
  };

  const bossChildren = (childrenByParent.get(BOSS_ROOT_ID) ?? []).map(toNode);
  for (const bot of bots) {
    if (!visited.has(bot.id)) bossChildren.push(toNode(bot));
  }

  return [{
    id: BOSS_ROOT_ID,
    name: "你（老板）",
    role: org.enforcementMode === "enforced" ? "最终拍板 · 按架构强约束" : "最终拍板 · 自由协作",
    status: "owner",
    reports: bossChildren,
  }];
}

function roundedOrthogonalPath(points: ReadonlyArray<{ x: number; y: number }>, radius = 8): string {
  if (points.length < 2) return "";
  const parts: string[] = [`M ${points[0]!.x} ${points[0]!.y}`];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const next = points[i + 1]!;
    const dx1 = curr.x - prev.x;
    const dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x;
    const dy2 = next.y - curr.y;
    const len1 = Math.hypot(dx1, dy1);
    const len2 = Math.hypot(dx2, dy2);
    if (len1 < 1 || len2 < 1) {
      parts.push(`L ${curr.x} ${curr.y}`);
      continue;
    }
    const r = Math.min(radius, len1 / 2, len2 / 2);
    const ax = curr.x - (dx1 / len1) * r;
    const ay = curr.y - (dy1 / len1) * r;
    const bx = curr.x + (dx2 / len2) * r;
    const by = curr.y + (dy2 / len2) * r;
    parts.push(`L ${ax} ${ay} Q ${curr.x} ${curr.y} ${bx} ${by}`);
  }
  const last = points[points.length - 1]!;
  parts.push(`L ${last.x} ${last.y}`);
  return parts.join(" ");
}

function handoffCurve(from: LayoutNode, to: LayoutNode): string {
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x;
  const y2 = to.y + to.height / 2;
  if (x2 >= x1 - 12) {
    const mid = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
  }
  const topY = Math.min(from.y, to.y) - 26;
  return `M ${from.x + from.width / 2} ${from.y} C ${from.x + from.width / 2} ${topY}, ${to.x + to.width / 2} ${topY}, ${to.x + to.width / 2} ${to.y}`;
}

function isDescendantInOrg(org: OpcOrgChartState, ancestorId: string, candidateId: string): boolean {
  if (candidateId === BOSS_ROOT_ID) return false;
  const visited = new Set<string>();
  let cursor: string | null = candidateId;
  while (cursor && !visited.has(cursor)) {
    if (cursor === ancestorId) return true;
    visited.add(cursor);
    cursor = org.nodes[cursor]?.reportsToBotId ?? null;
  }
  return false;
}

interface ActiveDragState {
  botId: string;
  startClientX: number;
  startClientY: number;
  clientX: number;
  clientY: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  moved: boolean;
}

export function OpcOrgChartView({
  bots,
  org,
  onOrgChange,
}: {
  bots: Bot[];
  org: OpcOrgChartState;
  onOrgChange: (next: OpcOrgChartState) => void;
}) {
  const { dispatch } = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 960, height: 560 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [activeDrag, setActiveDrag] = useState<ActiveDragState | null>(null);
  const [hoverTargetId, setHoverTargetId] = useState<string | null>(null);
  const [spendByBot, setSpendByBot] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [labBot, setLabBot] = useState<Bot | null>(null);

  const orgRef = useRef(org);
  orgRef.current = org;
  const panRef = useRef(pan);
  panRef.current = pan;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const justDraggedRef = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setViewport({ width: Math.max(360, el.clientWidth), height: Math.max(360, el.clientHeight) });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    void opcApi.getSpend(30).then(res => {
      if (!res.available) return;
      const map: Record<string, number> = {};
      for (const row of res.bots) map[row.botId] = row.totalCost;
      setSpendByBot(map);
    }).catch(() => {});
  }, []);

  const botById = useMemo(() => new Map(bots.map(b => [b.id, b])), [bots]);

  const layout = useMemo(() => {
    const roots = buildOrgTree(bots, org);
    const block = layoutOrganization(roots, viewport, DEFAULT_ORG_GEOMETRY);
    const nodes = flattenLayout(block.roots);
    const routes = routeReportingEdges(block.roots, DEFAULT_ORG_GEOMETRY.gap).map(route => ({
      ...route,
      roundedPath: roundedOrthogonalPath(route.points, 8),
    }));
    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const handoffEdges: Array<{ id: string; path: string; fromId: string; toId: string }> = [];
    for (const bot of bots) {
      const from = nodeById.get(bot.id);
      if (!from) continue;
      for (const targetId of org.nodes[bot.id]?.handoffToBotIds ?? []) {
        const to = nodeById.get(targetId);
        if (!to || targetId === bot.id) continue;
        handoffEdges.push({
          id: `${bot.id}->${targetId}`,
          path: handoffCurve(from, to),
          fromId: bot.id,
          toId: targetId,
        });
      }
    }
    return { block, nodes, nodeById, routes, handoffEdges };
  }, [bots, org, viewport]);

  const layoutNodesRef = useRef(layout.nodes);
  layoutNodesRef.current = layout.nodes;

  const updateNode = useCallback(async (botId: string, patch: Partial<Omit<OpcOrgNodeConfig, "botId">>) => {
    const previous = orgRef.current;
    // Optimistically update local org state so reparenting feels instantaneous.
    const existing = previous.nodes[botId] ?? {
      botId,
      reportsToBotId: null,
      handoffToBotIds: [],
      requireBossApproval: false,
      allowCrossConsult: true,
    };
    const optimistic: OpcOrgChartState = {
      ...previous,
      nodes: {
        ...previous.nodes,
        [botId]: {
          ...existing,
          ...patch,
          handoffToBotIds: patch.handoffToBotIds ?? existing.handoffToBotIds,
        },
      },
      updatedAt: Date.now(),
    };
    onOrgChange(optimistic);
    setSaving(true);
    setError("");
    try {
      const res = await opcApi.saveOrgNode(botId, patch);
      onOrgChange(res.org);
    } catch (err) {
      onOrgChange(previous);
      setError(err instanceof Error ? err.message : "保存组织架构失败。");
    } finally {
      setSaving(false);
    }
  }, [onOrgChange]);

  const canvasOriginOffset = useMemo(() => {
    const x = Math.max(0, Math.round((viewport.width - layout.block.width * zoom) / 2));
    const y = Math.max(12, Math.round((viewport.height - layout.block.height * zoom) / 4));
    return { x, y };
  }, [viewport.width, viewport.height, layout.block.width, layout.block.height, zoom]);

  const originOffsetRef = useRef(canvasOriginOffset);
  originOffsetRef.current = canvasOriginOffset;

  const hitTestNodeAtClient = useCallback((clientX: number, clientY: number, excludeId: string): string | null => {
    const el = containerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const curZoom = zoomRef.current;
    const worldX = (clientX - rect.left - originOffsetRef.current.x - panRef.current.x) / curZoom;
    const worldY = (clientY - rect.top - originOffsetRef.current.y - panRef.current.y) / curZoom;
    for (const node of layoutNodesRef.current) {
      if (node.id === excludeId) continue;
      if (
        worldX >= node.x - 10
        && worldX <= node.x + node.width + 10
        && worldY >= node.y - 10
        && worldY <= node.y + node.height + 10
      ) {
        return node.id;
      }
    }
    return null;
  }, []);

  const handleNodePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>, node: LayoutNode) => {
    if (e.button !== 0 || node.id === BOSS_ROOT_ID) return;
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const startState: ActiveDragState = {
      botId: node.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      clientX: e.clientX,
      clientY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      moved: false,
    };

    const dragRef = { current: startState };
    let currentTarget: string | null = null;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - dragRef.current.startClientX;
      const dy = ev.clientY - dragRef.current.startClientY;
      const moved = dragRef.current.moved || Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX;
      dragRef.current = {
        ...dragRef.current,
        clientX: ev.clientX,
        clientY: ev.clientY,
        moved,
      };
      if (moved) {
        setActiveDrag(dragRef.current);
        currentTarget = hitTestNodeAtClient(ev.clientX, ev.clientY, node.id);
        setHoverTargetId(currentTarget);
      }
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      setActiveDrag(null);
      setHoverTargetId(null);
    };

    const onCancel = () => {
      cleanup();
    };

    const onUp = () => {
      const finished = dragRef.current;
      const targetId = currentTarget;
      cleanup();
      if (!finished.moved) {
        setSelectedBotId(node.id);
        return;
      }
      justDraggedRef.current = true;
      window.setTimeout(() => { justDraggedRef.current = false; }, 0);
      if (!targetId || targetId === finished.botId) return;
      if (isDescendantInOrg(orgRef.current, finished.botId, targetId)) {
        setError("不能把员工拖到自己的下属名下（会形成循环汇报）。");
        return;
      }
      const nextReportsTo = targetId === BOSS_ROOT_ID ? null : targetId;
      const currentReportsTo = orgRef.current.nodes[finished.botId]?.reportsToBotId ?? null;
      if (currentReportsTo === nextReportsTo) return;
      void updateNode(finished.botId, { reportsToBotId: nextReportsTo });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }, [hitTestNodeAtClient, updateNode]);

  const handleCanvasPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const initPan = panRef.current;
    let dragged = false;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragged && Math.hypot(dx, dy) >= 4) {
        dragged = true;
        setPanning(true);
      }
      if (dragged) {
        setPan({ x: initPan.x + dx, y: initPan.y + dy });
      }
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setPanning(false);
      if (!dragged) setSelectedBotId(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, []);

  const handleWheel = useCallback((e: ReactWheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.08 : 0.08;
      setZoom(z => Math.max(0.5, Math.min(1.5, +(z + delta).toFixed(2))));
    } else {
      setPan(prev => ({ x: prev.x - e.deltaX, y: prev.y - e.deltaY }));
    }
  }, []);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const selectedBot = selectedBotId ? botById.get(selectedBotId) ?? null : null;
  const selectedCfg: OpcOrgNodeConfig | null = selectedBot
    ? (org.nodes[selectedBot.id] ?? {
      botId: selectedBot.id,
      reportsToBotId: null,
      handoffToBotIds: [],
      roleTitle: selectedBot.title || undefined,
      requireBossApproval: false,
      allowCrossConsult: true,
    })
    : null;

  const draggedBot = activeDrag ? botById.get(activeDrag.botId) ?? null : null;
  const hoverInvalid = activeDrag && hoverTargetId
    ? isDescendantInOrg(org, activeDrag.botId, hoverTargetId)
    : false;
  const hoverTargetName = hoverTargetId === BOSS_ROOT_ID
    ? "你（老板）"
    : hoverTargetId
      ? (botById.get(hoverTargetId)?.name ?? "上级")
      : null;

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {/* Main interactive org chart surface */}
      <div
        ref={containerRef}
        data-opc-org-chart=""
        onPointerDown={handleCanvasPointerDown}
        onWheel={handleWheel}
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden bg-app select-none touch-none",
          panning ? "cursor-grabbing" : "cursor-grab",
        )}
        style={{
          backgroundImage: "radial-gradient(color-mix(in srgb, var(--color-ink) 9%, transparent) 1px, transparent 1px)",
          backgroundSize: `${Math.round(24 * zoom)}px ${Math.round(24 * zoom)}px`,
          backgroundPosition: `${pan.x + canvasOriginOffset.x}px ${pan.y + canvasOriginOffset.y}px`,
        }}
      >
        {error && (
          <div role="alert" className="absolute left-5 right-5 top-4 z-20 mx-auto flex max-w-xl items-center justify-between gap-3 rounded-xl bg-danger/12 px-4 py-2.5 text-[12.5px] text-danger backdrop-blur-sm">
            <span>{error}</span>
            <button type="button" onClick={() => setError("")} aria-label="关闭错误" className="rounded-full p-1 hover:bg-danger/15">
              <X size={13.5} />
            </button>
          </div>
        )}

        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{
            width: layout.block.width,
            height: layout.block.height,
            transform: `translate3d(${canvasOriginOffset.x + pan.x}px, ${canvasOriginOffset.y + pan.y}px, 0) scale(${zoom})`,
          }}
        >
          {/* SVG reporting tracks (solid rounded) & workflow handoff arcs (dashed) */}
          <svg
            aria-hidden="true"
            width={Math.max(layout.block.width, 800)}
            height={Math.max(layout.block.height, 600)}
            className="pointer-events-none absolute inset-0 overflow-visible"
          >
            <defs>
              <marker id="opc-handoff-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="var(--color-accent)" fillOpacity="0.7" />
              </marker>
            </defs>
            {layout.routes.map(route => (
              <path
                key={`${route.parent.id}->${route.child.id}`}
                d={route.roundedPath}
                fill="none"
                stroke="var(--color-hairline)"
                strokeWidth="1.35"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
            {layout.handoffEdges.map(edge => (
              <path
                key={edge.id}
                d={edge.path}
                fill="none"
                stroke="var(--color-accent)"
                strokeOpacity="0.65"
                strokeWidth="1.4"
                strokeDasharray="5 4"
                markerEnd="url(#opc-handoff-arrow)"
              />
            ))}
          </svg>

          {/* Org node cards */}
          {layout.nodes.map(node => {
            const isBoss = node.id === BOSS_ROOT_ID;
            const bot = isBoss ? null : botById.get(node.id) ?? null;
            const cfg = bot ? org.nodes[bot.id] : undefined;
            const selected = selectedBotId === node.id;
            const isDraggingSource = activeDrag?.botId === node.id && activeDrag.moved;
            const isDropTarget = hoverTargetId === node.id && Boolean(activeDrag?.moved);
            const spend = bot ? (spendByBot[bot.id] ?? 0) : 0;

            return (
              <div
                key={node.id}
                data-org-node={node.id}
                tabIndex={isBoss ? undefined : 0}
                onPointerDown={(e) => handleNodePointerDown(e, node)}
                onClick={(e) => {
                  if (isBoss || justDraggedRef.current) return;
                  e.stopPropagation();
                  setSelectedBotId(node.id);
                }}
                onKeyDown={(e) => {
                  if (!isBoss && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    setSelectedBotId(node.id);
                  }
                }}
                style={{
                  left: node.x,
                  top: node.y,
                  width: node.width,
                  height: node.height,
                }}
                className={cn(
                  "group absolute flex flex-col justify-between rounded-2xl px-3.5 py-3 transition-[box-shadow,transform,opacity] duration-150 select-none",
                  isBoss
                    ? "cursor-default bg-ink text-app shadow-sm"
                    : "cursor-grab bg-panel/95 text-ink ring-[0.75px] ring-hairline/75 hover:ring-ink/40 active:cursor-grabbing",
                  selected && !isBoss && "ring-2 ring-ink shadow-md",
                  isDraggingSource && "opacity-35 ring-dashed ring-1 ring-ink/30",
                  isDropTarget && !hoverInvalid && "scale-[1.03] ring-2 ring-accent shadow-lg",
                  isDropTarget && hoverInvalid && "ring-2 ring-danger",
                )}
              >
                <div className="flex items-center gap-2.5">
                  {isBoss ? (
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-app/15">
                      <Crown size={15} />
                    </span>
                  ) : bot ? (
                    <BotAvatar bot={bot} size={32} motion="none" motionKey={0} animated={false} />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13.5px] font-semibold">{node.name}</span>
                      {!isBoss && bot?.busy && (
                        <span aria-label="工作中" className="size-1.5 shrink-0 rounded-full bg-emerald-500 animate-pulse" />
                      )}
                    </div>
                    <div className={cn("truncate text-[11.5px]", isBoss ? "text-app/75" : "text-ink-tertiary")}>
                      {node.role}
                    </div>
                  </div>
                  {!isBoss && (
                    <GripVertical size={13} className="shrink-0 text-ink-tertiary/40 transition-opacity group-hover:text-ink-tertiary" aria-hidden="true" />
                  )}
                </div>

                {!isBoss && bot && (
                  <div className="flex items-center justify-between gap-2 pt-1 text-[11px] text-ink-tertiary">
                    <div className="flex items-center gap-1.5 truncate">
                      {cfg?.requireBossApproval && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-ink/[0.06] px-1.5 py-0.5 text-[10.5px] text-ink-secondary">
                          <ShieldCheck size={10.5} /> 需拍板
                        </span>
                      )}
                      {(cfg?.handoffToBotIds?.length ?? 0) > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-[10.5px] text-ink-tertiary">
                          <GitBranch size={10.5} /> 交接 {cfg!.handoffToBotIds.length}
                        </span>
                      )}
                    </div>
                    <span className="shrink-0 tabular-nums">{formatCny(spend)}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Floating drag ghost card (Pointer Events — rock-solid on macOS Electron) */}
        {activeDrag?.moved && draggedBot && (
          <div
            className="pointer-events-none fixed z-50"
            style={{
              left: activeDrag.clientX - activeDrag.offsetX,
              top: activeDrag.clientY - activeDrag.offsetY,
              width: activeDrag.width,
            }}
          >
            <div className="flex items-center gap-2.5 rounded-2xl bg-panel px-3.5 py-3 text-ink shadow-2xl ring-2 ring-ink/70">
              <BotAvatar bot={draggedBot} size={30} motion="none" motionKey={0} animated={false} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-semibold">{draggedBot.name}</div>
                <div className="truncate text-[11.5px] text-ink-tertiary">
                  {hoverTargetName
                    ? hoverInvalid
                      ? "不能汇报给自己的下属"
                      : `松手汇报给「${hoverTargetName}」`
                    : "拖到老板或其他员工卡片上松手"}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Bottom-left minimal legend & zoom bar (anchored inside canvas, never overlaps sidebar) */}
        <div
          onPointerDown={e => e.stopPropagation()}
          className="absolute bottom-4 left-4 z-10 flex items-center gap-3 rounded-full bg-panel/90 px-3.5 py-1.5 text-[11.5px] text-ink-tertiary ring-[0.5px] ring-hairline/70 backdrop-blur-md"
        >
          <span className="hidden items-center gap-1.5 sm:inline-flex">
            <span className="h-px w-4 bg-hairline" /> 拖动员工卡片调整汇报线
          </span>
          <span className="hidden items-center gap-1.5 md:inline-flex">
            <span className="h-px w-4 border-t border-dashed border-accent" /> 交接流水线
          </span>
          <span className="hidden h-3 w-px bg-hairline/60 sm:inline-block" />
          <button type="button" onClick={() => setZoom(z => Math.max(0.5, +(z - 0.1).toFixed(2)))} aria-label="缩小" className="p-0.5 hover:text-ink"><Minus size={12.5} /></button>
          <span className="min-w-9 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => setZoom(z => Math.min(1.5, +(z + 0.1).toFixed(2)))} aria-label="放大" className="p-0.5 hover:text-ink"><Plus size={12.5} /></button>
          <button type="button" onClick={resetView} aria-label="重置视图" title="重置缩放与位置" className="p-0.5 hover:text-ink"><Maximize2 size={12} /></button>
        </div>
      </div>

      {/* Right minimal inspector drawer for selected employee */}
      {selectedBot && selectedCfg && (
        <aside
          aria-label={`${selectedBot.name} 岗位与汇报规则`}
          className="flex w-[310px] shrink-0 flex-col border-l border-hairline/60 bg-panel"
        >
          <div className="flex items-center justify-between border-b border-hairline/50 px-5 py-4">
            <div className="flex min-w-0 items-center gap-2.5">
              <BotAvatar bot={selectedBot} size={28} />
              <div className="min-w-0">
                <div className="truncate text-[14px] font-semibold text-ink">{selectedBot.name}</div>
                <div className="text-[11.5px] text-ink-tertiary">岗位与工作流约束</div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelectedBotId(null)}
              aria-label="关闭属性面板"
              className="rounded-full p-1 text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink"
            >
              <X size={15} />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5 text-[12.5px]">
            <label className="block space-y-1.5">
              <span className="text-[11.5px] font-medium text-ink-tertiary">岗位头衔</span>
              <input
                key={`title:${selectedBot.id}`}
                defaultValue={selectedCfg.roleTitle ?? selectedBot.title ?? ""}
                onBlur={e => {
                  const val = e.target.value.trim();
                  if (val !== (selectedCfg.roleTitle ?? "")) {
                    void updateNode(selectedBot.id, { roleTitle: val });
                  }
                }}
                placeholder="如：主编 / 选题侦察 / 视觉设计师"
                className="h-8 w-full rounded-lg border border-hairline/70 bg-inset px-2.5 text-[12.5px] text-ink outline-none placeholder:text-ink-tertiary focus:border-ink/40"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-[11.5px] font-medium text-ink-tertiary">直属上级（汇报对象）</span>
              <select
                value={selectedCfg.reportsToBotId ?? BOSS_ROOT_ID}
                disabled={saving}
                onChange={e => {
                  const val = e.target.value === BOSS_ROOT_ID ? null : e.target.value;
                  void updateNode(selectedBot.id, { reportsToBotId: val });
                }}
                className="h-8 w-full rounded-lg border border-hairline/70 bg-inset px-2.5 text-[12.5px] text-ink outline-none focus:border-ink/40"
              >
                <option value={BOSS_ROOT_ID}>你（老板 · 直接汇报）</option>
                {bots.filter(b => b.id !== selectedBot.id).map(b => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
              <p className="text-[11.5px] leading-relaxed text-ink-tertiary">
                开启「按架构约束」后，下属仅向上级汇报，上级可向下属派单与打回返工。
              </p>
            </label>

            <div className="space-y-2 border-t border-hairline/40 pt-4">
              <div className="text-[11.5px] font-medium text-ink-tertiary">流水线交接下一棒（可选）</div>
              <p className="text-[11.5px] text-ink-tertiary">
                勾选后在架构图绘制虚线箭头，允许本岗位完成后直接向其交接任务。
              </p>
              <div className="space-y-1 pt-1">
                {bots.filter(b => b.id !== selectedBot.id).length === 0 ? (
                  <p className="text-[12px] text-ink-tertiary">暂无其他员工可配置交接。</p>
                ) : (
                  bots.filter(b => b.id !== selectedBot.id).map(candidate => {
                    const checked = selectedCfg.handoffToBotIds.includes(candidate.id);
                    return (
                      <label
                        key={candidate.id}
                        className="flex cursor-pointer items-center justify-between rounded-lg px-2 py-1.5 hover:bg-ink/[0.04]"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <BotAvatar bot={candidate} size={20} motion="none" motionKey={0} animated={false} />
                          <span className="truncate text-[12.5px] text-ink">{candidate.name}</span>
                        </span>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={saving}
                          onChange={e => {
                            const next = e.target.checked
                              ? [...selectedCfg.handoffToBotIds, candidate.id]
                              : selectedCfg.handoffToBotIds.filter(id => id !== candidate.id);
                            void updateNode(selectedBot.id, { handoffToBotIds: next });
                          }}
                          className="size-3.5 rounded accent-ink"
                        />
                      </label>
                    );
                  })
                )}
              </div>
            </div>

            <div className="space-y-3 border-t border-hairline/40 pt-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[12.5px] font-medium text-ink">产物须老板拍板</div>
                  <div className="text-[11.5px] text-ink-tertiary">关键产出提醒先送老板台审核</div>
                </div>
                <Switch
                  checked={Boolean(selectedCfg.requireBossApproval)}
                  disabled={saving}
                  onClick={() => void updateNode(selectedBot.id, { requireBossApproval: !selectedCfg.requireBossApproval })}
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[12.5px] font-medium text-ink">允许跨岗咨询</div>
                  <div className="text-[11.5px] text-ink-tertiary">强约束下仍允许 consult 轻量询问</div>
                </div>
                <Switch
                  checked={selectedCfg.allowCrossConsult !== false}
                  disabled={saving}
                  onClick={() => void updateNode(selectedBot.id, { allowCrossConsult: selectedCfg.allowCrossConsult === false })}
                />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 border-t border-hairline/50 px-5 py-3.5">
            <button
              type="button"
              onClick={() => dispatch({ type: "select", id: selectedBot.id })}
              className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full bg-ink/[0.06] text-[12px] font-medium text-ink hover:bg-ink/[0.11]"
            >
              <MessageSquare size={13} /> 对话
            </button>
            <button
              type="button"
              onClick={() => setLabBot(selectedBot)}
              className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full bg-ink text-[12px] font-medium text-app hover:opacity-85"
            >
              <FlaskConical size={13} /> 能力实验室
            </button>
          </div>
        </aside>
      )}

      {labBot && (
        <OpcSkillStudioModal bot={labBot} open onClose={() => setLabBot(null)} />
      )}
    </div>
  );
}
