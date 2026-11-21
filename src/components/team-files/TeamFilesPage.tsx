import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { Download, FileText, Folder, FolderPlus, Image as ImageIcon, Pencil, Trash2, Upload, X } from "lucide-react";

import type { TeamFileView, TeamFilesListing, TeamFilesRefusal } from "../../../shared/team-files";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { relativeTime } from "@/lib/memory";
import type { LocaleKey } from "@/locales";
import { api, ApiError } from "@/state/api";
import { useStore } from "@/state/store";
import { TOOL_PAGE_TITLE, ToolPage, ToolPageActions, ToolPageHeader } from "../ToolPageShell";
import { readTeamFilePreview, TEAM_PICTURE_PREVIEW_MAX, TEAM_TEXT_PREVIEW_MAX } from "./preview";

const BASE = "/api/team-files";
const TEXT = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "log"]);
const PICTURE = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const REFUSALS: Partial<Record<TeamFilesRefusal, LocaleKey>> = {
  exists: "teamFiles.error.exists", forbidden: "teamFiles.error.forbidden", not_found: "teamFiles.error.notFound",
  bad_path: "teamFiles.error.badName", link: "teamFiles.error.badName",
};

const extension = (name: string) => (name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "");
export const previewKind = (name: string): "text" | "picture" | null => (TEXT.has(extension(name)) ? "text" : PICTURE.has(extension(name)) ? "picture" : null);
export const fileUrl = (path: string, download = false) => `${BASE}/file?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 ? value : value < 10 ? Number(value.toFixed(1)) : Math.round(value)} ${units[unit]}`;
}

export function changedLine(entry: Pick<TeamFileView, "last">, now = Date.now()): string | null {
  const last = entry.last;
  if (!last) return null;
  const person = last.person || t("teamFiles.someone"), when = relativeTime(last.at, now);
  if (last.action === "uploaded") return t("teamFiles.uploaded", { person, when });
  if (last.action === "folder") return t("teamFiles.made", { person, when });
  if (last.bot) return last.person ? t("teamFiles.changedWith", { person, bot: last.bot, when }) : t("teamFiles.changedBy", { person: last.bot, when });
  return t("teamFiles.changedBy", { person, when });
}

export function refusalText(error: unknown, limits: { uploadMax: number; cap: number }): string {
  const body = error instanceof ApiError ? error.body : (error as { body?: Record<string, unknown> } | null)?.body;
  const code = typeof body?.code === "string" ? body.code as TeamFilesRefusal : null;
  if (code === "too_large") return t("teamFiles.error.tooLarge", { mb: Math.round(limits.uploadMax / 1024 ** 2) });
  if (code === "full") return t("teamFiles.error.full", { gb: Math.round(limits.cap / 1024 ** 3) });
  return t((code && REFUSALS[code]) || "teamFiles.error.failed");
}

async function uploadFile(folder: string, file: File, signal: AbortSignal): Promise<void> {
  await api(`${BASE}/file?path=${encodeURIComponent(folder)}&name=${encodeURIComponent(file.name)}`, {
    method: "PUT", body: file, headers: { "content-type": "application/octet-stream" }, signal,
  });
}

type Editing = { kind: "folder" } | { kind: "rename"; entry: TeamFileView } | null;
type Preview = { entry: TeamFileView; text?: string; picture?: string; tooLarge?: boolean; failed?: boolean; loading?: boolean } | null;

export function TeamFilesPage() {
  const { state, dispatch } = useStore();
  const team = state.config?.team;
  return team ? <TeamFilesWorkspace key={team.id} teamName={team.name} onBack={() => dispatch({ type: "showChat" })} /> : null;
}

function TeamFilesWorkspace({ teamName, onBack }: { teamName: string; onBack(): void }) {
  const [folder, setFolder] = useState("");
  const [listing, setListing] = useState<TeamFilesListing | null>(null);
  const [failed, setFailed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<Preview>(null);
  const back = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const loading = useRef<AbortController | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const picture = useRef<string | null>(null);
  const mounted = useRef(true);
  const limits = { uploadMax: listing?.uploadMax ?? 100 * 1024 ** 2, cap: listing?.cap ?? 5 * 1024 ** 3 };
  const writingAllowed = listing !== null && !failed && (listing.admin || !/^templates(?:\/|$)/i.test(folder));
  const clearPreview = useCallback(() => {
    previewRequest.current?.abort(); previewRequest.current = null;
    if (picture.current) URL.revokeObjectURL(picture.current);
    picture.current = null; setPreview(null);
  }, []);

  const load = useCallback(async (path: string) => {
    loading.current?.abort();
    const controller = new AbortController();
    loading.current = controller;
    try {
      const answer = await api<TeamFilesListing>(`${BASE}?path=${encodeURIComponent(path)}`, { signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return;
      if (answer.path !== path || !Array.isArray(answer.entries) || !Number.isSafeInteger(answer.cap) || answer.cap <= 0 || !Number.isSafeInteger(answer.uploadMax) || answer.uploadMax <= 0 || answer.uploadMax > answer.cap) throw new Error("Invalid team file listing");
      setListing(answer);
      setFailed(false);
    } catch (error) {
      if (controller.signal.aborted || !mounted.current) return;
      setListing(null); clearPreview();
      if (path && error instanceof ApiError && error.status === 404) { setFolder(""); return; }
      setFailed(true);
    }
  }, [clearPreview]);
  useEffect(() => { void load(folder); }, [folder, load]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; loading.current?.abort(); previewRequest.current?.abort(); mutation.current?.abort();
      if (picture.current) URL.revokeObjectURL(picture.current);
    };
  }, []);
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, []);

  const act = async (work: (signal: AbortSignal) => Promise<unknown>) => {
    if (mutation.current || !listing || failed) return;
    const controller = new AbortController(); mutation.current = controller;
    setBusy(true); setProblem(null); clearPreview();
    try { await work(controller.signal); }
    catch (error) { if (!controller.signal.aborted && mounted.current) setProblem(refusalText(error, limits)); }
    finally {
      if (!controller.signal.aborted && mounted.current) {
        await load(folder);
      }
      if (mutation.current === controller) mutation.current = null;
      if (mounted.current) {
        setBusy(false);
        if (document.activeElement === document.body) back.current?.focus({ preventScroll: true });
      }
    }
  };
  const upload = (files: readonly File[]) => {
    if (!writingAllowed) return Promise.resolve();
    return act(async signal => {
      try {
        for (const file of files) {
          if (signal.aborted) return;
          setUploading(file.name);
          await uploadFile(folder, file, signal);
        }
      } finally {
        if (mounted.current) setUploading(null);
      }
    });
  };
  const submitName = () => {
    const wanted = name.trim();
    if (!wanted || !editing || busy) return;
    const current = editing;
    setEditing(null);
    void act(signal => current.kind === "folder"
      ? api(`${BASE}/folder`, { method: "POST", body: JSON.stringify({ path: join(folder, wanted) }), signal })
      : api(`${BASE}/rename`, { method: "POST", body: JSON.stringify({ from: current.entry.path, to: join(folder, wanted) }), signal }));
  };
  const remove = (entry: TeamFileView) => {
    if (!window.confirm(t("teamFiles.deleteConfirm", { name: entry.name }))) return;
    void act(signal => api(`${BASE}/delete`, { method: "POST", body: JSON.stringify({ path: entry.path }), signal }));
  };
  const navigate = (path: string) => {
    if (busy || mutation.current) return;
    loading.current?.abort(); clearPreview(); setEditing(null); setProblem(null); setListing(null); setFailed(false); setFolder(path);
    if (path === folder) void load(path);
  };
  const open = async (entry: TeamFileView) => {
    if (entry.kind === "folder") { navigate(entry.path); return; }
    clearPreview();
    const kind = previewKind(entry.name);
    if (!kind) { setPreview({ entry }); return; }
    if (entry.size > (kind === "text" ? TEAM_TEXT_PREVIEW_MAX : TEAM_PICTURE_PREVIEW_MAX)) { setPreview({ entry, tooLarge: true }); return; }
    const controller = new AbortController(); previewRequest.current = controller;
    setPreview({ entry, loading: true });
    try {
      const res = await fetch(fileUrl(entry.path), { signal: controller.signal, cache: "no-store" });
      if (!res.ok) throw new ApiError("Preview unavailable", res.status);
      const payload = await readTeamFilePreview(res, kind);
      const text = "blob" in payload && kind === "text" ? await payload.blob.text() : undefined;
      if (controller.signal.aborted || !mounted.current) return;
      if ("tooLarge" in payload) { setPreview({ entry, tooLarge: true }); return; }
      if (kind === "picture") { picture.current = URL.createObjectURL(payload.blob); setPreview({ entry, picture: picture.current }); }
      else setPreview({ entry, text });
    } catch {
      if (!controller.signal.aborted && mounted.current) setPreview({ entry, failed: true });
    }
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length && !busy && writingAllowed) void upload(files);
  };
  const crumbs = folder ? folder.split("/") : [];

  return (
    <ToolPage label={t("teamFiles.title")}>
      <ToolPageHeader backLabel={t("automations.back")} onBack={onBack} backRef={back}>
        <h1 className={TOOL_PAGE_TITLE}>{t("teamFiles.title")}</h1>
        <ToolPageActions>
          <button type="button" className="ui-button" disabled={busy || !writingAllowed} onClick={() => { setName(""); setEditing({ kind: "folder" }); }}><FolderPlus size={15} />{t("teamFiles.newFolder")}</button>
          <button type="button" className="ui-button ui-button-primary" disabled={busy || !writingAllowed} onClick={() => picker.current?.click()}><Upload size={15} />{t("teamFiles.upload")}</button>
          <input ref={picker} type="file" multiple hidden data-testid="team-files-picker" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; if (files.length) void upload(files); }} />
        </ToolPageActions>
      </ToolPageHeader>
      <div
        className={cn("relative min-h-0 flex-1 overflow-y-auto", dragging && "bg-accent/5")}
        data-team-files={listing ? listing.entries.length : "loading"}
        onDragOver={(event) => { event.preventDefault(); setDragging(writingAllowed && !busy); }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
          <p className="mb-3 text-[13px] text-ink-secondary">{t("teamFiles.intro", { team: teamName })}</p>
          <nav aria-label={t("teamFiles.title")} className="mb-3 flex flex-wrap items-center gap-1 text-[14px]">
            <button type="button" disabled={busy} className="rounded px-1 text-ink-secondary hover:text-ink" onClick={() => navigate("")}>{t("teamFiles.title")}</button>
            {crumbs.map((part, index) => (
              <span key={index} className="flex items-center gap-1">
                <span className="text-ink-secondary">/</span>
                <button type="button" disabled={busy} aria-current={index === crumbs.length - 1 ? "page" : undefined} className="rounded px-1 text-ink hover:underline"
                  onClick={() => navigate(crumbs.slice(0, index + 1).join("/"))}>{part}</button>
              </span>
            ))}
          </nav>
          {listing && <p data-team-files-used={`${listing.used}/${listing.cap}`} className="mb-3 text-[12px] text-ink-secondary">{t("teamFiles.used", { used: formatSize(listing.used), cap: formatSize(listing.cap) })}</p>}
          {uploading && <p role="status" className="mb-2 text-[13px] text-ink-secondary">{t("teamFiles.uploading", { name: uploading })}</p>}
          {problem && <p role="alert" className="mb-2 text-[13px] text-danger">{problem}</p>}
          {editing && (
            <form className="mb-3 flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); submitName(); }}>
              <input autoFocus aria-label={t(editing.kind === "folder" ? "teamFiles.folderName" : "teamFiles.newName")} className="min-w-0 flex-1 rounded-lg bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:ring-1 focus:ring-accent" value={name} onChange={(event) => setName(event.target.value)} />
              <button type="submit" className="ui-button ui-button-primary">{t(editing.kind === "folder" ? "teamFiles.create" : "teamFiles.save")}</button>
              <button type="button" className="ui-button" onClick={() => setEditing(null)}>{t("common.cancel")}</button>
            </form>
          )}
          {dragging && <p className="mb-2 text-center text-[13px] text-accent-text">{t("teamFiles.drop")}</p>}
          {failed ? (
            <section role="alert" className="px-6 py-16 text-center">
              <p className="text-[14px] text-ink-secondary">{t("teamFiles.loadFailed")}</p>
              <button type="button" className="ui-button mt-4" onClick={() => void load(folder)}>{t("common.tryAgain")}</button>
            </section>
          ) : listing && listing.entries.length === 0 ? (
            <section aria-label={t("teamFiles.empty.title")} className="rounded-xl border border-dashed border-hairline px-6 py-12 text-center">
              <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Folder size={20} /></div>
              <h2 className="text-[16px] font-semibold text-ink">{t("teamFiles.empty.title")}</h2>
              <p className="mx-auto mt-1 max-w-sm text-[13px] leading-relaxed text-ink-secondary">{t("teamFiles.empty.body")}</p>
            </section>
          ) : listing ? (
            <ul aria-label={t("teamFiles.title")} className="divide-y divide-hairline/40 overflow-hidden rounded-xl border border-hairline/40 bg-card">
              {listing.entries.map((entry) => {
                const line = changedLine(entry);
                const Icon = entry.kind === "folder" ? Folder : previewKind(entry.name) === "picture" ? ImageIcon : FileText;
                return (
                  <li key={entry.path} data-team-file={entry.path} className="flex items-center gap-3 px-3 py-2.5">
                    <Icon size={18} className="shrink-0 text-ink-secondary" aria-hidden />
                    <button type="button" disabled={busy} className="min-w-0 flex-1 text-left" aria-label={t("teamFiles.open", { name: entry.name })} onClick={() => void open(entry)}>
                      <span className="block truncate text-[14px] text-ink">{entry.name}</span>
                      <span className="block truncate text-[12px] text-ink-secondary">{[entry.kind === "file" ? formatSize(entry.size) : "", line].filter(Boolean).join(" · ")}</span>
                    </button>
                    {entry.kind === "file" && <a className="ui-icon-button" href={fileUrl(entry.path, true)} download={entry.name} aria-label={t("teamFiles.download")} title={t("teamFiles.download")}><Download size={15} /></a>}
                    {entry.canDelete && <button type="button" disabled={busy} className="ui-icon-button" aria-label={t("teamFiles.rename")} title={t("teamFiles.rename")} onClick={() => { setName(entry.name); setEditing({ kind: "rename", entry }); }}><Pencil size={15} /></button>}
                    {entry.canDelete && <button type="button" disabled={busy} className="ui-icon-button" aria-label={t("teamFiles.delete")} title={t("teamFiles.delete")} onClick={() => remove(entry)}><Trash2 size={15} /></button>}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {preview && (
            <section aria-label={preview.entry.name} className="mt-4 rounded-xl border border-hairline/40 bg-card">
              <header className="flex items-center gap-2 border-b border-hairline/40 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{preview.entry.name}</span>
                <a className="ui-icon-button" href={fileUrl(preview.entry.path, true)} download={preview.entry.name} aria-label={t("teamFiles.download")}><Download size={15} /></a>
                <button type="button" className="ui-icon-button" aria-label={t("teamFiles.closePreview")} onClick={clearPreview}><X size={15} /></button>
              </header>
              <div className="max-h-[60vh] overflow-auto p-3">
                {preview.loading ? <p role="status" className="text-[13px] text-ink-secondary">{t("teamFiles.previewLoading")}</p>
                  : preview.failed ? <p role="alert" className="text-[13px] text-danger">{t("teamFiles.loadFailed")}</p>
                  : preview.tooLarge ? <p className="text-[13px] text-ink-secondary">{t("teamFiles.previewTooLarge")}</p>
                    : preview.picture ? <img src={preview.picture} alt={preview.entry.name} className="mx-auto max-h-[56vh] max-w-full" />
                    : preview.text !== undefined ? <pre data-team-file-preview="" className="whitespace-pre-wrap break-words text-[13px] text-ink">{preview.text}</pre>
                      : <p className="text-[13px] text-ink-secondary">{t("teamFiles.noPreview")}</p>}
              </div>
            </section>
          )}
        </div>
      </div>
    </ToolPage>
  );
}
