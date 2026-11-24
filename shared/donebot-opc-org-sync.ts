import type { OpcOrgChartState, OpcOrgNodeConfig } from "./donebot-opc.ts";

export interface OrgSyncBot {
  id: string;
  name: string;
  title?: string;
  section?: string;
  chiefOfStaff?: boolean;
  hidden?: boolean;
}

function defaultOrgNode(botId: string, bot?: OrgSyncBot): OpcOrgNodeConfig {
  const roleTitle = bot?.title?.trim()
    || (bot?.chiefOfStaff ? (bot.section?.trim() ? "部门负责人" : "系统总协调") : undefined);
  return {
    botId,
    reportsToBotId: null,
    handoffToBotIds: [],
    ...(roleTitle ? { roleTitle } : {}),
    requireBossApproval: false,
    allowCrossConsult: true,
  };
}

function sectionOf(bot?: OrgSyncBot): string {
  return bot?.section?.trim() || "";
}

/**
 * Reconciles org-chart reporting edges against each department's `chiefOfStaff` status:
 * - Departments without a chief automatically flatten all intra-department edges to peer level,
 *   inheriting the top external manager (or Boss root `null`).
 * - Departments with a chief place the chief at the top of the department and attach all members
 *   not already inside the chief's intra-department subtree directly under the chief, while
 *   preserving user-arranged multi-tier sub-hierarchies (e.g. Chief A -> Lead B -> C, D).
 */
export function reconcileOrgChartWithBots(
  org: OpcOrgChartState,
  bots: readonly OrgSyncBot[],
): { org: OpcOrgChartState; changed: boolean } {
  const visibleBots = bots.filter(b => !b.hidden);
  const botById = new Map(visibleBots.map(b => [b.id, b]));
  const nodes: Record<string, OpcOrgNodeConfig> = {};
  for (const [id, node] of Object.entries(org.nodes)) {
    nodes[id] = {
      ...defaultOrgNode(id, botById.get(id)),
      ...node,
      handoffToBotIds: [...(node.handoffToBotIds ?? [])],
    };
  }

  let changed = false;
  for (const bot of visibleBots) {
    if (!nodes[bot.id]) {
      nodes[bot.id] = defaultOrgNode(bot.id, bot);
    }
    const node = nodes[bot.id]!;
    if (node.reportsToBotId && (node.reportsToBotId === bot.id || !botById.has(node.reportsToBotId))) {
      node.reportsToBotId = null;
      changed = true;
    }
  }

  const resolveExternalParent = (startBotId: string, secKey: string): string | null => {
    const visited = new Set<string>([startBotId]);
    let cursor = nodes[startBotId]?.reportsToBotId ?? null;
    while (cursor) {
      if (visited.has(cursor)) return null;
      visited.add(cursor);
      const target = botById.get(cursor);
      if (!target) return null;
      if (sectionOf(target) !== secKey) return target.id;
      cursor = nodes[cursor]?.reportsToBotId ?? null;
    }
    return null;
  };

  const hasCycleFrom = (startBotId: string): boolean => {
    const visited = new Set<string>([startBotId]);
    let cursor = nodes[startBotId]?.reportsToBotId ?? null;
    while (cursor) {
      if (visited.has(cursor)) return true;
      visited.add(cursor);
      cursor = nodes[cursor]?.reportsToBotId ?? null;
    }
    return false;
  };

  const bySection = new Map<string, OrgSyncBot[]>();
  for (const bot of visibleBots) {
    const secKey = sectionOf(bot);
    const list = bySection.get(secKey) ?? [];
    list.push(bot);
    bySection.set(secKey, list);
  }

  for (const [secKey, members] of bySection.entries()) {
    const deptChief = members.find(m => m.chiefOfStaff) ?? null;

    if (!deptChief) {
      // Snapshot external parents before mutating so multi-tier intra-department chains
      // (A -> B -> C, D) all flatten evenly to the same top external manager.
      const nextParentById = new Map<string, string | null>();
      for (const member of members) {
        const parentId = nodes[member.id]?.reportsToBotId ?? null;
        if (!parentId) continue;
        const parentBot = botById.get(parentId);
        if (parentBot && sectionOf(parentBot) === secKey) {
          nextParentById.set(member.id, resolveExternalParent(member.id, secKey));
        }
      }
      for (const [memberId, nextParent] of nextParentById.entries()) {
        if ((nodes[memberId]?.reportsToBotId ?? null) !== nextParent) {
          nodes[memberId]!.reportsToBotId = nextParent;
          changed = true;
        }
      }
      continue;
    }

    // 1. Ensure the department chief sits at the top of the department (never under a same-dept member).
    const chiefNode = nodes[deptChief.id]!;
    if (chiefNode.reportsToBotId) {
      const chiefParent = botById.get(chiefNode.reportsToBotId);
      if (chiefParent && sectionOf(chiefParent) === secKey) {
        const externalParent = resolveExternalParent(deptChief.id, secKey);
        if (chiefNode.reportsToBotId !== externalParent) {
          chiefNode.reportsToBotId = externalParent;
          changed = true;
        }
      }
    }
    if (hasCycleFrom(deptChief.id)) {
      chiefNode.reportsToBotId = null;
      changed = true;
    }

    // 2. Snapshot members already connected to the chief purely through same-department links
    //    so multi-tier structures (Chief A -> Lead B -> C, D) are deterministically preserved.
    const parentSnapshot = new Map<string, string | null>(
      members.map(m => [m.id, nodes[m.id]?.reportsToBotId ?? null]),
    );
    const underChief = new Set<string>([deptChief.id]);
    const isUnderChief = (memberId: string): boolean => {
      if (underChief.has(memberId)) return true;
      const visited = new Set<string>([memberId]);
      let cursor = parentSnapshot.get(memberId) ?? null;
      while (cursor) {
        if (cursor === deptChief.id) {
          underChief.add(memberId);
          return true;
        }
        if (visited.has(cursor)) return false;
        visited.add(cursor);
        const parentBot = botById.get(cursor);
        if (!parentBot || sectionOf(parentBot) !== secKey) return false;
        cursor = parentSnapshot.get(cursor) ?? null;
      }
      return false;
    };

    for (const member of members) {
      if (member.id === deptChief.id) continue;
      if (!isUnderChief(member.id)) {
        if (nodes[member.id]!.reportsToBotId !== deptChief.id) {
          nodes[member.id]!.reportsToBotId = deptChief.id;
          changed = true;
        }
      }
    }
  }

  // Final cycle safety pass across cross-department links.
  for (const bot of visibleBots) {
    if (hasCycleFrom(bot.id)) {
      nodes[bot.id]!.reportsToBotId = null;
      changed = true;
    }
  }

  if (!changed) {
    return { org: { ...org, nodes }, changed: false };
  }
  return {
    org: {
      ...org,
      nodes,
    },
    changed: true,
  };
}

/**
 * Validates whether `botId` may report to `nextReportsToBotId` (`null` = Boss root).
 * Returns `null` when allowed, or a concise Chinese explanation when disallowed.
 */
export function validateOrgReportsTo(
  botId: string,
  nextReportsToBotId: string | null | undefined,
  org: Pick<OpcOrgChartState, "nodes" | "generalDepartmentName">,
  bots?: readonly OrgSyncBot[],
): string | null {
  const targetId = nextReportsToBotId ? nextReportsToBotId.trim() : null;
  if (targetId === botId) {
    return "员工不能向自己汇报，请选择其他上级或直接向你汇报。";
  }

  if (targetId) {
    const visited = new Set<string>([botId]);
    let cursor: string | null = targetId;
    while (cursor) {
      if (visited.has(cursor)) {
        return "不能设置循环汇报关系（所选上级位于当前员工的下属链路中）。";
      }
      visited.add(cursor);
      cursor = org.nodes[cursor]?.reportsToBotId ?? null;
    }
  }

  if (!bots) return null;
  const visibleBots = bots.filter(b => !b.hidden);
  const bot = visibleBots.find(b => b.id === botId);
  if (!bot) return null;

  const mySec = sectionOf(bot);
  const generalLabel = org.generalDepartmentName?.trim() || "通用";
  const deptName = mySec || generalLabel;
  const deptMembers = visibleBots.filter(b => sectionOf(b) === mySec);
  const deptChief = deptMembers.find(b => b.chiefOfStaff) ?? null;
  const targetBot = targetId ? visibleBots.find(b => b.id === targetId) ?? null : null;
  const sameSection = Boolean(targetBot && sectionOf(targetBot) === mySec);

  if (!deptChief && sameSection) {
    return `「${deptName}」暂无负责人，成员保持平级；请先指定部门负责人后再建立多级汇报。`;
  }
  if (deptChief && deptChief.id === bot.id && sameSection) {
    return `「${bot.name}」是「${deptName}」负责人，不能向同部门成员汇报；可拖至你（负责人）或其他部门上级。`;
  }
  if (deptChief && deptChief.id !== bot.id && !sameSection) {
    return `「${deptName}」已设负责人「${deptChief.name}」，成员须归属其下级（可拖到本部门同事名下建多级，或拖入其他部门框转岗）。`;
  }
  return null;
}

/**
 * Picks a sensible default external manager when moving a bot into a department without a chief,
 * so the moved bot joins its new teammates at peer level instead of remaining tied to its old team.
 */
export function pickDepartmentFallbackManager(
  movedBotId: string,
  destinationSection: string,
  org: Pick<OpcOrgChartState, "nodes">,
  bots: readonly OrgSyncBot[],
): string | null {
  const destKey = destinationSection.trim();
  const visibleBots = bots.filter(b => !b.hidden);
  const existingDestMembers = visibleBots.filter(b => b.id !== movedBotId && sectionOf(b) === destKey);
  const destChief = existingDestMembers.find(b => b.chiefOfStaff);
  if (destChief) return destChief.id;

  // Match existing peer teammates' external manager when the destination department already has members.
  for (const peer of existingDestMembers) {
    const parentId = org.nodes[peer.id]?.reportsToBotId ?? null;
    if (!parentId) return null;
    const parentBot = visibleBots.find(b => b.id === parentId);
    if (parentBot && parentBot.id !== movedBotId && sectionOf(parentBot) !== destKey) {
      return parentBot.id;
    }
  }

  // Empty named department: attach under system chief (General section) if present, else Boss.
  if (destKey) {
    const systemChief = visibleBots.find(b => b.id !== movedBotId && !sectionOf(b) && b.chiefOfStaff);
    if (systemChief) return systemChief.id;
  }
  return null;
}
