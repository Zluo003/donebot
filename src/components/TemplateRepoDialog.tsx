import { Loader2, X } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { t } from "@/lib/i18n";
import { api } from "@/state/store";
import type { PackageDocument } from "../../shared/package-format";
import type { TemplatePublication } from "../../shared/template-publication";
import { Select } from "./Select";

export function TemplateRepoDialog({ document: template, returnFocus, onClose }: { document: PackageDocument; returnFocus: RefObject<HTMLElement | null>; onClose(): void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const [accounts, setAccounts] = useState<Array<{ id: string; alias?: string }>>([]);
  const [account, setAccount] = useState("");
  const [repository, setRepository] = useState("");
  const [folder, setFolder] = useState("templates");
  const [direct, setDirect] = useState(false);
  const [review, setReview] = useState<TemplatePublication | null>(null);
  const [history, setHistory] = useState<TemplatePublication[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    dialog.current?.focus();
    void Promise.allSettled([api<{ accounts: typeof accounts }>("/api/templates/github/accounts"), api<{ publications: TemplatePublication[] }>("/api/templates/publications")])
      .then(([connected, receipts]) => {
        if (!current) return;
        if (connected.status === "fulfilled") setAccounts(connected.value.accounts);
        else setError(connected.reason instanceof Error ? connected.reason.message : t("templates.connectGithubFirst"));
        if (receipts.status === "fulfilled") setHistory(receipts.value.publications);
        setBusy(false);
      });
    return () => { current = false; if (returnFocus.current?.isConnected) returnFocus.current.focus(); };
  }, [returnFocus]);
  useEffect(() => {
    if (!dialog.current?.contains(window.document.activeElement)) dialog.current?.focus();
  }, [busy, review]);
  const prepare = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const prepared = await api<TemplatePublication>("/api/templates/publications", { method: "POST", body: JSON.stringify({ account, repository, folder, direct, document: template }) });
      setReview(prepared); setSubmitted(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const refresh = async (id: string) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const result = await api<TemplatePublication>(`/api/templates/publications/${id}`);
      setReview(result); setSubmitted(result.status !== "ready");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const publish = async () => {
    if (!review || busy || submitted || review.status !== "ready") return;
    setBusy(true); setSubmitted(true); setError("");
    try {
      setReview(await api<TemplatePublication>(`/api/templates/publications/${review.id}/publish`, { method: "POST", body: JSON.stringify({ confirm: true }), timeoutMs: 90_000 }));
    } catch { setError(t("templateRepo.queryAfterDisconnect")); }
    finally { setBusy(false); }
  };
  const close = () => {
    if (busy) return;
    if (review?.status === "ready" && !submitted) void api(`/api/templates/publications/${review.id}`, { method: "DELETE" }).catch(() => undefined);
    onClose();
  };
  const field = "mt-1 block w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink";
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="template-repo-title" tabIndex={-1}
        className="flex max-h-[90vh] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-hairline bg-panel text-ink shadow-2xl outline-none"
        onKeyDown={event => {
          if (event.key === "Escape") { event.stopPropagation(); close(); }
          if (event.key === "Tab") {
            const controls = [...dialog.current!.querySelectorAll<HTMLElement>('input:enabled, select:enabled, button:enabled, summary, a[href]')];
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && window.document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <header className="flex items-start justify-between gap-4 px-6 pb-3 pt-5">
          <div><h2 id="template-repo-title" className="text-[17px] font-semibold">{t("templateRepo.title")}</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">{t("templateRepo.intro")}</p></div>
          <button aria-label={t("common.close")} disabled={busy} onClick={close} className="rounded-lg p-1.5 hover:bg-raised"><X size={18} /></button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-5 text-[13px]">
          {!review ? <fieldset disabled={busy} className="space-y-3">
            <label className="block">{t("templates.githubAccount")}<Select value={account} onChange={event => setAccount(event.target.value)} className="mt-1 w-full">
              <option value="">{t("templates.chooseGithubAccount")}</option>
              {accounts.map(item => <option key={item.id} value={item.id}>{item.alias || item.id}</option>)}
            </Select></label>
            <label className="block">{t("templateRepo.repository")}<input value={repository} maxLength={300} placeholder="owner/repository" onChange={event => setRepository(event.target.value)} className={field} /></label>
            <label className="block">{t("templateRepo.folder")}<input value={folder} maxLength={600} onChange={event => setFolder(event.target.value)} className={field} /></label>
            <label className="flex items-start gap-2"><input type="checkbox" checked={direct} onChange={event => setDirect(event.target.checked)} className="mt-0.5 accent-accent" />{t("templateRepo.direct")}</label>
          </fieldset> : <>
            <dl className="space-y-2 rounded-xl bg-raised/45 p-4">
              <dt className="text-ink-secondary">{t("templates.githubAccount")}</dt><dd className="break-all">{accounts.find(item => item.id === review.account)?.alias || review.account}</dd>
              <dt className="text-ink-secondary">{t("templateRepo.destination")}</dt><dd className="break-all font-medium">{review.repository}/{review.directory}</dd>
              <dt className="text-ink-secondary">{t("templateRepo.mode")}</dt><dd>{t(review.direct ? "templateRepo.commitMode" : "templateRepo.prMode")}</dd>
              <dt className="text-ink-secondary">{t("templateRepo.status")}</dt><dd role="status">{t(`templateRepo.${review.status}`)}</dd>
            </dl>
            {review.document && <details className="rounded-xl border border-hairline p-3"><summary className="cursor-pointer">{t("templateRepo.contents")}</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px]">{JSON.stringify(review.document, null, 2)}</pre></details>}
            <details className="rounded-xl border border-hairline p-3"><summary className="cursor-pointer">{t("templateRepo.files", { count: review.files.length })}</summary>
              <ul className="mt-2 space-y-2">{review.files.map(file => <li key={file.path} className="break-all"><span>{file.path}</span><span className="ml-2 text-ink-secondary">{file.bytes} B</span><code className="block text-[11px] text-ink-secondary">SHA-256 {file.sha256}</code></li>)}</ul></details>
            <p className="break-all text-[11px] text-ink-secondary">{t("templateRepo.receipt")} {review.id}<br />SHA-256 {review.digest}</p>
            {review.result && <a href={review.result.url} target="_blank" rel="noopener noreferrer" className="inline-block text-accent underline">{t("templateRepo.openResult")}</a>}
          </>}
          {!review && history.length > 0 && <details><summary className="cursor-pointer">{t("templateRepo.history")}</summary><ul className="mt-2 space-y-2">{history.map(item => <li key={item.id}>
            <button disabled={busy} onClick={() => void refresh(item.id)} className="max-w-full break-all text-left text-accent underline">{item.repository}/{item.directory} · {t(`templateRepo.${item.status}`)}</button>
          </li>)}</ul></details>}
          {error && <p role="alert" className="rounded-lg bg-danger/10 p-3 text-danger">{error}</p>}
        </div>
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-hairline px-6 py-3 text-[13px]">
          {busy && <Loader2 size={15} className="mr-auto animate-spin" />}
          <button disabled={busy} onClick={close} className="rounded-lg px-3 py-2 hover:bg-raised">{t("common.close")}</button>
          {review ? <>
            <button disabled={busy} onClick={() => void refresh(review.id)} className="rounded-lg border border-hairline px-3 py-2">{t("templateRepo.refresh")}</button>
            {review.status === "ready" && !submitted && <button disabled={busy} onClick={() => void publish()} className="rounded-lg bg-accent px-4 py-2 font-medium text-white disabled:opacity-40">{t("templateRepo.publish")}</button>}
          </> : <button disabled={busy || !account || !repository.trim()} onClick={() => void prepare()} className="rounded-lg bg-accent px-4 py-2 font-medium text-white disabled:opacity-40">{t("templateRepo.review")}</button>}
        </footer>
      </div>
    </div>, window.document.body,
  );
}
