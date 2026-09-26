# FLY-2757 附件逐项判定 — 探索
Issue: FLY-2757 (https://linear.app/geoforge3d/issue/FLY-2757/附件范围-同批次里一个无类型超大附件会把合法附件一起否掉拒绝原因给错了范围应逐个附件独立判定fly-2638-复审)
日期: 2026-09-24
基于: 无

## 问题与目标

FLY-2638 已让 Raya 能按 `deliveryId + attachmentId` 读取单个 Discord 附件，但下载原语在解析 Discord 消息时先用一个严格 schema 校验整组 `attachments`。同组任一条目缺少 `content_type`、超过消息级 schema 的 25 MiB 上限或含其他非法元数据时，整条消息会被判为 `invalid_metadata`，导致请求的是另一个合法附件也无法读取。

本单只修这个范围错误：每次读取只由目标 `attachmentId` 的 type/size/URL 等结论决定；坏附件仍返回属于自己的显式原因，合法附件正常交付内容。

## 当前数据流

```mermaid
flowchart LR
  A[同一 Discord 消息的附件列表] --> B[按 deliveryId 和 attachmentId 发起读取]
  B --> C[Bridge 拉取消息元数据]
  C --> D[当前: 严格解析整组附件]
  D -->|任一坏条目| E[整次读取 invalid_metadata]
  D -->|全部合法| F[定位目标并下载]
```

根因位于 `packages/teamlead/src/lead-capabilities/discord-attachments.ts`：`inboundMessageSchema` 把严格的 `inboundAttachmentSchema` 应用于数组中的每个条目，然后才按 `attachmentId` 查找目标。该顺序把消息级结构校验与目标附件策略校验混成了同一范围。

## 期望边界

- 消息级只校验消息 ID、频道 ID、附件数组形态与最多 10 项。
- 在原始附件数组中按 `attachmentId` 精确定位，0 个返回 `not_found`，重复返回 `invalid_metadata`。
- 仅对定位到的目标附件执行既有严格 schema 与 MIME、size、URL、下载内容校验。
- 不改变 5 MiB 图片、32 KiB 文本、15 秒超时、CDN allowlist、凭据隔离、receipt/carrier 授权或错误枚举。
- 不处理 FLY-2638 的其他 advisories：projects-file 双解析、zero-byte 图片原因文案、旧计划 full-access 文案漂移。

## 验收证据

新增实际同批次回归用例：一个超大或无类型附件与一个合法图片共存。读取合法图片时必须返回真实图片字节；读取坏附件时必须返回该附件自己的 `too_large` 或 `unsupported_type`，且不得访问坏附件的 CDN。把实现改回“整组严格校验”后，该用例应稳定变红。
