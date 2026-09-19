# FLY-2638 Discord 附件内容可达 — 探索
Issue: FLY-2638 (https://linear.app/geoforge3d/issue/FLY-2638/raya附件收件-discord-图片文本仅到达yuan数据lead-无法读取内容)
日期: 2026-09-18
基于: 无

> R2 更正（2026-09-18）：以下初轮研究中可复用 v2 parent/artifact 路径的建议已撤销。Raya 实际为 v1，persona gate 拒绝 v2；有效方案为 plan.md R2 的 lead_actions 原生 MCP image/TXT，Lead 已批准有界修正。初轮证据保留作设计沿革，不是实施指令。
## 目标与证据边界
Annie 在 #raya 要求验证「收到附件内容」，没有要求解释测试文件。标准 Discord → Bridge → mailbox → Raya Lead 必须提供实际图片/文本内容或可用的授权读取入口，保留原消息身份；失败必须说清原因。

现场只知道最终 Lead 输入：
- 1549844512120115290：Screenshot_2026-09-16_at_10.37.41_AM.png；image/png；19.05078125 KB。
- 1549847787707961349：recovered-sublime-note-2026-09-16.txt；text/plain;charset=utf-8；0.79296875 KB。不能推断 PNG 转成 TXT。
- 来源频道 1542079099928059987。没有取原文件、查询历史 Discord 消息或解释附件。

本次基线 bd2fc7dfe。当前源码证明标准信封只承载 name/type/sizeKb；不等同于证明两条历史消息具体在哪个部署版本丢失。生产根因和端到端可用性留给实施/QA 实测。

## 已确认约束
1. `chat-delivery-envelope.ts` 的 attachment 类型和 normalize 都仅保留三项元数据。
2. `discord-chat-ingest.ts:renderDiscordChatContent` 只输出自闭合 metadata tag。
3. 已有 `discord.message.attachments.get` 需要 attachmentId，入站信封没有该字段。
4. 该操作用 `discord.thread.read` 的 issue thread 授权，不能直接读取普通 #raya 父频道附件。
5. 下载成功只返回 artifactHandle+bytes；标准 MCP 代理只输出 JSON 文本，没有把图像字节变成模型图片输入。
6. 因此只补 URL、只补 attachmentId、只在 prompt 告诉 Lead 下载，均不能闭合整个验收。

## 方案比较
| 方案 | 优点 | 代价/结论 |
|---|---|---|
| 自动把所有附件内联进 mailbox | 不需额外调用 | mailbox 持久化私密正文，重放/大小/多模型载体复杂；不选 |
| 把 Discord CDN URL 直接给 Lead | 改动小 | 链接会过期，暴露签名链接，要求模型网络访问；不选 |
| 用原消息+附件身份，通过现有 Bridge 能力通道按需读取 | mailbox 仍只保留元信息；内容授权集中；无需 bot token 暴露 | 新增 mailbox 收件绑定授权与 typed content 输出；推荐 |

选定第三种。新增标准 `discord.inbound.attachment.read`，输入 deliveryId+attachmentId，服务端从可信 mailbox 查询原频道/消息；不改变原 thread.get 的权限，不另建 Discord 收件通道。原生图片工具输出和文本工具输出作为模型内容，不能把 base64 字符串当作可视图片。

## 范围
- PNG/JPEG/WebP 与 UTF-8 TXT 的受限读取，类型/大小/下载失败明确反馈。
- 普通频道和已有线程路由均要测试；replyRoute 与 source channel 独立。
- 无视频、PDF、HTML 执行、OCR 服务、新账号、新机器人、原文件内容日志、历史批量补采。
- 接入标准 Lead 能力清单，对 Claude/Codex 共用代理做契约验证；生产验收以实际 Raya 当前 carrier 为准，不切换 Raya backend。
- DM 不扩权限；无现有当前路由授权则明确不可用。

## 设计授权与进度
注入任务已经选定技术设计、full 文档范围及设计审查流程，不追加 brainstorm/founder 审批。已向 Lead 非阻塞询问更新决策：0d4cede1-9547-4ee2-83db-dc807372c671。Linear MCP 当前不可用，使用注入的完整 issue 说明及当前 inbox 为任务来源。
