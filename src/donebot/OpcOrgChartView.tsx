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
  Maximize2,
  Minus,
  Plus,
  X,
} from "lucide-react";
import type { OpcOrgChartState, OpcOrgNodeConfig } from "../../shared/donebot-opc";
import { validateOrgReportsTo } from "../../shared/donebot-opc-org-sync";
import { BotAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import type { TeamMapSection } from "@/lib/team-map";
import type { Bot } from "@/state/store";
import { opcApi } from "./opc-api";
import { OpcDeptMenu, OpcOrgNodeCard } from "./OpcOrgCard";
import { OpcOrgInspector } from "./OpcOrgInspector";
import { OpcSkillStudioModal } from "./OpcSkillStudioModal";
import {
  computeDepartmentClusters,
  layoutTopDownOrgChart,
  type DepartmentClusterBox,
  type TopDownLayoutNode,
  type TopDownOrgInputNode,
} from "./paperclip-org-layout";

const BOSS_ROOT_ID = "__boss__";
const DRAG_THRESHOLD_PX = 6;

function buildTopDownOrgTree(bots: readonly Bot[], org: OpcOrgChartState): TopDownOrgInputNode {
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
  const toNode = (bot: Bot): TopDownOrgInputNode => {
    visited.add(bot.id);
    const children = (childrenByParent.get(bot.id) ?? []).filter(c => !visited.has(c.id));
    return {
      id: bot.id,
      name: bot.name,
      role: org.nodes[bot.id]?.roleTitle || bot.title || (bot.chiefOfStaff ? (bot.section?.trim() ? "部门负责人" : "系统总协调") : "AI 员工"),
      status: bot.busy ? "working" : "idle",
      section: bot.section?.trim() || "",
      reports: children.map(toNode),
    };
  };

  const bossChildren = (childrenByParent.get(BOSS_ROOT_ID) ?? []).map(toNode);
  for (const bot of bots) {
    if (!visited.has(bot.id)) bossChildren.push(toNode(bot));
  }

  const bossSubtitle = org.enforcementMode === "enforced"
    ? (org.allowChiefCrossDispatch ? "最终拍板 · 强约束（跨部门负责人沟通）" : "最终拍板 · 强约束（总协调统筹跨部门）")
    : "最终拍板 · 自由协作";

  return {
    id: BOSS_ROOT_ID,
    name: "你（老板）",
    role: bossSubtitle,
    status: "owner",
    section: "",
    reports: bossChildren,
  };
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
  moved: boolean;
}

export function OpcOrgChartView({
  bots,
  sections,
  org,
  taggedBotIds = [],
  sent,
  bottomInset = 0,
  onOrgChange,
  onMoveToDepartment,
  onToggleChief,
  onRenameGeneralDepartment,
  onEditTeam,
  onInstructions,
  onMemory,
  onDeleteTeam,
}: {
  bots: Bot[];
  sections: TeamMapSection<Bot>[];
  org: OpcOrgChartState;
  taggedBotIds?: string[];
  sent?: { botIds: string[]; key: number } | null;
  bottomInset?: number;
  onOrgChange: (next: OpcOrgChartState) => void;
  onMoveToDepartment: (bot: Bot, destinationSection: string) => Promise<void>;
  onToggleChief: (bot: Bot, chiefOfStaff: boolean) => Promise<void>;
  onRenameGeneralDepartment: (currentLabel: string) => void;
  onEditTeam: (sectionKey: string, rename?: boolean) => void;
  onInstructions: (sectionKey: string, label: string) => void;
  onMemory: (sectionKey: string, label: string) => void;
  onDeleteTeam: (sectionKey: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 960, height: 560 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [activeDrag, setActiveDrag] = useState<ActiveDragState | null>(null);
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const [hoverDeptKey, setHoverDeptKey] = useState<string | null>(null);
  const [spendByBot, setSpendByBot] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [labBot, setLabBot] = useState<Bot | null>(null);

  const orgRef = useRef(org);
  orgRef.current = org;
  const botsRef = useRef(bots);
  botsRef.current = bots;
  const panRef = useRef(pan);
  panRef.current = pan;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const justDraggedRef = useRef(false);

  const generalDeptLabel = org.generalDepartmentName?.trim() || "通用";
  const deptLabelOfKey = useCallback(
    (key: string) => (key.trim() ? key.trim() : generalDeptLabel),
    [generalDeptLabel],
  );

  const hasNamedDepartments = useMemo(
    () => sections.some(s => Boolean(s.key)),
    [sections],
  );

  const sectionOptions = useMemo(() => {
    const list: Array<{ key: string; label: string }> = [{ key: "", label: generalDeptLabel }];
    const seen = new Set<string>([""]);
    for (const s of sections) {
      if (!s.key || seen.has(s.key)) continue;
      seen.add(s.key);
      list.push({ key: s.key, label: s.key });
    }
    return list;
  }, [sections, generalDeptLabel]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setViewport({ width: Math.max(360, el.clientWidth), height: Math.max(320, el.clientHeight) });
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
    const rootInput = buildTopDownOrgTree(bots, org);
    const tree = layoutTopDownOrgChart(rootInput);
    const nodeById = new Map(tree.nodes.map(n => [n.id, n]));
    const deptBoxes: DepartmentClusterBox[] = hasNamedDepartments
      ? computeDepartmentClusters(tree.nodes, [...new Set(["", ...sections.map(s => s.key)])], tree.width)
      : [];
    const maxBoxRight = deptBoxes.length
      ? Math.max(...deptBoxes.map(b => b.x + b.width + 64))
      : 0;
    const totalWidth = Math.max(tree.width, maxBoxRight);
    return { ...tree, width: totalWidth, nodeById, deptBoxes };
  }, [bots, org, hasNamedDepartments, sections]);

  const layoutNodesRef = useRef(layout.nodes);
  layoutNodesRef.current = layout.nodes;
  const deptBoxesRef = useRef(layout.deptBoxes);
  deptBoxesRef.current = layout.deptBoxes;

  const canvasOriginOffset = useMemo(() => {
    const usableH = Math.max(240, viewport.height - bottomInset);
    const x = Math.max(0, Math.round((viewport.width - layout.width * zoom) / 2));
    const y = Math.max(12, Math.round((usableH - layout.height * zoom) / 4));
    return { x, y };
  }, [viewport.width, viewport.height, bottomInset, layout.width, layout.height, zoom]);

  const originOffsetRef = useRef(canvasOriginOffset);
  originOffsetRef.current = canvasOriginOffset;

  const clientToWorld = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return {
      x: (clientX - rect.left - originOffsetRef.current.x - panRef.current.x) / zoomRef.current,
      y: (clientY - rect.top - originOffsetRef.current.y - panRef.current.y) / zoomRef.current,
    };
  }, []);

  const updateNode = useCallback(async (botId: string, patch: Partial<Omit<OpcOrgNodeConfig, "botId">>) => {
    const previous = orgRef.current;
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

  const handleMoveDept = useCallback(async (bot: Bot, destinationSection: string) => {
    setSaving(true);
    setError("");
    try {
      await onMoveToDepartment(bot, destinationSection);
    } catch (err) {
      setError(err instanceof Error ? err.message : "切换部门失败。");
    } finally {
      setSaving(false);
    }
  }, [onMoveToDepartment]);

  const handleToggleChief = useCallback(async (bot: Bot, nextChief: boolean) => {
    setSaving(true);
    setError("");
    try {
      await onToggleChief(bot, nextChief);
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新部门负责人失败。");
    } finally {
      setSaving(false);
    }
  }, [onToggleChief]);

  const hitTestDrop = useCallback((clientX: number, clientY: number, draggedBotId: string, draggedSection: string) => {
    const pt = clientToWorld(clientX, clientY);
    for (const node of layoutNodesRef.current) {
      if (node.id === draggedBotId) continue;
      if (
        pt.x >= node.x - 8
        && pt.x <= node.x + node.width + 8
        && pt.y >= node.y - 8
        && pt.y <= node.y + node.height + 8
      ) {
        return { nodeId: node.id, deptKey: null as string | null };
      }
    }
    for (const box of deptBoxesRef.current) {
      if (box.sectionKey === draggedSection) continue;
      if (pt.x >= box.x && pt.x <= box.x + box.width && pt.y >= box.y && pt.y <= box.y + box.height) {
        return { nodeId: null as string | null, deptKey: box.sectionKey };
      }
    }
    return { nodeId: null as string | null, deptKey: null as string | null };
  }, [clientToWorld]);

  const handleNodePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>, node: TopDownLayoutNode) => {
    if (e.button !== 0 || node.id === BOSS_ROOT_ID) return;
    if ((e.target as HTMLElement).closest("button, a, input, select, details")) return;
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const dragRef: { current: ActiveDragState } = {
      current: {
        botId: node.id,
        startClientX: e.clientX,
        startClientY: e.clientY,
        clientX: e.clientX,
        clientY: e.clientY,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        width: rect.width,
        moved: false,
      },
    };
    let curHit: { nodeId: string | null; deptKey: string | null } = { nodeId: null, deptKey: null };

    const onMove = (ev: PointerEvent) => {
      const moved = dragRef.current.moved
        || Math.hypot(ev.clientX - dragRef.current.startClientX, ev.clientY - dragRef.current.startClientY) >= DRAG_THRESHOLD_PX;
      dragRef.current = { ...dragRef.current, clientX: ev.clientX, clientY: ev.clientY, moved };
      if (moved) {
        setActiveDrag(dragRef.current);
        curHit = hitTestDrop(ev.clientX, ev.clientY, node.id, node.section);
        setHoverNodeId(curHit.nodeId);
        setHoverDeptKey(curHit.deptKey);
      }
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") cleanup();
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", cleanup);
      window.removeEventListener("keydown", onKeyDown);
      setActiveDrag(null);
      setHoverNodeId(null);
      setHoverDeptKey(null);
    };

    const onUp = () => {
      const finished = dragRef.current;
      const hit = curHit;
      cleanup();
      if (!finished.moved) {
        setSelectedBotId(node.id);
        return;
      }
      justDraggedRef.current = true;
      window.setTimeout(() => { justDraggedRef.current = false; }, 0);

      if (hit.nodeId && hit.nodeId !== finished.botId) {
        const nextReportsTo = hit.nodeId === BOSS_ROOT_ID ? null : hit.nodeId;
        const refusal = validateOrgReportsTo(finished.botId, nextReportsTo, orgRef.current, botsRef.current);
        if (refusal) {
          setError(refusal);
          return;
        }
        if ((orgRef.current.nodes[finished.botId]?.reportsToBotId ?? null) !== nextReportsTo) {
          void updateNode(finished.botId, { reportsToBotId: nextReportsTo });
        }
        return;
      }
      if (hit.deptKey !== null) {
        const bot = botById.get(finished.botId);
        if (bot && (bot.section?.trim() || "") !== hit.deptKey) {
          void handleMoveDept(bot, hit.deptKey);
        }
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cleanup);
    window.addEventListener("keydown", onKeyDown);
  }, [botById, handleMoveDept, hitTestDrop, updateNode]);

  const handleCanvasPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, details, input, select")) return;
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
      if (dragged) setPan({ x: initPan.x + dx, y: initPan.y + dy });
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
  const hoverDropRefusal = activeDrag && hoverNodeId
    ? validateOrgReportsTo(activeDrag.botId, hoverNodeId === BOSS_ROOT_ID ? null : hoverNodeId, org, bots)
    : null;
  const hoverInvalid = Boolean(hoverDropRefusal);
  const dragHint = (() => {
    if (!activeDrag || !draggedBot) return "";
    if (hoverNodeId) {
      if (hoverDropRefusal) return hoverDropRefusal;
      if (hoverNodeId === BOSS_ROOT_ID) return "松手直接汇报给「你（老板）」";
      const target = botById.get(hoverNodeId);
      const cross = target && (target.section?.trim() || "") !== (draggedBot.section?.trim() || "");
      const subTier = target && !cross && !target.chiefOfStaff;
      return `松手${cross ? "跨部门" : ""}汇报给「${target?.name ?? "上级"}」${subTier ? "（建立多级汇报）" : ""}`;
    }
    if (hoverDeptKey !== null) return `松手移入「${deptLabelOfKey(hoverDeptKey)}」部门`;
    return "拖到其他卡片改汇报线，或拖到部门框换部门（Esc 取消）";
  })();

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
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
        {/* Flat-mode subtle general department pill so users can still rename/configure the default department */}
        {!hasNamedDepartments && (
          <div
            onPointerDown={e => e.stopPropagation()}
            className="absolute left-4 top-4 z-10 flex items-center gap-1.5 rounded-full bg-panel/90 py-1 pl-3 pr-1 text-[12px] text-ink-secondary ring-[0.5px] ring-hairline/75 backdrop-blur-md"
          >
            <span className="font-medium text-ink">{generalDeptLabel}</span>
            <span className="text-[11px] text-ink-tertiary">· 扁平组织</span>
            <OpcDeptMenu
              sectionKey=""
              label={generalDeptLabel}
              onEditTeam={onEditTeam}
              onInstructions={onInstructions}
              onMemory={onMemory}
              onRenameGeneralDepartment={onRenameGeneralDepartment}
              onDeleteTeam={onDeleteTeam}
            />
          </div>
        )}

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
            width: layout.width,
            height: layout.height,
            transform: `translate3d(${canvasOriginOffset.x + pan.x}px, ${canvasOriginOffset.y + pan.y}px, 0) scale(${zoom})`,
          }}
        >
          {/* Department group containers (shown when custom departments exist) */}
          {layout.deptBoxes.map(box => {
            const label = deptLabelOfKey(box.sectionKey);
            const dropping = hoverDeptKey === box.sectionKey && Boolean(activeDrag?.moved);
            return (
              <section
                key={box.id}
                data-org-dept={box.sectionKey}
                style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
                className={cn(
                  "absolute rounded-2xl border border-dashed bg-panel/35 transition-colors has-[details[open]]:z-20",
                  dropping ? "border-accent bg-accent/[0.04] ring-2 ring-accent/25" : "border-hairline/75",
                )}
              >
                <header className="flex h-9 items-center justify-between gap-2 px-3.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[12px] font-semibold text-ink-secondary">{label}</span>
                    <span className="text-[11px] tabular-nums text-ink-tertiary">{box.nodeIds.length}</span>
                  </div>
                  <OpcDeptMenu
                    sectionKey={box.sectionKey}
                    label={label}
                    onEditTeam={onEditTeam}
                    onInstructions={onInstructions}
                    onMemory={onMemory}
                    onRenameGeneralDepartment={onRenameGeneralDepartment}
                    onDeleteTeam={onDeleteTeam}
                  />
                </header>
                {box.empty && (
                  <div className="flex h-[calc(100%-36px)] items-center justify-center px-5 pb-3 text-center text-[12px] text-ink-tertiary">
                    拖员工卡片到这里加入「{label}」
                  </div>
                )}
              </section>
            );
          })}

          {/* Straight top-down reporting lines */}
          <svg
            aria-hidden="true"
            width={Math.max(layout.width, 800)}
            height={Math.max(layout.height, 600)}
            className="pointer-events-none absolute inset-0 overflow-visible"
          >
            {layout.edges.map(edge => (
              <path
                key={`${edge.parent.id}->${edge.child.id}`}
                d={edge.path}
                fill="none"
                stroke={edge.crossDepartment ? "var(--color-ink-tertiary)" : "var(--color-hairline)"}
                strokeWidth={edge.crossDepartment ? "1.5" : "1.35"}
                strokeLinecap="square"
                strokeLinejoin="miter"
              />
            ))}
          </svg>

          {/* Subtle cross-department reporting pills */}
          {layout.edges.filter(e => e.crossDepartment).map(edge => (
            <span
              key={`xdept:${edge.parent.id}->${edge.child.id}`}
              style={{ left: edge.midX, top: edge.midY }}
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-hairline/70 bg-app px-2 py-0.5 text-[10px] text-ink-tertiary"
            >
              跨部门
            </span>
          ))}

          {/* Boss & Employee cards */}
          {layout.nodes.map(node => {
            const isBoss = node.id === BOSS_ROOT_ID;
            const bot = isBoss ? null : botById.get(node.id) ?? null;
            return (
              <OpcOrgNodeCard
                key={node.id}
                node={node}
                isBoss={isBoss}
                bot={bot}
                cfg={bot ? org.nodes[bot.id] : undefined}
                spend={bot ? (spendByBot[bot.id] ?? 0) : 0}
                selected={selectedBotId === node.id}
                tagged={!isBoss && taggedBotIds.includes(node.id)}
                sentKey={!isBoss && sent?.botIds.includes(node.id) ? sent.key : undefined}
                isDraggingSource={activeDrag?.botId === node.id && activeDrag.moved}
                isDropTarget={hoverNodeId === node.id && Boolean(activeDrag?.moved)}
                hoverInvalid={hoverInvalid}
                hasNamedDepartments={hasNamedDepartments}
                deptLabel={deptLabelOfKey(node.section)}
                onPointerDown={e => handleNodePointerDown(e, node)}
                onSelect={() => { if (!justDraggedRef.current) setSelectedBotId(node.id); }}
              />
            );
          })}
        </div>

        {/* Floating drag ghost */}
        {activeDrag?.moved && draggedBot && (
          <div
            className="pointer-events-none fixed z-50"
            style={{ left: activeDrag.clientX - activeDrag.offsetX, top: activeDrag.clientY - activeDrag.offsetY, width: activeDrag.width }}
          >
            <div className="flex items-center gap-2.5 rounded-2xl bg-panel px-3.5 py-3 text-ink shadow-2xl ring-2 ring-ink/70">
              <BotAvatar bot={draggedBot} size={30} motion="none" motionKey={0} animated={false} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-semibold">{draggedBot.name}</div>
                <div className={cn("line-clamp-2 text-[11px]", hoverInvalid ? "text-danger" : "text-ink-tertiary")}>{dragHint}</div>
              </div>
            </div>
          </div>
        )}

        {/* Bottom-left minimal legend & zoom bar (clears bottom MapComposer cleanly) */}
        <div
          onPointerDown={e => e.stopPropagation()}
          style={{ bottom: bottomInset > 0 ? bottomInset + 10 : 16 }}
          className="absolute left-4 z-10 flex items-center gap-3 rounded-full bg-panel/90 px-3.5 py-1.5 text-[11.5px] text-ink-tertiary ring-[0.5px] ring-hairline/70 backdrop-blur-md"
        >
          <span className="hidden items-center gap-1.5 sm:inline-flex">
            <span className="h-px w-4 bg-hairline" /> 拖卡片改汇报/部门
          </span>
          <span className="hidden h-3 w-px bg-hairline/60 sm:inline-block" />
          <button type="button" onClick={() => setZoom(z => Math.max(0.5, +(z - 0.1).toFixed(2)))} aria-label="缩小" className="p-0.5 hover:text-ink"><Minus size={12.5} /></button>
          <span className="min-w-9 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => setZoom(z => Math.min(1.5, +(z + 0.1).toFixed(2)))} aria-label="放大" className="p-0.5 hover:text-ink"><Plus size={12.5} /></button>
          <button type="button" onClick={resetView} aria-label="重置视图" title="重置缩放与位置" className="p-0.5 hover:text-ink"><Maximize2 size={12} /></button>
        </div>
      </div>

      {selectedBot && selectedCfg && (
        <OpcOrgInspector
          bot={selectedBot}
          cfg={selectedCfg}
          org={org}
          bots={bots}
          sectionOptions={sectionOptions}
          generalDeptLabel={generalDeptLabel}
          saving={saving}
          onClose={() => setSelectedBotId(null)}
          onUpdateNode={updateNode}
          onMoveDepartment={handleMoveDept}
          onToggleChief={handleToggleChief}
          onOpenLab={setLabBot}
        />
      )}

      {labBot && <OpcSkillStudioModal bot={labBot} open onClose={() => setLabBot(null)} />}
    </div>
  );
}
