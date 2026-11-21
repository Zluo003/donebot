# 团队模板库

固定来源为 OpenMausBot v0.1.173（799ebcd）的 `server/team-templates.ts`；保留团队目录、管理员发布、成员读取和一版 previous 的布局，适配现有 package v2/技能脚本及共享文件限额。存储和签名 HTTP 预览/发布/删除已接入，只有服务端显式设置 `DONEBOT_TEAM_TEMPLATES_ENABLED=1` 才创建路由。Cloud worker 未下发该开关，能力协商仍关闭；没有正式菜单或模板安装流程，不表示团队模板功能已开放。

## 存储与恢复

模板位于 `team-files/templates/<slug>/`，上一版为 `<slug>.previous/`；两者计入共享额度。元数据位于 `share/team-library.json`。发布只接受经过 file trust 解析和凭据扫描的包，内容通过既有文件夹读写器重新读取；脚本保存原字节，不执行。每次读取模板重新验证清单、必需文件、字节限制、路径及发布摘要；替换和移除使用版本摘要拒绝过期审核，不因来源为团队库而取得 org trust。

共享文件服务提供同步模板锁和总额检查；模板树中有进行中的上传时拒绝发布，其他目录上传预留的字节同样占额。单文件沿用团队套餐上限。替换仅回收更旧的 previous，当前版本继续保留；移除模板不立即删除最近一版。

发布先在私有 `share/team-template-<uuid>/` 保存新内容，再写入持久化事务记录，分别移动当前与旧 previous，保存索引后写入提交标记。提交前失败或进程退出恢复旧索引和两版目录；提交后只清理事务。回滚本身可以再次中断。无法恢复时阻断普通模板文件读写，不能把半成品当成已发布模板。服务重新创建时清理仅属于本模块的孤立目录与原子写临时文件。`share/` 事务资料需随数据完整保留，不能独立删除。

## 隔离存储与 HTTP 回归

```sh
pnpm exec vitest run server/team-templates.test.ts server/routes/team-templates.test.ts server/donebot-team-templates.e2e.test.ts server/host/team-files.test.ts server/host/team-files.concurrent.test.ts server/donebot/team-files.test.ts server/routes/team-files.test.ts server/donebot-team-files.e2e.test.ts server/request-auth.test.ts shared/share-folder.test.ts server/workspace-backup-policy.test.ts
pnpm exec tsc -p tsconfig.server.json
pnpm exec oxlint --deny-warnings server/team-templates.ts server/team-templates.test.ts server/routes/team-templates.ts server/routes/team-templates.test.ts server/donebot-team-templates.e2e.test.ts server/host/team-files.ts shared/team-templates.ts server/donebot/team-files.ts server/request-auth.ts server/index.ts scripts/control-omb.ts
```

只使用一次性数据目录及合成包。测试覆盖管理员/成员、非法 slug/包/作用域、技能脚本字节、当前及上一版计额、单文件限制、上传预留与大小写别名冲突、读取时文件损坏、链接、索引损坏、撤权回滚与磁盘写入失败。子进程在发布、移除和恢复的每个 fsync、rename、清理检查点实际退出；重建服务后验证索引与目录一致、原版本与上一版保留、无孤立事务且其他共享文件字节不变。

2026-11-21：存储切片 7 文件 / 87 项通过，日志 `/tmp/donebot-team-templates-regression.log`；服务端类型和定向 lint 分别为 `/tmp/donebot-team-templates-types.log`、`/tmp/donebot-team-templates-lint.log`。子进程在真实退出后恢复，不等于断电持久性。

2026-11-22：存储、签名 HTTP 路由、真实签名运行时、相邻文件接口及鉴权共 11 文件 / 164 项通过，日志 `/tmp/donebot-team-template-routes-regression.log`；类型与定向 lint 为 `/tmp/donebot-team-template-routes-types.log`、`/tmp/donebot-team-template-routes-lint.log`。合成用户覆盖 Owner/Admin/Member、外部团队和无效签名；成员可读取精确模板字节，只有管理员可发布/删除，提交必须带显式确认和已审核修订号。重复内容不改写 previous；旧修订、身份变化、角色降级、撤权和关闭实例均拒绝，读取不创建或执行 Bot。实际 Go TeamProxy + 一次性 PostgreSQL + 隔离 Node 运行时的撤权/未完成发布测试通过 race，日志 `/tmp/donebot-team-templates-proxy.log`；实际证据由测试输出记录。

客户端在“模板”中增加团队模板页，仅当 `/api/config` 协商 `team.sharedTemplates: true` 时显示并请求接口。成员可预览并通过 `mode=add` 安装；管理员可从分享审核结果发布、按当前 revision 更新及经二次确认移除。Bot 类型发布必须恰含一个 Bot；模板来源按 file trust 处理，技能仍关闭、例行任务仍暂停。模板移除不删除成员已经安装的副本。

UI 与协议回归：

```sh
pnpm exec vitest run src/components/TeamTemplatesTab.test.ts src/components/ShareTeamDialog.team-template.test.ts src/components/TeamLibraryPanel.test.ts src/components/ShareTeamDialog.test.ts server/team-templates.test.ts server/routes/team-templates.test.ts server/donebot-team-templates.e2e.test.ts
pnpm typecheck
pnpm exec oxlint --deny-warnings src/components/TeamTemplatesTab.tsx src/components/TeamTemplatesTab.test.ts src/components/TeamLibraryPanel.tsx src/components/TeamLibraryPanel.test.ts src/components/ShareTeamDialog.tsx src/components/ShareTeamDialog.team-template.test.ts server/team-templates.ts server/team-templates.test.ts
pnpm i18n:check
```

组件测试检查协商入口、成员只读及预览、管理员发布目标、显式删除确认、revision 绑定，以及发布冲突后不重试。它们不替代实际 Cloud worker 的端到端验证。浏览器、实际 Cloud worker、真实 Linux 恶意进程、断电持久性、完整备份恢复和 Windows 验收仍缺失。团队及模板能力继续默认关闭；Cloud worker 未启用 `DONEBOT_TEAM_TEMPLATES_ENABLED`。

2026-11-22：客户端及服务端模板 UI/API 回归 7 文件 / 36 项通过；`pnpm typecheck`、定向 Oxlint、`pnpm i18n:check`、`pnpm build` 通过。构建仅有既有 CSS `::highlight`、依赖注释和大 chunk 警告。真实 Cloud worker 验收尚未执行。
