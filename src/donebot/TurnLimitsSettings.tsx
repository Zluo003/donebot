import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_DONEBOT_TURN_LIMITS,
  MAX_DONEBOT_TURN_STEPS,
  MAX_DONEBOT_TURN_TOOL_CALLS,
  MIN_DONEBOT_TURN_STEPS,
  MIN_DONEBOT_TURN_TOOL_CALLS,
  type DoneBotTurnLimits,
} from "../../shared/donebot";
import { api } from "@/state/api";
import { Card, SettingRow } from "@/components/SettingsPrimitives";

function parseWholeNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function TurnLimitsSettings({ simple = false }: { simple?: boolean }) {
  const [saved, setSaved] = useState<DoneBotTurnLimits | null>(null);
  const [available, setAvailable] = useState(true);
  const [stepsDraft, setStepsDraft] = useState(String(DEFAULT_DONEBOT_TURN_LIMITS.maxSteps));
  const [toolCallsDraft, setToolCallsDraft] = useState(String(DEFAULT_DONEBOT_TURN_LIMITS.maxToolCalls));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "saved" | "error"; text: string } | null>(null);
  const epoch = useRef(0);

  useEffect(() => {
    const generation = ++epoch.current;
    void api<DoneBotTurnLimits>("/api/donebot/turn-limits")
      .then((result) => {
        if (generation !== epoch.current) return;
        setSaved(result);
        setStepsDraft(String(result.maxSteps));
        setToolCallsDraft(String(result.maxToolCalls));
      })
      .catch(() => {
        if (generation === epoch.current) setAvailable(false);
      });
    return () => { epoch.current += 1; };
  }, []);

  if (!available || !saved) return null;

  const parsedSteps = parseWholeNumber(stepsDraft);
  const parsedToolCalls = parseWholeNumber(toolCallsDraft);
  const dirty = parsedSteps !== saved.maxSteps || parsedToolCalls !== saved.maxToolCalls;
  const isCustom = saved.maxSteps !== DEFAULT_DONEBOT_TURN_LIMITS.maxSteps
    || saved.maxToolCalls !== DEFAULT_DONEBOT_TURN_LIMITS.maxToolCalls;

  const commit = async (next: DoneBotTurnLimits, reset = false) => {
    const generation = ++epoch.current;
    setBusy(true);
    setFeedback(null);
    try {
      const updated = await api<DoneBotTurnLimits>("/api/donebot/turn-limits", {
        method: "PUT",
        body: JSON.stringify(next),
      });
      if (generation !== epoch.current) return;
      setSaved(updated);
      setStepsDraft(String(updated.maxSteps));
      setToolCallsDraft(String(updated.maxToolCalls));
      setFeedback({
        kind: "saved",
        text: reset
          ? `已恢复默认（${updated.maxSteps} 步 / ${updated.maxToolCalls} 次工具调用）。`
          : `已保存（${updated.maxSteps} 步 / ${updated.maxToolCalls} 次工具调用），后续对话立即生效。`,
      });
    } catch (error) {
      if (generation === epoch.current) {
        setFeedback({
          kind: "error",
          text: error instanceof Error ? error.message : "单轮执行上限保存失败，请重试。",
        });
      }
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  };

  const handleSave = () => {
    if (parsedSteps === null || parsedSteps < MIN_DONEBOT_TURN_STEPS || parsedSteps > MAX_DONEBOT_TURN_STEPS) {
      setFeedback({
        kind: "error",
        text: `最大步数需为 ${MIN_DONEBOT_TURN_STEPS} 到 ${MAX_DONEBOT_TURN_STEPS} 之间的整数。`,
      });
      return;
    }
    if (
      parsedToolCalls === null
      || parsedToolCalls < MIN_DONEBOT_TURN_TOOL_CALLS
      || parsedToolCalls > MAX_DONEBOT_TURN_TOOL_CALLS
    ) {
      setFeedback({
        kind: "error",
        text: `最大工具调用次数需为 ${MIN_DONEBOT_TURN_TOOL_CALLS} 到 ${MAX_DONEBOT_TURN_TOOL_CALLS} 之间的整数。`,
      });
      return;
    }
    if (parsedToolCalls < parsedSteps) {
      setFeedback({ kind: "error", text: "最大工具调用次数不能小于最大步数。" });
      return;
    }
    void commit({ maxSteps: parsedSteps, maxToolCalls: parsedToolCalls });
  };

  const row = (
    <SettingRow
      title="Bot 单轮执行上限"
      subtitle={
        feedback ? (
          <span className={feedback.kind === "error" ? "text-danger" : "text-ink-secondary"}>
            {feedback.text}
          </span>
        ) : (
          `全局作用于所有 Bot（默认 ${DEFAULT_DONEBOT_TURN_LIMITS.maxSteps} 步 / ${DEFAULT_DONEBOT_TURN_LIMITS.maxToolCalls} 次工具调用）。仅作为长任务熔断上限，正常完成的任务不会多消耗 Token。`
        )
      }
    >
      <div className="flex flex-wrap items-center justify-end gap-2">
        <label className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
          <span>步数</span>
          <input
            type="number"
            inputMode="numeric"
            min={MIN_DONEBOT_TURN_STEPS}
            max={MAX_DONEBOT_TURN_STEPS}
            aria-label="单轮最大步数"
            value={stepsDraft}
            disabled={busy}
            onChange={(event) => {
              setStepsDraft(event.target.value);
              if (feedback) setFeedback(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (dirty && !busy) handleSave();
              }
            }}
            className="h-8 w-[76px] rounded-full border border-hairline bg-app px-2.5 text-center text-[13px] text-ink focus:border-ink/40 focus:outline-none"
          />
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
          <span>工具调用</span>
          <input
            type="number"
            inputMode="numeric"
            min={MIN_DONEBOT_TURN_TOOL_CALLS}
            max={MAX_DONEBOT_TURN_TOOL_CALLS}
            aria-label="单轮最大工具调用次数"
            value={toolCallsDraft}
            disabled={busy}
            onChange={(event) => {
              setToolCallsDraft(event.target.value);
              if (feedback) setFeedback(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (dirty && !busy) handleSave();
              }
            }}
            className="h-8 w-[84px] rounded-full border border-hairline bg-app px-2.5 text-center text-[13px] text-ink focus:border-ink/40 focus:outline-none"
          />
        </label>
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={handleSave}
          className="ui-button ui-button-primary shrink-0 disabled:opacity-40"
        >
          保存
        </button>
        {isCustom && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void commit(DEFAULT_DONEBOT_TURN_LIMITS, true)}
            className="ui-button shrink-0"
          >
            恢复默认
          </button>
        )}
      </div>
    </SettingRow>
  );

  if (simple) return row;
  return (
    <Card title="Bot 执行上限" subtitle="为需要长时间多步骤执行的 Bot 任务配置全局单轮步数与工具调用上限。">
      {row}
    </Card>
  );
}
