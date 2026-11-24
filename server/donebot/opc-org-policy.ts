import type { OpcOrgChartState, OpcOrgNodeConfig } from "../../shared/donebot-opc.ts";
import type { BotRecord } from "../store.ts";

function safeFence(content: string): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map(m => m[0].length));
  return "`".repeat(longest + 1);
}

function defaultNode(botId: string): OpcOrgNodeConfig {
  return {
    botId,
    reportsToBotId: null,
    handoffToBotIds: [],
    requireBossApproval: false,
    allowCrossConsult: true,
  };
}

function isAncestor(orgChart: OpcOrgChartState, managerId: string, subordinateId: string): boolean {
  const visited = new Set<string>();
  let cursor = orgChart.nodes[subordinateId]?.reportsToBotId ?? null;
  while (cursor && !visited.has(cursor)) {
    if (cursor === managerId) return true;
    visited.add(cursor);
    cursor = orgChart.nodes[cursor]?.reportsToBotId ?? null;
  }
  return false;
}

/**
 * Deterministic server-side coordination gate for `POST /api/internal/coordinate-bots`.
 * - Intra-department dialogue & file handoffs are decided by the department Chief (and sub-managers).
 * - Cross-department collaboration: department Chiefs communicate directly when `allowChiefCrossDispatch`
 *   ("跨部门沟通") is enabled; otherwise the System Coordinator coordinates across departments.
 */
export function evaluateOrgCoordination(
  orgChart: OpcOrgChartState,
  senderId: string,
  targetBotIds: readonly string[],
  consult: boolean,
  bots: readonly BotRecord[],
): string | null {
  if (orgChart.enforcementMode !== "enforced") return null;

  const visibleBots = bots.filter(b => !b.hidden);
  const senderNode = orgChart.nodes[senderId] ?? defaultNode(senderId);
  const senderBot = visibleBots.find(b => b.id === senderId) ?? bots.find(b => b.id === senderId);
  const sectionOf = (bot?: BotRecord) => bot?.section?.trim() || "";
  const deptName = (section: string) => section || (orgChart.generalDepartmentName || "通用");
  const nameOf = (id: string) => bots.find(b => b.id === id)?.name ?? id;
  const isSystemCoordinator = (bot?: BotRecord) => Boolean(bot?.chiefOfStaff && !sectionOf(bot));
  const isDeptChief = (bot?: BotRecord) => Boolean(bot?.chiefOfStaff && sectionOf(bot));
  const deptChiefOf = (section: string) =>
    section ? visibleBots.find(b => b.chiefOfStaff && sectionOf(b) === section) : undefined;
  const systemCoordinator = visibleBots.find(isSystemCoordinator);
  const senderSection = sectionOf(senderBot);
  const senderManaged = new Set((senderBot?.managedSections ?? []).map(s => s.trim()));
  const senderDeptChief = deptChiefOf(senderSection);

  for (const targetId of targetBotIds) {
    if (targetId === senderId) continue;
    const targetNode = orgChart.nodes[targetId] ?? defaultNode(targetId);
    const targetBot = visibleBots.find(b => b.id === targetId) ?? bots.find(b => b.id === targetId);
    const targetSection = sectionOf(targetBot);
    const targetDeptChief = deptChiefOf(targetSection);

    // 1. Lightweight consultation across branches/departments if both allow cross-consult.
    if (consult && (senderNode.allowCrossConsult ?? true) && (targetNode.allowCrossConsult ?? true)) continue;
    // 2. Top-down delegation from manager/ancestor to subordinate.
    if (isAncestor(orgChart, senderId, targetId)) continue;
    // 3. Department Chief supervises own or managed department members unless explicitly placed under another manager.
    if (
      senderBot?.chiefOfStaff
      && targetBot
      && (senderSection === targetSection || senderManaged.has(targetSection))
      && (!targetNode.reportsToBotId || targetNode.reportsToBotId === senderId)
    ) {
      continue;
    }
    // 4. Upward reporting to direct manager, or to own department Chief when no explicit manager is set.
    if (senderNode.reportsToBotId === targetId) continue;
    if (!senderNode.reportsToBotId && targetBot?.chiefOfStaff && senderBot && senderSection === targetSection) continue;
    // 5. System Coordinator coordinates across departments (Chief <-> System Coordinator, or chief-less department members).
    if (isSystemCoordinator(senderBot) && targetBot && (isDeptChief(targetBot) || !targetDeptChief)) continue;
    if (isSystemCoordinator(targetBot) && senderBot && (isDeptChief(senderBot) || !senderDeptChief)) continue;
    // 6. Cross-department communication toggle: when enabled, department Chiefs communicate directly across departments.
    if (orgChart.allowChiefCrossDispatch && senderBot?.chiefOfStaff && targetBot?.chiefOfStaff) continue;

    const crossDept = Boolean(senderBot && targetBot && senderSection !== targetSection);
    const ownDeptChief = !senderNode.reportsToBotId && senderBot && !senderBot.chiefOfStaff
      ? visibleBots.find(b => b.chiefOfStaff && sectionOf(b) === senderSection && b.id !== senderId)
      : senderDeptChief && senderDeptChief.id !== senderId
        ? senderDeptChief
        : undefined;
    const managerLabel = senderNode.reportsToBotId
      ? `直属上级「${nameOf(senderNode.reportsToBotId)}」`
      : ownDeptChief
        ? `本部门负责人「${ownDeptChief.name}」`
        : "老板（直接回复即可）";
    const consultHint = (senderNode.allowCrossConsult ?? true) ? "，或使用 consult=true 发起轻量咨询" : "";

    if (crossDept) {
      if (isDeptChief(senderBot) && isDeptChief(targetBot)) {
        return systemCoordinator
          ? `组织架构约束已拦截：当前未开启「跨部门沟通」，部门负责人不能直接跨部门对接「${nameOf(targetId)}（${deptName(targetSection)}）」。请先交由系统总协调「${systemCoordinator.name}」统一协调，或请老板在「组织与流程 → 组织架构」开启「跨部门沟通」。`
          : `组织架构约束已拦截：当前未开启「跨部门沟通」，部门负责人不能直接跨部门对接「${nameOf(targetId)}（${deptName(targetSection)}）」。请向老板汇报协调，或请老板指定系统总协调或在「组织与流程 → 组织架构」开启「跨部门沟通」。`;
      }
      if (isDeptChief(senderBot) && targetDeptChief) {
        return orgChart.allowChiefCrossDispatch
          ? `组织架构约束已拦截：部门内的对话与文件交接由对方部门负责人决定，请直接与「${deptName(targetSection)}」负责人「${targetDeptChief.name}」沟通对接，不要绕过负责人直接派单给「${nameOf(targetId)}」。`
          : `组织架构约束已拦截：当前未开启「跨部门沟通」，请交由${systemCoordinator ? `系统总协调「${systemCoordinator.name}」` : "老板"}统一协调「${deptName(targetSection)}」，不要直接跨部门派单给「${nameOf(targetId)}」。`;
      }
      return `组织架构约束已拦截：「${nameOf(senderId)}」无权直接向跨部门的「${nameOf(targetId)}（${deptName(targetSection)}）」派发任务。请先汇报给${managerLabel}，由其按跨部门协作规则统筹对接${consultHint}。`;
    }

    return `组织架构约束已拦截：部门内的对话与文件交接由${ownDeptChief ? `本部门负责人「${ownDeptChief.name}」` : managerLabel}统筹决定，「${nameOf(senderId)}」无权直接向同部门平级「${nameOf(targetId)}」派发任务。请先向${managerLabel}汇报${consultHint}。`;
  }
  return null;
}

/** Renders concise fenced Org & Workflow Discipline instructions for LLM system prompt injection. */
export function buildOrgPromptForBot(
  orgChart: OpcOrgChartState,
  botId: string,
  bots: readonly BotRecord[],
): string | undefined {
  const visibleBots = bots.filter(b => !b.hidden);
  const bot = visibleBots.find(b => b.id === botId) ?? bots.find(b => b.id === botId);
  const hasDepartments = visibleBots.some(b => Boolean(b.section?.trim()));
  const hasConfigured = Object.keys(orgChart.nodes).length > 0
    || orgChart.enforcementMode === "enforced"
    || hasDepartments
    || Boolean(orgChart.generalDepartmentName);
  if (!hasConfigured) return undefined;

  const node = orgChart.nodes[botId] ?? defaultNode(botId);
  const sectionOf = (b?: BotRecord) => b?.section?.trim() || "";
  const deptName = (section: string) => section || (orgChart.generalDepartmentName || "通用");
  const mySection = sectionOf(bot);
  const labelWithDept = (id: string) => {
    const target = bots.find(b => b.id === id);
    if (!target) return id;
    const tSec = sectionOf(target);
    return tSec !== mySection ? `${target.name}（${deptName(tSec)}·跨部门）` : target.name;
  };
  const directReports = visibleBots
    .filter(b => orgChart.nodes[b.id]?.reportsToBotId === botId)
    .map(b => labelWithDept(b.id));
  const systemCoordinator = visibleBots.find(b => b.chiefOfStaff && !sectionOf(b));
  const myDeptChief = mySection ? visibleBots.find(b => b.chiefOfStaff && sectionOf(b) === mySection) : undefined;
  const crossOpen = Boolean(orgChart.allowChiefCrossDispatch);
  const chiefCrossText = crossOpen
    ? "（已开启「跨部门沟通」：跨部门协作由各部门负责人直接沟通对接）"
    : `（未开启「跨部门沟通」：跨部门协作统一由${systemCoordinator ? `系统总协调「${systemCoordinator.name}」` : "系统总协调或老板"}协调）`;

  const intraDeptRule = myDeptChief
    ? myDeptChief.id === botId
      ? "部门内分工与交接：由你统筹决定本部门内的成员对话、任务分工与文件交接；成员完成后向你汇报，由你决定流转给下一位成员或向上交付。"
      : `部门内协作与交接：本部门内的对话调度与文件交接由部门负责人「${myDeptChief.name}」决定；完成本岗工作后向直属上级汇报，不要绕过上级私自横向派单。`
    : "";

  const crossDeptRule = bot?.chiefOfStaff && !mySection
    ? crossOpen
      ? "跨部门协调：当前已开启「跨部门沟通」，各部门负责人可直接对接；你负责全局统筹、复杂跨部门调度与汇总交付。"
      : "跨部门协调：当前未开启部门负责人跨部门直通，所有跨部门协作与文件流转统一由你协调各部门负责人完成。"
    : bot?.chiefOfStaff && mySection
      ? crossOpen
        ? "跨部门协作：已开启「跨部门沟通」，需要其他部门配合时请直接与对方部门负责人沟通对接（不要绕过对方负责人直接派单给其下属）。"
        : `跨部门协作：当前未开启「跨部门沟通」，需要其他部门配合时请提交给${systemCoordinator ? `系统总协调「${systemCoordinator.name}」` : "老板"}统一协调，不要直接跨部门派单。`
      : `跨部门协作：如需其他部门配合，请先汇报本部门负责人${myDeptChief ? `「${myDeptChief.name}」` : ""}，由其按组织规则对外沟通或交由总协调统筹。`;

  const lines: string[] = [
    `协作模式：${orgChart.enforcementMode === "enforced" ? `按组织架构强约束${chiefCrossText}` : "自由协作（优先按组织架构与部门职责协作）"}`,
    `所属部门：${deptName(mySection)}${bot?.chiefOfStaff ? (mySection ? "（你是本部门负责人，负责本部门拆解派单、验收汇总与对外对接）" : "（你是系统总协调，负责全局统筹、跨部门协调与汇总交付）") : ""}`,
    node.roleTitle ? `岗位头衔：${node.roleTitle}` : "",
    `直属上级：${node.reportsToBotId ? `${labelWithDept(node.reportsToBotId)}（任务完成、遇阻或需跨部门统筹时优先向其汇报）` : "老板（直接对最终结果负责）"}`,
    directReports.length ? `直属下属：${directReports.join("、")}（你负责拆解派单、验收返工并汇总结果）` : "",
    intraDeptRule,
    crossDeptRule,
    node.requireBossApproval ? "审批纪律：你的关键交付物需提交老板拍板确认后再对外流转或收尾。" : "",
    "固定工作流优先级：固定/定时工作流优先于日常组织架构约束，跨部门工作流节点直接按编排执行。",
    bot?.chiefOfStaff ? (!mySection ? "系统总协调编排权限：当老板要求建立固定或定时工作流（含跨部门流程）时，可直接调用 opc_list_workflows / opc_save_workflow / opc_run_workflow 创建、修改或启动。" : "部门负责人编排权限：仅可调用 opc_list_workflows / opc_save_workflow / opc_run_workflow 编排或启动本部门（含受权管辖部门）内的固定工作流；跨部门工作流请汇报给系统总协调或由老板编排。") : "",
  ].filter(Boolean);

  const body = lines.join("\n");
  const fence = safeFence(body);
  return `[Studio Org Chart & Workflow Rules]\n${fence}\n${body}\n${fence}`;
}
