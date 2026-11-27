import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { PageBoundary } from "./components/PageBoundary";
import { bootstrapBrand } from "./lib/brand";
import { applyFont, readFont } from "./lib/fonts";
import { loadPageLanguage } from "./lib/language-preference";
import { settleInterfaceMode } from "./lib/new-look";
import { readSkinChoice, resolveSkin, wearSkin } from "./lib/skins";
import { PetAvatarView } from "./donebot/pet/PetAvatarView";
import { PetPopoverView } from "./donebot/pet/PetPopoverView";
import "./styles.css";

function PetEntry() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view") === "popover" ? "popover" : "avatar";

  useEffect(() => window.ogb?.desktopPet?.onSkin?.(wearSkin), []);

  return view === "popover" ? <PetPopoverView /> : <PetAvatarView />;
}

if (window.ogb?.desktopPet) {
  settleInterfaceMode();
  wearSkin(resolveSkin(readSkinChoice()));
  applyFont(readFont());
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
  document.body.style.overflow = "hidden";
  void Promise.all([bootstrapBrand(), loadPageLanguage()]).then(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <PageBoundary>
          <PetEntry />
        </PageBoundary>
      </StrictMode>,
    );
  });
} else {
  location.replace(`/${location.search}${location.hash}`);
}
