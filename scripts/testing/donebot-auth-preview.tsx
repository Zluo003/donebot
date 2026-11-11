import { createRoot } from "react-dom/client";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { DoneBotAccountGate, DoneBotAccountSettings } from "../../src/donebot/Account";
import { StoreProvider } from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { loadLocale } from "../../src/lib/i18n";
import { applySkin } from "../../src/lib/skins";
import "../../src/styles.css";

setAnalyticsEnabled(false);
applySkin("atelier");
await loadLocale("zh-CN");
createRoot(document.getElementById("root")!).render(<DesktopCapabilitiesProvider><StoreProvider><DoneBotAccountGate><main className="mx-auto max-w-2xl p-8"><DoneBotAccountSettings /></main></DoneBotAccountGate></StoreProvider></DesktopCapabilitiesProvider>);
