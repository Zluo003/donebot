// Adapted from Paperclip (https://github.com/paperclipai/paperclip)
// ui/src/pages/org-chart/layout.ts — Copyright (c) 2025 Paperclip AI (MIT License).

export interface PaperclipOrgNode {
  id: string;
  name: string;
  role: string;
  status: string;
  reports: PaperclipOrgNode[];
}

export interface ChartGeometry {
  leaderWidth: number;
  leaderHeight: number;
  managerWidth: number;
  managerHeight: number;
  memberWidth: number;
  memberHeight: number;
  gap: number;
  levelGap: number;
  padding: number;
  taskHeight: number;
  sparsePadding: number;
  fitZoomMax: number;
  sparseFitZoomMax: number;
}

export interface LayoutNode {
  id: string;
  name: string;
  role: string;
  status: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  tier: 1 | 2 | 3;
  leader: boolean;
  children: LayoutNode[];
  offsetX?: number;
  offsetY?: number;
}

interface Block {
  roots: LayoutNode[];
  width: number;
  height: number;
}

function shift(node: LayoutNode, x: number, y: number) {
  node.offsetX = (node.offsetX ?? 0) + x;
  node.offsetY = (node.offsetY ?? 0) + y;
}

function resolvePositions(node: LayoutNode, x = 0, y = 0) {
  x += node.offsetX ?? 0;
  y += node.offsetY ?? 0;
  node.x += x;
  node.y += y;
  node.children.forEach(child => resolvePositions(child, x, y));
  delete node.offsetX;
  delete node.offsetY;
}

function pack(blocks: Block[], columns: number, gap: number): Block {
  const rows: Block[][] = [];
  for (let i = 0; i < blocks.length; i += columns) rows.push(blocks.slice(i, i + columns));
  const width = Math.max(0, ...rows.map(row => row.reduce((sum, b) => sum + b.width, 0) + (row.length - 1) * gap));
  let y = 0;
  const roots: LayoutNode[] = [];
  for (const row of rows) {
    let x = 0;
    for (const block of row) {
      block.roots.forEach(node => {
        shift(node, x, y);
        roots.push(node);
      });
      x += block.width + gap;
    }
    y += Math.max(...row.map(b => b.height)) + gap;
  }
  return { roots, width, height: Math.max(0, y - gap) };
}

/** Pack three fixed card tiers; keep source traversal and packing passes bounded. */
export function layoutOrganization(
  roots: PaperclipOrgNode[],
  viewport: { width: number; height: number },
  g: ChartGeometry,
): Block & { maxFitZoom: number } {
  let count = 0;
  const snapshot = (node: PaperclipOrgNode): PaperclipOrgNode => {
    count++;
    const { reports, ...fields } = node;
    return { ...fields, reports: reports.map(snapshot) };
  };
  const source = roots.map(snapshot);
  const density = Math.min(1, Math.max(0, (count - 4) / 8));
  const padding = g.sparsePadding + (g.padding - g.sparsePadding) * density;
  const maxFitZoom = g.sparseFitZoomMax + (g.fitZoomMax - g.sparseFitZoomMax) * density;
  if (!source.length) return { roots: [], width: 0, height: 0, maxFitZoom };
  const availableWidth = Math.max(1, viewport.width - g.padding);
  const availableHeight = Math.max(1, viewport.height - g.padding);
  const fitScale = (block: Block) => Math.min(availableWidth / block.width, availableHeight / block.height, maxFitZoom);
  const arrange = (columns: number): Block => {
    const build = (node: PaperclipOrgNode, depth: number): Block => {
      const reports = node.reports;
      const leader = reports.length > 0;
      const tier = !leader ? 3 : depth === 0 ? 1 : 2;
      const width = tier === 1 ? g.leaderWidth : tier === 2 ? g.managerWidth : g.memberWidth;
      const height = tier === 1 ? g.leaderHeight : tier === 2 ? g.managerHeight : g.memberHeight;
      const childBlocks = reports.map(child => build(child, depth + 1));
      const teams = childBlocks.filter(block => block.roots[0]!.leader);
      const members = childBlocks.filter(block => !block.roots[0]!.leader);
      const branches = teams.length && members.length
        ? [...teams, pack(members, 1, g.gap)]
        : childBlocks;
      const children = pack(branches, columns, g.gap);
      const blockWidth = Math.max(width, children.width);
      children.roots.forEach(child => shift(child, (blockWidth - children.width) / 2, height + g.levelGap));
      return {
        roots: [{
          id: node.id,
          name: node.name,
          role: node.role,
          status: node.status,
          x: (blockWidth - width) / 2,
          y: 0,
          width,
          height,
          depth,
          tier,
          leader,
          children: children.roots,
        }],
        width: blockWidth,
        height: height + (children.roots.length ? g.levelGap + children.height : 0),
      };
    };
    const candidate = pack(source.map(root => build(root, 0)), columns, g.levelGap);
    return { ...candidate, width: candidate.width + padding * 2, height: candidate.height + padding * 2 };
  };
  let best = arrange(1);
  let bestScore = -Infinity;
  for (let columns = 1; columns <= 6; columns++) {
    const candidate = columns === 1 ? best : arrange(columns);
    const scale = fitScale(candidate);
    const coverage = candidate.width * candidate.height * scale * scale / Math.max(1, viewport.width * viewport.height);
    const score = scale * (0.8 + coverage * 0.2);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  best.roots.forEach(root => {
    shift(root, padding, padding);
    resolvePositions(root);
  });
  return { ...best, maxFitZoom };
}

export interface ReportingRoute {
  parent: LayoutNode;
  child: LayoutNode;
  points: Array<{ x: number; y: number }>;
  path: string;
}

/** Give every relationship a separate port, horizontal track, and column lane. */
export function routeReportingEdges(roots: LayoutNode[], gap: number): ReportingRoute[] {
  const routes: ReportingRoute[] = [];
  const visit = (parent: LayoutNode) => {
    const columns = new Map<number, LayoutNode[]>();
    for (const child of parent.children) {
      const column = columns.get(child.x) ?? [];
      column.push(child);
      columns.set(child.x, column);
    }
    const lanes: Array<{ child: LayoutNode; x: number; port: number }> = [];
    for (const column of columns.values()) {
      column.sort((a, b) => a.y - b.y);
      column.forEach((child, row) => lanes.push({
        child,
        x: child.x - gap * (row + 1) / (column.length + 1),
        port: 0,
      }));
    }
    lanes.sort((a, b) => a.x - b.x);
    lanes.forEach((lane, index) => {
      lane.port = parent.x + gap / 2 + (parent.width - gap) * (index + 1) / (lanes.length + 1);
    });
    const left = lanes.filter(lane => lane.x < lane.port);
    const right = lanes.filter(lane => lane.x >= lane.port).reverse();
    const tracks = [...left, ...right];
    const bottom = parent.y + parent.height;
    const firstRow = Math.min(...parent.children.map(child => child.y));
    tracks.forEach((lane, index) => {
      const trackY = bottom + (firstRow - bottom) * (index + 1) / (tracks.length + 1);
      const endY = lane.child.y + lane.child.height / 2;
      const points = [
        { x: lane.port, y: bottom },
        { x: lane.port, y: trackY },
        { x: lane.x, y: trackY },
        { x: lane.x, y: endY },
        { x: lane.child.x, y: endY },
      ];
      routes.push({
        parent,
        child: lane.child,
        points,
        path: points.map((point, i) => `${i ? "L" : "M"} ${point.x} ${point.y}`).join(" "),
      });
    });
    parent.children.forEach(visit);
  };
  roots.forEach(visit);
  return routes;
}

/** Flatten layout tree to list of nodes. */
export function flattenLayout(nodes: LayoutNode[]): LayoutNode[] {
  const result: LayoutNode[] = [];
  const walk = (n: LayoutNode) => {
    result.push(n);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return result;
}

export const DEFAULT_ORG_GEOMETRY: ChartGeometry = {
  leaderWidth: 236,
  leaderHeight: 84,
  managerWidth: 224,
  managerHeight: 92,
  memberWidth: 216,
  memberHeight: 92,
  gap: 24,
  levelGap: 48,
  padding: 28,
  taskHeight: 0,
  sparsePadding: 36,
  fitZoomMax: 1.05,
  sparseFitZoomMax: 1.05,
};

// --- Classic Top-Down Center-to-Center Straight Orthogonal Org Layout ---

export interface TopDownOrgInputNode {
  id: string;
  name: string;
  role: string;
  status: string;
  /** Department key (`""` for default/general department, non-empty for named department). */
  section: string;
  reports: TopDownOrgInputNode[];
}

export interface TopDownLayoutNode {
  id: string;
  name: string;
  role: string;
  status: string;
  section: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  children: TopDownLayoutNode[];
}

export interface TopDownReportingEdge {
  parent: TopDownLayoutNode;
  child: TopDownLayoutNode;
  path: string;
  midX: number;
  midY: number;
  crossDepartment: boolean;
}

export interface DepartmentClusterBox {
  id: string;
  sectionKey: string;
  x: number;
  y: number;
  width: number;
  height: number;
  nodeIds: string[];
  empty: boolean;
}

const TD_BOSS_W = 240;
const TD_BOSS_H = 84;
const TD_BOT_W = 236;
const TD_BOT_H = 116;
const TD_SIBLING_GAP = 28;
const TD_DEPT_GAP = 64;
const TD_LEVEL_GAP = 86;
const TD_PAD_X = 64;
const TD_PAD_Y = 48;

interface MeasuredSubtree {
  node: TopDownLayoutNode;
  width: number;
  height: number;
}

function shiftTopDown(node: TopDownLayoutNode, dx: number, dy: number): void {
  node.x += dx;
  node.y += dy;
  for (const child of node.children) shiftTopDown(child, dx, dy);
}

/**
 * Lays out a top-down organization chart where every parent sits centered above its children
 * and siblings in the same department stay adjacent with extra spacing across departments.
 */
export function layoutTopDownOrgChart(root: TopDownOrgInputNode): {
  root: TopDownLayoutNode;
  nodes: TopDownLayoutNode[];
  edges: TopDownReportingEdge[];
  width: number;
  height: number;
} {
  const build = (input: TopDownOrgInputNode, depth: number): MeasuredSubtree => {
    const width = depth === 0 ? TD_BOSS_W : TD_BOT_W;
    const height = depth === 0 ? TD_BOSS_H : TD_BOT_H;

    // Keep same-department reports first so a department lead/system chief and all same-department
    // subordinates stay contiguous and enclosed in one unified department box without touching other departments.
    const sectionOrder: string[] = [];
    if (depth > 0 && input.reports.some(c => c.section === input.section)) {
      sectionOrder.push(input.section);
    }
    for (const child of input.reports) {
      if (!sectionOrder.includes(child.section)) sectionOrder.push(child.section);
    }
    const orderedReports = [...input.reports].sort(
      (a, b) => sectionOrder.indexOf(a.section) - sectionOrder.indexOf(b.section),
    );

    const measuredChildren = orderedReports.map(child => build(child, depth + 1));

    if (measuredChildren.length === 0) {
      return {
        node: {
          id: input.id,
          name: input.name,
          role: input.role,
          status: input.status,
          section: input.section,
          x: 0,
          y: 0,
          width,
          height,
          depth,
          children: [],
        },
        width,
        height,
      };
    }

    let cursorX = 0;
    let maxChildHeight = 0;
    let sameSectionRight = 0;
    const sameDeptChildren: MeasuredSubtree[] = [];
    measuredChildren.forEach((child, idx) => {
      if (idx > 0) {
        const prevSec = measuredChildren[idx - 1]!.node.section;
        cursorX += prevSec === child.node.section ? TD_SIBLING_GAP : TD_DEPT_GAP;
      }
      shiftTopDown(child.node, cursorX, height + TD_LEVEL_GAP);
      cursorX += child.width;
      if (depth > 0 && child.node.section === input.section) {
        sameDeptChildren.push(child);
        sameSectionRight = cursorX;
      }
      maxChildHeight = Math.max(maxChildHeight, child.height);
    });

    const childrenWidth = cursorX;
    let targetParentX: number;
    if (depth > 0 && sameDeptChildren.length > 0 && sameDeptChildren.length < measuredChildren.length) {
      const firstSame = sameDeptChildren[0]!.node;
      const lastSame = sameDeptChildren[sameDeptChildren.length - 1]!.node;
      const firstCenter = firstSame.x + firstSame.width / 2;
      const lastCenter = lastSame.x + lastSame.width / 2;
      targetParentX = Math.max(0, Math.min((firstCenter + lastCenter) / 2 - width / 2, sameSectionRight - width));
    } else {
      const firstCenter = measuredChildren[0]!.node.x + measuredChildren[0]!.node.width / 2;
      const lastChild = measuredChildren[measuredChildren.length - 1]!.node;
      const lastCenter = lastChild.x + lastChild.width / 2;
      targetParentX = (firstCenter + lastCenter) / 2 - width / 2;
    }

    let parentX = targetParentX;
    let blockWidth = Math.max(childrenWidth, parentX + width);
    if (parentX < 0) {
      const shiftRight = -parentX;
      measuredChildren.forEach(c => shiftTopDown(c.node, shiftRight, 0));
      parentX = 0;
      blockWidth = Math.max(width, childrenWidth + shiftRight);
    }

    return {
      node: {
        id: input.id,
        name: input.name,
        role: input.role,
        status: input.status,
        section: input.section,
        x: Math.round(parentX),
        y: 0,
        width,
        height,
        depth,
        children: measuredChildren.map(c => c.node),
      },
      width: Math.round(blockWidth),
      height: Math.round(height + TD_LEVEL_GAP + maxChildHeight),
    };
  };

  const tree = build(root, 0);
  shiftTopDown(tree.node, TD_PAD_X, TD_PAD_Y);

  const nodes: TopDownLayoutNode[] = [];
  const edges: TopDownReportingEdge[] = [];
  const walk = (node: TopDownLayoutNode) => {
    nodes.push(node);
    const parentCx = Math.round(node.x + node.width / 2);
    const parentBottom = Math.round(node.y + node.height);
    for (const child of node.children) {
      const childCx = Math.round(child.x + child.width / 2);
      const childTop = Math.round(child.y);
      const busY = Math.round(parentBottom + (childTop - parentBottom) / 2);
      const straight = Math.abs(parentCx - childCx) <= 1;
      const path = straight
        ? `M ${childCx} ${parentBottom} L ${childCx} ${childTop}`
        : `M ${parentCx} ${parentBottom} L ${parentCx} ${busY} L ${childCx} ${busY} L ${childCx} ${childTop}`;
      edges.push({
        parent: node,
        child,
        path,
        midX: straight ? childCx : Math.round((parentCx + childCx) / 2),
        midY: busY,
        crossDepartment: node.depth > 0 && node.section !== child.section,
      });
      walk(child);
    }
  };
  walk(tree.node);

  return {
    root: tree.node,
    nodes,
    edges,
    width: tree.width + TD_PAD_X * 2,
    height: tree.height + TD_PAD_Y * 2,
  };
}

/**
 * Computes clean non-overlapping visual boxes around contiguous department clusters
 * plus drop-zone cards for any currently empty named departments.
 */
export function computeDepartmentClusters(
  nodes: readonly TopDownLayoutNode[],
  allSectionKeys: readonly string[],
  layoutWidth: number,
): DepartmentClusterBox[] {
  const employeeNodes = nodes.filter(n => n.depth > 0);
  const padX = 18;
  const padTop = 38;
  const padBottom = 18;

  const overlapsForeign = (
    box: { x: number; y: number; width: number; height: number },
    sectionKey: string,
  ) => nodes.some(n => {
    if (n.depth > 0 && n.section === sectionKey) return false;
    return n.x < box.x + box.width + 6
      && n.x + n.width > box.x - 6
      && n.y < box.y + box.height + 6
      && n.y + n.height > box.y - 6;
  });

  const makeBox = (members: TopDownLayoutNode[]) => {
    const minX = Math.min(...members.map(n => n.x)) - padX;
    const minY = Math.min(...members.map(n => n.y)) - padTop;
    const maxX = Math.max(...members.map(n => n.x + n.width)) + padX;
    const maxY = Math.max(...members.map(n => n.y + n.height)) + padBottom;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  };

  const boxes: DepartmentClusterBox[] = [];
  const grouped = new Map<string, TopDownLayoutNode[]>();
  for (const node of employeeNodes) {
    const list = grouped.get(node.section) ?? [];
    list.push(node);
    grouped.set(node.section, list);
  }

  for (const [sectionKey, members] of grouped.entries()) {
    // Try single unified box first; if cross-department reparenting places a foreign node inside,
    // split greedily into largest non-overlapping clusters so boxes never clash.
    const fullBox = makeBox(members);
    if (!overlapsForeign(fullBox, sectionKey)) {
      boxes.push({
        id: `dept:${sectionKey || "__general__"}:0`,
        sectionKey,
        ...fullBox,
        nodeIds: members.map(m => m.id),
        empty: false,
      });
      continue;
    }

    const clusters: TopDownLayoutNode[][] = [];
    const sorted = [...members].sort((a, b) => a.x - b.x || a.y - b.y);
    for (const member of sorted) {
      let placed = false;
      for (const cluster of clusters) {
        const candidate = [...cluster, member];
        if (!overlapsForeign(makeBox(candidate), sectionKey)) {
          cluster.push(member);
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push([member]);
    }
    clusters.forEach((cluster, idx) => {
      const box = makeBox(cluster);
      boxes.push({
        id: `dept:${sectionKey || "__general__"}:${idx}`,
        sectionKey,
        ...box,
        nodeIds: cluster.map(m => m.id),
        empty: false,
      });
    });
  }

  // Place empty departments (including general when only the system chief resides there) to the right.
  let emptyX = Math.max(layoutWidth - TD_PAD_X + 24, TD_PAD_X + TD_BOSS_W + 64);
  const emptyY = TD_PAD_Y + TD_BOSS_H + TD_LEVEL_GAP - padTop;
  const seenEmpty = new Set<string>();
  for (const sectionKey of allSectionKeys) {
    if (grouped.has(sectionKey) || seenEmpty.has(sectionKey)) continue;
    seenEmpty.add(sectionKey);
    const width = TD_BOT_W + padX * 2;
    const height = TD_BOT_H + padTop + padBottom;
    boxes.push({
      id: `dept:${sectionKey || "__general__"}:empty`,
      sectionKey,
      x: emptyX,
      y: emptyY,
      width,
      height,
      nodeIds: [],
      empty: true,
    });
    emptyX += width + 32;
  }

  return boxes;
}
