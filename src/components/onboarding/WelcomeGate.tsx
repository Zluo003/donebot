import { useEffect, useState } from "react";
import { emailGateDone } from "@/lib/analytics";
import { clearWelcomeDraft } from "@/lib/welcome-draft";
import { hostedMember, LOCAL_VIEWER, welcomeDue, welcomeViewer, type WelcomeViewer } from "@/lib/onboarding";
import { api, useStore } from "@/state/store";
import { SharedWorkspaceHint } from "./SharedWorkspaceHint";
import { WelcomeFlow } from "./WelcomeFlow";
import { useViewerEmail } from "@/lib/default-bot";
import { chiefSetupBot } from "@/donebot/chief-setup";
import { DoneBotChiefSetup } from "@/donebot/ChiefSetup";

/**
 * Security: a remote page the desktop app loads gets a reduced but truthy window.ogb without remoteClient, and is no
 * more the owner than a browser.
 */
export function localDesktopPage(): boolean {
  return window.ogb?.remoteClient !== undefined;
}

export function useWelcomeViewer(): WelcomeViewer | null {
  const local = localDesktopPage();
  const [viewer, setViewer] = useState<WelcomeViewer | null>(local ? LOCAL_VIEWER : null);
  useEffect(() => {
    if (local) return;
    let active = true;
    void api("/api/auth/session", { timeoutMs: 10_000 })
      .then((session) => {
        if (active) setViewer(welcomeViewer(session));
      })
      .catch(() => {
        if (active) setViewer(LOCAL_VIEWER);
      });
    return () => {
      active = false;
    };
  }, [local]);
  return viewer;
}

export function WelcomeGate({ viewer }: { viewer: WelcomeViewer | null }) {
  const { state, dispatch } = useStore();
  const [dismissed, setDismissed] = useState(false);
  const [setupId, setSetupId] = useState<string | null>(null);
  const email = useViewerEmail();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const setup = chiefSetupBot({ bots: state.bots, config: state.config, connected: state.connected, hydrated: state.hydrated,
    viewer, email, remote: remoteClient });
  const activeSetup = setupId ? state.bots.find(bot => bot.id === setupId) : setup;
  useEffect(() => { if (setup && !dismissed) setSetupId(setup.id); }, [setup?.id, dismissed]);
  // A welcome finished elsewhere (another window, an older version's record) leaves no draft behind to resume later.
  const finished = Boolean(viewer && state.config) && !welcomeDue(state.config, {
    remoteClient, legacyDone: emailGateDone(), hosted: viewer?.hosted, canSave: viewer?.canSave, cloudHome: viewer?.cloudHome,
  });
  useEffect(() => {
    if (finished) clearWelcomeDraft();
  }, [finished]);
  if (!viewer) return null;
  if (!state.welcomeOpen && (!state.hydrated || email === undefined)) return null;
  if (!dismissed && activeSetup) return <DoneBotChiefSetup key={activeSetup.id} bot={activeSetup} cloudHome={viewer.cloudHome} onDone={id => {
    setDismissed(true); setSetupId(null);
    dispatch({ type: "toggleWelcome", open: false });
    dispatch({ type: "select", id });
  }} />;
  if (hostedMember(viewer)) {
    return remoteClient ? null : (
      <SharedWorkspaceHint
        replay={state.welcomeOpen}
        onClose={() => {
          if (state.welcomeOpen) dispatch({ type: "toggleWelcome", open: false });
        }}
      />
    );
  }
  const due =
    !dismissed &&
    welcomeDue(state.config, {
      remoteClient,
      legacyDone: emailGateDone(),
      hosted: viewer.hosted,
      canSave: viewer.canSave,
      cloudHome: viewer.cloudHome,
    });
  if (state.appSettingsOpen && (["desktopWorkspaces", "organization"].includes(state.appSettingsSection) ||
    (state.appSettingsSection === "cloudAccount" && state.appSettingsCloudLink > 0))) return null;
  if (!state.welcomeOpen && !due) return null;
  const fallback = state.bots.find((b) => !b.hidden && b.chiefOfStaff) ?? state.bots.find((b) => !b.hidden) ?? null;
  const replay = state.welcomeOpen && !due;
  return (
    <WelcomeFlow
      replay={replay}
      hosted={viewer.hosted}
      onDone={(botId) => {
        setDismissed(true);
        dispatch({ type: "toggleWelcome", open: false });
        // A first run ends in the chat with the bot it chose, else its Chief; the app tour starts only from Settings.
        const target = botId ?? (replay ? null : fallback?.id);
        if (target) dispatch({ type: "select", id: target });
      }}
    />
  );
}
