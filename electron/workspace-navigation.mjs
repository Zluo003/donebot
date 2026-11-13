export function createWorkspaceNavigation({ window, local, saved, restore, log = () => {} }) {
  let turn = 0;
  return async (url) => {
    const mine = ++turn;
    const win = window();
    if (!win || win.isDestroyed()) return false;
    const activeId = saved().activeId;
    try {
      await win.loadURL(url);
      return true;
    } catch {
      if (mine !== turn || window() !== win || win.isDestroyed() || saved().activeId !== activeId) return false;
      try {
        const computer = local();
        let origin;
        try { origin = new URL(win.webContents.getURL()).origin; } catch {}
        const visibleId = origin === computer.origin ? computer.id
          : saved().environments.find(entry => entry.kind !== "local" && entry.origin === origin)?.id;
        if (visibleId !== undefined) {
          if (visibleId !== saved().activeId) restore(visibleId);
        } else {
          restore(computer.id);
          await win.loadURL(computer.origin).catch(() => {});
        }
      } catch {
        log("Could not restore the workspace after a failed navigation");
      }
      return false;
    }
  };
}
