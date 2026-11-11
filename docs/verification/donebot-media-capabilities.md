# DoneBot 媒体能力与输入限制

核对日期：2026-11-11。范围：客户端开放的 Seedream 5.5、Seedance 2.5 和
Suno v6 生成接口。TTS 本轮不调整。

客户端首次 LLM 请求即提供固定模型的参数 schema 和使用限制；无需先查询能力。
模型能力、默认值、请求组装属于客户端。网关只鉴权、路由转发、计费及保存异步任务。
登记限制不等于已对媒体完成本地解码检查。

| 模型 | 官方依据 | 客户端开放能力 |
| --- | --- | --- |
| Seedream 5.5 | [APIMart 生成接口](https://docs.apimart.ai/cn/api-reference/images/seedream-5-5/generation) | 文生图、参考图编辑、多图融合、透明图、图层拆分及可选 OCR |
| Seedance 2.5 | [模型教程](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh)、[创建任务 API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh) | 文生视频、首帧、首尾帧、全模态参考、视频编辑和延长；音频参考可单独输入 |
| Suno v6 | [APIMart 生成接口](https://docs.apimart.ai/en/api-reference/audios/suno/generation)、[任务约定](https://docs.apimart.ai/en/api-reference/audios/suno/overview) | 纯音乐、带歌词歌曲；均使用 v6 自定义模式 |

## Seedream 5.5

| 项目 | 登记及校验 |
| --- | --- |
| 参考图 | 生成 0–10 张，拆分恰好 1 张；JPEG/PNG/WebP/BMP/TIFF/GIF/HEIC/HEIF；每张 ≤30 MiB、≤36,000,000 像素；不支持 AVIF/JP2 |
| 输入尺寸 | 官方未在本接口规定最小像素、每边 6000 或参考图宽高比限制，客户端不借用旧模型的这些限制 |
| 提示词 | 生成必填；图层拆分可省略；官方未公布本接口字符数上限 |
| 输出尺寸 | 1K/1.5K/2K；生成默认 2K；比例 1:1、4:3、3:4、16:9、9:16、3:2、2:3、21:9、2:1、1:2；亦接受相应 x 写法 |
| 精确尺寸 | 正整数 WIDTHxHEIGHT；921,600–4,624,220 像素，宽/高在 1/16–16；省略 resolution |
| 背景、格式 | auto/transparent/opaque，默认 auto；PNG/JPEG，默认 PNG；透明必须 PNG |
| 拆分 | size 优先于 resolution，默认 auto；仅 auto/1K/1.5K/2K；禁止 background 字段；max_images=2–100，默认 30，包含底图，是上限而非数量保证；图层为透明 PNG |
| OCR | text_recognition 布尔值，默认 false；有提示词时可能不返回 OCR，结果始终按可选字段处理 |
| 其他 | n=1；watermark 布尔值；提示词优化仅 standard，不能关闭；无流式、顺序多图或工具调用 |

本地检查原生字段、组合、数量、声明格式和字节数。真实解码格式和输入像素由上游
检查。输入参考图单独计费；拆分按实际返回图层计费，不能按 max_images 保证产量。

## Seedance 2.5

有参考素材时默认全能参考（omni_reference_task_type=reference），图片、视频、音频
分别使用 reference_image/reference_video/reference_audio；单张图片也不自动设为首帧。
无参考素材时使用文生视频，不填参考任务类型。用户明确要求时才切换首帧、首尾帧、
编辑或延长模式。

| 输入 | 登记限制 |
| --- | --- |
| 总数量 | 全模态参考最多 50 个文件：30 图片、10 视频、10 音频；首帧 1 张、首尾帧 2 张，与全模态参考互斥 |
| 图片 | JPEG/PNG/WebP/BMP/TIFF/GIF/HEIC/HEIF；每张严格小于 30 MB；每边 300–6000 像素；宽/高 0.4–2.5 |
| 视频 | MP4/MOV；H.264/HEVC；MP4 音轨 AAC/MP3，2.5 教程允许 MOV 音轨 AAC/MP3/PCM；每个 ≤200 MB；每边 300–6000；407,696–8,295,044 像素；宽/高 0.4–2.5；24–60 FPS |
| 视频时长 | 每个 2–30 秒；编辑输入每个 4–30 秒；全部视频累计 ≤30 秒 |
| 音频 | WAV/MP3；每个 ≤15 MB、2–30 秒；全部音频累计 ≤30 秒；无需强制搭配视觉参考 |
| 原生请求体 | ≤64 MB，使用 URL 引用后的 JSON 大小，不是所有引用文件的字节总和 |
| 提示词 | 推荐中文 ≤500 字、英文 ≤1000 词，属于建议而非硬限制；上游允许参考输入时省略文本，当前客户端要求完整提示词 |
| 人像 | 普通上传不等于授权。直接真人人脸图/视频需遵守官方已授权人像、预置虚拟人像或可信原始生成产物规则；可信原始产物有同上游账号、30 天等来源限制 |

文档中的 MB 在客户端字节校验中按 1024² 字节处理。模型登记保留原文单位及开闭边界。
输出 480p/720p/1080p，默认 720p；24 FPS、双声道；MP4（默认）或 MOV；
MOV 为 H.264/yuv444p/PCM。输出宽高比为 16:9/9:16/1:1/21:9/4:3/3:4/adaptive，
默认 adaptive；时长 4–30 整数秒或 -1（自动，客户端默认），实际结果可能不同。
客户端固定 generate_audio=true。首尾帧仅 adaptive；edit 需要参考视频、adaptive、
duration=-1；extend 需要参考视频、adaptive，duration 为最终总时长。
execution_expires_after=3600–259200（上游默认 172800），priority=0–9（默认 0），
safety_identifier 最多 64 个 ASCII 字符。watermark、return_last_frame 为布尔值。

官方另支持 web_search 和两阶段样片；登记中明确其为客户端未接入能力，生成 schema
不提供这些字段。样片预览仅 480p，成片仅 1080p；2026-10-28 10:00 UTC+8 起样片
任务有效期 14 天，两阶段独立计费，复用参数不得重传。不得宣称官方不支持样片或联网。

本地检查参数、角色、数量、声明格式和字节数。像素、比例、编解码、帧率、单段和
累计时长、人像来源授权仍由上游检查。聊天附件上传仍使用原版限制；较大允许文件可
从会话获准的工作目录读取。仅 DoneBot 参考媒体读取使用模型上限，不改原版文件机制。

## Suno v6

客户端固定 version=v6、custom=true、auto_lyrics=false；instrumental 必须明确传入。

| 项目 | 登记与本地校验 |
| --- | --- |
| 纯音乐 | instrumental=true，省略 prompt；编曲、乐器及情绪放 style；不传 vocal_gender |
| 带歌词歌曲 | instrumental=false，prompt 为完整歌词，≤5000 Unicode 字符；已有歌词原样保留；需要创作歌词时由当前 LLM 写好后提交歌曲生成 |
| 文本 | title≤80、style≤1000 Unicode 字符；negative_tags 官方未单独公布长度限制，不编造数值 |
| 声线 | vocal_gender 可选 Male/Female；官方亦接受 m/f/male/female |
| 时长 | duration=10–360 整数秒，表示目标，不保证精确成片时长 |
| 格式 | mp3/m4a/wav；客户端默认 mp3，上游未声明固定默认 |
| 权重 | style_weight、weirdness_constraint、audio_weight 都在 0–1 |
| 其他 | variety=off/normal/high/extra/max，无固定默认；max_mode 默认 false，开启为普通请求价格的两倍 |

不开放灵感模式、v6-mini/v6-wild、自定义模型、persona、参考输入、翻唱、续写或单独
歌词生成接口。不添加官方生成接口未列出的 nsfw_check。一次任务可能返回多首音乐，
客户端收集全部结果，不为获取另一版本重复付费提交。

## 上传与验证边界

客户端到网关的三类生成均为异步任务。客户端参考上传不再用通用 32 MiB 上限拦截
合法视频；图片和音频仍执行各自上限。网关上传默认值为 200 MiB；已保存的管理员
策略和已有显式配置继续生效。部署时须核对上传策略、gateway.max_body_size 及反向
代理请求体上限；上传需预留 multipart 开销，不能用 64 MB 原生 JSON 限制代替上传限制。

离线验证使用临时 HOME、数据目录及 loopback fake gateway：包括首轮 schema、非法
模式/参数、Unicode 边界、33 MiB 视频引用、纯音乐/歌词歌曲原生请求及原会话结果回传。
这些检查不代表线上模型的质量、响应时间或真实人像授权验收。
