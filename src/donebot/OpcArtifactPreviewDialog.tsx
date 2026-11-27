import { useEffect, useId, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Code2,
  Download,
  Eye,
  FileText,
  Loader2,
  RotateCcw,
  X,
} from "lucide-react";
import type { OpcBossReportAttachment } from "../../shared/donebot-opc";
import { requestMessageFile, useLocalFileSave } from "@/components/AttachmentPreview";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { OpcNativeDialog } from "./paperclip-ui";

const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

type PreviewKind = "image" | "video" | "audio" | "pdf" | "markdown" | "html" | "text" | "binary";

const MARKDOWN_EXT = /\.(?:md|markdown|mdx)$/i;
const HTML_EXT = /\.html?$/i;
const PDF_EXT = /\.pdf$/i;
const TEXT_EXT = /\.(?:txt|json|csv|tsv|ya?ml|xml|log|sql|sh|bash|zsh|py|ts|tsx|js|jsx|mjs|cjs|css|scss|less|go|rs|java|c|cpp|h|hpp|toml|ini|conf|env|svg)$/i;

export function classifyAttachmentPreview(att: Pick<OpcBossReportAttachment, "kind" | "name" | "path" | "mime">): PreviewKind {
  if (att.kind === "image") return "image";
  if (att.kind === "video") return "video";
  if (att.kind === "audio") return "audio";
  const target = att.name || att.path;
  if (att.mime === "application/pdf" || PDF_EXT.test(target)) return "pdf";
  if (att.mime === "text/markdown" || MARKDOWN_EXT.test(target)) return "markdown";
  if (att.mime === "text/html" || HTML_EXT.test(target)) return "html";
  if (att.mime?.startsWith("text/") || att.mime === "application/json" || TEXT_EXT.test(target)) return "text";
  return "binary";
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const lenHeader = response.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > maxBytes) {
    throw new Error("文件体积超过 2 MB，请直接下载到本地查看。");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new Error("文件体积超过 2 MB，请直接下载到本地查看。");
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
}

export function OpcArtifactPreviewDialog({
  attachment,
  onClose,
  onJumpToChat,
}: {
  attachment: OpcBossReportAttachment | null;
  onClose: () => void;
  onJumpToChat?: () => void;
}) {
  const titleId = useId();
  const mode = attachment ? classifyAttachmentPreview(attachment) : "binary";
  const needsTextFetch = mode === "markdown" || mode === "html" || mode === "text";

  const [textContent, setTextContent] = useState<string | null>(null);
  const [textError, setTextError] = useState("");
  const [showSource, setShowSource] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const save = useLocalFileSave(
    attachment?.path ?? "",
    attachment?.name,
    attachment ? { threadId: attachment.threadId, messageId: attachment.messageId } : undefined,
  );

  useEffect(() => {
    setShowSource(false);
    setTextContent(null);
    setTextError("");
    if (!attachment || !needsTextFetch) return;

    const controller = new AbortController();
    void (async () => {
      try {
        const res = await requestMessageFile(
          attachment.path,
          { threadId: attachment.threadId, messageId: attachment.messageId },
          controller.signal,
        );
        const content = await readBoundedText(res, MAX_TEXT_PREVIEW_BYTES);
        if (!controller.signal.aborted) setTextContent(content);
      } catch (err) {
        if (!controller.signal.aborted) {
          setTextError(err instanceof Error ? err.message : "暂时无法读取该附件内容，可直接下载到本地查看。");
        }
      }
    })();
    return () => controller.abort();
  }, [attachment, needsTextFetch, attempt]);

  return (
    <OpcNativeDialog
      open={attachment !== null}
      onClose={onClose}
      ariaLabelledBy={titleId}
      className="w-[min(94vw,920px)]"
    >
      {attachment && (
        <>
          <div className="flex items-center justify-between gap-3 border-b border-hairline/60 px-5 py-3.5">
            <div className="min-w-0">
              <h1 id={titleId} className="truncate text-[15px] font-semibold text-ink">
                {attachment.name}
              </h1>
              <p className="mt-0.5 truncate text-[12px] text-ink-tertiary">
                汇报附件预览
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {(mode === "markdown" || mode === "html") && textContent !== null && (
                <button
                  type="button"
                  aria-pressed={showSource}
                  onClick={() => setShowSource(v => !v)}
                  className="inline-flex h-8 items-center gap-1 rounded-full bg-ink/[0.06] px-3 text-[12px] font-medium text-ink transition-colors hover:bg-ink/[0.11]"
                >
                  {showSource ? <Eye size={13} aria-hidden="true" /> : <Code2 size={13} aria-hidden="true" />}
                  {showSource ? "排版预览" : "查看源码"}
                </button>
              )}
              <button
                type="button"
                disabled={save.state === "saving"}
                onClick={() => void save.save()}
                className="inline-flex h-8 items-center gap-1 rounded-full bg-ink px-3.5 text-[12px] font-medium text-app transition-opacity hover:opacity-85 disabled:opacity-50"
              >
                {save.state === "saving"
                  ? <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                  : save.state === "saved"
                    ? <Check size={13} aria-hidden="true" />
                    : <Download size={13} aria-hidden="true" />}
                {save.state === "saving" ? "下载中…" : save.state === "saved" ? "已保存" : "下载"}
              </button>
              {onJumpToChat && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onJumpToChat();
                  }}
                  className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[12px] text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink"
                >
                  原对话 <ArrowUpRight size={13} aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="关闭预览"
                className="flex size-8 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          </div>

          {save.state === "failed" && save.reason && (
            <div role="alert" className="border-b border-hairline/40 bg-danger/10 px-5 py-2 text-[12px] text-danger">
              {save.reason}
            </div>
          )}

          <div className="flex min-h-[280px] flex-1 items-center justify-center overflow-auto bg-app/70 p-5">
            {mode === "image" ? (
              <img
                src={attachment.previewUrl}
                alt={attachment.name}
                className="max-h-[68dvh] max-w-full rounded-xl object-contain"
              />
            ) : mode === "video" ? (
              <video
                src={attachment.previewUrl}
                controls
                className="max-h-[68dvh] max-w-full rounded-xl"
              />
            ) : mode === "audio" ? (
              <audio src={attachment.previewUrl} controls className="w-full max-w-md" />
            ) : mode === "pdf" ? (
              <iframe
                src={attachment.previewUrl}
                title={attachment.name}
                className="h-[68dvh] w-full rounded-xl border border-hairline/40 bg-panel"
              />
            ) : needsTextFetch ? (
              textError ? (
                <div className="space-y-3 text-center">
                  <FileText size={32} className="mx-auto text-ink-tertiary" aria-hidden="true" />
                  <p role="alert" className="text-[13px] text-ink-secondary">{textError}</p>
                  <div className="flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => setAttempt(v => v + 1)}
                      className="inline-flex h-8 items-center gap-1 rounded-full bg-ink/[0.06] px-3 text-[13px] font-medium text-ink hover:bg-ink/[0.11]"
                    >
                      <RotateCcw size={13} aria-hidden="true" /> 重试
                    </button>
                    <button
                      type="button"
                      disabled={save.state === "saving"}
                      onClick={() => void save.save()}
                      className="inline-flex h-8 items-center gap-1 rounded-full bg-ink px-3.5 text-[13px] font-medium text-app hover:opacity-85 disabled:opacity-50"
                    >
                      <Download size={13} aria-hidden="true" /> 下载到本地
                    </button>
                  </div>
                </div>
              ) : textContent === null ? (
                <div role="status" className="inline-flex items-center gap-2 text-[13px] text-ink-secondary">
                  <Loader2 size={16} className="animate-spin" aria-hidden="true" /> 正在加载附件内容…
                </div>
              ) : mode === "markdown" && !showSource ? (
                <div className="h-[68dvh] w-full overflow-auto rounded-xl border border-hairline/45 bg-panel px-6 py-5 text-[14px] leading-7 text-ink">
                  <ChatMarkdown text={textContent} />
                </div>
              ) : mode === "html" && !showSource ? (
                <iframe
                  sandbox=""
                  srcDoc={textContent}
                  title={attachment.name}
                  className="h-[68dvh] w-full rounded-xl border border-hairline/45 bg-white"
                />
              ) : (
                <pre
                  role="region"
                  aria-label={attachment.name}
                  tabIndex={0}
                  className="h-[68dvh] w-full overflow-auto rounded-xl border border-hairline/45 bg-inset p-4 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words text-ink"
                >
                  <code>{textContent}</code>
                </pre>
              )
            ) : (
              <div className="space-y-3 text-center">
                <FileText size={34} className="mx-auto text-ink-tertiary" aria-hidden="true" />
                <p className="text-[14px] font-medium text-ink">{attachment.name}</p>
                <p className="text-[13px] text-ink-secondary">
                  该文件格式暂不支持在窗口内直接预览，可直接下载到本地打开。
                </p>
                <button
                  type="button"
                  disabled={save.state === "saving"}
                  onClick={() => void save.save()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-medium text-app transition-opacity hover:opacity-85 disabled:opacity-50"
                >
                  {save.state === "saving"
                    ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                    : <Download size={14} aria-hidden="true" />}
                  下载附件
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </OpcNativeDialog>
  );
}
