import { ArrowLeft, ArrowRight, CheckCircle2, Eye, EyeOff, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { DoneBotAccountState } from "../../shared/donebot";
import type { DoneBotAuthProof, DoneBotAuthSettings, DoneBotEmailDelivery } from "../../shared/donebot-auth";
import brandMark from "../../branding/donebot/donebot-mark-black.svg";
import { api } from "@/state/api";
import { useStore, type ConfigStatus } from "@/state/store";
import "./auth.css";

type AuthView = "login" | "register" | "forgot";
const post = <T,>(path: string, body: object) => api<T>(`/api/donebot/${path}`, { method: "POST", body: JSON.stringify(body) });
const errorText = (error: unknown) => error instanceof Error ? error.message : "暂时无法完成，请检查网络后重试。";
const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

function PasswordField({ label, value, onChange, current = false }: { label: string; value: string; onChange(value: string): void; current?: boolean }) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return <label className="db-auth-field" htmlFor={id}>{label}<span className="db-auth-password">
    <input id={id} aria-label={label} required type={visible ? "text" : "password"} autoComplete={current ? "current-password" : "new-password"} minLength={current ? 1 : 6} maxLength={1000} value={value} onChange={event => onChange(event.target.value)} />
    <button type="button" className="db-auth-icon" aria-label={`${visible ? "隐藏" : "显示"}${label}`} title={`${visible ? "隐藏" : "显示"}${label}`} aria-pressed={visible} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button>
  </span></label>;
}

export function DoneBotSignIn() {
  const { state, dispatch } = useStore();
  const [view, setView] = useState<AuthView>("login");
  const [settings, setSettings] = useState<DoneBotAuthSettings | null>(null);
  const [settingsError, setSettingsError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [verification, setVerification] = useState("");
  const [invitation, setInvitation] = useState("");
  const [promo, setPromo] = useState("");
  const [totp, setTotp] = useState("");
  const [pending2fa, setPending2fa] = useState(state.config?.donebot?.requires2fa === true);
  const [busy, setBusy] = useState<"submit" | "code" | "cancel" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deadlines, setDeadlines] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now());
  const [agreed, setAgreed] = useState(false);
  const alive = useRef(true);
  const flight = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const cleanEmail = email.trim();
  const deliveryKey = `${view}:${cleanEmail.toLowerCase()}`;
  const deadline = deadlines[deliveryKey] ?? 0;
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  const sent = deadlines[deliveryKey] !== undefined;
  const captchaRequired = settings?.turnstile_enabled || settings?.tencent_captcha_enabled || settings?.aliyun_captcha_enabled;
  const documents = settings?.login_agreement_documents ?? [];
  const agreementRequired = settings?.login_agreement_enabled === true && documents.length > 0;
  const registerEnabled = settings?.registration_enabled === true;
  const recoveryEnabled = settings?.password_reset_enabled === true && settings?.email_verify_enabled === true;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setSettings(null); setSettingsError(false);
    void api<DoneBotAuthSettings>("/api/donebot/settings", { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setSettings(value);
    }).catch(() => { if (!controller.signal.aborted) setSettingsError(true); });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    setNow(Date.now());
    if (deadline <= Date.now()) return;
    const timer = window.setInterval(() => { const time = Date.now(); setNow(time); if (time >= deadline) window.clearInterval(timer); }, 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  useEffect(() => { heading.current?.focus(); }, [view, pending2fa]);

  const clearSecrets = () => { setPassword(""); setConfirmation(""); setTotp(""); setVerification(""); setInvitation(""); setPromo(""); };
  const changeView = (next: AuthView) => {
    if (flight.current) return;
    clearSecrets(); setView(next); setError(""); setNotice("");
  };
  const run = async (kind: NonNullable<typeof busy>, action: () => Promise<void>) => {
    if (flight.current) return;
    flight.current = true; setBusy(kind); setError(""); setNotice("");
    try { await action(); }
    catch (error) { if (alive.current) setError(errorText(error)); }
    finally { flight.current = false; if (alive.current) setBusy(null); }
  };
  const challenge = async (): Promise<DoneBotAuthProof> => {
    if (!captchaRequired) return {};
    if (!window.ogb?.donebotAuth) throw new Error("当前环境无法打开安全验证，请使用新版 DoneBot 桌面客户端。");
    const result = await window.ogb.donebotAuth.verify();
    if (!result.ok) throw new Error(result.error);
    if (!result.proof) throw new Error("安全验证已取消，请重试。");
    return result.proof;
  };
  const accept = async (account: DoneBotAccountState) => {
    if (!alive.current) return;
    setPending2fa(account.requires2fa === true);
    if (account.authenticated) {
      const config = await api<ConfigStatus>("/api/config");
      if (alive.current) dispatch({ type: "configStatus", config });
    }
  };
  const sendCode = () => void run("code", async () => {
    if (!settings || seconds > 0) return;
    if (!validEmail(cleanEmail)) throw new Error("请填写有效的邮箱地址。");
    if (view === "forgot" ? !recoveryEnabled : !registerEnabled) throw new Error("当前服务未开放此操作。");
    const proof = await challenge();
    if (!alive.current) return;
    const result = await post<DoneBotEmailDelivery>(view === "forgot" ? "forgot-password" : "verification", { email: cleanEmail, ...proof });
    if (!alive.current) return;
    const cooldown = Number.isSafeInteger(result.countdown) && result.countdown! >= 0 && result.countdown! <= 3600 ? result.countdown! : 60;
    setNow(Date.now()); setDeadlines(current => ({ ...current, [deliveryKey]: Date.now() + cooldown * 1000 }));
    setNotice(view === "forgot" ? "若该邮箱已注册，你将收到找回密码验证码。验证码 15 分钟内有效。" : "验证码已发送，请查看邮箱。");
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!pending2fa && view === "forgot" && !sent) { sendCode(); return; }
    void run("submit", async () => {
      if (!settings) return;
      if (pending2fa) {
        if (!/^\d{6}$/.test(totp.trim())) throw new Error("请输入六位动态验证码。");
        try { await accept(await post<DoneBotAccountState>("2fa", { totp_code: totp.trim() })); }
        finally { if (alive.current) setTotp(""); }
        return;
      }
      if (!validEmail(cleanEmail)) throw new Error("请填写有效的邮箱地址。");
      if (view !== "login" && password !== confirmation) throw new Error("两次输入的密码不一致。");
      if (view !== "login" && password.length < 6) throw new Error("密码至少需要六位。");
      if (view === "forgot") {
        if (!recoveryEnabled || !sent) throw new Error("请先获取邮箱验证码。");
        if (!/^\d{6}$/.test(verification.trim())) throw new Error("请输入六位邮箱验证码。");
        await post("reset-password", { email: cleanEmail, email_code: verification.trim(), new_password: password });
        if (alive.current) { clearSecrets(); setView("login"); setNotice("密码已更新，请使用新密码登录。"); }
        return;
      }
      if (agreementRequired && !agreed) throw new Error("请阅读并同意账号使用协议。");
      if (view === "register") {
        if (!registerEnabled) throw new Error("当前未开放注册。");
        if (settings.email_verify_enabled && !/^\d{6}$/.test(verification.trim())) throw new Error("请输入六位邮箱验证码。");
      }
      const proof = await challenge();
      if (!alive.current) return;
      try {
        await accept(await post<DoneBotAccountState>(view, { email: cleanEmail, password, ...proof,
          ...(view === "register" ? { verify_code: verification.trim(), invitation_code: invitation.trim(), ...(settings.promo_code_enabled ? { promo_code: promo.trim() } : {}) } : {}),
        }));
      } finally { if (alive.current) { setPassword(""); setConfirmation(""); } }
    });
  };
  const backToLogin = () => pending2fa ? void run("cancel", async () => {
    await post("cancel-login", {});
    if (alive.current) { clearSecrets(); setPending2fa(false); setView("login"); }
  }) : changeView("login");
  const title = pending2fa ? "验证身份" : view === "forgot" ? "找回密码" : view === "register" ? "创建账号" : "登录 DoneBot";

  return <section data-donebot-sign-in className="db-auth" aria-label="DoneBot 账号">
    <aside className="db-auth-brand">
      <div className="db-auth-wordmark"><img src="/app-icon-192.png" alt="" width="42" height="42" /><span>DoneBot</span></div>
      <div className="db-auth-intro"><img className="db-auth-mark" src={brandMark} alt="" width="160" height="134" /><h1>把事交出去。</h1><p>你定方向，多宝和团队推进工作。</p></div>
      <a className="db-auth-site" href="https://donebot.cn" target="_blank" rel="noreferrer">donebot.cn<ArrowRight size={13} aria-hidden /></a>
    </aside>
    <div className="db-auth-form-area"><div className="db-auth-form">
      {!settings ? <div className="db-auth-loading">{settingsError ? <><p role="alert">暂时无法读取账号设置，请检查网络后重试。</p><button className="db-auth-secondary" type="button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16} />重新加载</button></> : <p role="status"><Loader2 size={18} className="animate-spin" />正在连接 DoneBot…</p>}</div> : <>
        {!pending2fa && view !== "forgot" && <nav className="db-auth-tabs" aria-label="账号操作"><button type="button" aria-current={view === "login" ? "page" : undefined} disabled={Boolean(busy)} onClick={() => changeView("login")}>登录</button>{registerEnabled && <button type="button" aria-current={view === "register" ? "page" : undefined} disabled={Boolean(busy)} onClick={() => changeView("register")}>注册</button>}</nav>}
        {(pending2fa || view === "forgot") && <button type="button" className="db-auth-back" disabled={Boolean(busy)} onClick={backToLogin}><ArrowLeft size={16} />返回登录</button>}
        <h2 ref={heading} tabIndex={-1} className="db-auth-title">{title}</h2>
        <p className="db-auth-description">{pending2fa ? "输入身份验证器中的六位动态验证码。" : view === "forgot" ? sent ? "输入邮件中的验证码，并设置新密码。" : "使用注册邮箱获取验证码。" : view === "register" ? "创建账号，开始与你的 Bot 团队协作。" : "欢迎回来，继续与你的团队协作。"}</p>
        {view === "forgot" && !recoveryEnabled && <p role="status" className="db-auth-hint">当前服务未开放密码找回，请联系管理员。</p>}
        <form onSubmit={submit} className="db-auth-fields">
          <fieldset disabled={Boolean(busy)}>
            {pending2fa ? <label className="db-auth-field">动态验证码<input aria-label="动态验证码" autoFocus required autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" value={totp} onChange={event => setTotp(event.target.value)} maxLength={6} /></label> : <>
              <label className="db-auth-field">邮箱<input aria-label="邮箱" name="email" required autoComplete="username" type="email" placeholder="you@example.com" maxLength={320} value={email} onChange={event => { setEmail(event.target.value); setVerification(""); setNotice(""); }} /></label>
              {(view === "register" && settings.email_verify_enabled || view === "forgot" && sent) && <label className="db-auth-field">邮箱验证码<span className="db-auth-code"><input aria-label="邮箱验证码" required autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={verification} onChange={event => setVerification(event.target.value)} /><button type="button" className="db-auth-code-send" disabled={!cleanEmail || seconds > 0} onClick={sendCode}>{busy === "code" ? "发送中…" : seconds ? `${seconds} 秒后重发` : sent ? "重新发送" : "发送验证码"}</button></span></label>}
              {(view !== "forgot" || sent) && <PasswordField key={view} label={view === "forgot" ? "新密码" : "密码"} value={password} onChange={setPassword} current={view === "login"} />}
              {(view === "register" || view === "forgot" && sent) && <PasswordField label={view === "forgot" ? "确认新密码" : "确认密码"} value={confirmation} onChange={setConfirmation} />}
              {view === "register" && settings.invitation_code_enabled && <label className="db-auth-field">邀请码<input aria-label="邀请码" required maxLength={100} value={invitation} onChange={event => setInvitation(event.target.value)} autoComplete="off" /></label>}
              {view === "register" && settings.promo_code_enabled && <label className="db-auth-field">优惠码（可选）<input aria-label="优惠码" maxLength={100} value={promo} onChange={event => setPromo(event.target.value)} autoComplete="off" /></label>}
            </>}
          </fieldset>
          {!pending2fa && view === "register" && Boolean(settings.registration_email_suffix_whitelist?.length) && <p className="db-auth-hint">支持的邮箱：{settings.registration_email_suffix_whitelist!.join("、")}</p>}
          {!pending2fa && view !== "forgot" && agreementRequired && <div className="db-auth-agreement"><label><input type="checkbox" checked={agreed} onChange={event => setAgreed(event.target.checked)} disabled={Boolean(busy)} /><span>我已阅读并同意账号使用协议</span></label><details><summary>查看协议</summary>{documents.map(doc => <section key={doc.id}><h3>{doc.title}</h3><pre>{doc.content_md}</pre></section>)}</details></div>}
          {error && <p role="alert" className="db-auth-error">{error}</p>}
          {notice && <p role="status" className="db-auth-notice"><CheckCircle2 size={16} aria-hidden /><span>{notice}</span></p>}
          {!pending2fa && view === "forgot" && !sent ? <button type="submit" className="db-auth-primary" disabled={Boolean(busy) || !cleanEmail || !recoveryEnabled || seconds > 0}>{busy && <Loader2 size={17} className="animate-spin" />}{seconds ? `${seconds} 秒后重发` : "发送邮件验证码"}{!busy && <ArrowRight size={17} />}</button> : <button type="submit" className="db-auth-primary" disabled={Boolean(busy) || !pending2fa && view !== "forgot" && agreementRequired && !agreed}>{busy && <Loader2 size={17} className="animate-spin" />}{pending2fa ? "验证并登录" : view === "register" ? "创建账号" : view === "forgot" ? "保存新密码" : "登录"}{!busy && <ArrowRight size={17} />}</button>}
        </form>
        <div className="db-auth-actions">
          {!pending2fa && view === "login" && (
            <>
              <button type="button" disabled={Boolean(busy)} onClick={() => changeView("forgot")}>忘记密码？</button>
              {registerEnabled && <button type="button" disabled={Boolean(busy)} onClick={() => changeView("register")}>注册 DoneBot</button>}
            </>
          )}
          {!pending2fa && view === "register" && (
            <button type="button" disabled={Boolean(busy)} onClick={() => changeView("login")}>已有账号？返回登录</button>
          )}
        </div>
        {!pending2fa && view === "login" && !registerEnabled && <p className="db-auth-hint">当前未开放注册。</p>}
      </>}
    </div></div>
  </section>;
}
