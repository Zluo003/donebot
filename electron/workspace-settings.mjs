export function createWorkspaceSettings({ window, isLocal, selectLocal, navigate, origin }) {
  return (computerId) => {
    const win = window();
    if (!win || win.isDestroyed()) return;
    const id = typeof computerId === "string" ? computerId : null;
    if (isLocal({ sender: win.webContents })) {
      win.webContents.send("workspaces:open-settings", id);
    } else {
      selectLocal();
      navigate(`${origin()}/?desktop-settings=workspaces${id ? `&share-computer=${encodeURIComponent(id)}` : ""}`);
    }
  };
}

export function createClipboardServerConnect({ connect, read, dialog, t }) {
  return async () => {
    try {
      return await connect(read());
    } catch (error) {
      await dialog.showMessageBox({ type: "info", message: t("native.dialog.connectFailed.title"), detail: `${error.message}\n${t("native.dialog.connectFailed.detail")}` });
      return false;
    }
  };
}
