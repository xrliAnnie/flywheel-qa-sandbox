# FLY-1439 插件收据 producer 真机验收 — S3 证据摘要
Issue: FLY-1439 (https://linear.app/geoforge3d/issue/FLY-1439/qafly-1437-独立真机验收-插件收据核销-producerfork-pr-17-bb0a1509)
日期: 2026-07-23
基于: plan.md

## 结论

S3 通过：记账与 recovery-intent 都无法持久化时，真 Discord 消息仍投递给
Lead，且出现恰一条专属 advisory；故障解除后健康路径与可写 spool 恢复路径
均正常。所有可建账的有效 test root 已到 `processed`，spool、settle 与 barrier
均清空。

## M6：ENOTDIR fail-open

- M6 `1529808056618188831` 在 `fail-begin` 下发出；测试原子挪开 mode 0700
  的 spool 目录，并以 mode 0600 普通文件占据同一路径。
- Lead pane 显示 M6 真正到达；按消息要求没有回复。
- canonical DB 行数为 0，说明没有伪造 pending/delivered。
- Discord advisory `1529808058148982945` 内容精确包含
  `could not persist its recovery intent for message 1529808056618188831`；
  M6 之后的 API 结果中该 advisory 恰一条、reply reference 为 0。
- driver 的 `finally`/成功路径均把原目录移回；复原后目录仍为 0700。

## M7：健康阳性对照

- M7 `1529808671612211282` 正常 begin/complete，真 Lead 回复
  `1529808686241943623`，Discord reference 精确指向 M7。
- DB `created_at=11:13:29.783Z`、`delivered_at=11:13:30.332Z`、
  `processed_at=11:13:33.521Z`，evidence 为原 reply id。

## M8：可写 spool 恢复变体

有效 M8 `1529809599803162738`：

- `fail-begin` 时 mode 0600 intent 落盘；捕获时 `attempts=1`。
- shim 账本显示同一 M8 的 initial + worker 两次 failed begin，证明可写
  intent 确实驱动了重试而非静态文件假象。
- 恢复 passthrough 后发真 Discord kick
  `1529809601954840708`。intent 被删除，M8 建成唯一 canonical root，
  `[redelivery]` 在真 Lead pane 可见并完成 delivery。
- kick 的真回复 `1529809649316921395` 精确引用 kick，kick receipt processed；
  M8 随后从真 Lead pane、lease generation 34 以唯一 request id ack，
  `processed_at=11:17:45.267Z`。
- M8 没有 Discord reply；场景最终无 begin/settle intent、mode 或 barrier。

## Harness artifacts（不计产品 verdict）

- M8 首次 driver 把「intent 文件出现」误当成「失败次数已回写」，在
  `saveBeginIntent(attempts=0)` 与 `markIntentAttempt(attempts=1)` 之间采样，
  因硬断言失败而立即复原 passthrough。该 root 随后按合同从真 Lead pane
  关闭；driver 修成等待 `attempts>=1` 后重跑，得到上面的有效 M8。
- S2c 已提交有效证据之后，forced restart 后的 Lead 会话丢失了对首次回复的
  记忆，错误地声称 M5 未回复并在 11:13 补发第二条。Discord API 证明原回复
  `1529806019893526528` 与晚到回复 `1529808762800439326` 同时存在；canonical
  DB 始终保留原 evidence，冲突 settle 被 CLI 拒绝。为避免该 Lead-context
  artifact 污染 S3，精确的冲突 intent 连同 API/DB 快照被隔离存档后移出活跃
  spool。此事件不改变 S2c 的 write-ahead + 同 evidence 幂等结论；它作为
  「不同 evidence 冲突会进入重试 spool」的非阻塞 follow-up 记录。
