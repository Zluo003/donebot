import { Crown, FlaskConical, MessageSquare, Settings, X } from "lucide-react";
import type { OpcOrgNodeConfig } from "../../shared/donebot-opc";
import { BotAvatar } from "@/components/Avatar";
import { openBotSettings } from "@/components/bot-panel/panel-link";
import { Switch } from "@/components/SettingsPrimitives";
import { openBot, useStore, type Bot } from "@/state/store";
import { useShowThreads } from "@/lib/thread-preferences";

const BOSS_ROOT_ID = "__boss__";

export function OpcOrgInspector({
  bot,
  cfg,
  bots,
  sectionOptions,
  generalDeptLabel,
  saving,
  onClose,
  onUpdateNode,
  onMoveDepartment,
  onToggleChief,
  onOpenLab,
}: {
  bot: Bot;
  cfg: OpcOrgNodeConfig;
  bots: Bot[];
  sectionOptions: Array<{ key: string; label: string }>;
  generalDeptLabel: string;
  saving: boolean;
  onClose: () => void;
  onUpdateNode: (botId: string, patch: Partial<Omit<OpcOrgNodeConfig, "botId">>) => Promise<void>;
  onMoveDepartment: (bot: Bot, destinationSection: string) => Promise<void>;
  onToggleChief: (bot: Bot, chiefOfStaff: boolean) => Promise<void>;
  onOpenLab: (bot: Bot) => void;
}) {
  const { dispatch } = useStore();
  const showThreads = useShowThreads();
  const botSection = bot.section?.trim() || "";
  const deptLabelOf = (candidate: Bot) => candidate.section?.trim() || generalDeptLabel;

  return (
    <aside
      aria-label={`${bot.name} 岗位与汇报规则`}
      className="flex w-[316px] shrink-0 flex-col border-l border-hairline/60 bg-panel"
    >
      <div className="flex items-center justify-between border-b border-hairline/50 px-5 py-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <BotAvatar bot={bot} size={28} motion="none" motionKey={0} animated={false} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[14px] font-semibold text-ink">{bot.name}</span>
              {bot.chiefOfStaff && <Crown size={12} className="shrink-0 text-warning" aria-label="部门主 Bot" />}
            </div>
            <div className="text-[11.5px] text-ink-tertiary">岗位、部门与协作规则</div>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
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
            key={`title:${bot.id}:${cfg.roleTitle ?? ""}`}
            defaultValue={cfg.roleTitle ?? bot.title ?? ""}
            onBlur={e => {
              const val = e.target.value.trim();
              if (val !== (cfg.roleTitle ?? "")) {
                void onUpdateNode(bot.id, { roleTitle: val });
              }
            }}
            placeholder="如：主编 / 选题侦察 / 视觉设计师"
            className="h-8.5 w-full rounded-lg border border-hairline/70 bg-inset px-2.5 text-[12.5px] text-ink outline-none placeholder:text-ink-tertiary focus:border-ink/40"
          />
        </label>

        {/* Department assignment + Chief toggle */}
        <div className="space-y-3 border-t border-hairline/40 pt-4">
          <label className="block space-y-1.5">
            <span className="text-[11.5px] font-medium text-ink-tertiary">所属部门</span>
            <select
              value={botSection}
              disabled={saving}
              onChange={e => {
                const nextSection = e.target.value;
                if (nextSection !== botSection) void onMoveDepartment(bot, nextSection);
              }}
              className="h-8.5 w-full rounded-lg border border-hairline/70 bg-inset px-2.5 text-[12.5px] text-ink outline-none focus:border-ink/40"
            >
              {sectionOptions.map(opt => (
                <option key={opt.key || "__general__"} value={opt.key}>{opt.label}</option>
              ))}
            </select>
          </label>

          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[12.5px] font-medium text-ink">设为本部门主 Bot</div>
              <div className="text-[11.5px] text-ink-tertiary">统筹「{deptLabelOf(bot)}」成员分工与对外对接</div>
            </div>
            <Switch
              checked={Boolean(bot.chiefOfStaff)}
              disabled={saving}
              onClick={() => void onToggleChief(bot, !bot.chiefOfStaff)}
            />
          </div>
        </div>

        {/* Reporting hierarchy */}
        <label className="block space-y-1.5 border-t border-hairline/40 pt-4">
          <span className="text-[11.5px] font-medium text-ink-tertiary">直属上级（汇报对象 · 支持跨部门）</span>
          <select
            value={cfg.reportsToBotId ?? BOSS_ROOT_ID}
            disabled={saving}
            onChange={e => {
              const val = e.target.value === BOSS_ROOT_ID ? null : e.target.value;
              void onUpdateNode(bot.id, { reportsToBotId: val });
            }}
            className="h-8.5 w-full rounded-lg border border-hairline/70 bg-inset px-2.5 text-[12.5px] text-ink outline-none focus:border-ink/40"
          >
            <option value={BOSS_ROOT_ID}>你（老板 · 直接汇报）</option>
            {bots.filter(b => b.id !== bot.id).map(b => (
              <option key={b.id} value={b.id}>
                {b.name}（{deptLabelOf(b)}{b.chiefOfStaff ? " · 主 Bot" : ""}）
              </option>
            ))}
          </select>
          <p className="text-[11.5px] leading-relaxed text-ink-tertiary">
            开启「按架构约束」后，上级可向下属派单与打回返工，下属可向上汇报；跨部门汇报同样生效。
          </p>
        </label>

        {/* Cross-department or same-department handoff pipeline */}
        <div className="space-y-2 border-t border-hairline/40 pt-4">
          <div className="text-[11.5px] font-medium text-ink-tertiary">流水线交接下一棒（支持跨部门）</div>
          <p className="text-[11.5px] text-ink-tertiary">
            也可直接从画布卡片右侧圆点拖线连接，授权本岗位完成后直接向其交接任务。
          </p>
          <div className="space-y-1 pt-1">
            {bots.filter(b => b.id !== bot.id).length === 0 ? (
              <p className="text-[12px] text-ink-tertiary">暂无其他员工可配置交接。</p>
            ) : (
              bots.filter(b => b.id !== bot.id).map(candidate => {
                const checked = cfg.handoffToBotIds.includes(candidate.id);
                const crossDept = (candidate.section?.trim() || "") !== botSection;
                return (
                  <label
                    key={candidate.id}
                    className="flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-ink/[0.04]"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <BotAvatar bot={candidate} size={20} motion="none" motionKey={0} animated={false} />
                      <span className="truncate text-[12.5px] text-ink">{candidate.name}</span>
                      {crossDept && (
                        <span className="shrink-0 rounded-full bg-ink/[0.06] px-1.5 py-0.5 text-[10px] text-ink-tertiary">
                          {deptLabelOf(candidate)}
                        </span>
                      )}
                    </span>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={saving}
                      onChange={e => {
                        const next = e.target.checked
                          ? [...cfg.handoffToBotIds, candidate.id]
                          : cfg.handoffToBotIds.filter(id => id !== candidate.id);
                        void onUpdateNode(bot.id, { handoffToBotIds: next });
                      }}
                      className="size-3.5 shrink-0 rounded accent-ink"
                    />
                  </label>
                );
              })
            )}
          </div>
        </div>

        {/* Governance switches */}
        <div className="space-y-3 border-t border-hairline/40 pt-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[12.5px] font-medium text-ink">产物须老板拍板</div>
              <div className="text-[11.5px] text-ink-tertiary">关键产出提醒先送老板台审核</div>
            </div>
            <Switch
              checked={Boolean(cfg.requireBossApproval)}
              disabled={saving}
              onClick={() => void onUpdateNode(bot.id, { requireBossApproval: !cfg.requireBossApproval })}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[12.5px] font-medium text-ink">允许跨岗咨询</div>
              <div className="text-[11.5px] text-ink-tertiary">强约束下仍允许 consult 轻量问询</div>
            </div>
            <Switch
              checked={cfg.allowCrossConsult !== false}
              disabled={saving}
              onClick={() => void onUpdateNode(bot.id, { allowCrossConsult: cfg.allowCrossConsult === false })}
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 border-t border-hairline/50 px-4 py-3.5">
        <button
          type="button"
          onClick={() => openBot(dispatch, bot, showThreads)}
          className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full bg-ink/[0.06] text-[12px] font-medium text-ink hover:bg-ink/[0.11]"
        >
          <MessageSquare size={13} /> 对话
        </button>
        <button
          type="button"
          onClick={() => onOpenLab(bot)}
          className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full bg-ink text-[12px] font-medium text-app hover:opacity-85"
        >
          <FlaskConical size={13} /> 实验室
        </button>
        <button
          type="button"
          onClick={() => openBotSettings(dispatch, "identity", { botId: bot.id })}
          aria-label="打开完整设置"
          title="打开员工完整设置"
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.06] hover:text-ink"
        >
          <Settings size={14} />
        </button>
      </div>
    </aside>
  );
}
