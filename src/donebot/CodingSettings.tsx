import { useState } from "react";
import { DONEBOT_CODING, subscriptionCodingId, existingCodingId } from "../../shared/donebot-coding";
import { api } from "@/state/api";
import { useStore, type InstanceInfo } from "@/state/store";
import { Card } from "@/components/SettingsPrimitives";
import { EngineSetup, InstanceAccountNotes, needsCli, needsSignIn } from "@/components/EngineSetup";

function CodingMode({ instance, mode }: { instance: InstanceInfo; mode: number }) {
  const subscription = mode === 1, existing = mode === 2;
  const { dispatch } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const signOut = async () => {
    setBusy(true); setError("");
    try {
      const result = await api<{ instances: InstanceInfo[] }>(`/api/instances/${instance.instanceId}/auth/sign-out`, { method: "POST", body: "{}" });
      dispatch({ type: "instances", instances: result.instances });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const setup = needsCli(instance) || needsSignIn(instance);
  return <section className="min-w-0 rounded-xl border border-hairline p-3" aria-label={instance.displayName}>
    <h4 className="text-[13px] font-semibold text-ink">{existing ? "维持不变" : subscription ? "自有订阅" : "DoneBot 网关"}</h4>
    <p className="mt-1 text-[12px] text-ink-secondary">{existing ? "沿用已有 CLI 的模型、登录和服务配置，包括配置文件或 CC Switch 的设置。DoneBot 不改写这些配置。" : subscription ? "使用你在此执行器中登录的订阅账号，不扣 DoneBot 模型余额。" : "使用 DoneBot 账号已启用的兼容模型，按网关用量计费。"}</p>
    {existing ? <p role="status" className="mt-3 text-[12px] text-ink-secondary">{instance.snapshot.state === "available" ? "CLI 已找到 · 使用现有配置，连接状态以实际任务为准" : "请先在当前执行电脑或服务器上安装并配置 CLI，然后刷新状态。"}</p> : setup ? <EngineSetup instance={instance} className="mt-3" unframed /> : <>
      <p role="status" className="mt-3 text-[12px] text-success">已就绪 · {instance.models.options.length} 个模型</p>
      <InstanceAccountNotes instance={instance} listsModels />
      {subscription && instance.authentication && <button type="button" className="ui-button mt-3" disabled={busy} onClick={() => void signOut()}>退出执行器账号</button>}
      {!subscription && !instance.models.options.length && <p className="mt-2 text-[12px] text-ink-secondary">当前账号尚无该执行器兼容的模型。</p>}
    </>}
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
  </section>;
}

export function DoneBotCodingSettings() {
  const { state, refreshInstances } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => {
    setBusy(true); setError("");
    try { await refreshInstances({ reportErrors: true }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <Card title="编程执行器" subtitle="Codex 与 Claude Code 可分别选择 DoneBot 网关、自有订阅或维持不变。">
    <p className="text-[13px] text-ink-secondary">在对话顶部的模型菜单中随时选择执行器和计费方式，仅影响该对话；正在运行时先停止任务。切换保留对话记录，不会重新执行已完成的操作。</p>
    <p className="mt-2 text-[13px] text-ink-secondary">执行器运行在当前工作空间所在的电脑或服务器。可在 Bot 的资料库中选择工作目录，包括已有的外部项目文件夹；可让 Bot 在该目录创建新项目。“维持不变”使用该执行电脑或服务器上的 CLI 配置；本机配置不会自动同步到 Cloud。自有订阅模式的登录与个人 CLI 配置分别保存。Cloud 暂不支持 Codex 订阅登录。</p>
    <button type="button" className="ui-button mt-3" disabled={busy} onClick={() => void refresh()}>刷新执行器状态</button>
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    <div className="mt-4 space-y-4">{Object.entries(DONEBOT_CODING).map(([engine, entry]) => <div key={engine}>
      <h3 className="mb-2 text-[14px] font-semibold text-ink">{engine === "codex" ? "Codex" : "Claude Code"}</h3>
      <div className="grid gap-3 sm:grid-cols-2">{[entry.instanceId, subscriptionCodingId(engine as keyof typeof DONEBOT_CODING), existingCodingId(engine as keyof typeof DONEBOT_CODING)].map((id, position) => {
        const instance = state.instances.find(instance => instance.instanceId === id);
        return instance ? <CodingMode key={id} instance={instance} mode={position} /> : <p key={id} className="text-[12px] text-ink-secondary">执行器状态尚未加载，请刷新。</p>;
      })}</div>
    </div>)}</div>
  </Card>;
}
