import { BookOpen, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { t } from "@/lib/i18n";
import { api } from "@/state/store";
import type { TeamTemplate } from "../../shared/team-templates";
import type { TemplateScope } from "../../shared/share-folder";
import { ConfirmDialog } from "./ConfirmDialog";

export interface TeamTemplatePublishTarget {
  slug: string;
  scope: TemplateScope;
  revision: string | null;
}

interface Listing {
  templates: TeamTemplate[];
  admin: boolean;
}

export function TeamTemplatesTab({
  teams,
  refreshKey,
  onOpen,
  onPublish,
}: {
  teams: Array<{ name: string; bots: number }>;
  refreshKey: number;
  onOpen: (document: unknown, template: TeamTemplate) => void;
  onPublish: (team: string, target: TeamTemplatePublishTarget) => void;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedTeam, setSelectedTeam] = useState(teams[0]?.name ?? "");
  const [slug, setSlug] = useState("");
  const [scope, setScope] = useState<TemplateScope>("department");
  const [replacing, setReplacing] = useState<TeamTemplate | null>(null);
  const [removing, setRemoving] = useState<TeamTemplate | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const sourceTeams = useMemo(() => replacing?.scope === "bot" ? teams.filter((team) => team.bots === 1) : teams, [replacing, teams]);
  const botScopeAllowed = teams.find((team) => team.name === selectedTeam)?.bots === 1;

  useEffect(() => {
    if (!sourceTeams.some((team) => team.name === selectedTeam)) setSelectedTeam(sourceTeams[0]?.name ?? "");
  }, [selectedTeam, sourceTeams]);

  useEffect(() => {
    if (!replacing && scope === "bot" && !botScopeAllowed) setScope("department");
  }, [botScopeAllowed, replacing, scope]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setListing(await api<Listing>("/api/team-templates"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const openTemplate = async (template: TeamTemplate) => {
    setBusy(template.slug);
    setError("");
    try {
      const result = await api<{ document: unknown; template: TeamTemplate }>(`/api/team-templates/${encodeURIComponent(template.slug)}`);
      onOpen(result.document, result.template);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const removeTemplate = async () => {
    if (!removing || removeBusy) return;
    setRemoveBusy(true);
    setError("");
    try {
      await api(`/api/team-templates/${encodeURIComponent(removing.slug)}`, {
        method: "DELETE",
        body: JSON.stringify({ confirm: true, revision: removing.revision }),
      });
      setRemoving(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemoveBusy(false);
    }
  };

  const publish = () => {
    const normalizedSlug = slug.trim().toLowerCase();
    if (!sourceTeams.some((team) => team.name === selectedTeam) || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(normalizedSlug)) return;
    onPublish(selectedTeam, { slug: normalizedSlug, scope, revision: null });
  };

  const beginReplacement = (template: TeamTemplate) => {
    setReplacing(template);
    setSlug(template.slug);
    setScope(template.scope);
  };

  const replaceTemplate = () => {
    if (!replacing || !sourceTeams.some((team) => team.name === selectedTeam)) return;
    onPublish(selectedTeam, { slug: replacing.slug, scope: replacing.scope, revision: replacing.revision });
  };

  const cancelPublish = () => {
    setReplacing(null);
    setSlug("");
    setScope("department");
  };

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-[13px] leading-relaxed text-ink-secondary">{t("teamTemplates.intro")}</p>
        <button onClick={() => void load()} disabled={loading} aria-label={t("teamTemplates.refresh")} title={t("teamTemplates.refresh")} className="rounded-lg p-2 text-ink-secondary hover:bg-raised disabled:opacity-50">
          <RefreshCw size={17} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {listing?.admin && (
        <section className="mt-5 border-y border-hairline/35 py-4">
          <h3 className="text-[14px] font-medium text-ink">{t(replacing ? "teamTemplates.replaceTitle" : "teamTemplates.publishTitle")}</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-[12px] text-ink-secondary">{t("teamTemplates.slug")}
              <input value={slug} maxLength={48} disabled={replacing !== null} onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} placeholder="support-team" className="mt-1 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink" />
            </label>
            <label className="text-[12px] text-ink-secondary">{t("teamTemplates.sourceTeam")}
              <select value={selectedTeam} onChange={(event) => setSelectedTeam(event.target.value)} disabled={teams.length === 0} className="mt-1 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink">
                {sourceTeams.map((team) => <option key={team.name || "general"} value={team.name}>{team.name || t("teamLibrary.general")} · {team.bots}</option>)}
              </select>
            </label>
            <label className="text-[12px] text-ink-secondary">{t("teamTemplates.scope")}
              <select value={scope} disabled={replacing !== null} onChange={(event) => setScope(event.target.value as TemplateScope)} className="mt-1 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink">
                <option value="department">{t("teamTemplates.scope.department")}</option>
                {botScopeAllowed && <option value="bot">{t("teamTemplates.scope.bot")}</option>}
              </select>
            </label>
            <div className="flex items-end gap-2">
              <button onClick={replacing ? replaceTemplate : publish} disabled={sourceTeams.length === 0 || (replacing === null && !/^[a-z0-9][a-z0-9-]{0,47}$/.test(slug.trim().toLowerCase()))} className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-white hover:bg-accent/90 disabled:opacity-40">
                <Upload size={14} />{t(replacing ? "teamTemplates.replace" : "teamTemplates.publish")}
              </button>
              {replacing && <button onClick={cancelPublish} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised">{t("common.cancel")}</button>}
            </div>
          </div>
          <p className="mt-2 text-[12px] text-ink-secondary">{t("teamTemplates.reviewHint")}</p>
        </section>
      )}

      {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</div>}
      {loading && <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-secondary"><Loader2 size={15} className="animate-spin" />{t("teamTemplates.loading")}</div>}
      {!loading && listing?.templates.length === 0 && <div className="flex min-h-48 flex-col items-center justify-center text-center"><BookOpen size={22} className="text-ink-tertiary" /><p className="mt-2 text-[14px] font-medium text-ink">{t("teamTemplates.empty")}</p></div>}
      {!loading && listing && listing.templates.length > 0 && (
        <div className="mt-2">
          {listing.templates.map((template) => (
            <article key={template.slug} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-hairline/35 px-1 py-4">
              <BookOpen size={18} className="shrink-0 text-ink-secondary" />
              <div className="min-w-0 flex-1">
                <h4 className="truncate text-[14px] font-medium text-ink">{template.name}</h4>
                <p className="mt-0.5 truncate text-[12px] text-ink-secondary">{template.tagline || template.slug} · {template.release} · {t(`teamTemplates.scope.${template.scope}`)}</p>
              </div>
              <button onClick={() => void openTemplate(template)} disabled={busy !== null} className="rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
                {busy === template.slug ? <Loader2 size={14} className="animate-spin" /> : t("teamTemplates.preview")}
              </button>
              {listing.admin && <>
                <button onClick={() => beginReplacement(template)} disabled={busy !== null} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised disabled:opacity-50">{t("teamTemplates.replace")}</button>
                <button onClick={() => setRemoving(template)} aria-label={t("teamTemplates.removeAria", { name: template.name })} title={t("teamTemplates.remove")} disabled={busy !== null} className="rounded-lg p-2 text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-50"><Trash2 size={15} /></button>
              </>}
            </article>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={removing !== null}
        title={t("teamTemplates.removeTitle", { name: removing?.name ?? "" })}
        body={t("teamTemplates.removeBody")}
        confirmLabel={t("teamTemplates.remove")}
        pending={removeBusy}
        onCancel={() => !removeBusy && setRemoving(null)}
        onConfirm={() => void removeTemplate()}
      />
    </div>
  );
}
