import { Plus, Trash2 } from "lucide-react";
import type { OpcWorkflowScheduleKind } from "../../shared/donebot-opc";
import { wouldCreateWorkflowCycle } from "../../shared/donebot-opc-graph";
import { Switch } from "@/components/SettingsPrimitives";
import { cn } from "@/lib/cn";
import type { Bot } from "@/state/store";

export interface WorkflowDraftNode {
  id: string;
  name: string;
  botId: string;
  instruction: string;
  approvalGate: boolean;
  x: number;
  y: number;
  nextStepIds: string[];
}

export const WORKFLOW_TRIGGER_ID = "__trigger__";

export function OpcWorkflowInspector({
  bots,
  selectedId,
  name,
  description,
  scheduleKind,
  dailyTime,
  intervalMinutes,
  entryStepIds,
  nodes,
  onNameChange,
  onDescriptionChange,
  onScheduleKindChange,
  onDailyTimeChange,
  onIntervalMinutesChange,
  onPatchNode,
  onAddNodeAfter,
  onRemoveNode,
  onConnectEdge,
  onDisconnectEdge,
}: {
  bots: Bot[];
  selectedId: string;
  name: string;
  description: string;
  scheduleKind: OpcWorkflowScheduleKind;
  dailyTime: string;
  intervalMinutes: number;
  entryStepIds: string[];
  nodes: WorkflowDraftNode[];
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onScheduleKindChange: (value: OpcWorkflowScheduleKind) => void;
  onDailyTimeChange: (value: string) => void;
  onIntervalMinutesChange: (value: number) => void;
  onPatchNode: (id: string, patch: Partial<WorkflowDraftNode>) => void;
  onAddNodeAfter: (sourceId?: string) => void;
  onRemoveNode: (id: string) => void;
  onConnectEdge: (fromId: string, toId: string) => void;
  onDisconnectEdge: (fromId: string, toId: string) => void;
}) {
  const selectedNode = selectedId === WORKFLOW_TRIGGER_ID
    ? null
    : (nodes.find(n => n.id === selectedId) ?? null);

  return (
    <aside aria-label="节点属性配置" className="flex w-[320px] shrink-0 flex-col border-l border-hairline/60 bg-panel">
      {!selectedNode ? (
        <>
          <div className="border-b border-hairline/50 px-5 py-4">
            <div className="text-[14px] font-semibold text-ink">触发器与工作流设置</div>
            <div className="mt-0.5 text-[11.5px] text-ink-tertiary">定义启动方式与首位接棒员工</div>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-[12.5px]">
            <label className="block space-y-1.5">
              <span className="text-[11.5px] text-ink-tertiary">工作流名称</span>
              <input
                value={name}
                onChange={e => onNameChange(e.target.value)}
                placeholder="如：每日小红书爆款流水线"
                className="h-8.5 w-full rounded-lg border border-hairline/70 bg-inset px-2.5 text-ink outline-none focus:border-ink/40"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-[11.5px] text-ink-tertiary">业务说明（可选）</span>
              <textarea
                value={description}
                onChange={e => onDescriptionChange(e.target.value)}
                rows={2}
                placeholder="简述这条固定工作流产出的结果"
                className="w-full resize-none rounded-lg border border-hairline/70 bg-inset px-2.5 py-2 text-ink outline-none focus:border-ink/40"
              />
            </label>

            <div className="space-y-2 border-t border-hairline/40 pt-4">
              <span className="text-[11.5px] font-medium text-ink-tertiary">触发方式</span>
              <select
                value={scheduleKind}
                onChange={e => onScheduleKindChange(e.target.value as OpcWorkflowScheduleKind)}
                className="h-8.5 w-full rounded-lg border border-hairline/70 bg-inset px-2.5 text-ink outline-none focus:border-ink/40"
              >
                <option value="daily">每天定时</option>
                <option value="interval">按间隔周期</option>
                <option value="manual">仅手动触发</option>
              </select>
              {scheduleKind === "daily" && (
                <input
                  type="time"
                  value={dailyTime}
                  onChange={e => onDailyTimeChange(e.target.value)}
                  className="h-8.5 w-full rounded-lg border border-hairline/70 bg-inset px-2.5 text-ink outline-none"
                />
              )}
              {scheduleKind === "interval" && (
                <select
                  value={intervalMinutes}
                  onChange={e => onIntervalMinutesChange(Number(e.target.value))}
                  className="h-8.5 w-full rounded-lg border border-hairline/70 bg-inset px-2.5 text-ink outline-none"
                >
                  <option value={30}>每 30 分钟</option>
                  <option value={60}>每 1 小时</option>
                  <option value={120}>每 2 小时</option>
                  <option value={360}>每 6 小时</option>
                  <option value={720}>每 12 小时</option>
                </select>
              )}
            </div>

            <div className="space-y-2 border-t border-hairline/40 pt-4">
              <div className="text-[11.5px] font-medium text-ink-tertiary">入口节点（触发后首先启动）</div>
              <div className="space-y-1">
                {nodes.map(n => {
                  const checked = entryStepIds.includes(n.id);
                  return (
                    <label key={n.id} className="flex cursor-pointer items-center justify-between rounded-lg px-2 py-1.5 hover:bg-ink/[0.04]">
                      <span className="truncate text-[12.5px] text-ink">{n.name || "未命名步骤"}</span>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={e => {
                          if (e.target.checked) onConnectEdge(WORKFLOW_TRIGGER_ID, n.id);
                          else onDisconnectEdge(WORKFLOW_TRIGGER_ID, n.id);
                        }}
                        className="size-3.5 rounded accent-ink"
                      />
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between border-b border-hairline/50 px-5 py-4">
            <div className="min-w-0">
              <div className="truncate text-[14px] font-semibold text-ink">{selectedNode.name || "员工节点"}</div>
              <div className="text-[11.5px] text-ink-tertiary">配置执行员工、任务指令与下游连线</div>
            </div>
            {nodes.length > 1 && (
              <button
                type="button"
                onClick={() => onRemoveNode(selectedNode.id)}
                aria-label="删除此节点"
                className="rounded-full p-1.5 text-ink-tertiary hover:bg-danger/10 hover:text-danger"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-[12.5px]">
            <label className="block space-y-1.5">
              <span className="text-[11.5px] text-ink-tertiary">节点名称</span>
              <input
                value={selectedNode.name}
                onChange={e => onPatchNode(selectedNode.id, { name: e.target.value })}
                placeholder="如：热点选题 / 文案撰写 / 海报设计"
                className="h-8.5 w-full rounded-lg border border-hairline/70 bg-inset px-2.5 text-ink outline-none focus:border-ink/40"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-[11.5px] text-ink-tertiary">执行 AI 员工</span>
              <select
                value={selectedNode.botId}
                onChange={e => onPatchNode(selectedNode.id, { botId: e.target.value })}
                className="h-8.5 w-full rounded-lg border border-hairline/70 bg-inset px-2.5 text-ink outline-none focus:border-ink/40"
              >
                {bots.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>

            <label className="block space-y-1.5">
              <span className="text-[11.5px] text-ink-tertiary">
                任务指令（自然语言）
              </span>
              <textarea
                value={selectedNode.instruction}
                onChange={e => onPatchNode(selectedNode.id, { instruction: e.target.value })}
                rows={5}
                placeholder="直接用自然语言写明本节点要完成的任务；上游连线机器人的真实回复会自动通过对话交接给当前机器人。"
                className="w-full resize-none rounded-lg border border-hairline/70 bg-inset px-2.5 py-2 leading-relaxed text-ink outline-none focus:border-ink/40"
              />
              <span className="block text-[11px] leading-relaxed text-ink-tertiary">
                {selectedNode.nextStepIds.length === 0
                  ? "此节点为最终步骤，完成后将在该机器人的聊天窗口直接输出最终结果。"
                  : "完成后，当前机器人的真实回复将自动交接给下游连线机器人。"}
              </span>
            </label>

            <div className="flex items-center justify-between gap-3 border-t border-hairline/40 pt-4">
              <div>
                <div className="text-[12.5px] font-medium text-ink">完成后等待审批</div>
                <div className="text-[11.5px] text-ink-tertiary">暂停流水线，通过后才流向下一节点</div>
              </div>
              <Switch
                checked={selectedNode.approvalGate}
                onClick={() => onPatchNode(selectedNode.id, { approvalGate: !selectedNode.approvalGate })}
              />
            </div>

            <div className="space-y-2 border-t border-hairline/40 pt-4">
              <div className="flex items-center justify-between">
                <span className="text-[11.5px] font-medium text-ink-tertiary">流向下游节点（连线）</span>
                <button
                  type="button"
                  onClick={() => onAddNodeAfter(selectedNode.id)}
                  className="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-medium text-ink-secondary hover:bg-ink/[0.06] hover:text-ink"
                >
                  <Plus size={11} /> 新接一棒
                </button>
              </div>
              <div className="space-y-1">
                {nodes.filter(n => n.id !== selectedNode.id).length === 0 ? (
                  <p className="text-[11.5px] text-ink-tertiary">点上方「新接一棒」或在画布新增节点后拉线连接。</p>
                ) : (
                  nodes.filter(n => n.id !== selectedNode.id).map(candidate => {
                    const linked = selectedNode.nextStepIds.includes(candidate.id);
                    const blockedCycle = !linked && wouldCreateWorkflowCycle(nodes, selectedNode.id, candidate.id);
                    return (
                      <label
                        key={candidate.id}
                        className={cn(
                          "flex items-center justify-between rounded-lg px-2 py-1.5",
                          blockedCycle ? "opacity-45" : "cursor-pointer hover:bg-ink/[0.04]",
                        )}
                      >
                        <span className="truncate text-[12.5px] text-ink">{candidate.name || "未命名步骤"}</span>
                        <input
                          type="checkbox"
                          checked={linked}
                          disabled={blockedCycle}
                          onChange={e => {
                            if (e.target.checked) onConnectEdge(selectedNode.id, candidate.id);
                            else onDisconnectEdge(selectedNode.id, candidate.id);
                          }}
                          className="size-3.5 rounded accent-ink"
                        />
                      </label>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
