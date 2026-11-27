/**
 * Prompt constraint appended only for turns initiated from the desktop pet so the
 * chief bot still executes tools/delegations first and keeps only its final spoken reply concise.
 */
export const PET_BRIEF_CONTEXT =
  "\n\n[桌面宠物回复格式补充（仅约束最终回复的表达风格，不改变任何工具调用与派单规则）：\n"
  + "1. 先执行再回复：凡需要派发子助手、查询状态、生成素材或执行任务，必须先真实调用对应工具（如 list_bots、coordinate_bots 等）并收到工具成功结果后才能回复；严禁在未调用工具或工具未返回成功前口头声称已安排、已派单、正在处理或马上派发。\n"
  + "2. 工作台交付照常：产出重要成果时照常向工作台提交正式汇报与附件。\n"
  + "3. 最终口头回复简练：所有必要工具调用完成后，最后面向用户的直接回复用 1 到 2 句自然中文口语陈述已发生的事实或结果，沿用设定中的用户称呼，不废话、不寒暄、不使用 Markdown 或分点列表。]";

export function petBriefPromptBlock(enabled?: boolean): string {
  return enabled === true ? PET_BRIEF_CONTEXT : "";
}
