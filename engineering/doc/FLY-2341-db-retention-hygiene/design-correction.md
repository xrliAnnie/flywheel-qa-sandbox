# FLY-2341 终态数据库冷热分层 — 设计修正
Issue: FLY-2341 (https://linear.app/geoforge3d/issue/FLY-2341/引擎db-卫生-数据库无保留策略终态行只增不减teamleaddb-598mb-commdb-639mb让维护扫描随历史线性变慢)
日期: 2026-09-04
基于: plan.md

## R1 结论

R1 gate `b5e5189c-ddb7-4817-88c3-e17300cee1d6` 返回 `CHANGES_REQUESTED`。本修正不改变产品范围，
只收紧 eligibility、兼容合同和同步执行预算；`plan.md` 已原位同步。

| finding | 设计修正 | 可执行证明 |
| --- | --- | --- |
| HIGH: founder-review family 非 exact reader | cold row 保存 `subject_id` 并建索引；hot log miss 后按 subject 从 cold 重建 family | founder-review family compact 后仍可读测试 |
| HIGH: durable claim 混入 narrative allowlist | 从新 runtime 和旧 FLY-2006 operator 的 session/lead allowlist 删除 `external_merge_suspect` | 两条 allowlist 负控测试 |
| HIGH: active lineage 不完整 | 调用输入携带全部 CommDB running execution/issue；函数再合并 TeamLead live session、active/held run/node，并以 `json_tree` 排除 payload 中 active execution/issue/run exact scalar；任一 CommDB snapshot 失败即整 tick 不归档 | held node、Comm running、payload lineage 负控 + production schema 测试 |
| MEDIUM: TeamLead 时间格式 | 所有 TeamLead 边界/排序用 `julianday()`，并显式 `IS NOT NULL`；invalid time/payload fail-close | mixed-format/invalid fixture 与 expression-index plan |
| MEDIUM: mailbox 72h 被误改 | mailbox family archive 与 cleanup floor 保持 72h；只有 identity/log cold compaction 固定七天 | 精确 72h 与七天双边界测试 |
| MEDIUM: cold 增长与净 bytes | cold evidence 本单永久保留以满足回滚；明确不承诺 TeamLead 总文件 bytes 下降。rehearsal 同时报 hot/cold/total bytes 和一年线性投影；云端切口按日期映射分区/外部冷存储 | rehearsal JSON/文档 |
| MEDIUM: 无 off-switch | 新增 project-scoped、default-on `database_archive`；flag 不可读时 fail-close。关闭只停新 cold compactor，不停既有 mailbox family archive/content-ref GC | flag live-off、Comm runtime、TeamLead wiring 测试 |
| MEDIUM: 同步 pass 无预算 | TeamLead 固定 100 rows + 25ms，Comm 固定 25 identities + 25ms；TeamLead production 每 tick 轮转一张 source table，不连续跑三表 | fake-clock hard-budget、hard-cap、worst-case/query-plan 测试 |
| MEDIUM: event-id replay receipt | `event='progress'` 的 identity/log 整体留 hot，以 `(message_id,event)` anti-join/index fail-close，不让 cold fallback 猜测 receipt | progress receipt compaction 返回 0 测试 |
| LOW: fixture 偏离 production | eligibility 至少在 `StateStore.create()` 的真实 migration schema 上执行；手写 fixture 只做精确故障注入 | production-schema test |
| LOW: drain horizon 未量化 | runtime 总上限 28,800 rows/day；三表轮转单表 9,600/day，当前最大约 100k backlog 的 runtime-only 最坏约 10.5 天。一次性 operator 负责先清初始 debt；rehearsal 必须证明 drain rate 大于近期 insert rate | retention-rates + rehearsal batch metrics |

## 明确不做

- 不归档 `workflow_alert_outbox`、`alert_delivery_receipts` 或其他 current authority 表；
- 不为 `resumeMailboxInflightHold` 发明不可靠的 cold event lookup；progress receipt 保持 hot；
- 不改 FLY-2339 的三段算法和 guard 阈值；
- 不做 sharding/Postgres adapter/cold pruning。cold 日期列是未来云端分区切口，不是假装当前 SQLite 已分区。

## R2 修正

R2 gate `a15b7c17-bd94-41d6-ae93-4a2bdbb9a18c` 返回 `CHANGES_REQUESTED`。本轮仍不改变产品范围：

| finding | 设计修正 | 可执行证明 |
| --- | --- | --- |
| HIGH: 部分 compact 的 founder-review family 丢行 | subject reader 每次都查 hot 与 cold，以 message id 去重并按原 `seq` 排序，不再 short-circuit | question 先 cold、response 先 cold 两种 `limit:1` fixture |
| MEDIUM: cold table 未分类 | `workflow_terminal_archive` 列为 TeamLead protected authority，`mailbox_terminal_archive` 列为 Comm protected current/authority；同步 production table fixture 与计数 | FLY-2006 全文件单 fork 22/22 |
| MEDIUM: restore→re-archive 毒化 compactor | restore 保留原 archived log；re-archive 核对并复用 immutable cold payload/时间；compactor 每 identity 独立 transaction，坏行报警但不回滚旁路 identity | restore→archive→compact 成功 + cold digest 故障隔离测试 |
| LOW: cold 长期增长 | rehearsal 按实测 cold 平均 row bytes 外推一年，作为未来云端日期分区/外部冷存储输入 | rehearsal JSON/文档 |
| LOW: candidate SELECT 未受 deadline 中断 | 不宣称 SQLite SELECT 可抢占；rehearsal 的 max batch wall time覆盖完整 API（含 SELECT），并单列 mostly-protected 查询耗时 | rehearsal batch/query-plan 指标 |

隔离的 529 快照还暴露两个升级边界并纳入同轮：旧 CommDB 缺 `mailbox_identity.terminal_at` 时须在主 schema
之前安装迁移；历史 `workflow_run_event_no_delete` 只有在不可变 cold row 逐字段等值时才允许归档删除。两者
均以生产历史 schema fixture 先红后绿。

## R3 结论与 advisory 收口

R3 gate `5caf0643-fae1-4de2-8334-395ea9cea2f1` 返回 `APPROVED`。非阻塞 advisory 中，operator 的
per-identity reporter 和逐轮 active-lineage refresh 已以行为测试补齐；plan 也明确 evidence-gated trigger
是一次性 schema migration，`database_archive` 只停归档写入、不还原旧 trigger。测试直接导入 `dist/`
的 build 前置条件写入验证顺序。两个 carried LOW 由 rehearsal 输出量化，不再新增抽象或配置。
