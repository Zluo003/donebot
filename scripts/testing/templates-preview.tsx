import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { TeamLibraryPanel } from "../../src/components/TeamLibraryPanel";
import { StoreProvider } from "../../src/state/store";
import { applySkin } from "../../src/lib/skins";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import "../../src/styles.css";

setAnalyticsEnabled(false);
applySkin("daylight");

function Fixture() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [imported, setImported] = useState("");
  return <main className="min-h-screen bg-panel p-8 text-ink">
    <button ref={trigger} onClick={() => setOpen(true)}>Open templates</button>
    <output>{imported}</output>
    {open && <TeamLibraryPanel returnFocusRef={trigger} onClose={() => setOpen(false)} onImported={result => {
      setImported(`Added ${result.name}`);
      setOpen(false);
    }} />}
  </main>;
}

createRoot(document.getElementById("root")!).render(<StoreProvider><Fixture /></StoreProvider>);
