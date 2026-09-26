# FLY-2757 附件逐项判定 — 调研
Issue: FLY-2757 (https://linear.app/geoforge3d/issue/FLY-2757/附件范围-同批次里一个无类型超大附件会把合法附件一起否掉拒绝原因给错了范围应逐个附件独立判定fly-2638-复审)
日期: 2026-09-24
基于: exploration.md

## 结论

根因可稳定定位为“先校验整组，再选择目标”：`fetchInboundDiscordAttachment` 在 Discord message JSON 上调用 `inboundMessageSchema.parse`，而该 schema 的 `attachments` 是 `z.array(inboundAttachmentSchema)`。因此任何 sibling 缺 `content_type`、size 超过 25 MiB 或其他字段不合规，都会在目标 `attachmentId` 选择之前让整个 parse 失败并统一映射为 `invalid_metadata`。

这与现有公开合同冲突：工具输入一次只指定一个 `attachmentId`，FLY-2638 的计划也要求“一次读取一个”，type/size 与 MIME/byte 策略应属于目标附件，而不是消息批次。

## 代码证据

| 位置 | 当前行为 | 与本单关系 |
|---|---|---|
| `packages/teamlead/src/lead-capabilities/discord-attachments.ts` | `inboundMessageSchema.attachments` 严格校验每一项 | 直接根因 |
| 同文件 `fetchInboundDiscordAttachment` | 整组 parse 后才 filter 目标 ID | 判定顺序错误 |
| 同文件 `inboundAttachmentSchema` | 要求合法 snowflake、0–25 MiB、URL、非空 `content_type` | 应保留，但只作用于目标 |
| 同文件 `normalizeInboundMime` / `inboundLimits` | 支持 PNG/JPEG/WebP ≤5 MiB、UTF-8 text ≤32 KiB | 目标级策略，不改 |
| `chat-delivery-envelope.ts` 与两个 Discord producer | 入站元数据按附件逐项产生 `unavailableReason` | 已有逐项表达，不需重做 envelope |
| `inbound-attachment-scope.ts` | 按 envelope 中唯一 attachment ID 捕获单附件 scope | receipt/carrier 授权已是单附件，不改 |

## 最小实现形状

将消息 schema 收窄为：严格校验 `id`、`channel_id`，`attachments` 只要求是最多 10 项的对象数组。解析消息并确认 message/channel 后，用原始条目的 `id` 做精确匹配；只对唯一目标调用现有 `inboundAttachmentSchema.parse`。目标不存在仍为 `not_found`，重复目标 ID 或目标字段畸形仍为 `invalid_metadata`。随后沿用现有 MIME、期望元数据、大小、URL 与内容校验。

不能使用 `z.unknown()` 接受任意标量 sibling 后再忽略，因为 Discord attachment 集合的每一项仍应是对象；保留对象数组边界可以避免输入形状过度放宽，同时不会让 sibling 的 type/size 影响目标。

## 测试设计

在 `packages/teamlead/src/lead-capabilities/__tests__/discord-attachments.test.ts` 增加一个真实 `fetchInboundDiscordAttachment` 同批次用例，metadata response 同时含：

1. 合法 PNG（小尺寸、合法 CDN URL）；
2. 同消息中的坏附件（建议覆盖无 `content_type` 和超大两种表格行）。

断言读取合法 PNG 返回原始 bytes 与 `image/png`；针对坏附件单独读取时分别得到 `unsupported_type` 或 `too_large`，且坏附件不触发 CDN 下载。该测试直接经过生产下载原语，不只检查源码或 mock 调用次数。

阴性对照为把实现恢复到 `z.array(inboundAttachmentSchema)` 的整组校验：合法 PNG 的读取会在 metadata parse 阶段收到 `invalid_metadata`，新增用例必红。

## 验证范围

- 必跑新增/受影响的 `discord-attachments.test.ts`。
- 按 changed-file consumer sweep 保留直接消费者测试：Bridge router 与 attachment-read 集成面。
- TypeScript changed-file `vitest related ... --run`、`pnpm lint`、`flywheel-teamlead` 依赖构建与 typecheck。
- 不跑本地全包 suite；不请求 full CI。QA 后续拥有 frozen-head exact-head CI。
