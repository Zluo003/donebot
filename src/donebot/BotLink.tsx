import { useEffect, useRef, useState } from "react";

type LinkState = { enabled: boolean; connected: boolean; available: boolean; error: string };

export function DoneBotBotLink({ accountId, instanceId, ready }: { accountId: string; instanceId: string; ready: boolean }) {
  const bridge = window.ogb?.workspaces?.botLink;
  const [state, setState] = useState<LinkState | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
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
  }, [bridge, accountId, instanceId]);
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
  return <div className="w-full space-y-2 border-t border-hairline pt-3" data-donebot-bot-link>
    <div className="flex items-center justify-between gap-3">
      <span id="donebot-bot-link-title" className="text-[13px] font-medium text-ink">本机与 Cloud 协作</span>
      <button type="button" role="switch" aria-labelledby="donebot-bot-link-title" aria-checked={state?.enabled ?? false} disabled={busy || !state || !state.enabled && !ready} onClick={() => void toggle()} className="ui-button text-[12px] disabled:opacity-50">{busy ? "正在设置…" : state?.enabled ? "关闭" : "开启"}</button>
    </div>
    <p className="text-[12px] leading-relaxed text-ink-secondary">开启后，两处的 Bot 可相互委派任务，并传递任务所需的上下文和附件。本机任务需要这台电脑保持运行；离线时拒绝新任务。个人历史、记忆和目录不会自动同步。</p>
    {state?.enabled && <p role="status" className="text-[12px] text-ink-secondary">{state.connected ? "协作已连接" : "协作已开启，等待连接"}</p>}
    {!ready && !state?.enabled && <p className="text-[12px] text-ink-secondary">先连接当前账号的个人 Cloud，再开启协作。</p>}
    {(error || state?.error) && <p role="alert" className="text-[12px] text-danger">{error || state?.error}</p>}
  </div>;
}
