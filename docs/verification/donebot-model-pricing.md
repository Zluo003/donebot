# DoneBot 模型与价格

设置新增独立的“模型与价格”页面，按 LLM、图片、视频、音乐、音频展示 DoneBot
目录返回的所有模型及人民币销售价格，不按客户端的生成能力登记再次筛选。
LLM 展示输入和输出单价；图片、视频及音乐保留目录中的价格档位；TTS 的每百万字
单价除以 1000 后展示为元／千字。缺失或无效价格不会按零元显示，也不自行换算外币。
账户与模型页只移除旧的模型目录卡片，账户、Cloud 和媒体偏好设置继续保留。

## 自动检查

```sh
pnpm exec vitest run src/donebot/model-pricing.test.ts src/donebot/ModelPricing.dom.test.ts src/donebot/Account.dom.test.ts src/donebot/MediaSettings.dom.test.ts src/components/SettingsModal.simple.test.ts src/components/SettingsModal.groups.test.ts
pnpm typecheck
pnpm i18n:check
```

2026-11-20：6 文件 80 项通过，覆盖换算、零价、无效价格、参考视频档位、Muse 按秒
展示、完整目录、加载与刷新失败、空目录、账号切换及迟到响应、未登录，以及本机、
Cloud、远程设置入口。此页面复用现有目录接口，不修改网关或结算规则。

## 隔离页面

```sh
node --experimental-strip-types scripts/verify-donebot-model-pricing-ui.ts
```

启动器创建临时服务、合成账号和网关，只在打印出的回环地址操作。打开页面，从
设置进入模型与价格，刷新价格，检查五类目录；切换账户与模型检查旧目录卡片已移除。
在通用中切换浅色和深色，分别检查桌面及窄屏；窄屏通过顶部设置选择器切换页面。
Ctrl-C 关闭启动器，清理其拥有的服务及临时数据。

2026-11-20 的浏览器检查展示全部 15 个合成模型，包括未登记生成能力的模型；
验证搜索“价格”、刷新、旧目录移除、桌面明暗主题，以及 390px 和 320px 窄屏无横向
溢出。12 元／百万字显示为 0.012 元／千字。截图和 JSON 保存在
`output/playwright/model-pricing/`，`desktop-light.json` 记录隔离服务日志路径及目录内容。

本次只验证真实设置组件和隔离服务，未访问生产账号、真实收费上游或已安装客户端，
合成价格不代表生产定价。此页面尚未重新打包到安装包。
