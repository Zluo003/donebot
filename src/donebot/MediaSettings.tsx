import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { DoneBotMediaSettings, DoneBotMediaPreferences } from "../../shared/donebot";
import { api } from "@/state/api";
import { Card } from "@/components/SettingsPrimitives";
import { Select } from "@/components/Select";

export function DoneBotMediaSettingsPanel() {
  const [settings, setSettings] = useState<DoneBotMediaSettings | null>(null);
  const [draft, setDraft] = useState<DoneBotMediaPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const epoch = useRef(0);
  const load = async () => {
    const generation = ++epoch.current;
    setBusy(true); setError(""); setSaved(false);
    try {
      const result = await api<DoneBotMediaSettings>("/api/donebot/media-settings");
      if (generation === epoch.current) { setSettings(result); setDraft(result.preferences); }
    } catch (error) { if (generation === epoch.current) setError(error instanceof Error ? error.message : "媒体模型加载失败，请重试。"); }
    finally { if (generation === epoch.current) setBusy(false); }
  };
  useEffect(() => { void load(); return () => { epoch.current++; }; }, []);
  const save = async () => {
    if (!settings || !draft) return;
    const generation = ++epoch.current;
    setBusy(true); setError(""); setSaved(false);
    try {
      const result = await api<DoneBotMediaSettings>("/api/donebot/media-settings", { method: "PUT", body: JSON.stringify({ accountId: settings.accountId, preferences: draft }) });
      if (generation === epoch.current) { setSettings(result); setDraft(result.preferences); setSaved(true); }
    } catch (error) { if (generation === epoch.current) setError(error instanceof Error ? error.message : "媒体模型保存失败，请重试。"); }
    finally { if (generation === epoch.current) setBusy(false); }
  };
  const change = (kind: "image" | "video", key: "primary" | "fallback", value: string) => {
    setSaved(false);
    setDraft(current => current ? { ...current, [kind]: { ...current[kind], [key]: value,
      ...(key === "primary" && current[kind].fallback === value ? { fallback: "" } : {}) } } : current);
  };
  return <Card title="默认媒体模型" subtitle="选择当前工作区生成图片和视频的首选及备用模型。">
    <div className="flex flex-col gap-5" data-donebot-media-settings>
      {(["image", "video"] as const).map(kind => <fieldset key={kind} disabled={busy || !draft} className="min-w-0">
        <legend className="mb-2 text-[14px] font-medium text-ink">{kind === "image" ? "图片" : "视频"}</legend>
        <div className="grid gap-3 sm:grid-cols-2">{(["primary", "fallback"] as const).map(key => {
          const label = `${kind === "image" ? "图片" : "视频"}${key === "primary" ? "首选模型" : "备用模型"}`;
          const value = draft?.[kind][key] ?? "";
          const choices = settings?.models.filter(model => model.kind === kind && (key === "primary" || model.id !== draft?.[kind].primary)) ?? [];
          return <label key={key} className="flex min-w-0 flex-col gap-1 text-[13px] text-ink-secondary">{key === "primary" ? "首选模型" : "备用模型"}
            <Select aria-label={label} value={value} onChange={event => change(kind, key, event.target.value)} className="w-full">
              <option value="">{key === "primary" ? "自动选择已启用模型" : "不使用备用模型"}</option>
              {value && !choices.some(model => model.id === value) && <option value={value} disabled>{value}（当前不可用）</option>}
              {choices.map(model => <option value={model.id} key={model.id}>{model.name}</option>)}
            </Select>
          </label>;
        })}</div>
      </fieldset>)}
      <p className="text-[13px] text-ink-secondary">只显示当前账号已启用且客户端支持的模型。首选明确失败后，Bot 会说明原因和备用模型：图片直接继续，视频确认后继续；已授权免确认时直接继续。备用最多一次，结果未确认或仍在处理时继续等待原任务。</p>
      <p className="text-[13px] text-ink-secondary">已记忆的第三方 CLI／MCP 渠道优先于这里的模型，例如“以后优先使用即梦 CLI 生成图片”。之后依次使用首选、备用；每次实际生成按所用渠道计费。</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="ui-button" disabled={busy || !draft} onClick={() => void save()}>{busy ? "同步中…" : "保存媒体设置"}</button>
        <button type="button" className="ui-button inline-flex items-center gap-2" disabled={busy} onClick={() => void load()}><RefreshCw size={14} />刷新可用模型</button>
      </div>
      {saved && <p role="status" className="text-[13px] text-ink-secondary">媒体设置已保存。</p>}
      {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    </div>
  </Card>;
}
