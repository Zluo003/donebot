import { fileURLToPath } from "node:url";
import { skinChrome, skinIsLight } from "./skin-overlay.cjs";

export function cloudLoadingTheme(skin) {
  const light = skinIsLight(skin);
  const chrome = skinChrome(skin);
  return { "color-scheme": light ? "light" : "dark", "--bg": chrome.color,
    "--ink": light ? "#202020" : "#f5f5f5", "--muted": chrome.symbolColor,
    "--line": light ? "#00000024" : "#ffffff30", "--accent": light ? "#202020" : "#f5f5f5",
    "--wash": light ? "#00000008" : "#ffffff0a" };
}

export function cloudLoadingHtml(platform = process.platform, skin = "midnight") {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>连接 Cloud</title><style>
:root{${Object.entries(cloudLoadingTheme(skin)).map(([key, value]) => `${key}:${value}`).join(";")}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,sans-serif}
header{height:54px;-webkit-app-region:drag}main{min-height:calc(100vh - 108px);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;text-align:center}
.window-actions{display:flex;justify-content:flex-end}.window-actions button{width:46px;height:32px;padding:0;border:0;border-radius:0;-webkit-app-region:no-drag}.window-actions button:last-child:hover{background:#333;color:#fff}
.connection{display:flex;flex-direction:column;align-items:center;color:var(--ink);margin-bottom:30px}.connection-logo{width:42px;height:35px;margin-bottom:22px}.connection-diagram{width:224px;height:72px}.connection-line{stroke:var(--muted)}.connection-packet{animation:transmit 2s ease-in-out infinite}
h1{font-size:24px;font-weight:600;letter-spacing:-.5px;margin:0 0 12px}p{font-size:14px;color:var(--muted);line-height:1.7;max-width:360px;margin:0}.status{display:flex;align-items:center;gap:9px}
.spinner{width:15px;height:15px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:spin .85s linear infinite}
.hint{margin-top:12px;font-size:12px;min-height:21px}.actions{display:flex;gap:12px;margin-top:28px}button{font:inherit;font-size:13px;padding:10px 18px;border:1px solid var(--line);border-radius:20px;color:var(--ink);background:transparent;cursor:pointer}button:hover{background:var(--wash)}button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}#retry{background:var(--ink);border-color:var(--ink);color:var(--bg)}[hidden]{display:none!important}
body[data-failed] .spinner{display:none}body[data-failed] .connection-packet{animation:none;opacity:0}body[data-failed] #status{color:var(--ink)}
@keyframes spin{to{transform:rotate(360deg)}}@keyframes transmit{0%{transform:translateX(0);opacity:0}15%,85%{opacity:1}100%{transform:translateX(74px);opacity:0}}@media(prefers-reduced-motion:reduce){*,*:before{animation:none!important}}
</style></head><body><header>${platform === "win32" ? `<div class="window-actions"><button aria-label="最小化" onclick="window.cloudLoading.window('minimize')">−</button><button aria-label="最大化或还原" onclick="window.cloudLoading.window('maximize')">□</button><button aria-label="关闭" onclick="window.cloudLoading.window('close')">×</button></div>` : ""}</header><main>
<div class="connection" aria-hidden="true"><svg class="connection-logo" viewBox="298 423 1451 1210"><path fill="currentColor" fill-rule="evenodd" d="
    M732.00 1628.42
    C730.08 1628.20 722.88 1627.55 716.00 1626.97
    C676.64 1623.65 627.70 1611.36 590.46 1595.46
    C494.01 1554.26 411.32 1477.27 359.06 1380.00
    C302.52 1274.78 287.90 1153.20 317.99 1038.60
    C380.54 800.32 598.93 645.50 826.50 678.11
    C895.33 687.97 962.28 718.00 1018.82 764.38
    C1024.70 769.20 1026.32 770.10 1027.06 768.94
    C1027.61 768.08 1027.94 700.38 1027.88 600.00
    C1027.82 507.88 1027.83 431.56 1027.89 430.41
    L1028.00 428.33 1169.35 427.64
    C1247.09 427.26 1311.44 427.23 1312.35 427.58
    C1313.88 428.17 1314.00 470.13 1314.00 1015.00
    L1314.00 1601.78 1311.75 1602.32
    C1308.31 1603.15 1035.99 1602.97 1032.00 1602.14
    L1028.50 1601.42 1028.24 1563.50
    C1028.08 1541.34 1027.58 1525.18 1027.03 1524.63
    C1026.43 1524.03 1023.01 1526.47 1017.79 1531.20
    C960.23 1583.39 891.18 1615.06 811.00 1626.04
    C796.25 1628.06 742.94 1629.67 732.00 1628.42
    Z
    M1566.03 1617.41
    C1497.82 1606.44 1443.01 1548.29 1436.81 1480.33
    C1429.79 1403.30 1482.17 1333.80 1560.03 1316.85
    C1576.79 1313.20 1611.16 1313.43 1626.48 1317.30
    C1685.76 1332.27 1729.74 1377.22 1742.64 1436.00
    C1745.32 1448.22 1745.32 1483.76 1742.64 1495.95
    C1729.11 1557.53 1683.69 1602.93 1622.50 1616.02
    C1609.04 1618.90 1579.78 1619.62 1566.03 1617.41
    Z
    M840.42 1357.10
    C911.51 1342.39 964.58 1296.64 992.90 1225.63
    C1004.58 1196.34 1008.42 1153.35 1002.45 1118.60
    C985.15 1017.89 902.72 945.97 804.64 946.00
    C772.38 946.01 743.88 952.51 717.05 965.97
    C614.42 1017.48 572.37 1141.31 622.47 1244.50
    C651.68 1304.66 710.22 1349.06 772.00 1357.92
    C776.12 1358.51 780.62 1359.19 782.00 1359.42
    C789.54 1360.71 830.90 1359.07 840.42 1357.10
    Z"/></svg>
<svg class="connection-diagram" viewBox="0 0 240 72" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="19" width="54" height="35" rx="3"/><path d="M1 61h66M28 54v7m12-7v7"/><path class="connection-line" d="M85 37h74" stroke-dasharray="2 6"/><circle class="connection-packet" cx="85" cy="37" r="2.5" fill="currentColor" stroke="none"/><path d="M184 52h34a14 14 0 0 0 0-28 21 21 0 0 0-40 5 12 12 0 0 0 6 23Z"/></svg></div>
<h1 id="heading">正在连接 Cloud</h1><div class="status" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><p id="status">正在验证登录状态…</p></div>
<p class="hint" id="hint">正在为你准备云端对话</p><div class="actions"><button id="local" onclick="window.cloudLoading.local()">返回本地对话</button><button id="retry" hidden onclick="window.cloudLoading.retry()">重试连接</button></div>
</main></body></html>`;
}

export function createDoneBotCloudLoading({ createView, window: getWindow, changed = () => {}, local, skin = () => "midnight" }) {
  let current = null;
  function refreshTheme() {
    const active = current;
    if (!active) return;
    void active.ready.then(() => {
      if (current !== active || active.contents.isDestroyed()) return;
      return active.contents.executeJavaScript(`for (const [key,value] of Object.entries(${JSON.stringify(cloudLoadingTheme(skin()))})) document.documentElement.style.setProperty(key,value);`);
    }).catch(() => {});
  }
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
    active.ready = contents.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(cloudLoadingHtml(process.platform, skin())));
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
  return { start, hide, refreshTheme, visible: () => current !== null };
}
