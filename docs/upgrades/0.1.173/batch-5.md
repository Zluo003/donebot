# 第 5 批：委派、自动化与收件箱

团队卡片续跑已核对协调器的原成员和独立步骤；故障报告不会再通过 Chief 新建可能重复收费的模型调用。个人恢复保留。八文件 246 项及真实隔离服务卡片、目标、压缩共 27 项通过，证据和未接入的团队恢复范围见 [团队模型验证](../../verification/donebot-team-models.md#卡片续跑与故障恢复)。团队自动化和媒体来源仍待完成，本批未整体验收。

## 同会话定时跟进

接入固定上游 f10d1832f 的 check_back。Bot 可为用户本人发起的单聊安排跟进，按用户时区解析时间；到点在原会话运行，保留原请求人。取消、超限、忙碌、暂停、睡眠后补跑、会话删除和中断启动恢复沿用原版机制。启动前持久标记；重启发现受理不确定时不重新运行。云端下一次唤醒、备份维护及退出同步停止调度。群聊、委派、自动化、外部事件和个人 Cloud 访客不开放该工具。

DoneBot 保留当前共享协议和统一网关；状态行、取消和错误文案补齐简繁中文。不引入上游 phone-protocol 包重构。新增当前轮次复查：异步等待期间已取消或删除的后续记录不得执行；停止调度后不继续派发同批剩余记录。

2026-11-20 验证：

- `/tmp/donebot-checkback-workflow.log`：2 文件 / 3 个真实隔离服务流程通过。覆盖到点无人操作续跑、取消、Ask 级别真实 MCP 工具调用、原会话无伪造用户消息、团队私聊请求人保留及其他成员不可读。
- `/tmp/donebot-checkback-final.log`：13 文件 / 318 项通过。含时间解析及夏令时、限额、重启及睡眠补跑、启动不确定不重跑、取消/删除/停止竞态、中文及取消失败重试、路由授权、既有等待、person-first、工具目录原始及打包字节一致性、请求认证及媒体工具。
- `/tmp/donebot-checkback-types.log`、`/tmp/donebot-checkback-lint.log`、`/tmp/donebot-checkback-i18n.log`：类型、lint 和 16 个语言目录校验通过。工具目录差异仅增加 check_back 及相关自动化说明，既有字节预算检查保持。

尚未完成：委派状态及其余自动化、收件箱功能；上述测试不替代跨成员本机和真实镜像验收。团队新增能力继续关闭。

## 委派状态

接入 20aaf4f30，直接读取协调器任务记录：对话中的发送行和收件箱展示同一状态，支持已接单、工作中、等待成员或 Bot、完成、失败。群聊保留原 comm 状态；不修改执行流程和既有权限。状态变化再推送，重启恢复活动跟踪。

补齐上游边界：最近 200 个完成状态也持久保存；成员资料或请求人信息缺失时，仍依照会话实际受众隐藏私聊标题和失败内容。私聊标题在首次写入及广播前隐藏，之后的状态行复查继续保留。简繁中文状态文案已补齐。

2026-11-20 验证：

- `/tmp/donebot-handoff-status-regression.log`：10 文件 / 286 项通过。含任务状态、独立会话/收件箱组件、重启后完成状态、成员信息缺失的隐私边界、写入前隐藏标题、协调器、附件和请求认证。
- `/tmp/donebot-handoff-status-workflow-final.log`：3 文件 / 20 项真实隔离服务测试通过。Lead → Coder → Writer 无人操作推进及双处同步状态；团队私聊的读取、写入、搜索、附件、SSE 和离队权限；现有委派附件机制回归。
- `/tmp/donebot-handoff-status-types.log`、`/tmp/donebot-handoff-status-lint.log`、`/tmp/donebot-handoff-status-i18n.log`：typecheck、lint、16 语言校验通过。

其余批次 5 的长 brief、定向回复、完整文件传递、Webhook/自动化与收件箱改进继续实施；真实跨节点团队与手机验收未完成。

## 双向文件传递

接入固定上游 923d75725 的 coordinate_bots 显式 files、接收方 inbox、安全读取和传递记录。复用当前附件类型、大小及目录权限；单条最多 5 个文件、100 MiB，收件方取得独立副本，重试保留其编辑。内容寻址使用本次安装的密钥，避免从已知文件内容推算下载名称；不同媒体类型不共用名称。

DoneBot 适配保留现有媒体回传为唯一发布方，避免重复附件行和重复生成。显式文件与正文引用按内容及规范化 MIME 去重，额外引用仍传递；本轮文件继续经过自有 Cloud 桌面桥和原有来源验证。复制前后复查取消、会话存续及私聊受众；返回记录在启动失败时撤回已告知标记。inbox 内即使链接指向本 Bot 其他可读目录也拒绝。

团队备份按实际任务受众过滤文件记录、待发附件和私人 Bot 计数；恢复重定位文件路径及副本映射键，丢弃来源数据目录外的副本映射，保留目标安装的名称密钥。过期清理仅允许当前接收会话或当前 VM 的对应 inbox，旧来源路径不参与删除。

2026-11-20 验证：

- `/tmp/donebot-handoff-files-overlap-workflow-final.log`：3 文件 / 17 个真实隔离服务流程通过。包含双向显式传递、同字节不同类型、七种单聊/群聊/链式回传、显式与隐式输入重叠、越界/类型/数量拒绝、同会话文件报告，不重复执行生成者。
- `/tmp/donebot-handoff-files-backup.log`：5 文件 / 149 项通过、1 项平台跳过。包含加密导出与实际恢复、团队私聊待发文件剔除、共享待发记录保留、当前安装密钥、恢复副本路径、过期清理及取消/撤权/删除竞态。
- `/tmp/donebot-handoff-files-complete-units.log`：6 文件 / 164 项通过，含 inbox 链接拒绝、内容名称、工具参数、UI 附件和原始/打包工具目录一致性。
- `/tmp/donebot-handoff-files-privacy-media.log`：5 文件 / 202 项通过，包含真实团队私聊隔离、媒体跟进、统一媒体与备用以及工具代理。
- `/tmp/donebot-handoff-files-types-complete.log`、`/tmp/donebot-handoff-files-lint-complete.log`：类型与 lint 通过。

尚未接入跨节点文件协议、其余自动化和收件箱改进。本节不替代真实 Linux、Windows 或跨成员本机验收。

## 事件过滤与同会话续跑

接入固定上游 0a9d843a6 和 46859b327。Webhook 与 App 事件可选择继续同一会话，默认保持独立会话；同一事件源串行执行，重启后继续最近存在的执行会话，最近会话删除后新建。设置支持创建、编辑、Bot 工具修改、撤销及转发定义，保留当前共享协议。

Webhook 可指定最多 10 个字段的精确值过滤，支持点路径、数组任一项、忽略大小写；所有字段同时匹配才入队。不匹配记录为忽略，不派发执行；手动“立即运行”绕过字段过滤。深层数组使用迭代遍历，避免外部 JSON 耗尽调用栈。管理员审计记录两项设置变化，更新其他字段不清除既有过滤。

2026-11-21 验证：

- `/tmp/donebot-event-automations-workflow-final.log`：2 个真实隔离服务流程通过，包含过滤、重启续跑、原上下文保留、重复投递不执行、删除会话重建、关闭续跑及手动运行。另一个流程在入队成功但 Webhook 回执未保存时强制退出进程，重启仍只运行一次。
- `/tmp/donebot-event-automations-regression.log`：10 文件 / 123 项通过，包含两种编辑器的双向切换保存、撤销恢复、过滤、请求路由、投递去重、App 事件及转发字段。
- `/tmp/donebot-event-automations-catalog-final.log`：3 文件 / 60 项通过；`/tmp/donebot-event-automations-unit.log`：7 文件 / 293 项通过。工具目录仅新增两项可选参数及对应说明，每个 profile 增加 655 字节，预算基线只增加该差额，2% 约束保留。
- `/tmp/donebot-event-automations-types-final.log`、`/tmp/donebot-event-automations-lint-final.log`、`/tmp/donebot-event-automations-i18n-final.log`：类型、lint 和 16 语言校验通过。

续跑工作流证据：`/var/folders/wf/gs6jc_rd4qd_6_1jmqjkg1jh0000gn/T/donebot-verification-evidence/restartable-1795191164085-57589.log.continuity.json`。团队新增能力继续关闭；调度可靠性、收件箱及跨节点验收继续实施。

## 调度可靠性与损坏配置恢复

接入固定上游 026dd777a，以及其依赖的运行准备门和停止辅助机制。失败不再自动关闭周期任务；特定桌面启动失败连续三次后按一小时、四小时间隔重试，跳过的周期合并为有原因和次数的台账。较早版本自动关闭的任务只在识别出同一失败时间戳、三次相同失败且未超过 30 天时恢复一次；用户暂停、编辑、恢复备份、保留状态或冻结的任务保持原意。

默认普通运行累计工作三小时、目标运行十二小时；用户指定的时限沿用已有计时规则。默认计数每轮有上限，睡眠或时钟跳变不计作持续工作。周期任务忙等超过一小时记为错过，外部事件和用户手动请求继续等待。停止等待最多十秒，未确认的停止仍阻止同一自动化立即再跑，五分钟内重试并记录确认结果。暂停、删除会取消排队和等待输入的运行，保留已开始工作和用户后来发起的个人轮次；保存失败时不发送取消。

无法读取的 routines.json 不会被空状态覆盖，最多保存五个按内容命名的 0600 副本；配置和健康状态可报告故障，写入返回 503。文件恢复可读后，本地重接归属和结果线路，Cloud 重新启动以先完成运行归属核对。恢复备份会更新定义时间戳，避免误判成旧版自动关闭。健康报告从持久台账计算连续失败，重启不清零；合并漏跑行不参与成功率或最近执行结果。

DoneBot 额外保护：准备检查同步抛错或异步拒绝时阻止执行；暂停、删除立即撤销准备检查；未保存的暂停不得中止等待中的轮次。这里只接入通用准备钩子，实际 DoneBot 云桌面就绪适配留待第 7 批，不引入原版 Boat 自动重建或替换桌面。

2026-11-21 验证：

- `/tmp/donebot-routine-reliability-units-complete.log`：13 文件 / 412 项通过，覆盖退避、漏跑、计时、停止确认、损坏文件、失败恢复、暂停/删除竞态及准备失败。
- `/tmp/donebot-routine-reliability-workflow.log`：11 文件 / 145 项通过、1 项平台跳过；包含真实隔离服务重启、自动化生命周期、结果回传、事件续跑、转发、界面状态及备份恢复。
- `/tmp/donebot-routine-file-workflow.log`：真实隔离服务流程通过。实际损坏配置并重启，检查拒绝写入、原字节和私有副本、修复后执行一次、再重启无重跑及日志无秘密值。
- `/tmp/donebot-routine-reliability-types-final.log`、`/tmp/donebot-routine-reliability-lint-final.log`、`/tmp/donebot-routine-reliability-i18n-final.log`：类型、lint 和语言校验通过。

剩余长 brief、定向回复、收件箱、实际跨节点和真实 Linux 压力验证继续实施。团队能力仍关闭。

## 收件箱置顶、完成与消息定位

接入固定上游 bedfa6f5f、7616670cb、b0acbabbb 和 ed5d8be7d。收件箱展示已置顶会话和最近十个已读、空闲的完成会话，排除私聊房间、忙碌及排队中的任务；通知和活动会话的未读计数去重。结果点击后进入原会话、定位原消息，并保留在可展开的完成列表。问题和可回复消息继续在阅读面板处理，上一条/下一条不会意外跳出面板。批量标记已读不代替审批或回答问题。

DoneBot 将结果通知产生时的消息编号持久保存，后续回复和重启不改变定位目标；旧记录保留兼容回退。成员读取、完成和批量已读由服务端核验本人身份与受众。未读上下文卡片仅在进入会话时原问题位于首屏或历史窗口外显示，引用和附件保持可读，关闭只作用于本次停留。

2026-11-21 验证：

- `/tmp/donebot-inbox-regression-1121.log`：14 文件 / 211 项通过，覆盖通知状态、未读去重、置顶/完成、阅读面板、批量已读竞态、请求认证与消息定位持久化。
- `/tmp/donebot-inbox-overlay-1121.log`：4 项通过，覆盖首屏可见性、窗口外上下文、跳转、关闭和跨会话清理。
- `/tmp/donebot-inbox-workflow-1121.log`：2 文件 / 25 项真实隔离服务测试通过，覆盖两个成员独立状态、本机与个人 Cloud 的结果回传和读取、不重复执行。
- `/tmp/donebot-inbox-ui-1121.log`：真实浏览器流程通过，覆盖置顶、取消置顶、结果定位、完成列表及 390px 手机弹层；截图已人工检查。证据为 `output/playwright/inbox-upgrade/receipt.json`、`desktop.png` 和 `phone.png`。
- `/tmp/donebot-inbox-overlay-types-1121.log`、`/tmp/donebot-inbox-lint-1121.log`、`/tmp/donebot-inbox-i18n-1121.log`：类型、lint、16 个语言目录校验。

尚未验证真实长历史滚动、原生手机、跨工作空间切换以及跨成员本机执行。剩余长 brief、定向回复、跨节点协作和最终平台验收继续实施；团队新增能力保持关闭。

## 定向回复与忙碌排队

接入固定上游 45fdc09f9、1310f7611、f836bc67c、3a04350c7、0cd7b5910 及 a765ea999 至 c8e8ebfd4 的排队修复。回复 Bot 消息优先由该 Bot 回答，明确点名优先；不同引用目标不合并排队。自动路由排除全局暂停和房间暂停的 Bot，保留可用备用及目标任务原协调者。未指名的插话不注入他人正在执行的委派任务。

排队提示同时说明当前等待成员和 Bot 实际忙碌位置，不把尚未轮到的房间当作运行位置。DoneBot 在 HTTP、首次实时推送和重连回放均按会话受众过滤 busyIn；Owner 和 Admin 也不能取得其他成员的私聊编号。无法访问的位置只发送 busyElsewhere，不依赖前端隐藏名称。保持当前协调器 API 和共享协议布局。

2026-11-21 验证：

- `/tmp/donebot-room-routing-units-final.log`：8 文件 / 96 项通过，包含路由、排队合并、准入、忙碌状态、HTTP/SSE 过滤及界面提示。
- `/tmp/donebot-room-routing-workflows-final.log`：3 文件 / 31 个真实隔离服务测试通过。包含引用目标、暂停与目标协调者、插话不串任务、同房间串行与并行任务、其他房间忙碌及队列清空。
- `/tmp/donebot-room-routing-privacy-workflow-final.log`：真实 Team fixture 通过。Owner、Admin、另一 Member 的 HTTP 列表、实时帧和回放没有私聊编号；本人仍可见其忙碌位置。
- `/tmp/donebot-safe-coordination-types-complete.log`、`/tmp/donebot-room-routing-lint-final.log`、`/tmp/donebot-room-routing-i18n-final.log`：类型、lint、16 语言目录校验通过。

尚未验证真实手机和跨节点行为；长 brief 与其余批次继续实施，团队新增能力保持关闭。

## 长 brief 与安全回执

接入固定上游 25254cde4，工具、HTTP 和运行上下文共用 12,000 字 brief 限制；ID 支持大小写及至少八字符的唯一前缀，先于名字解析，歧义则不派发。保留现有受众检查；导入 ID 不允许占用 link- 前缀或仅大小写不同的已用 ID。

已结束任务的过期 answers 返回明确的 instructionOnly 回执，工具将其作为结束指令；真实失败仍报错。DoneBot 额外要求整批拒绝与指令回执逐条对应，混合失败不能被相同文字的指令回执掩盖。本节只接入本节点协作；跨节点协议仍属批次 3。

2026-11-21 验证：

- `/tmp/donebot-safe-coordination-units-final.log`：9 文件 / 360 项通过，覆盖 ID、完整 brief、工具桥、回执、问题路由和运行时。
- `/tmp/donebot-safe-coordination-catalog-complete.log`：50 项目录一致性和预算测试通过。
- `/tmp/donebot-safe-coordination-workflow-complete.log`：2 文件 / 32 项完整隔离服务流程通过，包括真实团队忙碌位置隐私。
- `/tmp/donebot-safe-coordination-boundary-workflow.log`：6 项真实隔离服务流程通过，包含 12,000 字完整送达、超限拒绝、大小写和唯一前缀只运行一次、过期 answers 不派发。
- `/tmp/donebot-room-routing-privacy-workflow-final.log`：真实团队私聊 HTTP、实时和回放隔离通过。
- `/tmp/donebot-safe-coordination-types-complete.log`、`/tmp/donebot-safe-coordination-lint-complete.log`：类型与 lint 通过。

团队能力保持关闭。真实手机、跨节点及最终平台验收尚未完成。


## Webhook 群聊提交目的地

接入固定上游 cd9c6cba4。音频或图片准备期间房间切换会话时，回执使用真正写入的 threadId。相同 deliveryId 重试、服务重启或触发器改指其他房间后仍返回原提交目的地，不再次发消息、执行模型或合成音频；旧版只存 runId 的回执保持可读。

2026-11-21 验证：`/tmp/donebot-webhook-receipt-regression.log` 六文件 65 项通过，覆盖会话切换竞态、重复/并发投递、重启及旧回执；`/tmp/donebot-webhook-receipt-workflow.log` 真实隔离服务再次核对重复投递返回原 threadId、仅一条消息和一次语音合成。`/tmp/donebot-data-webhook-types.log` 与 `/tmp/donebot-data-webhook-lint.log` 类型、定向 lint 通过。

## 团队定时跟进的成员归属

定时跟进通过当前可信工具轮次保存私有授权，先于待办记录持久化；保存失败不留下可运行的排期。授权固定原成员版本、Bot、会话受众和完整排期内容，不从待办的 origin 或最后发言者推断付款人。重启后的唤醒读取原绑定，来源缺失、记录改写和运行代次变化均拒绝；下一次跟进从实际唤醒轮次继承。保持原版启动前标记、中断不重跑及暂停等待机制。

2026-11-21：四文件 51 项通过，日志 `/tmp/donebot-team-check-back-units.log`；真实调度器与合成网关覆盖私聊、并发 tick、重启、后续排期、撤权、篡改和响应丢失，供应商计数不增加。两个真实隔离服务文件 3 项流程通过，日志 `/tmp/donebot-team-check-back-workflow.log`；类型与定向 lint 通过，日志 `/tmp/donebot-team-check-back-{types,lint}.log`。隔离服务包含原版 Team fixture 的私聊检查，不证明 DoneBot 签名团队模型端到端成功执行；真实 Linux 验收仍未通过，团队能力继续关闭。
