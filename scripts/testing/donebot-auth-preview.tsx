import { createRoot } from "react-dom/client";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { DoneBotAccountGate, DoneBotAccountSettings } from "../../src/donebot/Account";
import { PlaceAddSheet, OwnServerLink, RailSheet } from "../../src/components/PlaceAddSheet";
import { DoneBotCloudDialog } from "../../src/donebot/CloudDialog";
import { StoreProvider } from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { loadLocale } from "../../src/lib/i18n";
import { applySkin } from "../../src/lib/skins";
import "../../src/styles.css";

setAnalyticsEnabled(false);
applySkin("atelier");
await loadLocale("zh-CN");
const surface = new URLSearchParams(window.location.search).get("surface");
const close = () => { document.getElementById("root")!.dataset.closed = "true"; };
createRoot(document.getElementById("root")!).render(surface === "cloud-add"
  ? <PlaceAddSheet choices={{ cloud: true, local: true, link: true, address: true }} onClose={close} />
  : surface === "server-connect"
    ? <RailSheet focusKey="server" onClose={close}><OwnServerLink onBack={null} onConnected={close} /></RailSheet>
    : surface === "cloud-menu"
      ? <DoneBotCloudDialog onClose={close} />
      : <DesktopCapabilitiesProvider><StoreProvider><DoneBotAccountGate><main className="mx-auto max-w-2xl p-8"><DoneBotAccountSettings /></main></DoneBotAccountGate></StoreProvider></DesktopCapabilitiesProvider>);
