# FLY-2461 中文批准 — 调研
Issue: FLY-2461 (https://linear.app/geoforge3d/issue/FLY-2461/founder-ux静默失败-批准只认英文approve-look-good-to-me打回却认中文打回-founder)
日期: 2026-09-09
基于: exploration.md

代码基线 04ff8800a；证据为当前源码，不依赖历史消息的未知 anchor。

| 路径 | 当前行为 | 实施含义 |
| --- | --- | --- |
| workflow-rework-hint.ts | 共享英文批准词表，NFKC/trim/lowercase，去句号感叹号但保留问号 | 在同一 helper 增加五个中文词，不改 normalize |
| founder-review-response.ts | classify 使用共享 helper；writer 校验 owner/run/digest/最新问题/门开放 | 无需放松 writer |
| approval-signal/text-approval-source.ts | canonical founder + replyToCard 后才分类 | 中文支持自然进入 ship 路径；保留 anchor guard |
| founder-reply-deliverer.ts | 验证 Discord reply 类型、channel、卡绑定；否则转 Lead | 在 Lead 转达成功后为未绑定的精确批准词增加无授权作用的提示 |
| 同文件现有 explainer | 只对 anchored neither 发一次；词表提示英文 | 同步中文说明；不复用其先 claim 后发送的失败语义到新提示 |
| founder-thread-notifier.ts / gate-materializer.ts | 卡片仍宣称批准只认英文 | 同步实际协议并锁文案测试 |

已有 emitFounderReplyDeliveryForThread 测试使用真实 CommDB，注入 Discord 消息、cursor、binding store、postThreadReply，可验证 response 不存在、游标失败重试及恢复。现有 shared writer 测试负责 run/digest/最新轮 guards。新增用例必须经过 ingress 而非仅 helper。

新提示发送 false、throw 或 sender 缺失均返回失败 outcome，复用 retry ledger 和 cursor pin；不会成功消费后静默丢弃。成功发送后正常推进 cursor；重建 cursor store 后不重复正常已消费消息。发送成功但游标保存前崩溃允许提示重复，不能假称 Discord 外部副作用 exactly-once。无需数据库 schema/migration；rollback 为 revert 代码，不改历史 verdict。
