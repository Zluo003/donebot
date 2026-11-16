import { useEffect, useRef, useState } from "react";
import { Download, FileText, Film, Image as ImageIcon, MessageSquare, Music, RotateCcw } from "lucide-react";
import type { BotArtifact } from "../../../shared/artifacts";
import { t } from "@/lib/i18n";
import { tableDelimiter } from "@/lib/table-data";
import { requestMessageFile, useLocalFileSave } from "../AttachmentPreview";
import { useHtmlPreview } from "../HtmlFilePreview";
import { TableDialog } from "../RichTable";
import { readTableResponse, TableFileContent } from "../TableFilePreview";

const ICONS = { image: ImageIcon, video: Film, audio: Music, document: FileText };

function TextContent({ item }: { item: BotArtifact }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setText(null); setFailed(false);
    void requestMessageFile(item.path, item, controller.signal)
      .then(response => readTableResponse(response, controller.signal, 2 * 1024 * 1024))
      .then(value => { if (!controller.signal.aborted) setText(value); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [item.path, item.threadId, item.messageId, attempt]);
  if (failed) return <div role="alert" className="p-6 text-center text-sm"><p>{t("artifacts.previewFailed")}</p><button type="button" className="mt-3 text-accent" onClick={() => setAttempt(attempt + 1)}>{t("chat.retry")}</button></div>;
  return text === null ? <p role="status" className="p-6 text-sm text-ink-secondary">{t("artifacts.loading")}</p>
    : <pre className="max-h-[70dvh] overflow-auto whitespace-pre-wrap break-words p-4 text-[13px]">{text}</pre>;
}

function MediaContent({ item }: { item: BotArtifact }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const source = `${item.previewUrl}&attempt=${attempt}`;
  if (failed) return <div role="alert" className="p-6 text-center text-sm"><p>{t("artifacts.previewFailed")}</p><button type="button" className="mt-3 text-accent" onClick={() => { setAttempt(attempt + 1); setFailed(false); }}>{t("chat.retry")}</button></div>;
  if (item.kind === "image") return <img key={source} src={source} alt={item.title} className="mx-auto max-h-[70dvh] max-w-full object-contain" onError={() => setFailed(true)} />;
  if (item.kind === "video") return <video key={source} src={source} controls playsInline preload="metadata" className="mx-auto max-h-[70dvh] w-full" onError={() => setFailed(true)} />;
  return <audio key={source} src={source} controls preload="metadata" className="mx-auto my-8 w-full max-w-lg" onError={() => setFailed(true)} />;
}

export function ArtifactRow({ item, onShowMessage }: { item: BotArtifact; onShowMessage: () => void }) {
  const [open, setOpen] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const [near, setNear] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const Icon = ICONS[item.kind];
  const save = useLocalFileSave(item.path, item.name, item);
  const html = useHtmlPreview(item.path, item.name, item);
  const extension = /\.([a-z\d]{1,12})$/i.exec(item.name)?.[1]?.toUpperCase();
  useEffect(() => {
    setThumbFailed(false);
    if (typeof IntersectionObserver === "undefined" || !row.current) { setNear(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setNear(true); observer.disconnect(); }
    }, { rootMargin: "120px" });
    observer.observe(row.current);
    return () => observer.disconnect();
  }, [item.previewUrl]);
  const delimiter = tableDelimiter(item.name) ?? tableDelimiter(item.path);
  const pdf = item.mime === "application/pdf" || /\.pdf$/i.test(item.name);
  const text = item.mime?.startsWith("text/") || /\.(?:txt|json|xml|log|rtf)$/i.test(item.name);
  const icon = <Icon size={20} aria-hidden="true" className="text-ink-secondary" />;
  return <li ref={row} data-artifact-id={item.id} className="rounded-xl hover:bg-ink/[0.04]">
    <div className="flex min-w-0 items-center gap-1 px-1 py-1">
      <button ref={trigger} type="button" onClick={event => html.opens ? html.show(event) : setOpen(true)} title={item.title}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1.5 text-start focus-visible:outline-2 focus-visible:outline-accent">
        <span className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-ink/[0.06]">
          {near && !thumbFailed && item.kind === "image" ? <img src={item.previewUrl} alt="" loading="lazy" className="h-full w-full object-cover" onError={() => setThumbFailed(true)} />
            : near && !thumbFailed && item.kind === "video" ? <><video src={item.previewUrl} muted playsInline preload="metadata" aria-hidden="true" className="h-full w-full object-cover" onError={() => setThumbFailed(true)} /><Film size={12} className="absolute bottom-0.5 right-0.5 rounded bg-black/60 text-white" /></> : icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{item.title || t(`artifacts.kind.${item.kind}`)}</span>
        {extension && <span className="shrink-0 text-[10px] text-ink-tertiary">{extension}</span>}
      </button>
      <button type="button" onClick={onShowMessage} aria-label={t("artifacts.showMessage")} title={item.threadTitle} className="rounded-lg p-2 text-ink-tertiary hover:text-ink"><MessageSquare size={14} /></button>
      <button type="button" disabled={save.state === "saving"} onClick={() => void save.save()} aria-label={t("attach.downloadAria", { name: item.title })} title={t("attach.download")}
        className="rounded-lg p-2 text-ink-secondary hover:text-ink disabled:opacity-40">{save.state === "failed" ? <RotateCcw size={14} /> : <Download size={14} />}</button>
    </div>
    {save.state !== "idle" && <p role={save.state === "failed" ? "alert" : "status"} className="px-3 pb-2 text-[11px] text-ink-secondary">{save.state === "failed" ? save.reason : t(save.state === "saving" ? "attach.downloading" : "attach.downloaded")}</p>}
    {html.dialog}
    {open && <TableDialog title={item.title} returnFocus={trigger.current} onClose={() => setOpen(false)}>
      <div className="mb-3 flex items-center justify-between gap-3 px-2 text-sm text-ink-secondary">
        <span className="truncate">{item.threadTitle}</span>
        <button type="button" className="shrink-0 text-accent" disabled={save.state === "saving"} onClick={() => void save.save()}>{t("attach.download")}</button>
      </div>
      {item.kind !== "document" ? <MediaContent item={item} />
        : delimiter ? <TableFileContent path={item.path} name={item.name} message={item} delimiter={delimiter} />
          : pdf ? <iframe src={item.previewUrl} title={item.title} className="h-[70dvh] w-full border-0" />
            : text ? <TextContent item={item} />
              : <p className="p-8 text-center text-sm text-ink-secondary">{t("artifacts.downloadToOpen")}</p>}
    </TableDialog>}
  </li>;
}
