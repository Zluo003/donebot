import { useMemo, useState } from "react";
import { AlertCircle, ArrowUpRight, Bot, Loader2, Send, Sparkles, X } from "lucide-react";
import { api } from "@/state/api";
import { useStore } from "@/state/store";
import { openBot } from "@/state/thread-navigation";
import { appendComposerDraft } from "@/lib/drafts";
import { cn } from "@/lib/cn";
import { isExternalCodingAgentBot } from "../../shared/coding-agents";
import type { DoneBotTeamMember } from "../../shared/donebot-teams";
import { setCollabSidebarTab } from "./collab-store";
import { cleanError, COLLAB_BUTTON, COLLAB_INPUT, displayPersonName } from "./collab-types";

export interface DispatchViaBotResponse {
  bot_id: string;
  bot_name: string;
  thread_id: string;
  ok: boolean;
  reply: string;
  pending_card: boolean;
}

export function CollabTeamTaskDispatchBar({
  teamId,
  teamName,
  channelId,
  members,
  jobTitles,
  sourceQuote,
  mode = "inline",
  onDispatched,
  onCloseDialog,
}: {
  teamId: string;
  teamName: string;
  channelId?: string;
  members: DoneBotTeamMember[];
  jobTitles: Record<number, string>;
  sourceQuote?: string;
  mode?: "inline" | "dialog";
  onDispatched: () => Promise<void> | void;
  onCloseDialog?: () => void;
}) {
  const { state: appState, dispatch } = useStore();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<DispatchViaBotResponse | null>(null);

  const chiefBot = useMemo(() => {
    const visible = (appState.bots ?? []).filter(b => !b.hidden && !isExternalCodingAgentBot(b));
    return visible.find(b => b.chiefOfStaff) ?? visible[0] ?? null;
  }, [appState.bots]);

  const chiefName = chiefBot?.name || "主协调助手";

  const openChiefChat = (prefillDraft?: string) => {
    const target = (result?.bot_id
      ? (appState.bots ?? []).find(b => b.id === result.bot_id)
      : null) ?? chiefBot;
    if (!target) return;
    if (prefillDraft?.trim()) {
      appendComposerDraft(`bot:${target.id}:${target.threadId}`, prefillDraft.trim());
    }
    setCollabSidebarTab("bots");
    openBot(dispatch, target, false);
    dispatch({ type: "showChat" });
    onCloseDialog?.();
  };

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await api<DispatchViaBotResponse>(
        `/api/donebot/collab/teams/${teamId}/tasks/dispatch-via-bot`,
        {
          method: "POST",
          body: JSON.stringify({
            prompt: text,
            ...(channelId ? { channel_id: channelId } : {}),
            ...(sourceQuote ? { source_quote: sourceQuote } : {}),
          }),
        },
      );
      setResult(res);
      setPrompt("");
      await onDispatched();
    } catch (cause) {
      setError(cleanError(cause, "让主协调助手派发任务失败，请稍后重试。"));
    } finally {
      setBusy(false);
    }
  };

  const insertMemberMention = (m: DoneBotTeamMember) => {
    const name = displayPersonName(m);
    setPrompt(prev => (prev.trim() ? `${prev.trim()} ${name}` : `让${name}`));
  };

  if (mode === "inline") {
    return (
      <div className="shrink-0 border-b border-ink/[0.07] bg-inset/35 px-4 py-2.5">
        <form
          onSubmit={e => void submit(e)}
          data-collab-ai-dispatch-bar=""
          className="flex items-center gap-2 rounded-2xl bg-card/90 p-1.5 pl-3 ring-1 ring-inset ring-accent/25 focus-within:ring-accent/55"
        >
          <Sparkles size={15} className="shrink-0 text-accent-text" aria-hidden="true" />
          <input
            type="text"
            data-collab-ai-dispatch-input=""
            disabled={busy}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder={`一句话让「${chiefName}」自动派发任务，例如：让小王周五前出 3 张 9:16 竖图…`}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-tertiary focus:outline-none disabled:opacity-60"
          />
          <button
            type="submit"
            data-collab-ai-dispatch-submit=""
            disabled={busy || !prompt.trim()}
            className={`${COLLAB_BUTTON} ui-button-primary h-7 shrink-0 rounded-xl px-3 text-[12px]`}
          >
            {busy ? <Loader2 size={12.5} className="animate-spin" aria-hidden="true" /> : <Send size={12} aria-hidden="true" />}
            <span>{busy ? `${chiefName}正在派发…` : "让助手派发"}</span>
          </button>
        </form>

        {error && (
          <div role="alert" className="mt-2 flex items-center gap-2 rounded-xl bg-danger/10 px-3 py-1.5 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
            <AlertCircle size={13.5} className="shrink-0" aria-hidden="true" />
            <span className="flex-1">{error}</span>
            <button type="button" onClick={() => setError("")} className="opacity-75 hover:opacity-100"><X size={12.5} /></button>
          </div>
        )}

        {result && (
          <div
            data-collab-ai-dispatch-receipt=""
            className="mt-2 flex flex-col gap-1.5 rounded-xl bg-accent/[0.07] px-3 py-2 text-[12px] ring-1 ring-inset ring-accent/25"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 font-medium text-ink">
                <Bot size={13.5} className="text-accent-text" aria-hidden="true" />
                <span>{result.bot_name} 回执</span>
              </span>
              <div className="flex items-center gap-1.5">
                {chiefBot && (
                  <button
                    type="button"
                    data-collab-ai-dispatch-open-chat=""
                    onClick={() => openChiefChat()}
                    className="inline-flex items-center gap-0.5 rounded-full bg-card px-2 py-0.5 text-[11px] font-medium text-accent-text ring-1 ring-inset ring-accent/25 hover:bg-accent/12"
                  >
                    <span>去和「{result.bot_name}」继续聊</span>
                    <ArrowUpRight size={11} aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  aria-label="关闭回执"
                  onClick={() => setResult(null)}
                  className="text-ink-tertiary hover:text-ink"
                >
                  <X size={13} />
                </button>
              </div>
            </div>
            <p className="whitespace-pre-wrap leading-relaxed text-ink-secondary">{result.reply}</p>
          </div>
        )}
      </div>
    );
  }

  // Dialog mode: full-featured natural-language dispatch panel (default tab of 派发任务 modal).
  return (
    <div data-collab-ai-dispatch-panel="" className="flex flex-1 flex-col overflow-hidden">
      <form onSubmit={e => void submit(e)} className="flex flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4">
        <div className="flex items-start gap-2.5 rounded-2xl bg-accent/[0.08] p-3 ring-1 ring-inset ring-accent/25">
          <Sparkles size={16} className="mt-0.5 shrink-0 text-accent-text" aria-hidden="true" />
          <div className="min-w-0 flex-1 text-[12px] leading-relaxed text-ink-secondary">
            <div className="font-medium text-ink">直接用大白话告诉「{chiefName}」，不用手动填表</div>
            <p className="mt-0.5">
              会自动匹配成员分工、所属频道、截止日期并提炼客观验收清单。单条清晰需求直接建单并回执；一次拆 3 条以上或有歧义会先给草案确认。
            </p>
          </div>
        </div>

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
            <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="collab-ai-task-prompt" className="text-[13px] font-medium text-ink-secondary">
            要派发什么任务？（告诉「{chiefName}」给谁、做什么、何时交付）
          </label>
          <textarea
            id="collab-ai-task-prompt"
            autoFocus
            rows={4}
            disabled={busy}
            data-collab-ai-dispatch-textarea=""
            placeholder={`例如：\n让小王周五前做第 3 集女主定妆图，共 3 张 9:16 竖图，古风红衣人设保持一致、不能有文字乱码，做好了我来验收。`}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            className={`${COLLAB_INPUT} resize-y`}
          />
        </div>

        {members.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-ink-tertiary">点击成员快速填入：</span>
            <div className="flex flex-wrap gap-1.5">
              {members.map(m => {
                const name = displayPersonName(m);
                const role = jobTitles[m.user_id];
                return (
                  <button
                    key={m.user_id}
                    type="button"
                    disabled={busy}
                    onClick={() => insertMemberMention(m)}
                    className="inline-flex items-center gap-1 rounded-full bg-inset/80 px-2.5 py-1 text-[12px] text-ink-secondary ring-1 ring-inset ring-ink/[0.08] hover:bg-accent/12 hover:text-accent-text hover:ring-accent/25"
                  >
                    <span>@{name}</span>
                    {role && <span className="text-ink-tertiary">· {role}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {result && (
          <div
            data-collab-ai-dispatch-receipt=""
            className="flex flex-col gap-2 rounded-2xl bg-card p-3.5 ring-1 ring-inset ring-accent/30"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink">
                <Bot size={14} className="text-accent-text" aria-hidden="true" />
                <span>{result.bot_name} 已处理</span>
              </span>
              {chiefBot && (
                <button
                  type="button"
                  onClick={() => openChiefChat()}
                  className="inline-flex items-center gap-0.5 text-[12px] font-medium text-accent-text hover:underline"
                >
                  <span>打开对话继续确认/调整</span>
                  <ArrowUpRight size={12} aria-hidden="true" />
                </button>
              )}
            </div>
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-secondary">{result.reply}</p>
          </div>
        )}
      </form>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-ink/[0.07] px-5 py-3.5">
        {chiefBot ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => openChiefChat(prompt.trim()
              ? `请在团队「${teamName}」中帮我派发任务：${prompt.trim()}`
              : `请在团队「${teamName}」中帮我派发一个任务：`)}
            className={cn(COLLAB_BUTTON, "h-8 px-3 text-[12px] text-ink-secondary hover:text-ink")}
          >
            <Bot size={13.5} aria-hidden="true" />
            <span>切到「{chiefName}」对话</span>
          </button>
        ) : <span />}
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCloseDialog}
            className={`${COLLAB_BUTTON} h-8 px-3.5 text-[13px]`}
          >
            {result ? "完成" : "取消"}
          </button>
          <button
            type="button"
            data-collab-ai-dispatch-dialog-submit=""
            disabled={busy || !prompt.trim()}
            onClick={() => void submit()}
            className={`${COLLAB_BUTTON} ui-button-primary h-8 px-4 text-[13px]`}
          >
            {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Sparkles size={13} aria-hidden="true" />}
            <span>{busy ? `${chiefName}正在派发…` : `让「${chiefName}」派发`}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
