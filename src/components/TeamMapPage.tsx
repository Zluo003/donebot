import { UPSTREAM_SERVICES } from "@/donebot/services";
import { OpcOrgChartView } from "@/donebot/OpcOrgChartView";
import { OpcWorkflowsView } from "@/donebot/OpcWorkflowsView";
import { OpcNativeDialog } from "@/donebot/paperclip-ui";
import { opcApi } from "@/donebot/opc-api";
import type { OpcOrgChartState, OpcOrgEnforcementMode } from "../../shared/donebot-opc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, BookOpen, Box, GitBranch, Loader2, Monitor, Plus, Save, Users, UsersRound, X } from "lucide-react";
import { Switch } from "./SettingsPrimitives";

import { api, formatTime, openBot, openThread, useStore, type Bot } from "@/state/store";
import {
  EMPTY_TEAM_MAP_SNAPSHOT,
  buildTeamMapEdges,
  buildTeamMapSections,
  teamMapBotCount,
  type TeamMapEdge,
  type TeamMapSnapshot,
} from "@/lib/team-map";
import { cn } from "@/lib/cn";
import { useShowThreads } from "@/lib/thread-preferences";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { placeOffered } from "@/lib/place";
import { TeamCanvas } from "./TeamCanvas";
import { MapModeToggle, TeamOrgChart, useMapMode } from "./TeamOrgChart";
import { useTeamPeople } from "@/state/team-people";
import { TeamDialog } from "./TeamDialog";
import { TeamMemoryDialog } from "./TeamMemoryDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { intlLocale, t } from "@/lib/i18n";
import { CanvasComputers } from "./CanvasComputers";
import { useMapComputers, useShowComputers } from "@/lib/map-computers";
import { MapComposer } from "./MapComposer";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { openBotSettings } from "./bot-panel/panel-link";
import type { TeamComputer } from "../../shared/team-computer";

export function EdgeRow({ edge, bots }: { edge: TeamMapEdge; bots: Bot[] }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const source = bots.find((bot) => bot.id === edge.sourceBotId);
  const target = bots.find((bot) => bot.id === edge.targetBotId);
  if (!source || !target) return null;
  const live = edge.state !== "connected";
  return (
    <button
      onClick={() => {
        if (!edge.groupId && edge.threadId) openThread(dispatch, { botId: target.id, threadId: edge.threadId }, state, showThreads);
        else if (edge.groupId) dispatch({ type: "select", id: edge.groupId });
        else openBot(dispatch, target, showThreads);
      }}
      className="flex w-full items-center gap-3 rounded-xl border border-hairline/40 bg-card px-3 py-2.5 text-left transition hover:bg-raised/50"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-[13px] font-medium text-ink">{source.name}</span>
        <ArrowRight size={13} className={cn("shrink-0", live ? "text-accent" : "text-ink-secondary")} />
        <span className="truncate text-[13px] font-medium text-ink">{target.name}</span>
      </div>
      {edge.reason && <span className="max-w-[220px] truncate text-[12px] text-ink-secondary">{edge.reason}</span>}
      <span
        className={cn(
          "rounded-full px-2 py-0.5 text-[11px] font-medium",
          edge.state === "running"
            ? "bg-success/15 text-success"
            : edge.state === "queued"
              ? "bg-warning/15 text-warning"
              : "bg-control text-ink-secondary",
        )}
      >
      {edge.state === "running" ? t("canvas.edge.running") : edge.state === "queued" ? t("canvas.edge.queued") : edge.lastAt ? formatTime(edge.lastAt) : t("canvas.edge.connected")}
      </span>
    </button>
  );
}

interface SectionContextResponse {
  section: string;
  label: string;
  text: string;
  updatedAt: number | null;
  maxBytes: number;
}

export function SectionContextDialog({ section, label, onClose }: { section: string; label: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onCloseRef = useRef(onClose);
  const savingRef = useRef(false);
  const dirtyRef = useRef(false);
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [maxBytes, setMaxBytes] = useState(24_000);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = text !== savedText;
  const bytes = useMemo(() => new TextEncoder().encode(text).byteLength, [text]);
  onCloseRef.current = onClose;
  savingRef.current = saving;
  dirtyRef.current = dirty;

  const requestClose = useCallback(() => {
    if (savingRef.current) return;
    if (dirtyRef.current && !window.confirm(t("team.instructionsDiscard"))) return;
    onCloseRef.current();
  }, []);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingRef.current) {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [requestClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api(`/api/section-context?section=${encodeURIComponent(section)}`)
      .then((result: SectionContextResponse) => {
        if (cancelled) return;
        setText(result.text);
        setSavedText(result.text);
        setUpdatedAt(result.updatedAt);
        setMaxBytes(result.maxBytes);
        window.setTimeout(() => textareaRef.current?.focus(), 0);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [section]);

  const save = async () => {
    if (bytes > maxBytes) return;
    setSaving(true);
    setError(null);
    try {
      const result: SectionContextResponse = await api(
        `/api/section-context?section=${encodeURIComponent(section)}`,
        { method: "PUT", body: JSON.stringify({ text }) },
      );
      setSavedText(result.text);
      setText(result.text);
      setUpdatedAt(result.updatedAt);
      setMaxBytes(result.maxBytes);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    // No backdrop blur: blurring the whole team map behind the dialog on every repaint is costly without GPU
    // compositing (common on Linux).
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && requestClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="section-context-title"
        tabIndex={-1}
        className="animate-pop-in flex max-h-[min(680px,calc(100dvh-2rem))] w-full max-w-[680px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl shadow-black/50 outline-none"
      >
        <header className="flex items-start justify-between gap-4 border-b border-hairline/40 px-6 pb-4 pt-6 sm:px-8 sm:pt-7">
          <div>
            <div className="flex items-center gap-2">
              <BookOpen size={19} className="text-accent" />
              <h2 id="section-context-title" className="text-[20px] font-semibold tracking-[-0.01em] text-ink">
                {t("team.instructionsTitle", { name: label })}
              </h2>
            </div>
            <p className="mt-1.5 max-w-[520px] text-[13px] leading-relaxed text-ink-secondary">
              {t("team.instructionsHint")}
            </p>
          </div>
          <button
            onClick={requestClose}
            disabled={saving}
            aria-label={t("team.instructionsClose")}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
          >
            <X size={19} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 sm:px-8">
          {loading ? (
            <div className="flex min-h-[260px] items-center justify-center text-ink-secondary">
              <Loader2 size={20} className="animate-spin" aria-label={t("team.instructionsLoading")} />
            </div>
          ) : (
            <>
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={t("team.instructionsPlaceholder")}
                aria-label={t("team.instructionsTitle", { name: label })}
                className="min-h-[280px] w-full resize-y rounded-xl border border-hairline/60 bg-inset px-4 py-3 font-mono text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary focus:border-accent/50"
              />
              <div className="mt-2 flex items-start justify-between gap-4 text-[12px] text-ink-secondary">
                <span>
                  {t("team.instructionsFactHint")} {updatedAt ? ` ${t("team.instructionsLastSaved", { time: new Date(updatedAt).toLocaleString(intlLocale()) })}` : ""}
                </span>
                <span className={cn("shrink-0 tabular-nums", bytes > maxBytes && "text-danger")}>
                  {t("team.instructionsBytes", { bytes: bytes.toLocaleString(intlLocale()), limit: maxBytes.toLocaleString(intlLocale()) })}
                </span>
              </div>
            </>
          )}
          {error && <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-hairline/40 px-6 py-4 sm:px-8">
          <button onClick={requestClose} disabled={saving} className="rounded-lg px-3.5 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40">
            {t("common.cancel")}
          </button>
          <button
            onClick={() => void save()}
            disabled={loading || saving || !dirty || bytes > maxBytes}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {t("team.instructionsSave")}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** How long a card acknowledges a message sent from the map; its border fades within this. */
const SENT_HIGHLIGHT_MS = 1_400;

export function TeamMapPage() {
  const { state, dispatch } = useStore();
  const { dragProps } = useCaptionChrome();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const teamPeople = useTeamPeople();
  const admin = useOwnerOrAdmin();
  const reportsChart = useMapMode() === "people" && teamPeople !== null;
  const [snapshot, setSnapshot] = useState<TeamMapSnapshot>(EMPTY_TEAM_MAP_SNAPSHOT);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [contextEditor, setContextEditor] = useState<{ section: string; label: string } | null>(null);
  const [memoryEditor, setMemoryEditor] = useState<{ section: string; label: string } | null>(null);
  const [teamEditor, setTeamEditor] = useState<{ section?: string; rename?: boolean } | null>(null);
  const [deletingTeam, setDeletingTeam] = useState<string | null>(null);
  const [computersOpen, setComputersOpen] = useState(false);
  const [createComputerRequest, setCreateComputerRequest] = useState(0);
  const [computers, setComputers] = useState<TeamComputer[]>([]);
  const [computerDrop, setComputerDrop] = useState<{ id: string; section: string } | null>(null);
  const clearComputerDrop = useCallback(() => setComputerDrop(null), []);
  const [pendingMove, setPendingMove] = useState<{ bot: Bot; destination: string; resolve: (moved: boolean) => void } | null>(null);
  const [opcTab, setOpcTab] = useState<"org" | "workflows">("org");
  const [orgState, setOrgState] = useState<OpcOrgChartState>({ enforcementMode: "free", allowChiefCrossDispatch: false, nodes: {}, updatedAt: 0 });
  const [orgModeBusy, setOrgModeBusy] = useState(false);
  const [generalRenameOpen, setGeneralRenameOpen] = useState(false);
  const [generalNameDraft, setGeneralNameDraft] = useState("");
  const opcOrgEnabled = !teamPeople && !remoteClient;
  const loadOrg = useCallback(async () => {
    if (!opcOrgEnabled) return;
    try {
      setOrgState(await opcApi.getOrg());
    } catch {
      // Quietly keep default free org state on older remote runtimes.
    }
  }, [opcOrgEnabled]);
  useEffect(() => { void loadOrg(); }, [loadOrg]);
  const patchOrgSettings = async (patch: {
    enforcementMode?: OpcOrgEnforcementMode;
    allowChiefCrossDispatch?: boolean;
    generalDepartmentName?: string | null;
  }) => {
    if (orgModeBusy) return;
    const prev = orgState;
    const optimistic: OpcOrgChartState = {
      ...prev,
      ...(patch.enforcementMode !== undefined ? { enforcementMode: patch.enforcementMode } : {}),
      ...(patch.allowChiefCrossDispatch !== undefined ? { allowChiefCrossDispatch: patch.allowChiefCrossDispatch } : {}),
      ...(patch.generalDepartmentName !== undefined
        ? { generalDepartmentName: patch.generalDepartmentName?.trim() || undefined }
        : {}),
    };
    setOrgState(optimistic);
    setOrgModeBusy(true);
    setError(null);
    try {
      setOrgState(await opcApi.updateOrgSettings(patch));
    } catch (cause) {
      setOrgState(prev);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOrgModeBusy(false);
    }
  };
  const pendingMoveRef = useRef(pendingMove);
  pendingMoveRef.current = pendingMove;
  useEffect(() => () => pendingMoveRef.current?.resolve(false), []);
  const bots = useMemo(() => state.bots.filter((bot) => !bot.hidden), [state.bots]);
  const generalDeptLabel = orgState.generalDepartmentName?.trim() || t("teamSettings.general");
  const sections = useMemo(() => {
    const names = [...new Set([...(state.sections ?? []), ...state.groups.flatMap((group) => group.section ? [group.section] : [])])];
    const order = (key: string) => key === "" ? -1 : names.includes(key) ? names.indexOf(key) : names.length;
    return buildTeamMapSections(bots, names).sort((a, b) => order(a.key) - order(b.key));
  }, [bots, state.sections, state.groups]);
  const hasNamedDepartments = useMemo(() => sections.some(s => Boolean(s.key)), [sections]);
  const edges = useMemo(() => buildTeamMapEdges(bots, snapshot), [bots, snapshot]);
  const anyComputer = bots.some((bot) => bot.computer === "cloud" && bot.cloudBackend !== "vps") || computers.some((computer) => computer.section !== null);
  const { show: showComputers, loaded: computersChoiceLoaded, choose: setShowComputers } = useShowComputers(anyComputer);
  const mapComputers = useMapComputers(!opcOrgEnabled && !remoteClient && computersChoiceLoaded && showComputers);
  const [taggedBotIds, setTaggedBotIds] = useState<string[]>([]);
  const [sent, setSent] = useState<{ botIds: string[]; key: number } | null>(null);
  const sentTimer = useRef<number | undefined>(undefined);
  const acknowledgeSent = useCallback((botIds: string[]) => {
    window.clearTimeout(sentTimer.current);
    setSent((previous) => ({ botIds, key: (previous?.key ?? 0) + 1 }));
    sentTimer.current = window.setTimeout(() => setSent(null), SENT_HIGHLIGHT_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(sentTimer.current), []);
  const composerTeams = useMemo(
    () => sections.map((section) => ({
      key: section.key,
      name: section.key ? section.name : generalDeptLabel,
      count: section.chiefs.length + section.members.length,
    })),
    [sections, generalDeptLabel],
  );

  // `background`: the 3-second poll, which never wakes a Cloud home that went to sleep.
  const refresh = useCallback(async (background = false) => {
    try {
      setSnapshot(await api("/api/team-map", background ? { background } : undefined));
      setRefreshError(null);
    } catch (requestError) {
      setRefreshError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(true);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const moveBot = async (bot: Bot, destination: string) => {
    setError(null);
    try {
      const result: { sections: string[]; bots: Bot[] } = await api("/api/sidebar-sections", {
        method: "POST", body: JSON.stringify({ name: destination, botIds: [bot.id] }),
      });
      dispatch({ type: "sections", sections: result.sections });
      for (const patched of result.bots) dispatch({ type: "botPatched", bot: patched });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  };

  const toggleBotChief = async (bot: Bot, chiefOfStaff: boolean) => {
    setError(null);
    try {
      const patched: Bot = await api(`/api/bots/${encodeURIComponent(bot.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ chiefOfStaff }),
      });
      dispatch({ type: "botPatched", bot: patched });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  };

  const alignOrgByDepartments = async () => {
    if (orgModeBusy) return;
    setOrgModeBusy(true);
    setError(null);
    try {
      const chiefBySection = new Map<string, Bot>();
      for (const bot of bots) {
        if (bot.chiefOfStaff) chiefBySection.set(bot.section?.trim() || "", bot);
      }
      const generalChief = chiefBySection.get("");
      let latest = orgState;
      // Clear chiefs' parents first so reparenting never trips transient cycles.
      for (const bot of bots) {
        const sec = bot.section?.trim() || "";
        if (!bot.chiefOfStaff) continue;
        const targetManager = sec && generalChief && generalChief.id !== bot.id ? generalChief.id : null;
        if ((latest.nodes[bot.id]?.reportsToBotId ?? null) !== targetManager) {
          latest = (await opcApi.saveOrgNode(bot.id, { reportsToBotId: targetManager })).org;
        }
      }
      for (const bot of bots) {
        if (bot.chiefOfStaff) continue;
        const sec = bot.section?.trim() || "";
        const deptChief = chiefBySection.get(sec);
        const targetManager = deptChief && deptChief.id !== bot.id ? deptChief.id : (generalChief && generalChief.id !== bot.id ? generalChief.id : null);
        if ((latest.nodes[bot.id]?.reportsToBotId ?? null) !== targetManager) {
          latest = (await opcApi.saveOrgNode(bot.id, { reportsToBotId: targetManager })).org;
        }
      }
      setOrgState(latest);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOrgModeBusy(false);
    }
  };

  const requestMove = (bot: Bot, destination: string) => new Promise<boolean>((resolve) => {
    pendingMoveRef.current?.resolve(false);
    setPendingMove({ bot, destination, resolve });
  });
  const cancelMove = useCallback(() => {
    pendingMoveRef.current?.resolve(false);
    setPendingMove(null);
  }, []);

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink">
      <header {...dragProps} className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-hairline/40 px-6 py-3.5 max-md:pl-12">
        <div>
          <div className="flex items-center gap-2.5">
            <UsersRound size={17} className="text-ink-secondary" />
            <h1 className="text-[16px] font-semibold">{opcOrgEnabled ? "组织与流程" : t("canvas.title")}</h1>
            <span className="ml-0.5 text-[11.5px] tabular-nums text-ink-tertiary">{teamMapBotCount(bots.length)}</span>
          </div>
          <p className="mt-0.5 text-[12px] text-ink-tertiary">
            {opcOrgEnabled
              ? opcTab === "org"
                ? "扁平与部门组织统一视图 · 拖卡片调汇报或部门，右侧圆点拉跨部门交接线"
                : "固定工作流优先于组织架构约束直接跨部门执行，可画布编排或让主协调 Bot 创建"
              : t("canvas.description")}
          </p>
        </div>

        {teamPeople ? (
          <MapModeToggle />
        ) : opcOrgEnabled ? (
          <div role="tablist" aria-label="组织与流程视图" className="inline-flex items-center rounded-full bg-ink/[0.05] p-0.5">
            {([
              { id: "org", label: "组织架构" },
              { id: "workflows", label: "固定工作流" },
            ] as const).map(item => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={opcTab === item.id}
                onClick={() => setOpcTab(item.id)}
                className={cn(
                  "rounded-full px-3.5 py-1 text-[12px] font-medium transition-colors",
                  opcTab === item.id ? "bg-ink text-app" : "text-ink-secondary hover:text-ink",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        ) : null}

        {!remoteClient && (
          <div className="flex flex-wrap items-center gap-2.5">
            {opcOrgEnabled && opcTab === "org" && (
              <>
                <label
                  title="关闭：自由协作（架构仅作提示参考）。开启：服务端硬拦截越级派单与未授权跨部门派单。"
                  className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-hairline/70 bg-panel/80 px-3 py-1 text-[12px] text-ink-secondary hover:border-ink/30"
                >
                  <span className="font-medium text-ink">按架构约束</span>
                  <Switch
                    checked={orgState.enforcementMode === "enforced"}
                    disabled={orgModeBusy}
                    aria-label="开启按架构约束"
                    onClick={() => void patchOrgSettings({ enforcementMode: orgState.enforcementMode === "enforced" ? "free" : "enforced" })}
                  />
                </label>

                {orgState.enforcementMode === "enforced" && (
                  <label
                    title="默认严格模式关闭。开启后，各部门主 Bot 之间无需拉交接线即可跨部门直通派单。"
                    className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-hairline/70 bg-panel/80 px-3 py-1 text-[12px] text-ink-secondary hover:border-ink/30"
                  >
                    <span>部门负责人直通</span>
                    <Switch
                      checked={Boolean(orgState.allowChiefCrossDispatch)}
                      disabled={orgModeBusy}
                      aria-label="开启部门负责人跨部门直通"
                      onClick={() => void patchOrgSettings({ allowChiefCrossDispatch: !orgState.allowChiefCrossDispatch })}
                    />
                  </label>
                )}

                {hasNamedDepartments && (
                  <button
                    type="button"
                    disabled={orgModeBusy}
                    onClick={() => void alignOrgByDepartments()}
                    title="将各部门成员汇报线一键归入本部门主 Bot 名下，之后仍可自由拖拽做跨部门调整"
                    className="inline-flex h-8 items-center gap-1.5 rounded-full bg-ink/[0.06] px-3 text-[12px] font-medium text-ink-secondary hover:bg-ink/[0.1] hover:text-ink disabled:opacity-45"
                  >
                    <GitBranch size={12.5} /> 按部门对齐
                  </button>
                )}

                {admin !== false && (
                  <button
                    type="button"
                    onClick={() => setTeamEditor({})}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[12px] font-medium text-app hover:opacity-85"
                  >
                    <Plus size={13} /> 新建部门
                  </button>
                )}
              </>
            )}

            {!opcOrgEnabled && (
              <>
                <button onClick={() => setShowComputers(!showComputers)} aria-pressed={showComputers} title={t("canvas.showComputersHint")}
                  className={cn("flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] font-medium transition-colors", showComputers ? "border-accent/40 bg-accent/10 text-ink" : "border-hairline/60 bg-panel text-ink-secondary hover:bg-control hover:text-ink")}>
                  <span aria-hidden className={cn("relative h-4 w-7 shrink-0 rounded-full transition-colors", showComputers ? "bg-accent" : "bg-control")}>
                    <span className={cn("absolute top-0.5 size-3 rounded-full bg-white shadow-sm transition-[left]", showComputers ? "left-3.5" : "left-0.5")} />
                  </span>
                  {t("canvas.showComputers")}
                </button>
                {UPSTREAM_SERVICES.boat && <button onClick={() => setComputersOpen((value) => !value)} aria-label={t("canvas.computers")} aria-expanded={computersOpen} className="rounded-lg p-2 text-ink-secondary hover:bg-control hover:text-ink"><Monitor size={17} /></button>}
                {admin !== false && <details className="relative" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.removeAttribute("open"); }} onKeyDown={(event) => {
                  if (event.key === "Escape") { event.currentTarget.removeAttribute("open"); event.currentTarget.querySelector("summary")?.focus(); }
                }}>
                  <summary aria-label={t("canvas.addToMap")} className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg border border-hairline/60 bg-panel px-3 py-2 text-[12px] font-medium hover:bg-control [&::-webkit-details-marker]:hidden"><Plus size={14} /> {t("common.add")}</summary>
                  <div className="absolute right-0 top-full z-40 mt-2 w-52 rounded-xl border border-hairline/60 bg-panel p-1.5 shadow-xl" onClick={(event) => {
                    const details = event.currentTarget.closest("details"); details?.querySelector("summary")?.focus(); details?.removeAttribute("open");
                  }}>
                    <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-[12px] hover:bg-control" onClick={() => setTeamEditor({})}><Users size={14} />{t("team.create")}</button>
                    {UPSTREAM_SERVICES.boat && <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-[12px] hover:bg-control" onClick={() => { setComputersOpen(true); setCreateComputerRequest((value) => value + 1); }}><Box size={14} />{t("canvas.cloudComputer")}</button>}
                    {placeOffered("vm", state.config) && <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-[12px] hover:bg-control" onClick={() => dispatch({ type: "toggleAppSettings", section: "computer", open: true })}><Monitor size={14} />{t("canvas.localVm")}</button>}
                  </div>
                </details>}
              </>
            )}
          </div>
        )}
      </header>
      {(error || refreshError) && <div role="alert" className="flex shrink-0 items-center justify-between gap-3 border-b border-danger/20 bg-danger/10 px-6 py-2 text-[12px] text-danger">
        {error || refreshError}
        <button aria-label={t("common.close")} className="rounded p-1 hover:bg-danger/10" onClick={() => { setError(null); setRefreshError(null); }}><X size={14} /></button>
      </div>}
      <div className="relative flex min-h-0 flex-1">
      {opcOrgEnabled && opcTab === "org" ? (
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <OpcOrgChartView
            bots={bots}
            sections={sections}
            org={orgState}
            taggedBotIds={taggedBotIds}
            sent={sent}
            bottomInset={bots.length ? 92 : 0}
            onOrgChange={setOrgState}
            onMoveToDepartment={moveBot}
            onToggleChief={toggleBotChief}
            onRenameGeneralDepartment={(currentLabel) => {
              setGeneralNameDraft(currentLabel);
              setGeneralRenameOpen(true);
            }}
            onEditTeam={(section, rename) => setTeamEditor({ section, rename })}
            onInstructions={(section, label) => setContextEditor({ section, label })}
            onMemory={(section, label) => setMemoryEditor({ section, label })}
            onDeleteTeam={setDeletingTeam}
          />
          {bots.length > 0 && <MapComposer bots={bots} teams={composerTeams} onTagged={setTaggedBotIds} onSent={acknowledgeSent} />}
        </div>
      ) : opcOrgEnabled && opcTab === "workflows" ? (
        <OpcWorkflowsView bots={bots} />
      ) : (
        <>
          <div className="relative flex min-h-0 min-w-0 flex-1">
          {reportsChart ? <TeamOrgChart bots={bots} /> : <TeamCanvas sections={sections} canManage={!remoteClient && admin !== false} onMove={requestMove} taggedBotIds={taggedBotIds} sent={sent} bottomInset={bots.length ? 96 : 0}
            connectedBotIds={state.settingsOpen ? edges.flatMap((edge) => edge.sourceBotId === state.selectedId ? [edge.targetBotId] : edge.targetBotId === state.selectedId ? [edge.sourceBotId] : []) : []}
            onComputer={(bot) => openBotSettings(dispatch, "access", { botId: bot.id })}
            computers={showComputers && computersChoiceLoaded && !remoteClient ? mapComputers.computers : undefined} computerFrames={mapComputers.frames}
            onOpenComputer={(computer) => computer.kind === "team" ? setComputersOpen(true) : dispatch({ type: "toggleComputer", open: true, botId: computer.id })}
            teamComputers={Object.fromEntries(computers.filter((computer) => computer.section !== null).map((computer) => [computer.section!, { name: computer.name, state: computer.state }]))}
            onTeamComputer={() => setComputersOpen(true)}
            onComputerDrop={(id, section) => { if (!remoteClient) { setComputersOpen(true); setComputerDrop({ id, section }); } }}
            onInstructions={(section, label) => setContextEditor({ section, label })}
            onMemory={(section, label) => setMemoryEditor({ section, label })}
            onEditTeam={(section, rename) => setTeamEditor({ section, rename })}
            onDeleteTeam={setDeletingTeam}
            isEmpty={(key) => ![...state.bots, ...state.groups].some((record) => record.section?.trim() === key)} />}
          {bots.length > 0 && <MapComposer bots={bots} teams={composerTeams} onTagged={setTaggedBotIds} onSent={acknowledgeSent} />}
          </div>
          {UPSTREAM_SERVICES.boat && !remoteClient && <CanvasComputers open={computersOpen} createRequest={createComputerRequest} drop={computerDrop} sections={sections}
            onClose={() => setComputersOpen(false)} onDropHandled={clearComputerDrop} onChange={setComputers} />}
        </>
      )}
      </div>
      {(!opcOrgEnabled || opcTab === "org") && edges.length > 0 && <details className="shrink-0 border-t border-hairline/40 bg-panel px-6 py-3">
        <summary className="cursor-pointer text-[12px] text-ink-secondary">{t("canvas.whoHandsOn")} · {edges.length}</summary>
        <div className="mt-3 max-h-48 space-y-2 overflow-y-auto">{edges.slice(0, 12).map((edge) => <EdgeRow key={`${edge.sourceBotId}:${edge.targetBotId}`} edge={edge} bots={bots} />)}</div>
      </details>}
      {contextEditor && (
        <SectionContextDialog
          section={contextEditor.section}
          label={contextEditor.label}
          onClose={() => setContextEditor(null)}
        />
      )}
      {teamEditor && <TeamDialog {...teamEditor} onClose={() => setTeamEditor(null)} />}
      {memoryEditor && <TeamMemoryDialog key={memoryEditor.section} {...memoryEditor} onClose={() => setMemoryEditor(null)} />}
      <OpcNativeDialog
        open={generalRenameOpen}
        onClose={() => setGeneralRenameOpen(false)}
        ariaLabel="重命名默认部门"
        className="w-[min(92vw,420px)]"
      >
        <div className="flex items-center justify-between border-b border-hairline/60 px-5 py-3.5">
          <h3 className="text-[14.5px] font-semibold text-ink">重命名默认部门</h3>
          <button type="button" onClick={() => setGeneralRenameOpen(false)} aria-label="关闭" className="rounded-full p-1 text-ink-tertiary hover:bg-ink/[0.06]">
            <X size={15} />
          </button>
        </div>
        <div className="space-y-2.5 px-5 py-4 text-[12.5px]">
          <label className="block space-y-1.5">
            <span className="text-[12px] text-ink-secondary">部门名称（留空则恢复为「通用」）</span>
            <input
              value={generalNameDraft}
              maxLength={60}
              onChange={e => setGeneralNameDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") {
                  void patchOrgSettings({ generalDepartmentName: generalNameDraft.trim() || null }).then(() => setGeneralRenameOpen(false));
                }
              }}
              placeholder="如：总控中心 / 核心团队"
              className="h-9 w-full rounded-xl border border-hairline/70 bg-inset px-3 text-[13px] text-ink outline-none focus:border-ink/40"
            />
          </label>
          <p className="text-[11.5px] text-ink-tertiary">
            修改名称不会影响原有对话、公共指令和共享记忆，也会同步生效到 @ 指挥栏和 AI 组织提示词。
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-hairline/60 px-5 py-3.5">
          <button type="button" onClick={() => setGeneralRenameOpen(false)} className="h-8 rounded-full px-3 text-[12.5px] text-ink-secondary hover:bg-ink/[0.06]">
            取消
          </button>
          <button
            type="button"
            disabled={orgModeBusy}
            onClick={() => void patchOrgSettings({ generalDepartmentName: generalNameDraft.trim() || null }).then(() => setGeneralRenameOpen(false))}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-ink px-4 text-[12.5px] font-medium text-app hover:opacity-85 disabled:opacity-45"
          >
            保存名称
          </button>
        </div>
      </OpcNativeDialog>
      <ConfirmDialog open={pendingMove !== null} tone="neutral" title={t("canvas.moveConfirmTitle", { name: pendingMove?.bot.name ?? t("canvas.bot"), team: pendingMove?.destination || generalDeptLabel })}
        body={t("canvas.moveConfirmBody")}
        confirmLabel={t("canvas.moveConfirm") } onCancel={cancelMove} onConfirm={() => {
          const move = pendingMoveRef.current;
          if (!move) return;
          setPendingMove(null);
          void moveBot(move.bot, move.destination).then(() => move.resolve(true), () => move.resolve(false));
        }} />
      <ConfirmDialog open={deletingTeam !== null} title={t("team.deleteTitle", { name: deletingTeam ?? "" })}
        body={t("team.deleteKeepBotsDescription")}
        confirmLabel={t("team.delete")} onCancel={() => setDeletingTeam(null)} onConfirm={() => {
          const name = deletingTeam;
          setDeletingTeam(null);
          if (!name) return;
          void api(`/api/sidebar-sections?section=${encodeURIComponent(name)}`, { method: "DELETE" })
            .then(({ sections: names }) => dispatch({ type: "sections", sections: names }))
            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
        }} />
    </main>
  );
}
