import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  DEFAULT_DONEBOT_BROWSER_PROXY,
  type DoneBotBrowserProxyConfig,
  type DoneBotBrowserProxyMode,
  type DoneBotBrowserProxyState,
} from "../../shared/donebot";
import { Select } from "@/components/Select";
import { Card, SettingRow } from "@/components/SettingsPrimitives";
import { api } from "@/state/api";

function isValidManualProxyUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    const proto = parsed.protocol.toLowerCase();
    if (!["socks5:", "socks5h:", "socks:", "http:"].includes(proto)) return false;
    if (!parsed.hostname) return false;
    if (parsed.port) {
      const port = Number(parsed.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;
    }
    return !parsed.pathname || parsed.pathname === "/";
  } catch {
    return false;
  }
}

export function BrowserProxySettings({ simple = false }: { simple?: boolean }) {
  const [saved, setSaved] = useState<DoneBotBrowserProxyState | null>(null);
  const [available, setAvailable] = useState(true);
  const [modeDraft, setModeDraft] = useState<DoneBotBrowserProxyMode>(DEFAULT_DONEBOT_BROWSER_PROXY.mode);
  const [urlDraft, setUrlDraft] = useState("");
  const [bypassDraft, setBypassDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "saved" | "error"; text: string } | null>(null);
  const epoch = useRef(0);

  const load = useCallback(async (showSpinner = false) => {
    const generation = ++epoch.current;
    if (showSpinner) setDetecting(true);
    try {
      const result = await api<DoneBotBrowserProxyState>("/api/donebot/browser-proxy");
      if (generation !== epoch.current) return;
      setSaved(result);
      setModeDraft(result.mode);
      setUrlDraft(result.url);
      setBypassDraft(result.bypass);
    } catch {
      if (generation === epoch.current && !showSpinner) setAvailable(false);
    } finally {
      if (generation === epoch.current && showSpinner) setDetecting(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    return () => { epoch.current += 1; };
  }, [load]);

  if (!available || !saved) return null;

  const commit = async (next: DoneBotBrowserProxyConfig, successText?: string) => {
    const generation = ++epoch.current;
    setBusy(true);
    setFeedback(null);
    try {
      const updated = await api<DoneBotBrowserProxyState>("/api/donebot/browser-proxy", {
        method: "PUT",
        body: JSON.stringify(next),
      });
      if (generation !== epoch.current) return;
      setSaved(updated);
      setModeDraft(updated.mode);
      setUrlDraft(updated.url);
      setBypassDraft(updated.bypass);
      setFeedback({
        kind: "saved",
        text: successText ?? "已保存浏览器代理设置，后续网页访问立即生效。",
      });
    } catch (error) {
      if (generation === epoch.current) {
        setFeedback({
          kind: "error",
          text: error instanceof Error ? error.message : "保存浏览器代理设置失败，请重试。",
        });
      }
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  };

  const handleModeChange = (nextMode: DoneBotBrowserProxyMode) => {
    setModeDraft(nextMode);
    setFeedback(null);
    if (nextMode === "system") {
      void commit({ mode: "system", url: urlDraft.trim(), bypass: bypassDraft.trim() }, "已切换为跟随系统代理，开关 VPN 即时生效。");
    } else if (nextMode === "direct") {
      void commit({ mode: "direct", url: urlDraft.trim(), bypass: bypassDraft.trim() }, "已切换为直连模式（Bot 浏览器不使用代理）。");
    }
  };

  const handleSaveManual = () => {
    const trimmedUrl = urlDraft.trim();
    if (!trimmedUrl) {
      setFeedback({ kind: "error", text: "请填写代理地址（如 socks5://127.0.0.1:10808 或 http://127.0.0.1:10809）。" });
      return;
    }
    if (!isValidManualProxyUrl(trimmedUrl)) {
      setFeedback({ kind: "error", text: "代理地址格式无效，仅支持 socks5:// 或 http://（例如 socks5://127.0.0.1:10808）。" });
      return;
    }
    void commit(
      { mode: "manual", url: trimmedUrl, bypass: bypassDraft.trim() },
      `已保存手动代理（${trimmedUrl}），后续网页访问立即生效。`,
    );
  };

  const manualDirty = modeDraft === "manual"
    && (saved.mode !== "manual" || urlDraft.trim() !== saved.url || bypassDraft.trim() !== saved.bypass);

  const defaultSubtitle = modeDraft === "system"
    ? saved.detectedSystemProxy
      ? `已检测到系统代理：${saved.detectedSystemProxy}。自动适配 v2rayN / Clash / PAC，开关 VPN 即时生效，无需重启浏览器。`
      : "当前未检测到系统代理。开启 v2rayN / Clash 等系统代理后自动生效，也可切换为「手动指定代理」直填端口。"
    : modeDraft === "manual"
      ? "手动指定 Bot 内置浏览器的上游 VPN/代理端口（如 v2rayN 的 SOCKS5 或 HTTP 端口），无需修改系统全局代理。"
      : "Bot 内置浏览器直接访问公网，忽略系统代理与环境变量。";

  const content = (
    <div className="space-y-3">
      <SettingRow
        title="Bot 浏览器代理"
        subtitle={
          feedback ? (
            <span className={feedback.kind === "error" ? "text-danger" : "text-ink-secondary"}>
              {feedback.text}
            </span>
          ) : (
            defaultSubtitle
          )
        }
      >
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Select
            aria-label="Bot 浏览器代理模式"
            size="sm"
            value={modeDraft}
            disabled={busy}
            onChange={(event) => handleModeChange(event.target.value as DoneBotBrowserProxyMode)}
          >
            <option value="system">跟随系统代理（推荐）</option>
            <option value="manual">手动指定代理</option>
            <option value="direct">直连（不使用代理）</option>
          </Select>
          {modeDraft === "system" && (
            <button
              type="button"
              disabled={busy || detecting}
              onClick={() => void load(true)}
              aria-label="重新检测系统代理"
              title="重新检测系统代理"
              className="ui-button inline-flex shrink-0 items-center gap-1 disabled:opacity-45"
            >
              <RefreshCw size={12.5} className={detecting ? "animate-spin" : ""} aria-hidden="true" />
              检测
            </button>
          )}
        </div>
      </SettingRow>

      {modeDraft === "manual" && (
        <div className="flex flex-wrap items-end justify-end gap-2 pb-1">
          <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-[12px] text-ink-secondary">
            <span>代理地址（支持 socks5:// 或 http://）</span>
            <input
              type="text"
              aria-label="代理地址"
              value={urlDraft}
              disabled={busy}
              placeholder="socks5://127.0.0.1:10808"
              onChange={(event) => {
                setUrlDraft(event.target.value);
                if (feedback) setFeedback(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (!busy) handleSaveManual();
                }
              }}
              className="h-8 w-full rounded-full border border-hairline bg-app px-3 text-[13px] text-ink placeholder:text-ink-tertiary focus:border-ink/40 focus:outline-none"
            />
          </label>
          <label className="flex min-w-[180px] flex-1 flex-col gap-1 text-[12px] text-ink-secondary">
            <span>免代理域名（可选，逗号分隔）</span>
            <input
              type="text"
              aria-label="免代理域名"
              value={bypassDraft}
              disabled={busy}
              placeholder="localhost, *.cn"
              onChange={(event) => {
                setBypassDraft(event.target.value);
                if (feedback) setFeedback(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (!busy) handleSaveManual();
                }
              }}
              className="h-8 w-full rounded-full border border-hairline bg-app px-3 text-[13px] text-ink placeholder:text-ink-tertiary focus:border-ink/40 focus:outline-none"
            />
          </label>
          <button
            type="button"
            disabled={busy || !manualDirty}
            onClick={handleSaveManual}
            className="ui-button ui-button-primary shrink-0 disabled:opacity-40"
          >
            保存
          </button>
        </div>
      )}
    </div>
  );

  if (simple) return content;
  return (
    <Card title="Bot 浏览器网络代理" subtitle="让 Bot 内置浏览器复用本机 v2rayN / Clash 等 VPN 代理端口访问外网，无需重启浏览器。">
      {content}
    </Card>
  );
}
