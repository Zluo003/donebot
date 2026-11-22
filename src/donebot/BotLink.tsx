import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle } from "lucide-react";
import { Switch } from "@/components/SettingsPrimitives";

type LinkState = { enabled: boolean; connected: boolean; available: boolean; error: string };

export function DoneBotBotLink({ accountId, instanceId, ready }: { accountId: string; instanceId: string; ready: boolean }) {
  const bridge = window.ogb?.workspaces?.botLink;
  const [state, setState] = useState<LinkState | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const titleId = useId();
  const descId = useId();
  const epoch = useRef(0);
  const requestId = useRef(0), changing = useRef(false);
  useEffect(() => {
    const mine = ++epoch.current;
    setState(null); setBusy(false); setError(""); changing.current = false;
    const read = () => {
      if (changing.current) return;
      const generation = ++requestId.current;
      return bridge?.state().then(next => { if (mine === epoch.current && generation === requestId.current) { setState(next); setError(""); } }, () => { if (mine === epoch.current && generation === requestId.current) setError("协作状态暂时不可用，请稍后重试。"); });
    };
    void read();
    const timer = window.setInterval(() => { if (!document.hidden) void read(); }, 5_000);
    return () => { epoch.current++; window.clearInterval(timer); };
  }, [bridge, accountId, instanceId, ready]);
  if (!bridge) return null;
  const toggle = async () => {
    if (changing.current || !state) return;
    const mine = epoch.current;
    requestId.current++; changing.current = true;
    setBusy(true); setError("");
    try { const next = await bridge.set(!state.enabled, accountId, instanceId); if (mine === epoch.current) setState(next); }
    catch (cause) { if (mine === epoch.current) setError(cause instanceof Error ? cause.message : "协作设置未完成，请重试。"); }
    finally { if (mine === epoch.current) { changing.current = false; setBusy(false); } }
  };
  const enabled = state?.enabled ?? false;
  const alertText = error || state?.error || "";

  return <div className="flex flex-col gap-2.5 px-4 py-3.5" data-donebot-bot-link>
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span id={titleId} className="text-[14px] font-medium leading-5 text-ink">本机与 Cloud 协作</span>
          {enabled && (
            <span
              role="status"
              className={state?.connected
                ? "inline-flex items-center gap-1.5 rounded-full bg-success/12 px-2 py-0.5 text-[11px] font-medium text-success ring-1 ring-inset ring-success/25"
                : "inline-flex items-center gap-1.5 rounded-full bg-warning/12 px-2 py-0.5 text-[11px] font-medium text-warning ring-1 ring-inset ring-warning/25"}
            >
              <span aria-hidden="true" className={state?.connected ? "size-1.5 rounded-full bg-success" : "size-1.5 rounded-full bg-warning"} />
              {state?.connected ? "协作已连接" : "协作已开启，等待连接"}
            </span>
          )}
        </div>
        <p id={descId} className="text-[12px] leading-relaxed text-ink-secondary">
          开通个人 Cloud 后默认开启：两处的 Bot 可相互委派任务，并传递任务所需的上下文和附件。本机任务需要这台电脑保持运行；离线时拒绝新任务。个人历史、记忆和目录不会自动同步。
        </p>
      </div>
      <div className="flex shrink-0 items-center pt-0.5">
        <Switch
          checked={enabled}
          aria-labelledby={titleId}
          aria-describedby={descId}
          disabled={busy || !state || (!enabled && !ready)}
          onClick={() => void toggle()}
        />
      </div>
    </div>
    {!ready && !enabled && <p className="text-[12px] text-ink-tertiary">个人 Cloud 启动运行后将自动开启协作。</p>}
    {alertText && (
      <p role="alert" className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
        <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span>{alertText}</span>
      </p>
    )}
  </div>;
}
