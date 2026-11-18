import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { loadLocale } from "../../src/lib/i18n";
import { applySkinChoice, readSkinChoice } from "../../src/lib/skins";
import "../../src/styles.css";

setAnalyticsEnabled(false);
applySkinChoice(readSkinChoice());
await loadLocale("zh-CN");
createRoot(document.getElementById("root")!).render(<App />);
