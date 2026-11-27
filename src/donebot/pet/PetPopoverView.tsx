import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Code2,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  RotateCcw,
  Send,
  Square,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { OpcBossReportAttachment, OpcBossReportItem } from "../../../shared/donebot-opc";
import { requestMessageFile, useLocalFileSave } from "@/components/AttachmentPreview";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { classifyAttachmentPreview } from "@/donebot/OpcArtifactPreviewDialog";
import { opcApi } from "@/donebot/opc-api";
import type {
  PetHostSnapshot,
  PetHostToPopoverMessage,
  PetPopoverCommand,
  PetPreviewTarget,
} from "./pet-protocol";

const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

function sendCommand(cmd: PetPopoverCommand) {
  void window.ogb?.desktopPet?.post("avatar", cmd);
}

function ReportApprovalCard({
  report,
  onResolved,
  onPreview,
}: {
  report: OpcBossReportItem;
  onResolved: (reportId: string) => void;
  onPreview: (attachment: OpcBossReportAttachment, reportTitle: string) => void;
}) {
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState("");
  const [working, setWorking] = useState<"approve" | "revise" | null>(null);
  const [error, setError] = useState("");
  const approveLabel = report.workflow && !report.workflow.isLastStep ? "通过并继续" : "通过";

  const approve = async () => {
    if (working) return;
    setWorking("approve");
    setError("");
    try {
      if (report.source === "workflow" && report.workflow) {
        await opcApi.decideWorkflowRun(report.workflow.runId, { action: "approve" });
      } else if (report.artifactIds.length > 1) {
        await opcApi.reviewReport({
          botId: report.botId,
          status: "approved",
          artifactIds: report.artifactIds,
          threadId: report.threadId,
          reportTitle: report.title,
        });
      } else if (report.artifactIds.length === 1) {
        await opcApi.reviewArtifact(report.artifactIds[0]!, {
          botId: report.botId,
          status: "approved",
          threadId: report.threadId,
          artifactTitle: report.title,
        });
      }
      onResolved(report.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "审批失败，请稍后重试。");
    } finally {
      setWorking(null);
    }
  };

  const submitRevision = async () => {
    if (!revising) {
      setRevising(true);
      return;
    }
    if (working) return;
    setWorking("revise");
    setError("");
    try {
      const trimmed = note.trim();
      if (report.source === "workflow" && report.workflow) {
        await opcApi.decideWorkflowRun(report.workflow.runId, { action: "revise", note: trimmed });
      } else if (report.artifactIds.length > 1) {
        await opcApi.reviewReport({
          botId: report.botId,
          status: "changes_requested",
          artifactIds: report.artifactIds,
          note: trimmed,
          threadId: report.threadId,
          reportTitle: report.title,
          dispatchRevision: true,
        });
      } else if (report.artifactIds.length === 1) {
        await opcApi.reviewArtifact(report.artifactIds[0]!, {
          botId: report.botId,
          status: "changes_requested",
          note: trimmed,
          threadId: report.threadId,
          artifactTitle: report.title,
          dispatchRevision: true,
        });
      }
      setRevising(false);
      setNote("");
      onResolved(report.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交修改意见失败。");
    } finally {
      setWorking(null);
    }
  };

  return (
    <article className="flex flex-col gap-2 rounded-xl border border-hairline/70 bg-card/95 p-3 shadow-xs">
      <div className="flex items-center justify-between gap-2 text-[11px] text-ink-tertiary">
        <span className="truncate font-medium text-ink-secondary">
          {report.workflow ? `${report.workflow.workflowName} · ${report.workflow.stepName}` : "工作台汇报"}
        </span>
        <span className="shrink-0 truncate">{report.botName}</span>
      </div>

      <h3 className="text-[13px] font-semibold leading-5 text-ink">{report.title}</h3>

      {report.summary && (
        <p className="line-clamp-3 text-[12px] leading-5 text-ink-secondary">{report.summary}</p>
      )}

      {report.attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {report.attachments.map((att) => (
            <button
              key={`${att.path}:${att.name}`}
              type="button"
              onClick={() => onPreview(att, report.title)}
              className="inline-flex max-w-full items-center gap-1 rounded-lg border border-hairline/70 bg-inset/80 px-2 py-1 text-[11px] font-medium text-ink transition-colors hover:bg-raised"
              title={`预览 ${att.name}`}
            >
              <Paperclip size={11} className="shrink-0 text-ink-tertiary" aria-hidden="true" />
              <span className="truncate">{att.name}</span>
            </button>
          ))}
        </div>
      )}

      {revising && (
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="输入修改意见（选填）…"
          rows={2}
          autoFocus
          className="w-full resize-none rounded-lg border border-hairline bg-app px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
        />
      )}

      {error && (
        <p role="alert" className="text-[11px] text-danger">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-1.5 pt-1">
        {revising && (
          <button
            type="button"
            disabled={working !== null}
            onClick={() => {
              setRevising(false);
              setNote("");
            }}
            className="h-7 rounded-lg px-2.5 text-[11px] text-ink-secondary transition-colors hover:bg-raised"
          >
            取消
          </button>
        )}
        <button
          type="button"
          disabled={working !== null}
          onClick={() => void submitRevision()}
          className="inline-flex h-7 items-center gap-1 rounded-lg border border-hairline px-2.5 text-[11px] font-medium text-ink-secondary transition-colors hover:bg-raised hover:text-ink disabled:opacity-50"
        >
          {working === "revise" ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
          {revising ? "发送修改意见" : "退回修改"}
        </button>
        <button
          type="button"
          disabled={working !== null}
          onClick={() => void approve()}
          className="inline-flex h-7 items-center gap-1 rounded-lg bg-ink px-3 text-[11px] font-medium text-app transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {working === "approve" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {approveLabel}
        </button>
      </div>
    </article>
  );
}

function AttachmentPreviewPane({
  target,
  onBack,
  onClose,
}: {
  target: PetPreviewTarget;
  onBack: () => void;
  onClose: () => void;
}) {
  const { attachment, reportTitle } = target;
  const mode = classifyAttachmentPreview(attachment);
  const needsTextFetch = mode === "markdown" || mode === "html" || mode === "text";
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textError, setTextError] = useState("");
  const [showSource, setShowSource] = useState(false);

  const save = useLocalFileSave(
    attachment.path,
    attachment.name,
    { threadId: attachment.threadId, messageId: attachment.messageId },
  );

  useEffect(() => {
    setShowSource(false);
    setTextContent(null);
    setTextError("");
    if (!needsTextFetch) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await requestMessageFile(
          attachment.path,
          { threadId: attachment.threadId, messageId: attachment.messageId },
          controller.signal,
        );
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_TEXT_PREVIEW_BYTES) {
          throw new Error("文件超过 2 MB，请直接下载查看。");
        }
        if (!controller.signal.aborted) {
          setTextContent(new TextDecoder("utf-8", { fatal: false }).decode(buf));
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setTextError(err instanceof Error ? err.message : "暂时无法加载附件内容。");
        }
      }
    })();
    return () => controller.abort();
  }, [attachment, needsTextFetch]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden rounded-2xl border border-hairline/80 bg-panel/98 text-ink shadow-2xl backdrop-blur-xl">
      <div className="flex items-center justify-between gap-2 border-b border-hairline/70 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
          >
            <ArrowLeft size={13} /> 返回审批
          </button>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-ink">{attachment.name}</div>
            <div className="truncate text-[11px] text-ink-tertiary">{reportTitle}</div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {(mode === "markdown" || mode === "html") && textContent !== null && (
            <button
              type="button"
              onClick={() => setShowSource((v) => !v)}
              className="inline-flex h-7 items-center gap-1 rounded-lg bg-raised px-2.5 text-[11px] font-medium text-ink"
            >
              {showSource ? <Eye size={12} /> : <Code2 size={12} />}
              {showSource ? "排版预览" : "源码"}
            </button>
          )}
          <button
            type="button"
            disabled={save.state === "saving"}
            onClick={() => void save.save()}
            className="inline-flex h-7 items-center gap-1 rounded-lg bg-ink px-2.5 text-[11px] font-medium text-app disabled:opacity-50"
          >
            {save.state === "saving" ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            {save.state === "saved" ? "已保存" : "下载"}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭预览"
            className="flex size-7 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center overflow-auto bg-app/75 p-4">
        {mode === "image" ? (
          <img src={attachment.previewUrl} alt={attachment.name} className="max-h-full max-w-full rounded-xl object-contain" />
        ) : mode === "video" ? (
          <video src={attachment.previewUrl} controls className="max-h-full max-w-full rounded-xl" />
        ) : mode === "audio" ? (
          <audio src={attachment.previewUrl} controls className="w-full max-w-md" />
        ) : mode === "pdf" ? (
          <iframe src={attachment.previewUrl} title={attachment.name} className="h-full w-full rounded-xl border border-hairline/60 bg-panel" />
        ) : needsTextFetch ? (
          textError ? (
            <div className="space-y-2 text-center text-[13px] text-ink-secondary">
              <FileText size={28} className="mx-auto text-ink-tertiary" />
              <p>{textError}</p>
            </div>
          ) : textContent === null ? (
            <div className="inline-flex items-center gap-2 text-[13px] text-ink-secondary">
              <Loader2 size={15} className="animate-spin" /> 正在加载附件…
            </div>
          ) : mode === "markdown" && !showSource ? (
            <div className="h-full w-full overflow-auto rounded-xl border border-hairline/50 bg-panel px-5 py-4 text-[13px] leading-6 text-ink">
              <ChatMarkdown text={textContent} />
            </div>
          ) : mode === "html" && !showSource ? (
            <iframe sandbox="" srcDoc={textContent} title={attachment.name} className="h-full w-full rounded-xl border border-hairline/50 bg-white" />
          ) : (
            <pre className="h-full w-full overflow-auto rounded-xl border border-hairline/50 bg-inset p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink">
              <code>{textContent}</code>
            </pre>
          )
        ) : (
          <div className="space-y-3 text-center">
            <FileText size={32} className="mx-auto text-ink-tertiary" />
            <p className="text-[13px] text-ink-secondary">该文件暂不支持内嵌预览，可直接下载查看。</p>
            <button
              type="button"
              onClick={() => void save.save()}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-ink px-3.5 text-[12px] font-medium text-app"
            >
              <Download size={13} /> 下载到本地
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function PetPopoverView() {
  const [mode, setMode] = useState<DesktopPetPopoverMode>("composer");
  const [snapshot, setSnapshot] = useState<PetHostSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [previewTarget, setPreviewTarget] = useState<PetPreviewTarget | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const bridge = window.ogb?.desktopPet;
    if (!bridge) return;
    const offMode = bridge.onPopoverMode((nextMode) => {
      setMode(nextMode);
      if (nextMode !== "preview") setPreviewTarget(null);
      if (nextMode === "composer") {
        setTimeout(() => inputRef.current?.focus(), 30);
      }
      sendCommand({ type: "request-sync" });
    });
    const offMsg = bridge.onMessage((raw) => {
      const msg = raw as PetHostToPopoverMessage | null;
      if (msg?.type === "host-sync") setSnapshot(msg.snapshot);
    });
    sendCommand({ type: "request-sync" });
    return () => {
      offMode();
      offMsg();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (mode === "preview" && previewTarget) {
        setPreviewTarget(null);
        void window.ogb?.desktopPet?.openPopover("approval");
        return;
      }
      if (mode === "voice") {
        sendCommand({ type: "voice-stop" });
      }
      void window.ogb?.desktopPet?.closePopover();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, previewTarget]);

  // Fit compact popover height to actual card height for composer/bubble/voice.
  useLayoutEffect(() => {
    if (mode === "preview" || mode === "approval") return;
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.height > 0) {
      void window.ogb?.desktopPet?.resizePopover({ height: Math.ceil(rect.height) + 12 });
    }
  }, [mode, snapshot?.bubble?.id, snapshot?.voice.heard, snapshot?.voice.phase, snapshot?.sending, draft]);

  const submitDraft = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    sendCommand({ type: "send", text });
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submitDraft();
    }
  };

  const closePopover = () => {
    if (mode === "voice") sendCommand({ type: "voice-stop" });
    void window.ogb?.desktopPet?.closePopover();
  };

  if (mode === "preview" && previewTarget) {
    return (
      <div className="p-1.5">
        <AttachmentPreviewPane
          target={previewTarget}
          onBack={() => {
            setPreviewTarget(null);
            void window.ogb?.desktopPet?.openPopover("approval");
          }}
          onClose={closePopover}
        />
      </div>
    );
  }

  const chiefName = snapshot?.coordinator?.name ?? "主协调助手";
  const muted = snapshot?.petState?.muted === true;
  const speaking = snapshot?.speaking === true;
  const sending = snapshot?.sending === true;
  const busy = snapshot?.coordinator?.busy === true;
  const reports = snapshot?.reports ?? [];

  if (mode === "approval") {
    return (
      <div className="flex h-screen w-screen flex-col p-1.5">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-hairline/80 bg-panel/96 text-ink shadow-[0_14px_38px_rgba(0,0,0,0.28)] backdrop-blur-xl">
          <div className="flex items-center justify-between gap-2 border-b border-hairline/70 px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <FileText size={15} className="text-amber-500" aria-hidden="true" />
              <span className="text-[13px] font-semibold text-ink">
                工作台待审批{reports.length > 0 ? `（${reports.length}）` : ""}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => void window.ogb?.desktopPet?.openWorkbench()}
                className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
              >
                完整工作台 <ArrowUpRight size={12} />
              </button>
              <button
                type="button"
                onClick={closePopover}
                aria-label="关闭"
                className="flex size-7 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="flex-1 space-y-2.5 overflow-y-auto p-3">
            {reports.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                <Check size={24} className="text-emerald-500" />
                <p className="text-[13px] font-medium text-ink">当前没有待审批汇报</p>
                <p className="text-[11px] text-ink-tertiary">新工作完成后会第一时间向您汇报。</p>
              </div>
            ) : (
              reports.map((report) => (
                <ReportApprovalCard
                  key={report.id}
                  report={report}
                  onResolved={(reportId) => sendCommand({ type: "report-resolved", reportId })}
                  onPreview={(attachment, reportTitle) => {
                    setPreviewTarget({ attachment, reportTitle });
                    void window.ogb?.desktopPet?.openPopover("preview");
                  }}
                />
              ))
            )}
          </div>
        </div>
      </div>
    );
  }

  if (mode === "bubble") {
    const bubble = snapshot?.bubble;
    return (
      <div className="p-1.5">
        <div
          ref={cardRef}
          className="rounded-2xl border border-hairline/80 bg-panel/96 px-3.5 py-3 text-ink shadow-[0_12px_32px_rgba(0,0,0,0.24)] backdrop-blur-xl"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-ink-tertiary">
                <span>{chiefName}</span>
                {speaking && <Volume2 size={11} className="text-emerald-500" />}
              </div>
              <p className={`text-[13px] leading-5 ${bubble?.kind === "error" ? "text-danger" : "text-ink"}`}>
                {bubble?.text ?? "待命中"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => sendCommand({ type: "dismiss-bubble" })}
              aria-label="关闭气泡"
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-tertiary hover:bg-raised hover:text-ink"
            >
              <X size={13} />
            </button>
          </div>
          {bubble?.kind === "report" && reports.length > 0 && (
            <div className="mt-2.5 flex justify-end">
              <button
                type="button"
                onClick={() => void window.ogb?.desktopPet?.openPopover("approval")}
                className="inline-flex h-7 items-center gap-1 rounded-lg bg-ink px-3 text-[11px] font-medium text-app transition-opacity hover:opacity-90"
              >
                <FileText size={12} /> 立即预览审批
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (mode === "voice") {
    const voice = snapshot?.voice;
    const wakePhrase = snapshot?.wakePhrase ?? `你好${chiefName}`;
    const phaseLabel =
      voice?.phase === "waking"
        ? "已唤醒，请讲…"
        : voice?.phase === "listening"
          ? "正在聆听…"
          : voice?.phase === "sending" || sending
            ? "正在传达给主协调…"
            : voice?.phase === "working" || busy
              ? "主协调处理中…"
              : voice?.phase === "speaking" || speaking
                ? snapshot?.bargeInEnabled ? "正在语音汇报（可直接开口打断）…" : "正在语音汇报…"
                : voice?.wakeEnabled
                  ? `语音唤醒待命中（喊「${wakePhrase}」）`
                  : "语音对话已就绪";

    return (
      <div className="p-1.5">
        <div
          ref={cardRef}
          className="rounded-2xl border border-hairline/80 bg-panel/96 p-3.5 text-ink shadow-[0_12px_32px_rgba(0,0,0,0.26)] backdrop-blur-xl"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="flex size-6 items-center justify-center rounded-full bg-accent/15 text-accent">
                <Mic size={13} />
              </span>
              <span className="text-[12px] font-semibold text-ink">{chiefName} · {phaseLabel}</span>
            </div>
            <button
              type="button"
              onClick={closePopover}
              aria-label="结束语音对话"
              className="flex size-6 items-center justify-center rounded-md text-ink-tertiary hover:bg-raised hover:text-ink"
            >
              <X size={13} />
            </button>
          </div>

          <div className="mt-2 min-h-[28px] rounded-lg bg-inset/75 px-2.5 py-1.5 text-[12px] leading-5 text-ink-secondary">
            {voice?.error ? (
              <span className="text-danger">{voice.error}</span>
            ) : voice?.heard ? (
              <span className="text-ink">{voice.heard}</span>
            ) : snapshot?.bubble?.text ? (
              <span className="text-ink">{snapshot.bubble.text}</span>
            ) : (
              <span>直接说出指令即可，说完自动发送。</span>
            )}
          </div>

          <div className="mt-2.5 flex items-center justify-between gap-2">
            {voice?.needsMicSettings ? (
              <button
                type="button"
                onClick={() => void window.ogb?.permOpenSettings?.("mic")}
                className="inline-flex h-7 items-center gap-1 rounded-lg bg-raised px-2.5 text-[11px] font-medium text-ink"
              >
                打开系统隐私设置
              </button>
            ) : (
              <button
                type="button"
                onClick={() => sendCommand({ type: "voice-interrupt" })}
                className="inline-flex h-7 items-center gap-1 rounded-lg bg-raised px-2.5 text-[11px] font-medium text-ink transition-colors hover:bg-raised/80"
              >
                <Mic size={12} /> {speaking ? "打断并继续说" : "重新聆听"}
              </button>
            )}
            <button
              type="button"
              onClick={() => sendCommand({ type: "voice-stop" })}
              className="inline-flex h-7 items-center gap-1 rounded-lg bg-rose-500/15 px-2.5 text-[11px] font-medium text-rose-600 transition-colors hover:bg-rose-500/25 dark:text-rose-400"
            >
              <MicOff size={12} /> {voice?.wakeEnabled ? "回到唤醒待命" : "结束对话"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Default: composer mode
  return (
    <div className="p-1.5">
      <div
        ref={cardRef}
        className="rounded-2xl border border-hairline/80 bg-panel/96 p-3 text-ink shadow-[0_14px_38px_rgba(0,0,0,0.28)] backdrop-blur-xl"
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={`size-2 shrink-0 rounded-full ${
                busy || sending ? "bg-amber-500" : speaking ? "bg-emerald-500" : "bg-emerald-500/70"
              }`}
            />
            <span className="truncate text-[12px] font-semibold text-ink">{chiefName}</span>
            <span className="shrink-0 text-[11px] text-ink-tertiary">
              {sending ? "发送中…" : busy ? "工作中" : speaking ? "播报中" : "待命"}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            {reports.length > 0 && (
              <button
                type="button"
                onClick={() => void window.ogb?.desktopPet?.openPopover("approval")}
                title={`查看 ${reports.length} 份待审批汇报`}
                className="inline-flex h-6 items-center gap-1 rounded-md bg-amber-500/15 px-1.5 text-[11px] font-medium text-amber-600 hover:bg-amber-500/25 dark:text-amber-400"
              >
                <FileText size={11} /> {reports.length}
              </button>
            )}
            {snapshot?.speechAvailable && (
              <button
                type="button"
                onClick={() => sendCommand({ type: "voice-start" })}
                title="进入语音对话"
                className="flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
              >
                <Mic size={13} />
              </button>
            )}
            <button
              type="button"
              onClick={() => sendCommand({ type: "toggle-mute" })}
              title={muted ? "取消静音" : "静音播报"}
              className="flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            >
              {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
            </button>
            <button
              type="button"
              onClick={() => void window.ogb?.desktopPet?.openMainWindow()}
              title="打开 DoneBot 主窗口"
              className="flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <ExternalLink size={12} />
            </button>
            <button
              type="button"
              onClick={closePopover}
              aria-label="关闭输入栏"
              className="flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={13} />
            </button>
          </div>
        </div>

        {snapshot?.bubble?.text && (
          <div className="mb-2 flex items-start justify-between gap-2 rounded-xl bg-inset/80 px-2.5 py-2 text-[12px] leading-5">
            <p className={snapshot.bubble.kind === "error" ? "text-danger" : "text-ink-secondary"}>
              {snapshot.bubble.text}
            </p>
            {speaking && (
              <button
                type="button"
                onClick={() => sendCommand({ type: "stop-speaking" })}
                title="停止播报"
                className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded bg-raised text-ink"
              >
                <Square size={10} />
              </button>
            )}
          </div>
        )}

        <div className="flex items-end gap-2 rounded-xl border border-hairline/80 bg-app px-2.5 py-2 focus-within:border-accent">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="给主协调下达指令，Enter 发送…"
            rows={2}
            className="max-h-[96px] min-h-[36px] flex-1 resize-none bg-transparent text-[13px] leading-5 text-ink placeholder:text-ink-tertiary focus:outline-none"
          />
          <button
            type="button"
            disabled={!draft.trim() || sending}
            onClick={submitDraft}
            aria-label="发送指令"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink text-app transition-opacity hover:opacity-90 disabled:opacity-35"
          >
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}
