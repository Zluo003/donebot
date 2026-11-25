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
    const targetBot = visibleBots.find(b => b.id === targetId) ?? bots.find(b => b.id === targetId);
    // Unresolved/unknown target IDs are refused downstream by resolveTeammate, not misclassified as same-dept peers.
    if (!targetBot) continue;
    const targetNode = orgChart.nodes[targetId] ?? defaultNode(targetId);
    const targetSection = sectionOf(targetBot);
    const targetDeptChief = deptChiefOf(targetSection);

    // 1. Lightweight consultation across branches/departments if both allow cross-consult.
    if (consult && (senderNode.allowCrossConsult ?? true) && (targetNode.allowCrossConsult ?? true)) continue;
    // 2. Top-down delegation from manager/ancestor to subordinate.
    if (isAncestor(orgChart, senderId, targetId)) continue;
    // 3. System Coordinator (unique, General scope) can always dispatch to uncategorized bots,
    //    any department coordinator, and any chief-less department member; if a department has an
    //    independent coordinator (reportsTo=null), guide dispatch to that department coordinator.
    if (isSystemCoordinator(senderBot)) {
      if (!targetSection || isDeptChief(targetBot) || !targetDeptChief) continue;
      return `组织架构约束已拦截：「${deptName(targetSection)}」由部门协调机器人「${targetDeptChief.name}」负责统筹，请先派发给「${targetDeptChief.name}」转派本部门成员${(senderNode.allowCrossConsult ?? true) ? "，或使用 consult=true 发起轻量咨询" : ""}。`;
    }
    // 4. Department Coordinator supervises own or explicitly managed department members unless placed under another manager.
    if (
      isDeptChief(senderBot)
      && (senderSection === targetSection || senderManaged.has(targetSection))
      && !isSystemCoordinator(targetBot)
      && (!targetNode.reportsToBotId || targetNode.reportsToBotId === senderId)
    ) {
      continue;
    }
    // 5. Upward reporting to direct manager, to own department coordinator, or to the unique System Coordinator.
    if (senderNode.reportsToBotId === targetId) continue;
    if (!senderNode.reportsToBotId && targetBot.chiefOfStaff && senderBot && senderSection === targetSection) continue;
    if (isSystemCoordinator(targetBot) && senderBot && (!senderSection || isDeptChief(senderBot) || !senderDeptChief)) continue;
    // 6. Cross-department communication toggle: when enabled, department coordinators communicate directly across departments.
    if (orgChart.allowChiefCrossDispatch && isDeptChief(senderBot) && isDeptChief(targetBot)) continue;

    const crossDept = Boolean(senderBot && senderSection !== targetSection);
    const ownDeptChief = !senderNode.reportsToBotId && senderBot && !senderBot.chiefOfStaff
      ? visibleBots.find(b => b.chiefOfStaff && sectionOf(b) === senderSection && b.id !== senderId)
      : senderDeptChief && senderDeptChief.id !== senderId
        ? senderDeptChief
        : undefined;
    const managerLabel = senderNode.reportsToBotId
      ? `直属上级「${nameOf(senderNode.reportsToBotId)}」`
      : ownDeptChief
        ? `${senderSection ? "本部门协调机器人" : "总协调机器人"}「${ownDeptChief.name}」`
        : "工作空间负责人（直接回复即可）";
    const consultHint = (senderNode.allowCrossConsult ?? true) ? "，或使用 consult=true 发起轻量咨询" : "";

    if (crossDept) {
      if (isDeptChief(senderBot) && isDeptChief(targetBot)) {
        return systemCoordinator
          ? `组织架构约束已拦截：当前未开启「跨部门沟通」，部门协调机器人不能直接跨部门对接「${nameOf(targetId)}（${deptName(targetSection)}）」。请先交由总协调机器人「${systemCoordinator.name}」统一协调，或在「组织与流程 → 组织架构」开启「跨部门沟通」。`
          : `组织架构约束已拦截：当前未开启「跨部门沟通」，部门协调机器人不能直接跨部门对接「${nameOf(targetId)}（${deptName(targetSection)}）」。请先汇报协调，或由负责人在「组织与流程 → 组织架构」指定总协调机器人或开启「跨部门沟通」。`;
      }
      if (isDeptChief(senderBot) && targetDeptChief) {
        return orgChart.allowChiefCrossDispatch
          ? `组织架构约束已拦截：部门内的对话与文件交接由对方部门协调机器人决定，请直接与「${deptName(targetSection)}」部门协调机器人「${targetDeptChief.name}」沟通对接，不要绕过部门协调机器人直接派单给「${nameOf(targetId)}」。`
          : `组织架构约束已拦截：当前未开启「跨部门沟通」，请交由${systemCoordinator ? `总协调机器人「${systemCoordinator.name}」` : "工作空间负责人"}统一协调「${deptName(targetSection)}」，不要直接跨部门派单给「${nameOf(targetId)}」。`;
      }
      return `组织架构约束已拦截：「${nameOf(senderId)}」无权直接向跨部门的「${nameOf(targetId)}（${deptName(targetSection)}）」派发任务。请先汇报给${managerLabel}，由其按跨部门协作规则统筹对接${consultHint}。`;
    }

    return `组织架构约束已拦截：部门内的对话与文件交接由${ownDeptChief ? `${senderSection ? "本部门协调机器人" : "总协调机器人"}「${ownDeptChief.name}」` : managerLabel}统筹决定，「${nameOf(senderId)}」无权直接向同部门平级「${nameOf(targetId)}」派发任务。请先向${managerLabel}汇报${consultHint}。`;
  }
  return null;
}

export const BOSS_FORMAL_REPORT_RULE =
  "正式汇报规范：凡是正式汇报阶段成果、提交工作流门禁产出或请求人工审批确认时，必须使用清晰的正式汇报格式（Markdown 排版）：① 一级或二级标题写明汇报主题；② 「核心结论」先行（1–3 句概括结论与关键产出）；③ 「执行摘要」列出关键数据、完成项或风险；④ 「待确认事项」（如有需决断事项，给出明确选项与建议方案）；⑤ 「交付附件」（如有产出文件，逐项说明文件用途并确保文件真实已生成）。严禁将零散过程日志、思维草稿或未整理的原始输出直接当作正式汇报提交。";

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
  if (!hasConfigured) {
    const fence = safeFence(BOSS_FORMAL_REPORT_RULE);
    return `[Studio Boss Reporting Rules]\n${fence}\n${BOSS_FORMAL_REPORT_RULE}\n${fence}`;
  }

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
    ? "（已开启「跨部门沟通」：跨部门协作由各部门协调机器人直接沟通对接）"
    : `（未开启「跨部门沟通」：跨部门协作统一由${systemCoordinator ? `总协调机器人「${systemCoordinator.name}」` : "总协调机器人或工作空间负责人"}协调）`;

  const intraDeptRule = myDeptChief
    ? myDeptChief.id === botId
      ? "部门内分工与交接：由你统筹决定本部门内的成员对话、任务分工与文件交接；成员完成后向你汇报，由你决定流转给下一位成员或向上交付。"
      : `部门内协作与交接：本部门内的对话调度与文件交接由部门协调机器人「${myDeptChief.name}」决定；完成本岗工作后向直属上级汇报，不要绕过上级私自横向派单。`
    : (!mySection && systemCoordinator && systemCoordinator.id !== botId)
      ? `归属关系：你尚未归入具体部门，直接归属总协调机器人「${systemCoordinator.name}」统筹管理。`
      : "";

  const crossDeptRule = bot?.chiefOfStaff && !mySection
    ? crossOpen
      ? "全局与跨部门统筹：你是全局唯一的总协调机器人（未归入部门的机器人直接归属你）；你可以直接向各部门协调机器人派发任务、创建新部门与部门机器人并指定部门协调机器人（新部门会自动创建部门群聊）。当前已开启「跨部门沟通」，各部门协调机器人可直接对接，你负责全局统筹、复杂跨部门调度与汇总交付。"
      : "全局与跨部门统筹：你是全局唯一的总协调机器人（未归入部门的机器人直接归属你）；你可以直接向各部门协调机器人派发任务、创建新部门与部门机器人并指定部门协调机器人（新部门会自动创建部门群聊）。当前未开启部门间直通，所有跨部门协作与文件流转统一由你协调各部门协调机器人完成。"
    : bot?.chiefOfStaff && mySection
      ? crossOpen
        ? "跨部门协作：你是本部门的部门协调机器人（非全局总协调机器人）。已开启「跨部门沟通」，需要其他部门配合时请直接与对方部门协调机器人沟通对接（不要绕过对方部门协调机器人直接派单给其下属）。"
        : `跨部门协作：你是本部门的部门协调机器人（非全局总协调机器人）。当前未开启「跨部门沟通」，需要其他部门配合时请提交给${systemCoordinator ? `总协调机器人「${systemCoordinator.name}」` : "工作空间负责人"}统一协调，不要直接跨部门派单。`
      : `跨部门协作：如需其他部门配合，请先汇报${myDeptChief ? `本部门协调机器人「${myDeptChief.name}」` : systemCoordinator ? `总协调机器人「${systemCoordinator.name}」` : "直属上级"}，由其按组织规则对外沟通或交由总协调统筹。`;

  const lines: string[] = [
    `协作模式：${orgChart.enforcementMode === "enforced" ? `按组织架构强约束${chiefCrossText}` : "自由协作（优先按组织架构与部门职责协作）"}`,
    `所属部门：${deptName(mySection)}${bot?.chiefOfStaff ? (mySection ? "（你是本部门协调机器人，负责本部门拆解派单、验收汇总与对外对接）" : "（你是全局唯一的总协调机器人，直接管辖未归入部门的机器人，负责全局统筹、建部门/建队、跨部门协调与汇总交付）") : ""}`,
    node.roleTitle ? `岗位头衔：${node.roleTitle}` : "",
    `直属上级：${node.reportsToBotId ? `${labelWithDept(node.reportsToBotId)}（任务完成、遇阻或需跨部门统筹时优先向其汇报）` : "工作空间负责人（直接对最终结果负责）"}`,
    directReports.length ? `直属下属：${directReports.join("、")}（你负责拆解派单、验收返工并汇总结果）` : "",
    intraDeptRule,
    crossDeptRule,
    node.requireBossApproval ? "审批纪律：你的关键交付物需提交工作台审批确认后再对外流转或收尾。" : "",
    BOSS_FORMAL_REPORT_RULE,
    "固定工作流优先级：固定/定时工作流优先于日常组织架构约束，跨部门工作流节点直接按编排执行。",
    bot?.chiefOfStaff ? (!mySection ? "总协调机器人编排权限：当用户要求建立固定或定时工作流（含跨部门流程）时，可直接调用 opc_list_workflows / opc_save_workflow / opc_run_workflow 创建、修改或启动。" : "部门协调机器人编排权限：仅可调用 opc_list_workflows / opc_save_workflow / opc_run_workflow 编排或启动本部门（含受权管辖部门）内的固定工作流；跨部门工作流请汇报给总协调机器人或在工作空间「组织与流程」编排。") : "",
  ].filter(Boolean);

  const body = lines.join("\n");
  const fence = safeFence(body);
  return `[Studio Org Chart & Workflow Rules]\n${fence}\n${body}\n${fence}`;
}
