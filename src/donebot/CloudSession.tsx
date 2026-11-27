import { useCallback, useEffect, useRef, useState } from "react";
import { DONEBOT_CLOUD_URL } from "./services";

export function DoneBotCloudSessionEnded() {
  const workspaces = window.ogb?.workspaces;
  const reconnect = workspaces?.reconnectCloud;
  const open = workspaces?.open;
  const returnLocal = workspaces?.returnLocal ?? (open ? () => open("local") : undefined);
  const flight = useRef(false);
  const [connecting, setConnecting] = useState(Boolean(reconnect));
  const [error, setError] = useState("");
  const restore = useCallback(async () => {
    if (!reconnect || flight.current) return;
    flight.current = true; setConnecting(true); setError("");
    try { await reconnect(); }
    catch { setError("Cloud 暂时无法连接，请稍后重试或检查实例运行状态。"); }
    finally { flight.current = false; setConnecting(false); }
  }, [reconnect]);
  const leave = () => {
    setError("");
    void returnLocal?.().catch(() => setError("暂时无法返回本地，请从电脑菜单切换到这台电脑。"));
  };
  useEffect(() => { void restore(); }, [restore]);
  return <main className="flex min-h-screen items-center justify-center bg-app p-6 text-ink">
    <section className="max-w-md rounded-2xl border border-hairline bg-panel p-8 text-center">
      <h1 className="text-xl font-semibold">{connecting ? "正在重新连接 Cloud…" : "Cloud 会话已结束"}</h1>
      <p className="mt-3 text-sm text-ink-secondary">{error || (connecting ? "正在恢复你的云端工作空间，也可以先返回本地对话。" : "聊天记录仍保留在云端，可以稍后重新连接。")}</p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        {returnLocal && <button className="ui-button" onClick={leave}>返回本地对话</button>}
        {reconnect ? <button className="ui-button" disabled={connecting} onClick={() => void restore()}>重试连接</button>
          : !returnLocal && <a className="ui-button inline-flex" href={DONEBOT_CLOUD_URL}>返回 Cloud 控制台</a>}
      </div>
    </section>
  </main>;
}
