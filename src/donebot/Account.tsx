import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, LogOut, RefreshCw } from "lucide-react";
import { doneBotMediaConcurrency, type DoneBotAccountState, type DoneBotCatalog } from "../../shared/donebot";
import { api } from "@/state/api";
import { useStore } from "@/state/store";
import { Card } from "@/components/SettingsPrimitives";
import { WindowFrameBar } from "@/components/WindowFrameBar";
import { WindowCaptionButtons } from "@/components/WindowCaptionButtons";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { DoneBotSignIn } from "./SignIn";
import { isDoneBotCloudBrowser } from "./services";
import { DoneBotCloudAccess } from "./CloudAccess";

const buttonClass = "ui-button inline-flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50";
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败，请稍后重试。";
const post = <T,>(path: string, body: Record<string, unknown>) => api<T>(`/api/donebot/${path}`, { method: "POST", body: JSON.stringify(body) });

export function DoneBotAccountGate({ children }: { children: ReactNode }) {
  const { state } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const enabled = state.config?.donebot?.enabled === true;
  if (!state.config) return <main className="flex h-full items-center justify-center bg-app text-ink-secondary"><Loader2 size={20} className="animate-spin" aria-label="正在加载 DoneBot" /></main>;
  if (!enabled) return children;
  if (state.config?.donebot?.authenticated) return children;
  return <div className="flex h-full flex-col bg-app"><WindowFrameBar /><main className="min-h-0 flex-1 overflow-auto"><DoneBotSignIn /></main><WindowCaptionButtons visible={capabilities.windowChrome === "win-caption" && Boolean(window.ogb?.windowControls)} /></div>;
}

export function DoneBotAccountSettings() {
  const { state, dispatch } = useStore();
  const [catalog, setCatalog] = useState<DoneBotCatalog | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [concurrency, setConcurrency] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const email = state.config?.donebot?.user?.email;
  const refresh = async () => {
    const generation = ++epoch.current;
    setBusy(true); setError("");
    const result = await Promise.allSettled([api<DoneBotCatalog>("/api/donebot/catalog"), api<{ balance_cents?: number | string; concurrency?: number }>("/api/donebot/account")]);
    if (generation !== epoch.current) return;
    if (result[0].status === "fulfilled") setCatalog(result[0].value); else setError(errorText(result[0].reason));
    if (result[1].status === "fulfilled") {
      const account = result[1].value;
      const cents = account.balance_cents === undefined ? NaN : Number(account.balance_cents);
      setBalance(Number.isFinite(cents) ? cents / 100 : null);
      setConcurrency(typeof account.concurrency === "number" && doneBotMediaConcurrency(account.concurrency) !== null ? account.concurrency : null);
    } else { setConcurrency(null); setError(errorText(result[1].reason)); }
    setBusy(false);
  };
  useEffect(() => { void refresh(); return () => { epoch.current++; }; }, [email]);
  const logout = async () => {
    ++epoch.current; setBusy(true); setError("");
    try {
      const account = await post<DoneBotAccountState>("logout", {});
      if (state.config) dispatch({ type: "configStatus", config: { ...state.config, donebot: account } });
    } catch (error) { setError(errorText(error)); setBusy(false); }
  };
  return <div data-donebot-account className="flex flex-col gap-4">
    <Card title="DoneBot 账号" subtitle="模型服务由 DoneBot 统一提供。">
      <div className="flex flex-wrap items-center justify-between gap-3 text-[14px] text-ink"><span className="min-w-0 break-all">{email ?? "已登录"}</span>{!isDoneBotCloudBrowser() && <button type="button" disabled={busy} onClick={() => void logout()} className={buttonClass}><LogOut size={14} />退出登录</button>}</div>
      {balance !== null && <p className="mt-3 text-[13px] text-ink-secondary">可用余额（CNY）：{balance.toLocaleString(undefined, { maximumFractionDigits: 4 })}</p>}
      <p className="mt-3 text-[13px] text-ink-secondary">{concurrency === null ? "账号并发尚未同步，媒体任务将等待配置。" : `账号总并发：${concurrency}；图片、视频和音乐共用并发：${doneBotMediaConcurrency(concurrency)}。`}</p>
      {concurrency === 1 && <p className="mt-2 text-[13px] text-ink-secondary">当前仅 1 个并发，媒体执行时无法为其他模型保留并发。</p>}
      <p className="mt-2 text-[13px] text-ink-secondary">文本、语音和媒体共用账号并发，图片、视频和音乐任务在并发用满时自动排队。</p>
      {!state.config?.donebot?.persistent && <p className="mt-3 text-[13px] text-ink-secondary">当前设备未启用凭据持久保存，重启后需要重新登录。</p>}
    </Card>
    <Card title="DoneBot Cloud" subtitle="使用同一个 DoneBot 账号，开通或管理你的专属云实例。">
      {isDoneBotCloudBrowser() ? <p className="text-[13px] text-ink-secondary">请在本机 DoneBot 客户端管理 Cloud 订阅。</p> : <DoneBotCloudAccess key={state.config?.donebot?.user?.id} heading={false} />}
    </Card>
    <Card title="可用模型" subtitle="账号可使用的模型将自动同步。">
      <button type="button" disabled={busy} onClick={() => void refresh()} className={buttonClass}><RefreshCw size={14} className={busy ? "animate-spin" : ""} />刷新模型</button>
      {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
      {catalog && <ul className="mt-4 divide-y divide-hairline">{catalog.models.map(model => <li key={model.id} className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-[13px]"><span className="break-all text-ink">{model.display_name || model.id}</span><span className="text-ink-secondary">{model.media_types.join(" · ")}</span></li>)}</ul>}
      {catalog?.models.length === 0 && <p className="mt-3 text-[13px] text-ink-secondary">当前账号暂无可用模型。</p>}
    </Card>
  </div>;
}
