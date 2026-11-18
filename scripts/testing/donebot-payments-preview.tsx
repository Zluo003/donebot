import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { SettingsModal } from "../../src/components/SettingsModal";
import { DoneBotAccountGate } from "../../src/donebot/Account";
import { StoreProvider, useStore } from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { setAdvancedMode } from "../../src/lib/interface-mode";
import { loadLocale } from "../../src/lib/i18n";
import { applySkin } from "../../src/lib/skins";
import "../../src/styles.css";

setAnalyticsEnabled(false);
setAdvancedMode(false);
applySkin("atelier");
await loadLocale("zh-CN");

function Preview() {
  const { state, dispatch } = useStore();
  useEffect(() => { dispatch({ type: "toggleAppSettings", open: true, section: "general" }); }, [dispatch]);
  return <DoneBotAccountGate>{state.appSettingsOpen ? <SettingsModal /> : <button onClick={() => dispatch({ type: "toggleAppSettings", open: true })}>打开设置</button>}</DoneBotAccountGate>;
}

createRoot(document.getElementById("root")!).render(<DesktopCapabilitiesProvider><StoreProvider><Preview /></StoreProvider></DesktopCapabilitiesProvider>);
