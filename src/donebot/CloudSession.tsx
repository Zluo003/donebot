import { DONEBOT_CLOUD_URL } from "./services";

export function DoneBotCloudSessionEnded() {
  return <main className="flex min-h-screen items-center justify-center bg-app p-6 text-ink">
    <section className="max-w-md rounded-2xl border border-hairline bg-surface p-8 text-center">
      <h1 className="text-xl font-semibold">Cloud 网页会话已结束</h1>
      <p className="mt-3 text-sm text-ink-secondary">请返回控制台检查实例状态，并重新打开云实例。</p>
      <a className="ui-button mt-6 inline-flex" href={DONEBOT_CLOUD_URL}>返回 Cloud 控制台</a>
    </section>
  </main>;
}
