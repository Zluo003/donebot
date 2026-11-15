# DoneBot 图片预处理与附件上下文

桌面端和 Cloud 的 DoneBot 网关模型共用图片上下文策略。聊天中保存的附件和
原文件保持不变；发送模型前，静态、不含透明像素的 PNG 会在独立线程中生成
JPEG 候选，最长边 2048、质量 85，只有候选更小时采用。JPEG 也可以生成较小
版本。透明图片、动画、含 EXIF 的 JPEG 和不支持解码的图片保留原格式。
转换结果按内容哈希缓存，缓存最多 256 MiB，清理缓存不会删除原附件。

每次模型请求同时检查处理后的图片文件总计 30 MiB 和 Base64 编码总计
32 MiB。两项都满足才携带图片像素；按当前轮素材、较新的历史素材排序。
一次请求最多携带 20 张图片，更多素材通过引用按需读取。
同一内容的重复像素只携带一次。超限图片保留 ID、原消息、消息内图片顺序、
关联文字及原文件路径。`attachment_list` 可以按关联文字搜索当前分支的图片，
`attachment_read_image` 可重新读取；需要细节时可以请求原始分辨率。
未加载的图片不能作为已经看见的视觉证据。关联文字来自原消息，不是自动生成
的图像描述。已有文字摘要机制继续运行，压缩后的旧附件仍可通过原始记录找到。

工具返回图片采用相同策略，下一次模型请求前移除较早的像素，保留工具调用关系。
本轮工具图片的原始数据临时落盘，结束后清理；用户附件的原图长期保留。
重读不重新执行生成工具，不重复提交收费任务。工具范围中的显式排除继续有效；
重读只接受当前分支已经通过原附件验证的图片 ID，不接受模型提供的任意主机路径。

```sh
pnpm exec vitest run server/donebot/image-context.test.ts server/donebot/image-context.e2e.test.ts server/donebot/llm-driver.test.ts server/drivers/chat-images.test.ts --maxWorkers=1
pnpm typecheck
pnpm lint
pnpm test:packaged-server
```

端到端用例通过 `launchVerificationServer` 启动临时 HOME、数据目录和独立端口，
连接 loopback 假网关。验证原 PNG 不变、模型收到 JPEG、自动文字压缩后仍有稳定
图片 ID 和用途、原工具循环能够重读，以及没有媒体生成请求。证据写入
`.omb-scratch/verify-evidence/donebot-image-context/result.json`。单元用例覆盖大图
预算、当前图片优先、连续工具截图、透明度、缓存、外部 ID 和符号链接拒绝。
合成模型按脚本调用工具，不证明真实 LLM 每次都会正确选择重新读取。
