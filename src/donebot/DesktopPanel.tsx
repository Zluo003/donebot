import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Hand, Loader2, Monitor, RefreshCw, X } from "lucide-react";
import { z } from "zod";
import { api, useStore, type Bot } from "@/state/store";
import { ComputerFilesPane } from "@/components/ComputerFilesPane";
import { BrowserPanel } from "@/components/BrowserPanel";
import { CloudBackendPicker } from "@/components/CloudBackendPicker";
import { useCaptionChrome, useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, useComputerPanelResize } from "@/components/computer-panel-resize";
import { readComputerPanelView, writeComputerPanelView, computerPanelTabs, resolveComputerPanelView, type ComputerPanelView } from "@/lib/computer-panel-view";
import { useComputerPanelEntry, releaseComputerPanelFocus } from "@/lib/computer-panel-focus";
import { usePanelPage, type PanelPage } from "@/lib/page-open";
import { useAdvancedMode } from "@/lib/interface-mode";
import { AndroidDevicePanel, useAndroidUsbDevices } from "@/components/AndroidDevicePanel";
import { RoutinesSection } from "@/components/bot-settings/RoutinesSection";
import { LocalComputerAutoWarning } from "@/components/LocalComputerAutoWarning";
import { instanceSupportsLocalComputer, localComputerSelectable } from "@/lib/local-computer";
import { personPin, placeLabelKey } from "@/lib/place";
import { placeManagedBy, worksOnChoices, worksOnSelected } from "@/components/WorksOnGrid";
import { approvalModeFor } from "../../shared/approval-mode";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";

const LiveDesktop = lazy(() => import("@/components/LiveDesktop").then(module => ({ default: module.LiveDesktop })));
const DataPanel = lazy(() => import("@/components/data/DataPanel").then(module => ({ default: module.DataPanel })));
const statusSchema = z.object({ ready: z.boolean(), problem: z.string().nullable().optional(), control: z.object({ occupied: z.boolean(), review_required: z.boolean() }).optional() });
type Status = z.infer<typeof statusSchema>;
export function DoneBotDesktopPanel({ bot }: { bot: Bot }) {
  const { state, dispatch, flushBotPatches } = useStore(), { dragProps } = useCaptionChrome();
  const resize = useComputerPanelResize();
  const advanced = useAdvancedMode(), android = useAndroidUsbDevices(), { capabilities } = useDesktopCapabilities();
  const context = { advanced, androidConnected: android.devices.length > 0 }, tabs = computerPanelTabs(context);
  const [storedTab, setTab] = useState<ComputerPanelView>(() => readComputerPanelView(bot.id));
  const tab = resolveComputerPanelView(storedTab, context), panelRef = useComputerPanelEntry(bot.id, tab);
  const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState("");
  const [localWarning, setLocalWarning] = useState(false), [pageRequest, setPageRequest] = useState<PanelPage>();
  const [dataRequest, setDataRequest] = useState<{ id: string; requestId: number }>();
  const [signInRequest, setSignInRequest] = useState<{ url: string; site: string; nonce: number }>();
  const [frame, setFrame] = useState<string | null>(null), [busy, setBusy] = useState(false), [viewer, setViewer] = useState(false), [expanded, setExpanded] = useState(false);
  const selectTab = (next: ComputerPanelView) => { setViewer(false); setTab(next); writeComputerPanelView(bot.id, next); };
  usePanelPage(bot.id, page => { selectTab("browser"); setPageRequest(page); });
  const requestedData = state.dataResultFocus?.botId === bot.id ? state.dataResultFocus : undefined;
  const requestedSignIn = state.signInFocus?.botId === bot.id ? state.signInFocus : undefined;
  useEffect(() => {
    if (!requestedData || requestedData.consumed) return;
    setDataRequest(requestedData); setTab("data"); writeComputerPanelView(bot.id, "data");
    dispatch({ type: "dataResultFocusConsumed", requestId: requestedData.requestId });
  }, [bot.id, dispatch, requestedData]);
  useEffect(() => {
    if (!requestedSignIn || requestedSignIn.consumed) return;
    const next = requestedSignIn.place === "browser" ? "browser" : "computer";
    setTab(next); writeComputerPanelView(bot.id, next);
    if (next === "browser") setSignInRequest({ url: requestedSignIn.url, site: requestedSignIn.site, nonce: requestedSignIn.requestId });
    dispatch({ type: "signInFocusConsumed", requestId: requestedSignIn.requestId });
  }, [bot.id, dispatch, requestedSignIn]);
  const generation = useRef(0), flight = useRef(false);
  useEffect(() => {
    const current = ++generation.current, controller = new AbortController(); let loading = false;
    const refresh = async () => {
      if (loading || document.hidden || flight.current || viewer || tab !== "computer") return;
      loading = true;
      try {
        await flushBotPatches(bot.id);
        const next = statusSchema.parse(await api("/api/donebot/desktop", { signal: controller.signal, background: true }));
        if (generation.current !== current) return;
        setStatus(next); setError("");
        if (next.ready) {
          const image = z.object({ png: z.string().max(20 * 1024 * 1024), format: z.literal("png") }).parse(await api("/api/donebot/desktop/frame", { signal: controller.signal, background: true }));
          if (generation.current === current) setFrame(`data:image/png;base64,${image.png}`);
        }
      } catch (cause) { if (!controller.signal.aborted && generation.current === current) setError(cause instanceof Error ? cause.message : "无法连接 Cloud 桌面。 "); }
      finally { loading = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => { generation.current++; controller.abort(); clearInterval(timer); };
  }, [bot.id, tab, viewer, flushBotPatches]);
  const start = async (action: "start" | "stop" = "start") => {
    if (flight.current) return;
    const current = generation.current; flight.current = true; setBusy(true); setError("");
    try {
      await flushBotPatches(bot.id);
      const next = statusSchema.parse(await api("/api/donebot/desktop", { method: "POST", body: JSON.stringify({ action }) }));
      if (current === generation.current) setStatus(next);
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : "Cloud 桌面启动未完成。 "); }
    finally { flight.current = false; setBusy(false); }
  };
  const localAvailable = localComputerSelectable({ capabilities, providerSupportsLocal: instanceSupportsLocalComputer(state.instances, bot) });
  const pin = personPin(bot.tasks?.find(task => task.threadId === bot.threadId));
  const heldPin = pin && bot.computer !== "off" && pin !== bot.computer ? pin : undefined;
  const choices = worksOnChoices(state.config, capabilities).filter(([mode]) => mode !== "local" || localAvailable);
  const select = (computer: "cloud" | "vm" | "local" | "browser" | "off" | null) => {
    if (computer === "vm") return;
    if (computer === "local" && approvalModeFor(bot) === "auto") { setLocalWarning(true); return; }
    dispatch({ type: "updateBot", botId: bot.id, patch: { computer, ...(computer === "cloud" ? { cloudBackend: "donebot" } : {}), ...(computer === "browser" ? { browser: true } : {}) } });
  };
  return <><aside ref={panelRef} className="relative flex min-h-0 shrink-0 flex-col border-l border-hairline/40 bg-panel max-md:fixed max-md:inset-0 max-md:z-40 max-md:w-full" style={{ width: resize.panelWidth }}>
    <div ref={resize.separatorRef} role="separator" aria-label={t("computer.resizeAria")} aria-orientation="vertical" aria-valuemin={PANEL_MIN_WIDTH} aria-valuemax={PANEL_MAX_WIDTH} aria-valuenow={resize.separatorWidth ?? undefined} tabIndex={0}
      onKeyDown={resize.onSeparatorKeyDown} onPointerDown={resize.onResizeStart} onPointerMove={resize.onResizeMove} onPointerUp={resize.onResizeEnd} onPointerCancel={resize.onResizeEnd} className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/40 max-md:hidden" />
    <header {...dragProps} className="flex items-center justify-center gap-1 p-3 pl-5">
      <div role="tablist" aria-label={t("computer.tabsAria")} className="flex rounded-full bg-inset p-1">
        {tabs.map(id => <button key={id} role="tab" aria-selected={tab === id} onClick={() => selectTab(id)} className={cn("rounded-full px-3 py-1 text-[13px]", tab === id ? "bg-raised text-ink shadow-sm" : "text-ink-secondary")}>{t(`computer.tab.${id}`)}</button>)}
      </div>
      <button data-computer-panel-close aria-label={t("computer.close")} onClick={() => { releaseComputerPanelFocus(panelRef.current, bot.id); dispatch({ type: "toggleComputer", open: false }); }} className="ml-auto rounded p-1 text-ink-secondary hover:bg-control"><X size={18} /></button>
    </header>
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4" role="tabpanel">
      {tab === "browser" ? <BrowserPanel bot={bot} signIn={signInRequest} page={pageRequest} /> : tab === "data" ? <Suspense fallback={<Loader2 className="animate-spin" />}><DataPanel bot={bot} requestedCard={dataRequest} /></Suspense> : tab === "files" ? <ComputerFilesPane bot={bot} /> : tab === "android" ? <AndroidDevicePanel status={android} /> : tab === "routines" ? <RoutinesSection bot={bot} routines={state.routines.filter(routine => routine.botId === bot.id)} runs={state.routineRuns} /> : <>
        <div className="mb-3 text-[13px] text-ink-secondary">{bot.name} · DoneBot 云端桌面</div>
        <div className="relative flex min-h-64 flex-1 items-center justify-center overflow-hidden rounded-xl bg-inset">
          {viewer ? <Suspense fallback={<Loader2 className="animate-spin" />}><LiveDesktop target="donebot/shared" threadId={bot.threadId} name={bot.name} poster={frame} expanded={expanded} onExpandedChange={setExpanded} onHandBack={() => setViewer(false)} handingBack={false} onUnreachable={() => { setViewer(false); setError("桌面暂不可接管；请确认其他任务已交还操作权。 "); }} /></Suspense>
            : frame && status?.ready ? <img src={frame} alt={`${bot.name} 的云端桌面`} className="max-h-full w-full object-contain" />
            : <div className="flex flex-col items-center gap-3 p-6 text-center text-sm text-ink-secondary"><Monitor size={28} /><span>{busy ? "正在启动云端桌面…" : status?.ready ? "正在读取桌面…" : "使用自己账号的 DoneBot Cloud 桌面"}</span></div>}
        </div>
        {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
        {status?.control?.review_required && <p role="alert" className="mt-3 text-[13px] text-danger">上次桌面操作的结果尚未确认。请在 Cloud 中核对结果并停止桌面，再重新启动。</p>}
        <div className="mt-3 flex gap-2">
          {!status?.ready && <button onClick={() => void start()} disabled={busy || status?.control?.review_required} className="ui-button flex flex-1 items-center justify-center gap-2 px-3 py-2 text-sm">{busy ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}启动云桌面</button>}
          {status?.control?.review_required && <button onClick={() => void start("stop")} disabled={busy || status.control.occupied} className="ui-button px-3 py-2 text-sm">已核对结果，停止桌面</button>}
          {status?.ready && !viewer && <button onClick={() => setViewer(true)} disabled={Boolean(bot.busy) || status.control?.occupied || status.control?.review_required} className="ui-button flex flex-1 items-center justify-center gap-2 px-3 py-2 text-sm disabled:opacity-50"><Hand size={16} />{bot.busy || status.control?.occupied ? "任务结束后可接管" : "接管云桌面"}</button>}
        </div>
        <section className="mt-4 rounded-xl bg-card p-4">
          <h3 className="text-[15px] font-medium">{t("computer.worksOn")}</h3>
          <div className="mt-3 grid grid-cols-3 gap-2">{choices.map(([mode, label, , Icon]) => {
            const selected = worksOnSelected(mode, bot.computer, capabilities), managedBy = placeManagedBy(mode, "donebot", state.config?.managedPolicy);
            return <button key={mode ?? "auto"} aria-pressed={selected} disabled={Boolean(managedBy)} title={managedBy} onClick={() => select(mode)} className={cn("rounded-lg border px-2 py-3 text-[13px] disabled:opacity-50", selected ? "border-accent/60 bg-accent/10" : "border-hairline/40 hover:bg-control")}><Icon size={14} className="mx-auto mb-1" />{t(label)}</button>;
          })}</div>
          {heldPin && <div className="mt-2 flex items-center gap-2">
            <p data-testid="place-pinned-note" className="flex-1 text-[12px] text-ink-secondary">{t("place.pinnedNoteSimple", { place: t(placeLabelKey(heldPin)) })}</p>
            <button data-testid="place-unpin" disabled={Boolean(bot.busy)} onClick={() => dispatch({ type: "updateTask", botId: bot.id, threadId: bot.threadId, patch: { surface: null } })} className="text-[12px] text-accent-text disabled:opacity-50">{t("place.unpinSimple", { place: t(placeLabelKey(bot.computer ?? "auto")) })}</button>
          </div>}
          <CloudBackendPicker value="donebot" onChange={cloudBackend => dispatch({ type: "updateBot", botId: bot.id, patch: { cloudBackend } })} />
          <p className="mt-3 text-[12px] leading-5 text-ink-secondary">操作云桌面时仍使用当前 Bot 和会话。本地 Bot 使用云桌面时，本机须保持运行；Cloud 工作空间内的 Bot 可独立运行。</p>
        </section>
      </>}
    </div>
  </aside><LocalComputerAutoWarning open={localWarning} onCancel={() => setLocalWarning(false)} onConfirm={() => {
    setLocalWarning(false); dispatch({ type: "updateBot", botId: bot.id, patch: { computer: "local", acknowledgeLocalAuto: true } });
  }} /></>;
}
