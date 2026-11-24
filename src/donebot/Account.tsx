import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, LogOut, Pencil } from "lucide-react";
import { doneBotMediaConcurrency, type DoneBotAccountState } from "../../shared/donebot";
import { api } from "@/state/api";
import { useStore } from "@/state/store";
import { Card } from "@/components/SettingsPrimitives";
import { WindowFrameBar } from "@/components/WindowFrameBar";
import { WindowCaptionButtons } from "@/components/WindowCaptionButtons";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { DoneBotSignIn } from "./SignIn";
import { isDoneBotCloudBrowser } from "./services";
import { DoneBotMediaSettingsPanel } from "./MediaSettings";
import { CollabAvatar, CollabProfileDialog } from "./CollabAvatar";
import { isCollabEligible, isHumanTeamCollabVisible, refreshCollabOverview } from "./collab-store";

const buttonClass = "ui-button inline-flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50";
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败，请稍后重试。";
const post = <T,>(path: string, body: Record<string, unknown>) => api<T>(`/api/donebot/${path}`, { method: "POST", body: JSON.stringify(body) });

export function DoneBotAccountGate({ children }: { children: ReactNode }) {
  const { state } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const enabled = state.config?.donebot?.enabled === true;
  if (!state.config) return <main className="flex h-full items-center justify-center bg-app text-ink-secondary"><Loader2 size={20} className="animate-spin" aria-label="正在加载 DoneBot" /></main>;
  if (!enabled || state.config?.team || state.config?.donebot?.authenticated) return children;
  return <div className="flex h-full flex-col bg-app"><WindowFrameBar /><main className="min-h-0 flex-1 overflow-auto"><DoneBotSignIn /></main><WindowCaptionButtons visible={capabilities.windowChrome === "win-caption" && Boolean(window.ogb?.windowControls)} /></div>;
}

export function DoneBotAccountSettings() {
  const { state, dispatch } = useStore();
  const team = state.config?.team;
  const [balance, setBalance] = useState<number | null>(null);
  const [concurrency, setConcurrency] = useState<number | null>(null);
  const [profile, setProfile] = useState<{ nickname: string; avatar_url: string }>({
    nickname: state.config?.profile?.name ?? "",
    avatar_url: state.config?.profile?.avatarUrl ?? "",
  });
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const email = state.config?.donebot?.user?.email || state.config?.profile?.email;
  const canEditProfile = isCollabEligible(state.config);
  const refresh = async () => {
    const generation = ++epoch.current;
    setBusy(true); setError(""); setBalance(null); setConcurrency(null);
    try {
      const [account, remoteProfile] = await Promise.all([
        api<{ balance_cents?: number | string; concurrency?: number }>("/api/donebot/account"),
        canEditProfile
          ? api<{ email?: string; nickname?: string; avatar_url?: string; local_avatar_url?: string }>("/api/donebot/collab/profile").catch(() => null)
          : Promise.resolve(null),
      ]);
      if (generation !== epoch.current) return;
      const cents = account.balance_cents === undefined ? NaN : Number(account.balance_cents);
      setBalance(Number.isFinite(cents) ? cents / 100 : null);
      setConcurrency(typeof account.concurrency === "number" && doneBotMediaConcurrency(account.concurrency) !== null ? account.concurrency : null);
      if (remoteProfile) {
        const nextNickname = remoteProfile.nickname?.trim() || state.config?.profile?.name || "";
        const nextAvatar = remoteProfile.avatar_url?.trim() || state.config?.profile?.avatarUrl || "";
        setProfile({ nickname: nextNickname, avatar_url: nextAvatar });
        const nextLocalAvatar = remoteProfile.local_avatar_url !== undefined
          ? (remoteProfile.local_avatar_url || undefined)
          : (nextAvatar || undefined);
        const nextEmail = remoteProfile.email?.trim() || email || state.config?.profile?.email || "";
        if (
          state.config
          && (
            nextNickname !== (state.config.profile?.name ?? "")
            || nextLocalAvatar !== state.config.profile?.avatarUrl
            || nextEmail !== (state.config.profile?.email ?? "")
          )
        ) {
          dispatch({
            type: "configStatus",
            config: {
              ...state.config,
              profile: {
                ...state.config.profile,
                name: nextNickname,
                email: nextEmail,
                avatarUrl: nextLocalAvatar,
              },
            },
          });
        }
      }
    } catch (error) { if (generation === epoch.current) setError(errorText(error)); }
    finally { if (generation === epoch.current) setBusy(false); }
  };
  useEffect(() => { if (team) return; void refresh(); return () => { epoch.current++; }; }, [team, email, state.config?.donebot?.user?.id]);
  if (team) {
    return <div data-donebot-account className="flex flex-col gap-4">
      <Card title="DoneBot 团队空间" subtitle="当前工作空间由团队统一提供模型服务。">
        <p className="text-[14px] text-ink">当前团队：{team.name}</p>
        {email && <p className="mt-2 text-[13px] text-ink-secondary">当前成员：{email}</p>}
        <p className="mt-3 text-[13px] text-ink-secondary">团队模型费用由团队 Owner 统一结算；个人账号、余额充值、Cloud 订阅及团队成员管理请切回本机或个人空间操作。</p>
      </Card>
    </div>;
  }
  const logout = async () => {
    ++epoch.current; setBusy(true); setError("");
    try {
      const account = await post<DoneBotAccountState>("logout", {});
      if (state.config) dispatch({ type: "configStatus", config: { ...state.config, donebot: account } });
    } catch (error) { setError(errorText(error)); setBusy(false); }
  };
  return <div data-donebot-account className="flex flex-col gap-4">
    <Card title="DoneBot 账号" subtitle="模型服务由 DoneBot 统一提供。">
      <div className="flex flex-wrap items-center justify-between gap-3 text-[14px] text-ink">
        <div className="flex min-w-0 items-center gap-3">
          <CollabAvatar
            avatarUrl={profile.avatar_url || state.config?.profile?.avatarUrl}
            nickname={profile.nickname || state.config?.profile?.name}
            email={email}
            size={40}
          />
          <div className="min-w-0">
            <div className="truncate font-medium text-ink">
              {profile.nickname || state.config?.profile?.name || email || "已登录"}
            </div>
            {(profile.nickname || state.config?.profile?.name) && email && (
              <div className="truncate text-[12px] text-ink-secondary">{email}</div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canEditProfile && (
            <button type="button" disabled={busy} onClick={() => setProfileDialogOpen(true)} className={buttonClass}>
              <Pencil size={13} aria-hidden="true" />编辑资料
            </button>
          )}
          {!isDoneBotCloudBrowser() && <button type="button" disabled={busy} onClick={() => void logout()} className={buttonClass}><LogOut size={14} aria-hidden="true" />退出登录</button>}
        </div>
      </div>
      {balance !== null && <p className="mt-3 text-[13px] text-ink-secondary">可用余额（CNY）：{balance.toLocaleString(undefined, { maximumFractionDigits: 4 })}</p>}
      <p className="mt-3 text-[13px] text-ink-secondary">{concurrency === null ? "账号并发尚未同步，媒体任务将等待配置。" : `账号总并发：${doneBotMediaConcurrency(concurrency)}；文本、语音和媒体共同使用全部额度。`}</p>
      <p className="mt-2 text-[13px] text-ink-secondary">文本、语音和媒体共用账号并发，图片、视频和音乐任务在并发用满时自动排队。</p>
      {!state.config?.donebot?.persistent && <p className="mt-3 text-[13px] text-ink-secondary">当前设备未启用凭据持久保存，重启后需要重新登录。</p>}
      {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
    </Card>
    {canEditProfile && (
      <CollabProfileDialog
        open={profileDialogOpen}
        onClose={() => setProfileDialogOpen(false)}
        email={email ?? ""}
        initialNickname={profile.nickname || state.config?.profile?.name || ""}
        initialAvatarUrl={profile.avatar_url || state.config?.profile?.avatarUrl || ""}
        onSaved={async next => {
          setProfile(next);
          if (isHumanTeamCollabVisible(state.config)) {
            await refreshCollabOverview({ silent: true });
          }
        }}
      />
    )}
    <DoneBotMediaSettingsPanel key={state.config?.donebot?.user?.id} />
  </div>;
}
