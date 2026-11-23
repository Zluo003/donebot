import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  Crown,
  FlaskConical,
  GitBranch,
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
const DRAG_MIME = "application/x-donebot-opc-org-bot";

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
  // Attach any detached cycle survivors directly under Boss so every employee stays visible.
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
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [spendByBot, setSpendByBot] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [labBot, setLabBot] = useState<Bot | null>(null);

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
    const routes = routeReportingEdges(block.roots, DEFAULT_ORG_GEOMETRY.gap);
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
    return { block, nodes, routes, handoffEdges };
  }, [bots, org, viewport]);

  const updateNode = useCallback(async (botId: string, patch: Partial<Omit<OpcOrgNodeConfig, "botId">>) => {
    setSaving(true);
    setError("");
    try {
      const res = await opcApi.saveOrgNode(botId, patch);
      onOrgChange(res.org);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存组织架构失败。");
    } finally {
      setSaving(false);
    }
  }, [onOrgChange]);

  const onDragStart = (event: DragEvent, botId: string) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_MIME, botId);
  };

  const onDropOnParent = (event: DragEvent, targetParentId: string) => {
    event.preventDefault();
    setDragOverId(null);
    const draggedBotId = event.dataTransfer.getData(DRAG_MIME);
    if (!draggedBotId || draggedBotId === targetParentId) return;
    const reportsToBotId = targetParentId === BOSS_ROOT_ID ? null : targetParentId;
    if ((org.nodes[draggedBotId]?.reportsToBotId ?? null) === reportsToBotId) return;
    void updateNode(draggedBotId, { reportsToBotId });
  };

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

  const canvasWidth = Math.max(viewport.width, layout.block.width);
  const canvasHeight = Math.max(viewport.height, layout.block.height);

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {/* Main interactive org chart surface */}
      <div
        ref={containerRef}
        data-opc-org-chart=""
        className="relative min-h-0 flex-1 overflow-auto bg-app"
        style={{
          backgroundImage: "radial-gradient(color-mix(in srgb, var(--color-ink) 8%, transparent) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelectedBotId(null);
        }}
      >
        {error && (
          <div role="alert" className="sticky left-6 top-4 z-20 mx-6 mt-4 flex items-center justify-between gap-3 rounded-xl bg-danger/12 px-4 py-2.5 text-[12.5px] text-danger backdrop-blur-sm">
            <span>{error}</span>
            <button type="button" onClick={() => setError("")} aria-label="关闭错误" className="rounded-full p-1 hover:bg-danger/15">
              <X size={13.5} />
            </button>
          </div>
        )}

        <div
          className="relative mx-auto origin-top-left transition-transform duration-150"
          style={{
            width: canvasWidth,
            height: canvasHeight,
            transform: `scale(${zoom})`,
          }}
        >
          {/* SVG reporting tracks (solid) & workflow handoff arcs (dashed) */}
          <svg
            aria-hidden="true"
            width={canvasWidth}
            height={canvasHeight}
            className="pointer-events-none absolute inset-0"
          >
            <defs>
              <marker id="opc-handoff-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="var(--color-accent)" fillOpacity="0.7" />
              </marker>
            </defs>
            {layout.routes.map(route => (
              <path
                key={`${route.parent.id}->${route.child.id}`}
                d={route.path}
                fill="none"
                stroke="var(--color-hairline)"
                strokeWidth="1.25"
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
            const dragOver = dragOverId === node.id;
            const spend = bot ? (spendByBot[bot.id] ?? 0) : 0;

            return (
              <div
                key={node.id}
                data-org-node={node.id}
                draggable={!isBoss}
                onDragStart={!isBoss ? (e) => onDragStart(e, node.id) : undefined}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes(DRAG_MIME)) {
                    e.preventDefault();
                    setDragOverId(node.id);
                  }
                }}
                onDragLeave={() => setDragOverId(prev => (prev === node.id ? null : prev))}
                onDrop={(e) => onDropOnParent(e, node.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!isBoss) setSelectedBotId(node.id);
                }}
                style={{
                  left: node.x,
                  top: node.y,
                  width: node.width,
                  height: node.height,
                }}
                className={cn(
                  "absolute flex flex-col justify-between rounded-2xl px-3.5 py-3 transition-all select-none",
                  isBoss
                    ? "bg-ink text-app shadow-sm"
                    : "cursor-pointer bg-panel/95 text-ink ring-[0.75px] ring-hairline/75 hover:ring-ink/35",
                  selected && !isBoss && "ring-2 ring-ink shadow-md",
                  dragOver && "ring-2 ring-accent scale-[1.02]",
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

        {/* Bottom-left minimal legend & zoom bar */}
        <div className="fixed bottom-5 left-[calc(var(--rail-beside,0px)_+_296px)] z-10 hidden items-center gap-3 rounded-full bg-panel/90 px-3.5 py-1.5 text-[11.5px] text-ink-tertiary ring-[0.5px] ring-hairline/70 backdrop-blur-md lg:flex">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-px w-4 bg-hairline" /> 汇报线（可拖拽调整）
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-px w-4 border-t border-dashed border-accent" /> 交接流水线
          </span>
          <span className="h-3 w-px bg-hairline/60" />
          <button type="button" onClick={() => setZoom(z => Math.max(0.55, +(z - 0.1).toFixed(2)))} aria-label="缩小" className="p-0.5 hover:text-ink"><Minus size={12.5} /></button>
          <span className="min-w-9 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => setZoom(z => Math.min(1.4, +(z + 0.1).toFixed(2)))} aria-label="放大" className="p-0.5 hover:text-ink"><Plus size={12.5} /></button>
          <button type="button" onClick={() => setZoom(1)} aria-label="重置缩放" className="p-0.5 hover:text-ink"><Maximize2 size={12} /></button>
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
