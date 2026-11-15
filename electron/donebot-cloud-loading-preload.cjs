const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cloudLoading", {
  local: () => ipcRenderer.send("donebot-cloud-loading:local"),
  retry: () => ipcRenderer.send("donebot-cloud-loading:retry"),
  window: action => ipcRenderer.send("donebot-cloud-loading:window", action),
});
