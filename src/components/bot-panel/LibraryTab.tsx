import { AppWindow, Brain, Folder, Globe, Zap } from "lucide-react";
import { useMemo } from "react";

import { t } from "@/lib/i18n";
import { usePageOpener } from "@/lib/page-open";
import { shortPath } from "@/lib/short-path";
import { SIDEBAR_INLINE, useMediaQuery } from "@/lib/use-media-query";
import { useStore, visibleMessages, type Bot, type Message } from "@/state/store";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { skillSwitchOn, useManagedSkills } from "../bot-settings/SkillsSection";
import type { SimplePageId } from "./page-registry";
import { Card, NavRow } from "./rows";
import { panelMemoryNotes } from "./memory-notes";
import { useMemoryDoc } from "./use-memory-doc";

export interface LibraryItems {
  pages: Array<{ messageId: string; title: string; url: string }>;
  apps: Array<{ messageId: string; title: string }>;
}

/** What the bot made in the open conversation, newest first: its live published pages and interactive apps.
 * Delivered documents and media live in the dedicated Artifacts tab instead of mixing with raw workspace churn here. */
export function libraryItems(bot: Bot, messages: readonly Message[] = visibleMessages(bot)): LibraryItems {
  const pages: LibraryItems["pages"] = [];
  const apps: LibraryItems["apps"] = [];
  const seenPages = new Set<string>();
  for (const message of [...messages].reverse()) {
    const page = message.publishedPage;
    if (page?.state === "live" && page.url && !seenPages.has(page.url)) {
      seenPages.add(page.url);
      pages.push({ messageId: message.id, title: page.title || page.url, url: page.url });
    }
    if (message.kind === "app" && message.app?.doc) apps.push({ messageId: message.id, title: message.app.title });
  }
  return { pages, apps };
}

export function LibraryTab({ bot, onOpen }: { bot: Bot; onOpen: (page: SimplePageId) => void }) {
  const { dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const openPage = usePageOpener();
  const phone = !useMediaQuery(SIDEBAR_INLINE, true);
  const skills = useManagedSkills(bot);
  const memory = useMemoryDoc(bot);
  const { pages, apps } = useMemo(() => libraryItems(bot), [bot]);
  const showInChat = (messageId: string) => {
    dispatch({ type: "focusMessage", threadId: bot.threadId, messageId });
    if (phone) dispatch({ type: "toggleSettings", open: false });
  };
  const skillsOn = skills.skills.filter(skillSwitchOn).length;
  const notes = memory.docs ? panelMemoryNotes(memory.docs).length : null;
  const memoryValue = bot.memoryEnabled === false ? t("botPanel.memory.off")
    : notes === null ? (memory.error ? t("botPanel.memory.nothingYet") : undefined)
    : notes === 0 ? t("botPanel.memory.nothingYet")
    : notes === 1 ? t("botPanel.memory.note") : t("botPanel.memory.notes", { count: notes });
  const keeps = (
    <Card anchor="keeps">
      <NavRow data-panel-page="memory" icon={Brain} title={t("botPanel.memoryRow")} value={memoryValue} onClick={() => onOpen("memory")} />
      <NavRow
        data-panel-page="skills"
        icon={Zap}
        title={t("botSettings.simple.skills")}
        value={skills.loading ? undefined : skillsOn > 0 ? skillsOn : t("botPanel.none")}
        onClick={() => onOpen("skills")}
      />
      <NavRow
        data-panel-page="folder"
        icon={Folder}
        title={t("computer.files.folder")}
        value={bot.cwd ? shortPath(bot.cwd, capabilities.host?.homeDir) : t("botPanel.folder.private")}
        onClick={() => onOpen("folder")}
      />
    </Card>
  );

  if (pages.length + apps.length === 0) {
    return (
      <div data-panel-tabpanel="library">
        {keeps}
        <p data-panel-empty="library" className="px-3 py-6 text-center text-[13px] leading-[18px] text-ink-tertiary">
          {t("botPanel.library.empty")}
        </p>
      </div>
    );
  }
  return (
    <div data-panel-tabpanel="library">
      {keeps}
      {pages.length > 0 && (
        <Card label={t("botPanel.library.pages")} anchor="pages">
          {pages.map((page) => (
            <NavRow key={page.url} data-panel-row="page" icon={Globe} title={<span className="block truncate">{page.title}</span>} hint={<span className="block truncate">{page.url}</span>} onClick={() => openPage(page.url)} />
          ))}
        </Card>
      )}
      {apps.length > 0 && (
        <Card label={t("botPanel.library.apps")} anchor="apps">
          {apps.map((app) => (
            <NavRow key={app.messageId} data-panel-row="app" icon={AppWindow} title={<span className="block truncate">{app.title}</span>} onClick={() => showInChat(app.messageId)} />
          ))}
        </Card>
      )}
      <p className="mt-3 text-center text-[12px] text-ink-tertiary">{t("botPanel.library.scope")}</p>
    </div>
  );
}
