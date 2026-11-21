import { createRoot } from "react-dom/client";
import { VaultSettings } from "../../src/components/VaultSettings";
import { StoreProvider } from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { applySkinChoice } from "../../src/lib/skins";
import "../../src/styles.css";

setAnalyticsEnabled(false);
applySkinChoice(new URLSearchParams(location.search).get("skin") === "midnight" ? "midnight" : "daylight");
createRoot(document.getElementById("root")!).render(<StoreProvider><main className="mx-auto max-w-3xl p-4"><VaultSettings /></main></StoreProvider>);
