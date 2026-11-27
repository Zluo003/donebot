import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BellOff,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import type { OpcHeartbeatConfig } from "../../shared/donebot-opc";
import { cn } from "@/lib/cn";
import { Select } from "@/components/Select";
import { Switch } from "@/components/SettingsPrimitives";
import type { Bot } from "@/state/store";
import { opcApi } from "./opc-api";

const INTERVAL_PRESETS = [
  { minutes: 30, label: "每 30 分钟" },
  { minutes: 60, label: "每 1 小时" },
  { minutes: 120, label: "每 2 小时" },
  { minutes: 360, label: "每 6 小时" },
  { minutes: 1440, label: "每天" },
] as const;

function intervalLabel(minutes: number): string {
  const hit = INTERVAL_PRESETS.find(p => p.minutes === minutes);
  if (hit) return hit.label;
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
  return `每 ${minutes} 分钟`;
}

export function OpcHeartbeatPanel({
  bots,
  compact = false,
  variant = "default",
}: {
  bots: Bot[];
  compact?: boolean;
  variant?: "default" | "editorial";
}) {
  const [items, setItems] = useState<OpcHeartbeatConfig[]>([]);
  const [creating, setCreating] = useState(false);
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [silentWhenOk, setSilentWhenOk] = useState(true);
  const [maxFailures, setMaxFailures] = useState(3);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!botId && bots[0]) setBotId(bots[0].id);
  }, [botId, bots]);

  const load = useCallback(async () => {
    try {
      setItems(await opcApi.listHeartbeats());
    } catch {
      // Quietly degrade in restricted workspaces.
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!botId || !name.trim() || !prompt.trim()) return;
    setBusyId("create");
    setError("");
    try {
      const created = await opcApi.createHeartbeat({
        botId,
        name: name.trim(),
        prompt: prompt.trim(),
        intervalMinutes,
        silentWhenOk,
        maxConsecutiveFailures: maxFailures,
      });
      setItems(prev => [created, ...prev]);
      setName("");
      setPrompt("");
      setCreating(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建巡检任务失败。");
    } finally {
      setBusyId(null);
    }
  };

  const handleToggle = async (hb: OpcHeartbeatConfig) => {
    setBusyId(`toggle:${hb.id}`);
    setError("");
    try {
      const updated = await opcApi.updateHeartbeat(hb.id, { enabled: !hb.enabled });
      setItems(prev => prev.map(x => (x.id === hb.id ? updated : x)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "切换状态失败。");
    } finally {
      setBusyId(null);
    }
  };

  const handleRunNow = async (hb: OpcHeartbeatConfig) => {
    setBusyId(`run:${hb.id}`);
    setError("");
    try {
      const res = await opcApi.runHeartbeatNow(hb.id);
      setItems(prev => prev.map(x => (x.id === hb.id ? res.heartbeat : x)));
      if (!res.ok && res.error) setError(res.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : "立即巡检失败。");
    } finally {
      setBusyId(null);
    }
  };

  const handleResetBreaker = async (hb: OpcHeartbeatConfig) => {
    setBusyId(`reset:${hb.id}`);
    setError("");
    try {
      const res = await opcApi.resetCircuitBreaker(hb.id, true);
      setItems(prev => prev.map(x => (x.id === hb.id ? res.heartbeat : x)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "解除熔断失败。");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (hb: OpcHeartbeatConfig) => {
    setBusyId(`del:${hb.id}`);
    try {
      await opcApi.deleteHeartbeat(hb.id);
      setItems(prev => prev.filter(x => x.id !== hb.id));
    } finally {
      setBusyId(null);
    }
  };

  if (bots.length === 0) return null;

  const isEditorial = variant === "editorial";

  return (
    <section
      aria-label="24h 静默巡检"
      className={cn(
        "space-y-3",
        isEditorial ? "" : compact ? "rounded-2xl bg-card p-4 ring-[0.5px] ring-hairline/70" : "mb-6",
      )}
    >
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-2",
          isEditorial ? "border-b border-hairline/50 pb-3" : "px-0.5",
        )}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {!isEditorial && <Activity size={15} className="shrink-0 text-accent" aria-hidden="true" />}
            <h2 className={cn("font-semibold text-ink", isEditorial ? "text-[13px] tracking-wide" : "text-[14px]")}>
              24h 静默巡检
            </h2>
            {isEditorial && items.length > 0 && (
              <span className="text-[12px] tabular-nums text-ink-tertiary">{items.length}</span>
            )}
          </div>
          {!isEditorial && (
            <p className="mt-0.5 text-[12px] text-ink-tertiary">无事静默不打扰 · 连续失败自动熔断防跑飞</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setCreating(v => !v)}
          className={cn(
            "inline-flex items-center gap-1 text-[12px] font-medium transition-colors",
            isEditorial
              ? "rounded-full px-2.5 py-1 text-ink-secondary hover:bg-ink/[0.06] hover:text-ink"
              : compact
                ? "h-7 rounded-lg bg-raised px-2.5 text-ink hover:bg-control"
                : "h-7 rounded-lg bg-card px-2.5 text-ink ring-[0.5px] ring-hairline/60 hover:bg-raised",
          )}
        >
          <Plus size={13} /> {creating ? "收起" : isEditorial ? "新建" : "新建巡检"}
        </button>
      </div>

      {error && (
        <div role="alert" className="rounded-xl bg-danger/10 px-3.5 py-2 text-[12.5px] text-danger">
          {error}
        </div>
      )}

      {creating && (
        <form
          onSubmit={handleCreate}
          className={cn(
            "space-y-3 rounded-2xl p-4",
            isEditorial ? "bg-ink/[0.03] ring-[0.5px] ring-hairline/50" : "border border-hairline/50 bg-card",
          )}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-[12px] font-medium text-ink-secondary">值班员工</span>
              <Select
                value={botId}
                onChange={(e) => setBotId(e.target.value)}
                className="w-full"
              >
                {bots.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </label>
            <label className="block space-y-1">
              <span className="text-[12px] font-medium text-ink-secondary">巡检名称</span>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：竞品动态与评论区巡检"
                className="w-full rounded-xl border border-hairline/70 bg-panel px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
              />
            </label>
          </div>

          <label className="block space-y-1">
            <span className="text-[12px] font-medium text-ink-secondary">巡检说明</span>
            <textarea
              required
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="告诉 AI 员工每次巡检要查什么、什么情况下需要叫醒你…"
              className="w-full resize-none rounded-xl border border-hairline/70 bg-panel px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
            />
          </label>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[12px] text-ink-secondary">频率：</span>
            {INTERVAL_PRESETS.map(p => (
              <button
                key={p.minutes}
                type="button"
                onClick={() => setIntervalMinutes(p.minutes)}
                className={cn(
                  "rounded-lg px-2.5 py-1 text-[12px] transition-colors",
                  intervalMinutes === p.minutes ? "bg-accent text-accent-ink font-medium" : "bg-panel text-ink-secondary hover:text-ink",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline/40 pt-3">
            <div className="flex flex-wrap items-center gap-4 text-[12px] text-ink-secondary">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={silentWhenOk}
                  onChange={(e) => setSilentWhenOk(e.target.checked)}
                  className="rounded border-hairline accent-accent"
                />
                <BellOff size={13} className="text-ink-tertiary" />
                无事静默，有事推送
              </label>
              <label className="flex items-center gap-1.5">
                <ShieldAlert size={13} className="text-ink-tertiary" />
                连续失败
                <input
                  type="number"
                  min={2}
                  max={10}
                  value={maxFailures}
                  onChange={(e) => setMaxFailures(Math.max(2, Math.min(10, Number(e.target.value) || 3)))}
                  className="w-12 rounded-md border border-hairline/70 bg-panel px-1.5 py-0.5 text-center tabular-nums text-ink"
                />
                次自动熔断
              </label>
            </div>
            <button
              type="submit"
              disabled={busyId === "create"}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full px-4 text-[12.5px] font-medium transition-opacity hover:opacity-85 disabled:opacity-45",
                isEditorial ? "bg-ink text-app" : "bg-accent text-accent-ink",
              )}
            >
              {busyId === "create" && <Loader2 size={13} className="animate-spin" />}
              保存巡检
            </button>
          </div>
        </form>
      )}

      {items.length === 0 && !creating && isEditorial && (
        <div className="py-2">
          <p className="text-[13px] leading-relaxed text-ink-tertiary">
            设定定时巡检任务：无异常时静默不打扰，发现变化再推送；连续失败自动熔断保护算力。
          </p>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-full bg-ink/[0.06] px-3.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-ink/[0.11]"
          >
            <Plus size={13} /> 开启首条巡检
          </button>
        </div>
      )}

      {items.length > 0 && (
        <ul
          className={cn(
            "divide-y divide-hairline/40",
            isEditorial ? "" : "overflow-hidden rounded-2xl border border-hairline/40 bg-card",
          )}
        >
          {items.map(hb => {
            const tripped = hb.pausedByCircuitBreaker;
            return (
              <li key={hb.id} className={cn("flex items-start gap-3", isEditorial ? "py-3" : "px-4 py-3.5")}>
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-1.5 size-2 shrink-0 rounded-full",
                    tripped
                      ? "bg-danger"
                      : !hb.enabled
                        ? "bg-ink-tertiary/40"
                        : hb.lastOutcome === "action_needed"
                          ? "bg-amber-500"
                          : "bg-emerald-500",
                  )}
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-medium text-ink">{hb.name}</span>
                    <span className="text-[12px] text-ink-tertiary">
                      {hb.botName} · {intervalLabel(hb.intervalMinutes)}
                      {hb.silentWhenOk ? " · 无事静默" : ""}
                    </span>
                  </div>
                  <p className="text-[12.5px] text-ink-secondary">{hb.prompt}</p>
                  {tripped && (
                    <div className="flex flex-wrap items-center gap-2 pt-0.5 text-[12px] text-danger">
                      <AlertTriangle size={13} className="shrink-0" />
                      <span>{hb.circuitBreakerReason || "连续失败已触发自动熔断保护"}</span>
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => void handleResetBreaker(hb)}
                        className="inline-flex items-center gap-1 rounded-md bg-danger/12 px-2 py-0.5 text-[11.5px] font-medium text-danger hover:bg-danger/20"
                      >
                        <RotateCcw size={11.5} /> 解除熔断并恢复
                      </button>
                    </div>
                  )}
                  {!tripped && hb.lastSummary && (
                    <div className="text-[11.5px] text-ink-tertiary">
                      上次结果（{hb.lastRunAt ? new Date(hb.lastRunAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}）：{hb.lastSummary}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void handleRunNow(hb)}
                    title="立即巡检一次"
                    aria-label={`立即运行「${hb.name}」`}
                    className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
                  >
                    {busyId === `run:${hb.id}` ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                  </button>
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void handleDelete(hb)}
                    title="删除巡检"
                    aria-label={`删除「${hb.name}」`}
                    className="rounded-lg p-1.5 text-ink-tertiary hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                  >
                    <Trash2 size={14} />
                  </button>
                  <Switch
                    checked={hb.enabled && !tripped}
                    disabled={busyId === `toggle:${hb.id}` || tripped}
                    aria-label={`开关「${hb.name}」`}
                    onClick={() => void handleToggle(hb)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
