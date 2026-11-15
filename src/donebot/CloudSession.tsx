import { useCallback, useEffect, useRef, useState } from "react";
import { DONEBOT_CLOUD_URL } from "./services";

export function DoneBotCloudSessionEnded() {
  const reconnect = window.ogb?.workspaces?.reconnectCloud;
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
  useEffect(() => { void restore(); }, [restore]);
  return <main className="flex min-h-screen items-center justify-center bg-app p-6 text-ink">
    <section className="max-w-md rounded-2xl border border-hairline bg-surface p-8 text-center">
      <h1 className="text-xl font-semibold">{connecting ? "正在重新连接 Cloud…" : "Cloud 会话已结束"}</h1>
      <p className="mt-3 text-sm text-ink-secondary">{error || (reconnect ? "正在恢复你的云端工作空间。" : "请返回控制台检查实例状态，并重新打开云实例。")}</p>
      {reconnect ? <button className="ui-button mt-6" disabled={connecting} onClick={() => void restore()}>重试连接</button>
        : <a className="ui-button mt-6 inline-flex" href={DONEBOT_CLOUD_URL}>返回 Cloud 控制台</a>}
    </section>
  </main>;
}
