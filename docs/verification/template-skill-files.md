# 模板附带技能脚本

只操作临时 home/data、合成 Bot 和假引擎，不使用真实账号或网关。

```sh
pnpm exec vitest run shared/skill-files.test.ts server/skill-side-files.test.ts server/presets.test.ts server/template-skill-files.e2e.test.ts
DONEBOT_UI_E2E=1 pnpm exec vitest run scripts/testing/template-skill-ui.e2e.test.ts --silent=false
```

HTTP 工作流通过 `launchVerificationServer` 和 `runControlOmb` 验证：危险路径、凭据和目录冲突在创建 Bot 前拒绝；导入技能关闭；v2 JSON 和 v1 Markdown 分享及复制保留脚本字节；未登记文件不导出；修改后拒绝启用和显式导出，批量预览报告跳过；向复制 Bot 发送真实回合不会装载未启用脚本。文件预设测试验证 New bot 预设安装脚本后同样关闭。

界面工作流使用 `control-omb ui launch --entry templates`，挂载真实 TeamLibraryPanel 和 ShareTeamDialog；仅模板目录 API 由本地空目录代替，导入导出仍调用真实隔离服务。读取文件、预览三个附带文件、键盘展开脚本、显示危险指令提醒、确认添加、再分享并比较保存内容。HTML 内容作为文字显示，不执行；预览前后 Bot 列表相同。截图和 JSON 回执写到服务日志旁的 `server-*-template-skill.{png,json}`。中英文文案另由组件测试验证。

每技能最多 30 个附带文件，每文件 128 KiB、合计 512 KiB，只接受 UTF-8 文本。隐藏文件、生成目录、凭据文件、二进制、大小写/Unicode/文件夹前缀冲突拒绝进入安装包。导出只读取原清单和摘要验证通过的文件；代码参加危险指令扫描，但不使用会改写代码的普通文本脱敏。应用内置技能和引擎原生/项目技能不打包。

此切片接入既有 JSON/Markdown 文件模板通道；原模板菜单仍按 DoneBot 配置关闭。原组织带签章安装通道不能携带脚本，明确拒绝而非遗漏；未接入 enterprise；后续文件夹及私有 GitHub 读取见 [文件夹与私有 GitHub 模板](template-folders.md)。真实 Windows、物理手机和 Cloud 团队共享库仍待后续批次验收。
