import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  LogIn,
  MessageSquare,
  Plus,
  RefreshCw,
  ShieldAlert,
  X,
} from "lucide-react";
import type {
  ExternalCodingAgentId,
  ExternalCodingAgentStatus,
} from "../../shared/coding-agents";
import { api, openBot, useStore, type Bot } from "@/state/store";
import { useShowThreads } from "@/lib/thread-preferences";
import { cn } from "@/lib/cn";
import { CodingAgentAvatar } from "./CodingAgentAvatar";
import "./coding-agents.css";

interface AuthFlowView {
  agentId: ExternalCodingAgentId;
  flowId: string | null;
  authorizationUrl: string | null;
  userCode?: string;
  message?: string;
}

function sourceLabel(source: ExternalCodingAgentStatus["source"]): string {
  if (source === "desktop") return "桌面端";
  if (source === "managed") return "官方运行时";
  if (source === "cli") return "CLI";
  return "未安装";
}

function isOutsideRect(event: PointerEvent, dialog: HTMLDialogElement): boolean {
  const rect = dialog.getBoundingClientRect();
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
}

export function CodingAgentsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [agents, setAgents] = useState<ExternalCodingAgentStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [busyAgentId, setBusyAgentId] = useState<ExternalCodingAgentId | null>(null);
  const [expandedAddId, setExpandedAddId] = useState<ExternalCodingAgentId | null>(null);
  const [customName, setCustomName] = useState("");
  const [customCwd, setCustomCwd] = useState("");
  const [authFlow, setAuthFlow] = useState<AuthFlowView | null>(null);

  const loadAgents = useCallback(async (fresh = false) => {
    setError("");
    if (fresh) setRefreshing(true);
    else setLoading(true);
    try {
      const data = await api<{ agents: ExternalCodingAgentStatus[] }>(
        `/api/donebot/coding-agents${fresh ? "?fresh=1" : ""}`,
      );
      setAgents(Array.isArray(data.agents) ? data.agents : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "检测本机编程 Agent 失败。");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open && typeof dialog.showModal === "function") {
        dialog.showModal();
      }
      void loadAgents(false);
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open, loadAgents]);

  // Fallback for browsers without native <dialog closedby="any"> support (e.g. Safari).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || "closedBy" in HTMLDialogElement.prototype) return;
    let pressedOutside = false;
    const onPointerDown = (event: PointerEvent) => {
      pressedOutside = isOutsideRect(event, dialog);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (pressedOutside && isOutsideRect(event, dialog) && dialog.open) {
        dialog.close();
      }
      pressedOutside = false;
    };
    dialog.addEventListener("pointerdown", onPointerDown);
    dialog.addEventListener("pointerup", onPointerUp);
    return () => {
      dialog.removeEventListener("pointerdown", onPointerDown);
      dialog.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  useEffect(() => {
    if (!authFlow?.flowId) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api<{ auth: { phase: string; message?: string } }>(
        `/api/donebot/coding-agents/${authFlow.agentId}/auth/status?flowId=${encodeURIComponent(authFlow.flowId!)}`,
      )
        .then((res) => {
          if (cancelled) return;
          const phase = res.auth?.phase;
          if (phase === "succeeded") {
            setAuthFlow(null);
            void loadAgents(true);
          } else if (phase === "failed" || phase === "expired" || phase === "cancelled") {
            setError(res.auth?.message || "登录未完成，请重试。");
            setAuthFlow(null);
          }
        })
        .catch(() => { /* keep polling until completed or dismissed */ });
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [authFlow, loadAgents]);

  const handleClose = () => {
    const dialog = dialogRef.current;
    if (dialog) dialog.returnValue = "";
    setAuthFlow(null);
    setExpandedAddId(null);
    onCloseRef.current();
  };

  const closeDialog = () => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    else handleClose();
  };

  const openExistingBot = (botId: string) => {
    const found = state.bots.find((b) => b.id === botId);
    if (found) openBot(dispatch, found, showThreads);
    closeDialog();
  };

  const createCodingAgentBot = async (
    agent: ExternalCodingAgentStatus,
    opts?: { name?: string; cwd?: string },
  ) => {
    setError("");
    setBusyAgentId(agent.id);
    try {
      const payload: Record<string, unknown> = {};
      if (opts?.name?.trim()) payload.name = opts.name.trim();
      if (opts?.cwd?.trim()) payload.cwd = opts.cwd.trim();
      const res = await api<{ bot: Bot }>(`/api/donebot/coding-agents/${agent.id}/bot`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (res.bot) {
        dispatch({ type: "botAdded", bot: res.bot });
        openBot(dispatch, res.bot, showThreads);
      }
      setExpandedAddId(null);
      setCustomName("");
      setCustomCwd("");
      closeDialog();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `创建 ${agent.displayName} 失败。`);
    } finally {
      setBusyAgentId(null);
    }
  };

  const installManagedRuntime = async (agent: ExternalCodingAgentStatus) => {
    setError("");
    setBusyAgentId(agent.id);
    try {
      const res = await api<{ agent: ExternalCodingAgentStatus }>(
        `/api/donebot/coding-agents/${agent.id}/install`,
        { method: "POST" },
      );
      if (res.agent) {
        setAgents((prev) => prev.map((item) => (item.id === agent.id ? res.agent : item)));
      } else {
        await loadAgents(true);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `安装 ${agent.displayName} 运行时失败。`);
    } finally {
      setBusyAgentId(null);
    }
  };

  const startInAppAuth = async (agent: ExternalCodingAgentStatus) => {
    setError("");
    setBusyAgentId(agent.id);
    try {
      const res = await api<{
        auth: { phase: string; flowId: string | null; authorizationUrl: string | null; userCode?: string };
      }>(`/api/donebot/coding-agents/${agent.id}/auth/start`, { method: "POST" });
      if (res.auth.phase === "succeeded") {
        await loadAgents(true);
        return;
      }
      setAuthFlow({
        agentId: agent.id,
        flowId: res.auth.flowId,
        authorizationUrl: res.auth.authorizationUrl,
        userCode: res.auth.userCode,
      });
      if (res.auth.authorizationUrl && typeof window !== "undefined") {
        window.open(res.auth.authorizationUrl, "_blank", "noopener,noreferrer");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `发起 ${agent.displayName} 登录失败。`);
    } finally {
      setBusyAgentId(null);
    }
  };

  const refreshSingleAgent = async (agent: ExternalCodingAgentStatus) => {
    setError("");
    setBusyAgentId(agent.id);
    try {
      const res = await api<{ agent: ExternalCodingAgentStatus }>(
        `/api/donebot/coding-agents/${agent.id}/refresh`,
        { method: "POST" },
      );
      if (res.agent) {
        setAgents((prev) => prev.map((item) => (item.id === agent.id ? res.agent : item)));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `刷新 ${agent.displayName} 状态失败。`);
    } finally {
      setBusyAgentId(null);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: "any" } as Record<string, string>)}
      aria-labelledby={titleId}
      onClose={handleClose}
      className="donebot-coding-agents-dialog"
    >
      <div className="flex max-h-[min(86vh,760px)] flex-col overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-hairline/40 px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[16px] font-semibold tracking-tight text-ink">
              接入外部编程 Agent
            </h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">
              自动检测本机已安装的官方桌面应用或 CLI，继续使用你自己的订阅或账号，不经过 DoneBot 网关。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => void loadAgents(true)}
              disabled={refreshing || loading}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-hairline/50 bg-raised/70 px-2.5 text-[12px] font-medium text-ink hover:bg-raised disabled:opacity-50"
            >
              <RefreshCw size={13} className={cn(refreshing && "animate-spin")} aria-hidden="true" />
              重新检测
            </button>
            <button
              type="button"
              onClick={closeDialog}
              aria-label="关闭窗口"
              className="flex size-8 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="flex items-center gap-2 border-b border-hairline/30 bg-inset/60 px-5 py-2.5 text-[12px] text-ink-secondary">
          <ShieldAlert size={14} className="shrink-0 text-warning" aria-hidden="true" />
          <span>外部本地编程 Agent 仅限个人本地工作空间使用，不允许加入群聊或团队群聊。</span>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div
              role="alert"
              className="mb-3 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[12.5px] text-danger"
            >
              {error}
            </div>
          )}

          {authFlow && (
            <div className="mb-3 rounded-xl border border-accent/30 bg-accent/10 px-3.5 py-3 text-[12.5px] text-ink">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-medium">
                  <Loader2 size={14} className="animate-spin text-accent" aria-hidden="true" />
                  <span>正在等待浏览器完成登录授权…</span>
                </div>
                <button
                  type="button"
                  onClick={() => setAuthFlow(null)}
                  className="text-[12px] text-ink-secondary hover:text-ink"
                >
                  取消等待
                </button>
              </div>
              {authFlow.userCode && (
                <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-secondary">
                  <span>授权码：</span>
                  <code className="rounded bg-inset px-2 py-0.5 font-mono text-[13px] font-semibold text-ink">
                    {authFlow.userCode}
                  </code>
                </div>
              )}
              {authFlow.authorizationUrl && (
                <a
                  href={authFlow.authorizationUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline"
                >
                  打开登录页面
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              )}
            </div>
          )}

          {loading && agents.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-ink-secondary">
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              正在检测本机已安装的编程 Agent…
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {agents.map((agent) => {
                const busy = busyAgentId === agent.id;
                const ready = agent.installed && agent.authenticated;
                const expanded = expandedAddId === agent.id;
                return (
                  <li
                    key={agent.id}
                    data-coding-agent-card={agent.id}
                    className="rounded-2xl border border-hairline/45 bg-card p-3.5 transition-colors hover:border-hairline/80"
                  >
                    <div className="flex items-start gap-3.5">
                      <CodingAgentAvatar agentId={agent.id} size={44} label={agent.displayName} />

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[14.5px] font-semibold text-ink">{agent.displayName}</span>
                          <span className="rounded-md bg-inset px-1.5 py-0.5 text-[11px] font-medium text-ink-secondary">
                            {agent.vendor}
                          </span>
                          {ready ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
                              <CheckCircle2 size={11} aria-hidden="true" />
                              已就绪 · {sourceLabel(agent.source)}
                            </span>
                          ) : agent.installed ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning">
                              已检测（{sourceLabel(agent.source)}）· 待登录
                            </span>
                          ) : agent.desktopAppDetected ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
                              已检测到桌面端 · 需初始化引擎
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-0.5 text-[11px] font-medium text-ink-tertiary">
                              未检测到安装
                            </span>
                          )}
                          {agent.version && (
                            <span className="text-[11px] text-ink-tertiary">v{agent.version}</span>
                          )}
                        </div>

                        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">
                          {agent.tagline}
                        </p>

                        {agent.account && (
                          <div className="mt-1 text-[11.5px] text-ink-tertiary">
                            当前账号：{agent.account}
                          </div>
                        )}

                        {!ready && (
                          <div className="mt-1.5 text-[11.5px] leading-relaxed text-ink-tertiary">
                            {agent.reason || agent.loginGuide}
                          </div>
                        )}

                        {agent.bots.length > 0 && (
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            {agent.bots.map((bot) => (
                              <button
                                key={bot.id}
                                type="button"
                                onClick={() => openExistingBot(bot.id)}
                                className="inline-flex items-center gap-1 rounded-lg border border-hairline/40 bg-inset/80 px-2 py-1 text-[11.5px] font-medium text-ink hover:bg-raised"
                              >
                                <MessageSquare size={11} className="text-accent" aria-hidden="true" />
                                <span>打开 {bot.name}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        {!agent.installed && agent.supportsManagedInstall ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void installManagedRuntime(agent)}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                          >
                            {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                            一键安装
                          </button>
                        ) : agent.installed && !agent.authenticated && agent.supportsInAppAuth ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void startInAppAuth(agent)}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                          >
                            {busy ? <Loader2 size={13} className="animate-spin" /> : <LogIn size={13} />}
                            立即登录
                          </button>
                        ) : ready ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void createCodingAgentBot(agent)}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                          >
                            {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                            添加为 Bot
                          </button>
                        ) : (
                          <a
                            href={agent.docsUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex h-8 items-center gap-1 rounded-lg border border-hairline/50 bg-raised/70 px-2.5 text-[12px] font-medium text-ink hover:bg-raised"
                          >
                            安装说明
                            <ExternalLink size={12} aria-hidden="true" />
                          </a>
                        )}

                        <div className="flex items-center gap-1">
                          {ready && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                if (expanded) {
                                  setExpandedAddId(null);
                                } else {
                                  setExpandedAddId(agent.id);
                                  setCustomName(agent.bots.length === 0 ? agent.name : `${agent.name} ${agent.bots.length + 1}`);
                                  setCustomCwd("");
                                }
                              }}
                              className="rounded-md px-2 py-1 text-[11.5px] text-ink-secondary hover:bg-raised hover:text-ink"
                            >
                              {expanded ? "收起配置" : "绑定项目目录"}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void refreshSingleAgent(agent)}
                            title="重新检测状态"
                            className="rounded-md p-1 text-ink-tertiary hover:bg-raised hover:text-ink disabled:opacity-40"
                          >
                            <RefreshCw size={12} className={cn(busy && "animate-spin")} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    </div>

                    {expanded && ready && (
                      <div className="mt-3 flex flex-col gap-2 rounded-xl border border-hairline/40 bg-inset/60 p-3">
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <label className="flex flex-col gap-1 text-[11.5px] text-ink-secondary">
                            <span>机器人名称</span>
                            <input
                              type="text"
                              value={customName}
                              maxLength={80}
                              onChange={(event) => setCustomName(event.target.value)}
                              placeholder={agent.name}
                              className="h-8 rounded-lg border border-hairline/50 bg-panel px-2.5 text-[12.5px] text-ink focus:border-accent focus:outline-none"
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-[11.5px] text-ink-secondary">
                            <span className="inline-flex items-center gap-1">
                              <FolderOpen size={11} aria-hidden="true" />
                              默认代码仓库目录（可选）
                            </span>
                            <input
                              type="text"
                              value={customCwd}
                              onChange={(event) => setCustomCwd(event.target.value)}
                              placeholder="例如 /Users/name/Dev/my-project"
                              className="h-8 rounded-lg border border-hairline/50 bg-panel px-2.5 text-[12.5px] text-ink focus:border-accent focus:outline-none"
                            />
                          </label>
                        </div>
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setExpandedAddId(null)}
                            className="h-7 rounded-lg px-2.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void createCodingAgentBot(agent, { name: customName, cwd: customCwd })}
                            className="inline-flex h-7 items-center gap-1 rounded-lg bg-accent px-3 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                          >
                            {busy && <Loader2 size={12} className="animate-spin" />}
                            创建并进入对话
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </dialog>
  );
}
