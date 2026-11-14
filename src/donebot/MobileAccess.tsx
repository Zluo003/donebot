import { useEffect, useState } from "react";
import { RefreshCw, Smartphone } from "lucide-react";
import { api } from "@/state/api";
import { Card } from "@/components/SettingsPrimitives";

interface Status { authenticated: boolean; registered: boolean; relay: string; node: string | null; problem: string }
export function DoneBotMobileAccess() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try { const next = await api<Status>("/api/donebot/mobile/status"); if (active) { setStatus(next); setError(""); } }
      catch { if (active) setError("无法读取手机连接状态，请稍后重试。"); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 5_000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const ready = !error && status?.registered && status.relay === "connected";
  const title = !status ? "正在检查连接…" : !status.authenticated ? "请先登录 DoneBot 账号" : ready ? "手机连接已就绪" : status.problem === "unavailable" ? "手机连接服务尚未启用" : status.problem === "login" ? "请重新登录 DoneBot 账号" : "正在连接手机服务";
  return <Card title="手机连接" subtitle="在手机 App 登录同一个 DoneBot 账号，即可自动找到这台电脑，无需扫码配对。">
    <div className="flex items-start gap-3" data-phone-pairing="computer">
      <Smartphone size={20} className={ready ? "text-accent" : "text-ink-secondary"} />
      <div className="space-y-2 text-[13px]">
        <p role="status" className="font-medium text-ink">{title}</p>
        <p className="text-ink-secondary">{ready ? "请保持这台电脑的 DoneBot 运行。" : status?.problem === "unavailable" ? "账号登录已可用，远程连接服务需要管理员完成部署后才能使用。" : "电脑需要保持运行并能够访问 DoneBot 服务。连接状态会自动更新。"}</p>
        {error && <p role="alert" className="text-red-500">{error}</p>}
        {!ready && status?.authenticated && !status.problem && <RefreshCw size={14} className="animate-spin text-ink-secondary" />}
      </div>
    </div>
  </Card>;
}
