# 批次 6：设置、Apps、技能与文件

本批继续实施；以下只记录已验证的子项。

## 表格导入、SQL、导出和图表边界

接入 c1ad50f98、eea768514、369565808、b3d847d88、11d451a65、a9b2c7e15、e0b4e3b61、d9dfb1938、98c54270a、83a3487eb、7586b70b8、d27758e51、c2c5f59b5、0a8e96665、e15a66c1d、3dfda815c、907d40005 和 d608ddf70。查询结果编号先持久化，并发导出预留互不冲突的路径；Windows 路径大小写按平台折叠。支持引用及 Unicode 表名、大小写扩展名、压缩 CSV、带方括号的真实目录，保留源文件字段并生成不重名的来源列。单条 SQL 识别实际终止分号及嵌套尾注释；截断标记与 UTF-8 字节预算一致。图表处理早期年份、空坐标、非有限数、常量分布及源列与聚合列重名。

2026-11-21 验证：

- `/tmp/donebot-data-regression-accepted.log`：25 文件 / 431 项通过，包括文档引用检查。
- `/tmp/donebot-data-edge-workflow-fixed.log`：真实隔离 HTTP 流程通过，验证字面目录不会误导入相邻 glob 文件、来源字段保留、嵌套 SQL 尾注释、多语句拒绝及三路并发导出内容。
- `/tmp/donebot-data-workflow-native-final.log`：完整 Chromium 工作流通过，包含十万行、120 列、图表、分页/过滤/排序、重启、SQL 竞态、键鼠调整尺寸、窄屏及聊天调用实际数据工具更新当前结果。证据为 `server-1795213174868-42402.log.data.json` 与相邻截图，位于系统临时目录的 `donebot-verification-evidence/`。
- `/tmp/donebot-data-accepted-types.log`、`/tmp/donebot-data-accepted-lint.log`：类型及定向 lint 通过。

fixture 更新欢迎版本和界面标签，图表选择器限定到 Data 面板；合成模型服务分别处理模型目录 GET 和聊天 POST。数据目录、home、浏览器与服务均由 fixture 创建及清理。未使用真实用户数据。发布格式元数据仍记录上游 0.1.152，和保留的应用版本 0.1.3 不一致；`server/data-format.test.ts` 的发布版本检查留至正式版本确定时处理，未为消除失败改写发布记录。

## GitHub／skills.sh 技能导入

接入固定上游 558047fff、8ed728be7、1f08f4912 和 92585043f。skill_manage 新增 import，把单个远端技能转为受审核的 create；SKILL.md 和至多八个 references/<topic>.md 进入原有扫描、32 KiB 单文件限制、名字冲突、审批和 Undo 机制。脚本及其它文件不进入该方式，摘要明确列出遗漏文件。

保留 DoneBot 既有 skill_import：默认只预览，明确安装时保留整个受验证文件夹（包括脚本、资源），以禁用状态安装，不执行脚本。两种接口均在下载结束后复查任务是否仍有效、技能设置和当前管理权限；共享同一下载预算和任务取消信号。直接应用政策保持原版：本机可直接应用并撤销，非主人驱动的 Cloud 会话须主人确认；本轮没有增加额外本机审批。

原版策略在下载后重新读取审批来源和卡片容量，避免下载期间的变化失效。真实个人 Cloud 访客测试在其它请求填满八张卡后拒绝第九张；错误审核哈希不安装，正确哈希只安装卡片展示的正文和参考文件。未接入模板脚本、私库连接及团队共享配额。

2026-11-21 验证：

- `/tmp/donebot-skill-import-regression-complete.log`：7 文件 / 377 项通过。包含取消前与取消中下载、单个及多技能源、路径/大小限制、扫描/审批/Undo、技能工具和原始/打包工具目录一致性。
- `/tmp/donebot-skill-import-workflow-cloud.log`：6 项真实隔离服务流程通过。覆盖本机撤销、下载中关闭技能功能（两接口）、移除管理权限、停止任务取消上游下载、完整文件夹禁用导入，以及实际重启成个人 Cloud 后的访客卡片容量与精确字节审批。
- `/tmp/donebot-skill-import-workflow.log` 中既有 bot-skill-setup fixture 通过，保留 Chief 与专家技能目录、完整本地技能文件、跨 Bot 管理和撤销。
- `/tmp/donebot-skill-import-types-final.log`、`/tmp/donebot-skill-import-lint-final.log`、`/tmp/donebot-skill-import-i18n.log`：类型、lint、16 个语言目录校验通过。

工具目录仅技能 profile 增加 267 字节；预算基线不变，2% 约束继续通过。未访问真实 GitHub、网关或用户数据。这些测试不替代跨节点团队与平台验收。

## MCP 登录、刷新和命令环境

接入固定上游 b07a4de16、d5e6ee167、89bc1d346、a27236595、e8e97f8e8、50630c354、467f9fad7、06eb477c1、627e0c83f、2faa745e3、7a7f3b578、ecdb86325 和 76dc471a5。并发连接复用按 state 分派的回调监听；刷新结果只适用于发起时的授权记录，注销不等待远端撤销才删除本机令牌。刷新令牌发送前以 0600 文件持久标记，响应丢失或成功但无有效令牌时不重放，离线未连接、明确临时错误及协议允许的非轮换令牌仍可重试。仅在上游声明支持时请求 offline_access；手工 scope 不被改写。

命令服务器探测与聊天共用可写 npm 缓存选择。保留可写的既有缓存和服务器显式设置，仅在继承缓存不可写时使用进程复用的临时缓存；没有放宽环境凭据过滤。query_result 的保留名在所有分页过滤，本地工具替换参数作为通用 normalizer 能力接入；私有本地桌面及其文件工具仍未启用。

2026-11-21 验证：

- `/tmp/donebot-mcp-reliability-auth-final.log`：9 文件 / 319 项通过，覆盖 OAuth、刷新竞争/重启、发现、令牌文件、探测、聊天环境及登录组件。
- `/tmp/donebot-mcp-reliability-gate-final.log`：5 文件 / 102 项通过，覆盖真实子进程协议、分页冲突、环境与 schema。
- `/tmp/donebot-mcp-reliability-workflows.log`：3 文件 / 23 项隔离服务用例通过，其余 325 项由明确测试名过滤而未运行；包含聊天登录卡、成员个人 OAuth 与 MCP API。
- `/tmp/donebot-mcp-reliability-ui-final.log`：真实设置面板完成八项流程，包含阻止弹窗、粘贴回调、处理中取消重试、实际工具探测及退出登录取消；截图位于 `.omb-scratch/mcp-oauth-evidence/`。验证工具 socket 使用短临时目录，避免 macOS socket 路径上限。
- `/tmp/donebot-mcp-reliability-types.log`、`/tmp/donebot-mcp-reliability-lint.log`：类型和 lint 通过。

未访问真实 OAuth 账号或用户应用。npm 权限路径覆盖为单元环境与真实命令子进程测试，不替代真实 Linux 团队隔离。

## MCP 专用连接及名额

接入 8db69909c、b57c6c098、1d53cbb99 和 88d0d4327。HTTP/SSE 连接复用命令连接的 bot 归属，列表和执行挂载均按 Bot 过滤；其它 Bot 即使伪造 bot 字段，也不能测试、登录、注销、修改、删除、重启或切换该连接。管理员通过已有编辑接口设置归属；公开新增接口保持原版共享默认。修改预算等字段保留归属和同一 OAuth 授权。

每 Bot 最多 20 个可用连接（共享加专用），安装合计最多 100 个；新增、编辑归属、JSON 导入、安装包导入和既有配置导入共用检查。Bot 私有程序的归属由真实工作目录推导，不能由 Bot 请求自行指定。删除 Bot 会取消待完成登录并清除其 OAuth；清理某项密码库或命令规则失败时仍继续其它连接和保存登录的清理，不影响其它 Bot 的连接。

2026-11-21 验证：

- `/tmp/donebot-mcp-ownership-units.log`：9 文件 / 260 项通过，覆盖名额、归属、修改、导入和密码库失败清理。
- `/tmp/donebot-mcp-ownership-workflow-final.log`：新增真实隔离流程通过。两个 Bot 同时登录同一服务、各自取得不同凭据，回合仅挂载自己的连接；另一 Bot 的八种管理操作均拒绝且不触达提供方；删除取消待登录回调，同名重建不继承令牌。
- `/tmp/donebot-mcp-ownership-workflows.log`：已有登录卡及开启审批四项流程通过；同次新增流程的初始 fixture 假设失败已由上述最终证据替代。
- `/tmp/donebot-mcp-ownership-types-final.log`、`/tmp/donebot-mcp-ownership-lint.log`：类型和定向 lint 通过。

本项不宣称 DoneBot 团队 Cloud 的执行授权已完成，相关能力继续关闭。

## 大音视频按需播放

接入固定上游 fd393a7d8、aed2714e8。受授权的消息附件可换取短期不透明播放链接，每次读取仍校验当前身份、消息、路径及 MIME；每段最多 8 MiB，无 Range 的保存继续流式传输完整文件。保留 DoneBot 的 ETag、If-Range、416、附件根目录及原有图片预览行为；手机代理链接额外绑定认证设备，不能与桌面或另一设备互用。旧服务不支持播放链接时仍回退原有有界 Blob，视频解码失败显示下载入口。

2026-11-21 验证：

- `/tmp/donebot-media-streaming-regression.log`：6 文件 / 148 项通过，覆盖附件、授权、播放器和旧服务兼容。
- `/tmp/donebot-media-streaming-route-regression.log`：4 项已有真实服务附件流程通过，329 项按名称未运行。
- `/tmp/donebot-media-streaming-workflow-complete.log`：新增真实隔离服务流程通过，覆盖 30 MB 文件、范围和完整读取、两个 cookie 会话、撤权、文件替换、越界符号链接及错误类型。
- `output/playwright/media-streaming/`：真实 Chromium 完成按需加载、解码、播放和拖动进度；MP4 14.033333 秒跳至 10 秒，WAV 960 秒跳至 900 秒，媒体错误为空；390 px 无横向溢出，两类响应均为 206 / 8 MiB。
- 类型、定向 lint 和 16 个语言目录校验通过，命令及使用方式见 `docs/verification/chat-polish.md`。

已关闭该命名浏览器和临时服务。未访问真实网关、用户文件或应用；打包 Electron、物理手机和 Cloud 代理留至整体验收。

## 压缩包、未知格式与文件粘贴

接入固定上游 73e9f6962、f42488d0b、ccbe58b7a 和 a6cd67c78。压缩包从文件选择、拖放或 Chromium 文件剪贴板进入原有附件 intake；支持手机系统常见 MIME 别名。未知格式以 `.bin` 保存，显示名保留安全扩展名，只能下载；文本粘贴和纯图片粘贴保持既有路径。Bot 可通过原有 attach_file 回传八类压缩包，不自动解压。保留 DoneBot 的上传重试、内容冲突、凭据目录隔离及媒体回执不重复发布规则。

2026-11-21 验证：

- `/tmp/donebot-archive-intake-units.log`：5 文件 / 185 项通过；`/tmp/donebot-archive-delivery-units.log`：4 文件 / 143 项通过。
- `/tmp/donebot-archive-intake-route.log`、`/tmp/donebot-archive-delivery-route.log`：分别通过已有上传流程及 Bot 回传压缩包；各自仅运行指定名称，其余跳过。
- `/tmp/donebot-archive-roundtrip-final.log`：真实隔离服务完成六种文件重试、会话发送和下载；内联及媒体播放被拒绝，未授权直读被拒绝，文件内容保持一致。
- `/tmp/donebot-archive-catalog-final.log`：原始与桥接工具目录共 90 项通过。桥接快照补齐此前已实现的委派文件、check_back、技能导入及 DoneBot 附件去重说明；逐项审核后按实际目录差额 466–504 字节调整超出范围的旧基线，其中本次压缩包说明为 48 字节，2% 断言保留。没有套用上游预算数值。
- Chromium 粘贴、真实发送与 390 px 窄屏通过，记录见 `docs/verification/plain-file-attachments.md`。本次 fixture 首轮缺少 scripted reply 导致假引擎失败，补齐合成计划后在全新隔离 home 重测通过；不是生产应用故障。
- `/tmp/donebot-archive-types-final.log`、`/tmp/donebot-archive-lint.log`、`/tmp/donebot-archive-lint-final.log`、`/tmp/donebot-archive-i18n.log`：类型、定向 lint、16 个语言目录校验通过。
