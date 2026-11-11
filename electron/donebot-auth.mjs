import { randomUUID } from "node:crypto";

const origin = "https://donebot.cn";
const domains = ["challenges.cloudflare.com", "qcloud.com", "gtimg.com", "qq.com", "capassets.com", "alicdn.com", "aliyuncs.com", "aliyun.com"];
const allowedResource = value => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)); }
  catch { return false; }
};

export function authChallengeConfiguration(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("无法读取安全验证配置。");
  const flags = [raw.turnstile_enabled, raw.tencent_captcha_enabled, raw.aliyun_captcha_enabled].map(value => value === true);
  if (flags.filter(Boolean).length > 1) throw new Error("安全验证配置冲突，请联系管理员。");
  const text = value => typeof value === "string" && value.length <= 500 && value.trim() ? value.trim() : null;
  if (flags[0] && text(raw.turnstile_site_key)) return { provider: "turnstile", siteKey: text(raw.turnstile_site_key) };
  if (flags[1] && text(raw.tencent_captcha_app_id)) return { provider: "tencent", appId: text(raw.tencent_captcha_app_id), region: raw.tencent_captcha_region === "intl" ? "intl" : "cn" };
  if (flags[2] && text(raw.aliyun_captcha_scene_id) && text(raw.aliyun_captcha_prefix)) return { provider: "aliyun", sceneId: text(raw.aliyun_captcha_scene_id), prefix: text(raw.aliyun_captcha_prefix), region: raw.aliyun_captcha_region === "sgp" ? "sgp" : "cn" };
  if (flags.some(Boolean)) throw new Error("安全验证尚未配置完成，请联系管理员。");
  return { provider: "none" };
}

export function authChallengeProof(config, raw) {
  const valid = value => typeof value === "string" && value.length > 0 && value.length <= 8192 && !value.startsWith("trerror_");
  if (config.provider === "none") return {};
  if (!raw || typeof raw !== "object") return null;
  if (config.provider === "tencent") return valid(raw.tencent_captcha_ticket) && valid(raw.tencent_captcha_randstr)
    ? { tencent_captcha_ticket: raw.tencent_captcha_ticket, tencent_captcha_randstr: raw.tencent_captcha_randstr } : null;
  return valid(raw.turnstile_token) ? { turnstile_token: raw.turnstile_token } : null;
}

export function authChallengeHTML(config) {
  const settings = JSON.stringify(config).replaceAll("<", "\\u003c");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>DoneBot 安全验证</title>
<style>body{font:14px system-ui;margin:32px;color:#202126;background:#fff}h1{font-size:22px}p{line-height:1.8;color:#64676e}button{border:0;border-radius:6px;background:#c92e3c;color:white;padding:12px 20px;margin-top:20px}#challenge{min-height:70px}</style>
<h1>安全验证</h1><p id="message">请完成验证，完成后会自动返回 DoneBot。</p><div id="challenge"></div><button id="verify" hidden>开始验证</button><script>
const config=${settings},message=document.getElementById('message');
const finish=proof=>{window.__donebotAuthResult=proof;message.textContent='验证已完成，正在返回…';};
const fail=()=>{window.__donebotAuthError=true;};
const sdk=document.createElement('script');sdk.onerror=fail;
if(config.provider==='turnstile'){
 sdk.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';sdk.onload=()=>{try{turnstile.render('#challenge',{sitekey:config.siteKey,size:'flexible',callback:token=>finish({turnstile_token:token}),'error-callback':fail,'expired-callback':fail});}catch{fail();}};
}else if(config.provider==='tencent'){
 sdk.src=config.region==='intl'?'https://ca.turing.captcha.qcloud.com/TJNCaptcha-global.js':'https://turing.captcha.qcloud.com/TJCaptcha.js';
 sdk.onload=()=>{try{const callback=result=>{if(result.ret===0&&!result.errorCode)finish({tencent_captcha_ticket:result.ticket,tencent_captcha_randstr:result.randstr});else fail();};const options={userLanguage:'zh-cn',enableAutoCheck:false,type:'popup'};const captcha=config.region==='intl'?new TencentCaptcha(document.getElementById('challenge'),config.appId,callback,options):new TencentCaptcha(config.appId,callback,options);const button=document.getElementById('verify');button.hidden=false;button.onclick=()=>captcha.show();captcha.show();}catch{fail();}};
}else if(config.provider==='aliyun'){
 window.AliyunCaptchaConfig={region:config.region,prefix:config.prefix};sdk.src='https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
 sdk.onload=()=>{try{document.getElementById('verify').hidden=false;initAliyunCaptcha({SceneId:config.sceneId,prefix:config.prefix,mode:'popup',element:'#challenge',button:'#verify',captchaVerifyCallback:param=>{finish({turnstile_token:param});return{captchaResult:true,bizResult:true};},onBizResultCallback:()=>{},getInstance:()=>{},language:'cn',slideStyle:{width:300,height:40}});}catch{fail();}};
}else fail();
document.head.appendChild(sdk);
</script></html>`;
}

export function createDoneBotAuthChallenge({ BrowserWindow, session, fetchResource = (partition, request) => partition.fetch(request, { bypassCustomProtocolHandlers: true }) }) {
  let active = null;
  const close = () => active?.();
  const verify = async (config, owner) => {
    if (active) throw new Error("请先完成已打开的安全验证。");
    if (config.provider === "none") return {};
    const partition = session.fromPartition(`donebot-auth-${randomUUID()}`);
    const url = `${origin}/__donebot__/verify/${randomUUID()}`;
    await partition.protocol.handle("https", request => {
      if (request.url === url) return new Response(authChallengeHTML(config), { headers: {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline' https://challenges.cloudflare.com https://*.qcloud.com https://*.gtimg.com https://*.qq.com https://*.capassets.com https://*.alicdn.com; frame-src https://challenges.cloudflare.com https://*.qcloud.com https://*.qq.com https://*.capassets.com https://*.aliyuncs.com https://*.aliyun.com; connect-src https://challenges.cloudflare.com https://*.qcloud.com https://*.qq.com https://*.capassets.com https://*.aliyuncs.com https://*.aliyun.com; img-src data: blob: https:; style-src 'unsafe-inline' https:; font-src https:; base-uri 'none'; form-action 'none'",
      } });
      return allowedResource(request.url) ? fetchResource(partition, request) : new Response("Blocked", { status: 403 });
    });
    const window = new BrowserWindow({ title: "DoneBot 安全验证", width: 460, height: 520, parent: owner, modal: true, autoHideMenuBar: true,
      webPreferences: { session: partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
    partition.setPermissionCheckHandler(() => false);
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.on("will-download", event => event.preventDefault());
    partition.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== url && !allowedResource(details.url) }));
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", event => event.preventDefault());
    window.webContents.on("will-redirect", event => event.preventDefault());
    return new Promise(resolve => {
      let settled = false, polling = false;
      const finish = proof => {
        if (settled) return;
        settled = true; active = null; clearInterval(timer); clearTimeout(timeout);
        owner?.removeListener("closed", cancel);
        if (!window.isDestroyed()) window.close();
        partition.protocol.unhandle("https");
        void partition.clearStorageData().catch(() => {});
        void partition.clearCache().catch(() => {});
        resolve(proof);
      };
      const cancel = () => finish(null);
      active = cancel;
      const timer = setInterval(async () => {
        if (polling || window.isDestroyed()) return;
        polling = true;
        try {
          const result = await window.webContents.executeJavaScript("({ proof: window.__donebotAuthResult ?? null, failed: window.__donebotAuthError === true })");
          if (result?.proof) finish(authChallengeProof(config, result.proof));
          else if (result?.failed) finish(null);
        } catch { finish(null); }
        finally { polling = false; }
      }, 250);
      const timeout = setTimeout(cancel, 120_000);
      owner?.once("closed", cancel);
      window.once("closed", cancel);
      void window.loadURL(url).catch(cancel);
    });
  };
  return { verify, close };
}

export function installDoneBotAuth({ ipcMain, app, BrowserWindow, session, localOnly, requireMainWindowSender, fetch: fetcher = globalThis.fetch }) {
  const challenge = createDoneBotAuthChallenge({ BrowserWindow, session });
  let pending = false;
  ipcMain.handle("donebot-auth:verify", localOnly("donebot-auth:verify", async event => {
    requireMainWindowSender(event);
    if (pending) return { ok: false, error: "请先完成已打开的安全验证。" };
    pending = true;
    try {
      const response = await fetcher(`${origin}/api/v1/settings/public`, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error("无法读取安全验证配置，请稍后重试。");
      const raw = await response.json();
      const config = authChallengeConfiguration(raw?.code === 0 && raw.data ? raw.data : raw);
      requireMainWindowSender(event);
      const proof = await challenge.verify(config, BrowserWindow.fromWebContents(event.sender));
      return { ok: true, proof };
    } catch { return { ok: false, error: "安全验证暂不可用，请重试或联系管理员。" }; }
    finally { pending = false; }
  }));
  app.once("before-quit", challenge.close);
  return challenge;
}
