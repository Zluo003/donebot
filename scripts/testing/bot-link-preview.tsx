import { createRoot } from "react-dom/client";
import { DoneBotCloudAccess } from "../../src/donebot/CloudAccess";
import { applySkin } from "../../src/lib/skins";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import "../../src/styles.css";

setAnalyticsEnabled(false);
applySkin("atelier");
createRoot(document.getElementById("root")!).render(<main className="mx-auto max-w-2xl p-8"><DoneBotCloudAccess /></main>);
