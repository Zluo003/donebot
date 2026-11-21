import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TeamFilesPage } from "../../src/components/team-files/TeamFilesPage";
import { StoreProvider } from "../../src/state/store";
import { applySkin } from "../../src/lib/skins";
import { loadLocale } from "../../src/lib/i18n";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import "../../src/styles.css";

setAnalyticsEnabled(false);
await loadLocale("en");
applySkin("daylight");

function Fixture() {
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dark, setDark] = useState(false);
  const changePerson = async (role: string) => {
    setBusy(true);
    try {
      const response = await fetch(`/__fixture/actor?role=${role}`, { method: "POST" });
      if (!response.ok) throw new Error("Fixture actor unavailable");
      setRevision(value => value + 1);
    } finally { setBusy(false); }
  };
  return <div className="flex h-dvh flex-col bg-app text-ink">
    <aside aria-label="Fixture controls" className="flex shrink-0 flex-wrap gap-2 border-b border-hairline p-2 text-[12px]">
      {['member', 'admin'].map(role => <button className="ui-button" disabled={busy} key={role} onClick={() => void changePerson(role)}>View as {role}</button>)}
      <button className="ui-button" onClick={() => void fetch("/__fixture/actor?role=revoked", { method: "POST" })}>Revoke access</button>
      <button className="ui-button" onClick={() => { const value = !dark; setDark(value); applySkin(value ? "midnight" : "daylight"); }}>{dark ? "Light theme" : "Dark theme"}</button>
    </aside>
    <div className="flex min-h-0 flex-1"><StoreProvider key={revision}><TeamFilesPage /></StoreProvider></div>
  </div>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
