import { fileURLToPath } from "node:url";

export function cloudLoadingHtml(platform = process.platform) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>连接 Cloud</title><style>
:root{color-scheme:light dark;--bg:#f8f8f8;--ink:#202124;--muted:#73777d;--line:#dedfe2;--accent:#00a58f;--wash:#00a58f12}
@media(prefers-color-scheme:dark){:root{--bg:#111214;--ink:#f0f1f2;--muted:#9a9ea5;--line:#33363a;--wash:#00a58f16}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,sans-serif}
header{height:54px;-webkit-app-region:drag}main{min-height:calc(100vh - 108px);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;text-align:center}
.window-actions{display:flex;justify-content:flex-end}.window-actions button{width:46px;height:32px;padding:0;border:0;border-radius:0;-webkit-app-region:no-drag}.window-actions button:last-child:hover{background:#c42b1c;color:#fff}
.cloud{position:relative;display:grid;place-items:center;width:96px;height:96px;border-radius:28px;background:var(--wash);color:var(--accent);margin-bottom:28px}
.cloud:before{content:"";position:absolute;inset:-10px;border:1px solid var(--accent);border-radius:36px;animation:breathe 2.4s ease-in-out infinite;opacity:.2}
h1{font-size:24px;font-weight:600;letter-spacing:-.5px;margin:0 0 12px}p{font-size:14px;color:var(--muted);line-height:1.7;max-width:360px;margin:0}.status{display:flex;align-items:center;gap:9px}
.spinner{width:15px;height:15px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:spin .85s linear infinite}
.hint{margin-top:12px;font-size:12px;min-height:21px}.actions{display:flex;gap:12px;margin-top:28px}button{font:inherit;font-size:13px;padding:10px 18px;border:1px solid var(--line);border-radius:20px;color:var(--ink);background:transparent;cursor:pointer}button:hover{background:var(--wash)}button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}#retry{background:var(--accent);border-color:var(--accent);color:#fff}[hidden]{display:none!important}
body[data-failed] .spinner{display:none}body[data-failed] .cloud:before{animation:none}body[data-failed] #status{color:var(--ink)}
@keyframes spin{to{transform:rotate(360deg)}}@keyframes breathe{50%{transform:scale(1.12);opacity:.5}}@media(prefers-reduced-motion:reduce){*,*:before{animation:none!important}}
</style></head><body><header>${platform === "win32" ? `<div class="window-actions"><button aria-label="最小化" onclick="window.cloudLoading.window('minimize')">−</button><button aria-label="最大化或还原" onclick="window.cloudLoading.window('maximize')">□</button><button aria-label="关闭" onclick="window.cloudLoading.window('close')">×</button></div>` : ""}</header><main>
<div class="cloud" aria-hidden="true"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M20 16.2A4.5 4.5 0 0 0 18 7.7a6 6 0 0 0-11.7 1.8A3.6 3.6 0 0 0 6 16.7h4m4 0h4M12 13v8m-3-3 3 3 3-3"/></svg></div>
<h1 id="heading">正在连接 Cloud</h1><div class="status" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><p id="status">正在验证登录状态…</p></div>
<p class="hint" id="hint">正在为你准备云端对话</p><div class="actions"><button id="local" onclick="window.cloudLoading.local()">返回本地对话</button><button id="retry" hidden onclick="window.cloudLoading.retry()">重试连接</button></div>
</main></body></html>`;
}

export function createDoneBotCloudLoading({ createView, window: getWindow, changed = () => {}, local }) {
  let current = null;
  function hide() {
    const active = current;
    if (!active) return;
    current = null;
    clearTimeout(active.slow);
    active.window.removeListener("resize", active.layout);
    active.window.removeListener("closed", hide);
    if (!active.window.isDestroyed()) active.window.contentView.removeChildView(active.view);
    if (!active.contents.isDestroyed()) active.contents.close();
    changed();
  }
  function start(retry) {
    hide();
    const win = getWindow();
    if (!win || win.isDestroyed()) return null;
    const view = createView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: fileURLToPath(new URL("./donebot-cloud-loading-preload.cjs", import.meta.url)) } });
    const contents = view.webContents;
    const active = { window: win, view, contents, stage: "authorizing", slow: null, ready: null, layout: () => {
      const [width, height] = win.getContentSize();
      view.setBounds({ x: 0, y: 0, width, height });
    } };
    current = active;
    const update = stage => {
      if (current !== active) return;
      active.stage = stage;
      const failed = stage === "failed";
      const text = failed ? "Cloud 暂时无法连接，请重试或返回本地对话。" : stage === "loading" ? "正在加载聊天内容…" : stage === "connecting" ? "正在建立安全连接…" : "正在验证登录状态…";
      void active.ready.then(() => {
        if (current !== active || contents.isDestroyed()) return;
        return contents.executeJavaScript(`document.body.toggleAttribute('data-failed', ${failed});document.getElementById('heading').textContent=${JSON.stringify(failed ? "暂时无法连接 Cloud" : "正在连接 Cloud")};document.getElementById('status').textContent=${JSON.stringify(text)};document.getElementById('retry').hidden=${!failed};`);
      }).catch(() => {});
    };
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", event => event.preventDefault());
    contents.on("will-redirect", event => event.preventDefault());
    contents.on("ipc-message", (event, channel, action) => {
      if (current !== active || event.senderFrame !== contents.mainFrame) return;
      if (channel === "donebot-cloud-loading:local") {
        hide();
        void Promise.resolve().then(local).catch(() => { start(retry)?.fail(); });
      }
      if (channel === "donebot-cloud-loading:retry" && active.stage === "failed") void retry().catch(() => {});
      if (channel === "donebot-cloud-loading:window") {
        if (action === "minimize") win.minimize();
        if (action === "maximize") { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
        if (action === "close") win.close();
      }
    });
    active.ready = contents.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(cloudLoadingHtml()));
    active.ready.catch(() => {});
    win.contentView.addChildView(view);
    active.layout();
    win.on("resize", active.layout);
    win.once("closed", hide);
    changed();
    active.slow = setTimeout(() => {
      void active.ready.then(() => {
        if (current === active && !contents.isDestroyed()) return contents.executeJavaScript("document.getElementById('hint').textContent='连接时间较长，你可以继续等待或先返回本地对话';");
      }).catch(() => {});
    }, 8_000);
    active.slow.unref?.();
    return {
      update,
      fail: () => update("failed"),
      close: () => { if (current === active) hide(); },
      async finish() {
        if (current !== active || win.isDestroyed()) return;
        // Electron finishes navigation before React mounts its asynchronously imported app.
        const ready = await win.webContents.executeJavaScript(`new Promise(resolve => {
          const root = document.getElementById('root');
          if (!root || root.childElementCount) { resolve(true); return; }
          const observer = new MutationObserver(() => { if (root.childElementCount) done(true); });
          const timer = setTimeout(() => done(false), 20000);
          function done(value) { clearTimeout(timer); observer.disconnect(); resolve(value); }
          observer.observe(root, { childList: true });
        })`);
        if (current !== active) return;
        if (!ready) throw new Error("Cloud 页面尚未准备好，请重试。");
        hide();
      },
    };
  }
  return { start, hide, visible: () => current !== null };
}
