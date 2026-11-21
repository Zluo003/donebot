# 文件夹与私有 GitHub 模板

只运行临时 home/data、假引擎及 loopback connected-apps/GitHub 服务。没有读取真实 GitHub 仓库、使用真实账号或写入外部仓库。

```sh
pnpm exec vitest run shared/share-folder.test.ts shared/package-format.test.ts shared/skill-files.test.ts server/share-github.test.ts server/team-library.test.ts server/team-manifest.test.ts server/package-export.test.ts server/package-import.test.ts server/skill-side-files.test.ts server/routes/templates.test.ts server/host/share-github-access.test.ts src/lib/template-folder.test.ts src/lib/team-share.test.ts server/template-folders.e2e.test.ts server/template-skill-files.e2e.test.ts
DONEBOT_UI_E2E=1 pnpm exec vitest run scripts/testing/template-folders-ui.e2e.test.ts scripts/testing/template-skill-ui.e2e.test.ts
```

固定上游 `844b91ecb4e070c147642fb7ffe47764212c2781` 的 `bot.md`/`team.md` 文件夹契约适配当前 package v2。旧 JSON/Markdown 通道继续可用；模板不能授予工具权限。浏览器只打开清单列出的脚本、参考文件与头像；隐藏、越界和未登记文件不会进入安装。UTF-8 文本严格解码，CRLF 和 Unicode 内容保持原样；脚本仍须原安装校验并保持关闭，例程暂停。

`/api/templates/folder` 和 `/api/templates/github` 只生成预览，通过 `/api/teams/import` 明确添加后才创建 Bot。私有仓库必须显式开启连接通道，多账号时不自动挑选；账号从完整 inventory 验证，调用前检查账号、连接身份、工作区规则和会话，读取完成后再检查授权。不向模型或 renderer 暴露 GitHub token。公共读取只请求 raw.githubusercontent.com，不携带连接凭据或跟随重定向，并在流读取时限制字节。

`template-folders.e2e` 启动完整 DoneBot fixture、真实 broker Worker 和假 GitHub toolkit，覆盖另一用户账号拒绝、多账号选择、只读清单、安装前无 Bot 变化、安装后脚本关闭及磁盘字节、缺文件拒绝、撤权后无更多 GitHub 内容请求。没有启动模型回合。route 测试覆盖 Member/service loopback 拒绝和异步撤权后不释放账号名称；host 测试覆盖等待期间规则、项目用户、broker 身份、账号和请求会话变化。

真实 Chromium 挂载 TeamLibraryPanel，检查账号默认未选、未选择时 Load 禁用、另一个用户账号不可见、选择后启用，以及文件夹预览、确认安装和技能关闭。浏览器文件选择使用合成 FileList 与原 change 事件，账号选择使用原生 select value/change；没有证明系统文件夹选择器或原生下拉菜单的键盘提交。原脚本模板 UI 回归另行通过。截图在 `output/playwright/template-folders/`，完整服务回执写入 fixture 日志旁的 `.templates.json` 和 `.template-folders-ui.json`，fixture 自动清理。

当前限制：模板正式菜单仍关闭；尚未接入仓库发布、团队共享库或团队受限连接代理。共享/团队工作区的私有 GitHub 模板连接明确拒绝。未验证真实 Composio/GitHub 账号、Windows、物理手机或团队 Cloud；供应商返回格式不符时拒绝读取，不伪装为空模板。starter notes 仍只在现有导出流程明确勾选后携带。
