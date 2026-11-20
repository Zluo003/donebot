# 压缩包与普通文件附件

只在隔离 home/data 下验证，不向用户应用上传文件。

```sh
node --experimental-strip-types scripts/verify-attachment-intake.ts
pnpm exec vitest run server/plain-file-upload.e2e.test.ts
pnpm exec vitest run server/attachments.test.ts server/bot-attachment.test.ts server/message-file.test.ts src/lib/composer-attachments.test.ts src/lib/intake-files.test.ts src/lib/attach-notice.test.ts
```

打开启动器打印的 previewUrl，完成 fixture 欢迎页后选择 Attachment fixture。
粘贴同时含 ZIP 和未知二进制格式的 File 列表，确认出现两个文件 chip，输入框不出现文件名；发送后，原会话保留两个附件，fake engine 回复 Fixture files received。
文本格式仍沿用原有文本附件处理。纯图片粘贴继续走图片路径，混合文件使用文件选择器相同的 intake。

HTTP 流程覆盖 ZIP/GZIP/RAR 的系统 MIME 别名、HTML/SVG/EXE 的不透明 `.bin` 存储、相同 uploadId 重试与不同内容的 409、无会话文件读取的拒绝、消息内下载的原始字节、`attachment` 和 `nosniff`，以及禁止将这些文件作为图片或媒体播放。Bot 回传压缩包另走现有 attach_file、大小及目录限制；不会自动解压。

2026-11-21：真实 Chromium 合成 ClipboardEvent 粘贴 Project.zip 与 module.wasm 后发送成功；会话中 requestPending 为 false、turnSucceeded 为 true。390×844 下 scrollWidth 为 390，文件均为普通下载 chip，页面无媒体/iframe/object/embed。截图及回执位于 `output/playwright/attachment-intake/`，服务日志为 `server-1795209345940-27710.log`。唯一控制台错误是 fixture 缺少 favicon；命名浏览器和确切的 fixture 进程已关闭并清理临时数据。

该结果验证 Chromium 的 clipboardData.files 分支，不替代真实 Finder/Explorer 系统剪贴板、物理手机与安装包验收。
