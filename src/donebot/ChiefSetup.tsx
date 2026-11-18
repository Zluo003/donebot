import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
import { BotAvatar, MausAvatar } from "@/components/Avatar";
import { Layer } from "@/components/Layer";
import { Select } from "@/components/Select";
import { BOT_PROFILE_LIMITS, fitsOnOneLine } from "../../shared/bot-profile";
import { api, persistBotUpdate, useStore, type Bot, type ConfigStatus, type InstanceInfo } from "@/state/store";
import { setEmailGateDone } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { setChiefStepOpen, setWelcomingBot, stageIntro } from "@/lib/default-bot";
import { t } from "@/lib/i18n";
import { MAUS_COLOR_NAMES, colorSwatch } from "@/lib/mascot";
import { bodyName, colorName } from "@/lib/mascot-names";
import { firstRunPatch, markWelcomeFinished, showWelcome } from "@/lib/onboarding";
import { clearWelcomeDraft } from "@/lib/welcome-draft";
import { CLOUD_INTENT_ASKED, CLOUD_WELCOME_DONE } from "@/lib/cloud-setup";
import { PICKABLE_BOT_BODIES } from "./avatars";
import { CHIEF_SETUP_HINT, CHIEF_TRAITS, chiefSetupKey, chiefSetupModels, chiefSetupPatch, initialChiefSetup,
  readChiefSetupDraft, saveChiefSetupDraft, type ChiefSetupDraft } from "./chief-setup";

const STEPS = ["identity", "personality", "model", "avatar", "review"] as const;
const FIELD = "mt-2 w-full rounded-xl border border-hairline/50 bg-inset px-3 py-2.5 text-[15px] text-ink outline-none focus:border-accent-border focus:ring-2 focus:ring-accent/15";

export function DoneBotChiefSetup({ bot, cloudHome = false, onDone }: { bot: Bot; cloudHome?: boolean; onDone: (id: string) => void }) {
  return <Layer modal><ChiefSetup bot={bot} cloudHome={cloudHome} onDone={onDone} /></Layer>;
}

function ChiefSetup({ bot, cloudHome, onDone }: { bot: Bot; cloudHome: boolean; onDone: (id: string) => void }) {
  const { state, dispatch } = useStore();
  const key = chiefSetupKey(bot.id, state.config?.donebot?.user?.id);
  const [draft, setDraft] = useState(() => readChiefSetupDraft(key) ?? initialChiefSetup(bot));
  const [busy, setBusy] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [error, setError] = useState("");
  const [modelError, setModelError] = useState(false);
  const saving = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const record = useRef(state.config?.onboarding);
  record.current = state.config?.onboarding;
  const models = chiefSetupModels(state.instances);
  const chosen = models.find(model => model.id === draft.model);
  const preview = { ...bot, name: draft.name.trim() || "多宝", color: draft.color, mascotBody: draft.body, avatarCrop: "mascot" as const };
  const edit = (patch: Partial<ChiefSetupDraft>) => { setDraft(current => ({ ...current, ...patch })); setError(""); };

  useEffect(() => { saveChiefSetupDraft(key, draft); }, [key, draft]);
  useEffect(() => {
    const hide = showWelcome();
    setChiefStepOpen(true); setWelcomingBot(bot.id);
    return () => { hide(); setChiefStepOpen(false); setWelcomingBot(null); };
  }, [bot.id]);
  useEffect(() => { dialog.current?.querySelector<HTMLElement>("[data-step-title]")?.focus(); }, [draft.step]);
  useEffect(() => {
    if (draft.model || !models.length) return;
    const gateway = state.instances.find(instance => instance.instanceId === "donebot");
    setDraft(current => ({ ...current, model: gateway?.models?.default || models[0]!.id }));
  }, [draft.model, models, state.instances]);

  const refreshModels = async () => {
    setLoadingModels(true); setModelError(false);
    try {
      const result = await api<{ instances: InstanceInfo[] }>("/api/instances", { timeoutMs: 15_000 });
      dispatch({ type: "instances", instances: result.instances });
    } catch { setModelError(true); }
    finally { setLoadingModels(false); }
  };
  const valid = () => {
    if (!fitsOnOneLine(draft.name) || !fitsOnOneLine(draft.address)) { setError(t("chiefSetup.singleLine")); return false; }
    if (draft.model && !chosen) { edit({ step: 2 }); setError(t("chiefSetup.modelChanged")); return false; }
    const patch = chiefSetupPatch(bot, draft, models);
    if (new TextEncoder().encode(patch.soul).length > BOT_PROFILE_LIMITS.soul) { setError(t("chiefSetup.tooLong")); return false; }
    return true;
  };
  const finish = async () => {
    if (saving.current || !valid()) return;
    saving.current = true; setBusy(true); setError("");
    try {
      const saved = await persistBotUpdate(bot.id, chiefSetupPatch(bot, draft, models), AbortSignal.timeout(15_000));
      dispatch({ type: "botPatched", bot: saved });
      const patch = firstRunPatch(record.current);
      const cloudHints = cloudHome || state.config?.cloudHome ? [CLOUD_WELCOME_DONE, CLOUD_INTENT_ASKED] : [];
      const hintsSeen = [...new Set([...(record.current?.hintsSeen ?? []), ...(patch.onboarding.hintsSeen ?? []), CHIEF_SETUP_HINT, ...cloudHints])];
      const config = await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ onboarding: { ...patch.onboarding, hintsSeen } }), timeoutMs: 15_000 });
      dispatch({ type: "configStatus", config });
      saveChiefSetupDraft(key, null); clearWelcomeDraft();
      setEmailGateDone("submitted"); markWelcomeFinished(); stageIntro(bot.id);
      onDone(bot.id);
    } catch { setError(t("chiefSetup.saveError")); }
    finally { saving.current = false; setBusy(false); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
    if (event.key !== "Tab") return;
    const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input, textarea, select, [tabindex="0"]') ?? [])]
      .filter(control => control.getClientRects().length > 0);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement?.hasAttribute("data-step-title"))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };

  return <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="chief-setup-title" onKeyDown={onKeyDown}
    data-chief-setup={STEPS[draft.step]} className="fixed inset-0 z-50 overflow-y-auto bg-app text-ink" style={{ colorScheme: "var(--code-color-scheme)" }}>
    <div className="mx-auto flex min-h-full max-w-[1040px] flex-col px-5 pb-6 pt-14 sm:px-10 sm:pb-10 sm:pt-16">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline/40 pb-5">
        <span className="text-[15px] font-semibold">DoneBot <span className="ml-2 font-normal text-ink-secondary">{t("chiefSetup.welcome")}</span></span>
        <span className="text-[13px] tabular-nums text-ink-secondary">{t("chiefSetup.progress", { current: String(draft.step + 1), total: "5" })}</span>
      </header>
      <div className="grid flex-1 items-center gap-8 py-8 md:grid-cols-[0.8fr_1.2fr] md:gap-16 md:py-12">
        <aside className="flex flex-col items-center text-center md:sticky md:top-20 md:self-start md:pt-12">
          <div className="motion-safe:animate-pop-in"><BotAvatar bot={preview} size={120} state="happy" /></div>
          <div className="mt-5 max-w-full break-words text-[28px] font-semibold tracking-tight">{preview.name}</div>
          <p className="mt-2 text-[14px] text-ink-secondary">{t("chiefSetup.coordinator")}</p>
          <p aria-live="polite" className="mt-5 max-w-[260px] whitespace-pre-wrap break-words text-[15px] leading-7">
            {draft.address.trim() ? t("chiefSetup.greetingNamed", { user: draft.address.trim(), bot: preview.name }) : t("chiefSetup.greeting", { bot: preview.name })}
          </p>
        </aside>
        <main className="min-w-0">
          <nav aria-label={t("chiefSetup.steps")} className="mb-7 flex gap-2">
            {STEPS.map((step, index) => <button key={step} type="button" disabled={busy || index > draft.step} onClick={() => edit({ step: index })}
              aria-label={t(`chiefSetup.step.${step}`)} aria-current={index === draft.step ? "step" : undefined}
              className={cn("h-1.5 flex-1 rounded-full transition-colors disabled:cursor-default", index <= draft.step ? "bg-accent" : "bg-ink/10")} />)}
          </nav>
          <h1 id="chief-setup-title" data-step-title tabIndex={-1} className="text-[25px] font-semibold tracking-tight outline-none">{t(`chiefSetup.title.${STEPS[draft.step]}`)}</h1>
          <p className="mt-2 text-[14px] leading-6 text-ink-secondary">{t(`chiefSetup.help.${STEPS[draft.step]}`)}</p>
          <fieldset disabled={busy} className="mt-7 space-y-6 disabled:opacity-60">
            {draft.step === 0 && <>
              <label className="block text-[14px] font-medium">{t("chiefSetup.name")}
                <input className={FIELD} maxLength={BOT_PROFILE_LIMITS.name} value={draft.name} placeholder="多宝" autoComplete="off" onChange={event => edit({ name: event.target.value })} />
                <span className="mt-2 block text-[12px] font-normal text-ink-secondary">{t("chiefSetup.nameHelp")}</span>
              </label>
              <label className="block text-[14px] font-medium">{t("chiefSetup.address")}
                <input className={FIELD} maxLength={100} value={draft.address} placeholder={t("chiefSetup.addressPlaceholder")} autoComplete="off" onChange={event => edit({ address: event.target.value })} />
              </label>
            </>}
            {draft.step === 1 && <>
              <div role="group" aria-label={t("chiefSetup.traits")} className="flex flex-wrap gap-2">
                {CHIEF_TRAITS.map(trait => <button type="button" key={trait} aria-pressed={draft.traits.includes(trait)}
                  onClick={() => edit({ traits: draft.traits.includes(trait) ? draft.traits.filter(item => item !== trait) : [...draft.traits, trait] })}
                  className={cn("inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-[14px] transition-colors", draft.traits.includes(trait) ? "border-accent-border bg-accent/10 text-accent-text" : "border-hairline/50 hover:bg-control")}>
                  {draft.traits.includes(trait) && <Check size={14} aria-hidden />}{t(`chiefSetup.trait.${trait}`)}
                </button>)}
              </div>
              <label className="block text-[14px] font-medium">{t("chiefSetup.custom")}
                <textarea rows={4} maxLength={2000} className={cn(FIELD, "resize-y leading-6")} value={draft.custom} placeholder={t("chiefSetup.customPlaceholder")} onChange={event => edit({ custom: event.target.value })} />
              </label>
            </>}
            {draft.step === 2 && <>
              <label className="block text-[14px] font-medium">{t("chiefSetup.model")}
                <Select className="mt-2 w-full" size="lg" value={chosen ? draft.model : ""} onChange={event => edit({ model: event.target.value })}>
                  {!chosen && <option value="">{t("chiefSetup.modelDefault")}</option>}
                  {models.map(model => <option key={model.id} value={model.id}>{model.label || model.id}</option>)}
                </Select>
              </label>
              {!models.length && <p className="text-[13px] leading-6 text-ink-secondary">{t("chiefSetup.noModels")}</p>}
              <button type="button" disabled={loadingModels} onClick={() => void refreshModels()} className="ui-button inline-flex items-center gap-2">{loadingModels && <Loader2 size={14} className="animate-spin" />}{t("chiefSetup.refreshModels")}</button>
              {modelError && <p role="alert" className="text-[13px] text-danger">{t("chiefSetup.modelsError")}</p>}
            </>}
            {draft.step === 3 && <>
              <div><div className="text-[14px] font-medium">{t("chiefSetup.shape")}</div>
                <div role="group" aria-label={t("chiefSetup.shape")} className="mt-3 grid grid-cols-5 gap-2">
                  {PICKABLE_BOT_BODIES.map(body => <button key={body} type="button" title={bodyName(body)} aria-label={bodyName(body)} aria-pressed={draft.body === body} onClick={() => edit({ body })}
                    className={cn("flex h-14 items-center justify-center rounded-xl transition-colors hover:bg-control", draft.body === body && "bg-control ring-2 ring-accent-border")}>
                    <MausAvatar color={draft.color} bodyId={body} size={40} animated={false} trackPointer={false} />
                  </button>)}
                </div>
              </div>
              <div><div className="text-[14px] font-medium">{t("chiefSetup.color")}</div>
                <div role="group" aria-label={t("chiefSetup.color")} className="mt-3 flex flex-wrap gap-3">
                  {MAUS_COLOR_NAMES.map(color => <button key={color} type="button" title={colorName(color)} aria-label={colorName(color)} aria-pressed={draft.color === color} onClick={() => edit({ color })}
                    className={cn("size-9 rounded-full transition-transform hover:scale-110", draft.color === color && "ring-2 ring-accent-border ring-offset-2 ring-offset-app")}
                    style={{ background: colorSwatch(color) }} />)}
                </div>
              </div>
            </>}
            {draft.step === 4 && <dl className="divide-y divide-hairline/40 text-[14px]">
              {[
                [t("chiefSetup.name"), preview.name, 0],
                [t("chiefSetup.address"), draft.address.trim() || t("chiefSetup.addressDefault"), 0],
                [t("chiefSetup.traits"), [...draft.traits.map(trait => t(`chiefSetup.trait.${trait}`)), draft.custom.trim()].filter(Boolean).join(" · ") || t("chiefSetup.traitsDefault"), 1],
                [t("chiefSetup.model"), chosen?.label || chosen?.id || t("chiefSetup.modelDefault"), 2],
                [t("chiefSetup.shape"), `${bodyName(draft.body)} · ${colorName(draft.color)}`, 3],
              ].map(([label, value, step]) => <div key={label} className="flex items-start justify-between gap-4 py-3 first:pt-0">
                <div className="min-w-0"><dt className="text-ink-secondary">{label}</dt><dd className="mt-1 whitespace-pre-wrap break-words leading-6">{value}</dd></div>
                <button type="button" onClick={() => edit({ step: Number(step) })} aria-label={t("chiefSetup.editField", { field: String(label) })} className="shrink-0 py-1 text-accent-text hover:underline">{t("chiefSetup.edit")}</button>
              </div>)}
            </dl>}
          </fieldset>
          {error && <p role="alert" className="mt-5 text-[13px] leading-6 text-danger">{error}</p>}
          <footer className="mt-8 flex items-center justify-between gap-3 border-t border-hairline/40 pt-5">
            <button type="button" disabled={busy || draft.step === 0} onClick={() => edit({ step: draft.step - 1 })} className="ui-button inline-flex items-center gap-2 disabled:opacity-30"><ArrowLeft size={15} aria-hidden />{t("chiefSetup.back")}</button>
            <button type="button" disabled={busy} onClick={() => { if (draft.step === 4) void finish(); else if (draft.step !== 0 || (fitsOnOneLine(draft.name) && fitsOnOneLine(draft.address))) edit({ step: draft.step + 1 }); else setError(t("chiefSetup.singleLine")); }}
              className="ui-button ui-button-primary inline-flex items-center gap-2 px-5 py-2.5 disabled:opacity-60">
              {busy && <Loader2 size={15} className="animate-spin" aria-hidden />}{t(busy ? "chiefSetup.saving" : draft.step === 4 ? "chiefSetup.finish" : "chiefSetup.next")}{!busy && draft.step < 4 && <ArrowRight size={15} aria-hidden />}
            </button>
          </footer>
        </main>
      </div>
    </div>
  </div>;
}
