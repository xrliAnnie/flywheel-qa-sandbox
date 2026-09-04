# FLY-2222 inbox 判据卫生 — 调研
Issue: FLY-2222 (https://linear.app/geoforge3d/issue/FLY-2222/判据卫生-runner-的-inbox-查询看不到已注入的-lead-指令no-instructions被当成没有新指令的假阴性两名-qa)
日期: 2026-09-03
基于: exploration.md

## 1. 原始症状与新鲜复核

本 implement exec 在任务轮次开始后第一次查询得到 `No instructions.`；数分钟后再次查询，读到
Lead 新指令 `[lead-instruction 2222-scope]`。该指令提供了 2026-09-04 01:00Z 快照：四个 Codex
exec 共 14 条 `state=QUEUED`、`last_error` 为空的消息仍未被租出。

不能直接采信描述，因此对生产 CommDB 做了 `sqlite3 -readonly` 复核。约 01:35Z 的当前状态为：

| exec | issue | QUEUED response | LEASED response | distinct leased batches |
|---|---|---:|---:|---:|
| `8baa35c5…` | FLY-2147 | 7 | 3 | 3 |
| `b5e9b95d…` | FLY-2301 | 4 | 3 | 3 |
| `0f39390f…` | FLY-2296 | 0 | 3 | 3 |
| `234ed33e…` | FLY-2302 | 0 | 1 | 1 |

快照之后 `0f39390f…` 的两条与 `234ed33e…` 的一条已经推进到 ACKED/LEASED，说明队列在动；
`8baa35c5…` 与 `b5e9b95d…` 的 11 条仍真实 QUEUED。所有这些 live 行都是 `type=response`，
各自 `ref_id` 指向该 runner 发给 `flywheel-eng-lead` 的 question。Lead 把它们统称“指令”在产品
语义上可以理解，但数据库类型并不是 instruction。

## 2. inbox 的真实查询面

`packages/flywheel-comm/src/commands/inbox.ts` 调用 `CommDB.getUnreadInstructions(execId)`，随后对
每条结果 `markInstructionRead`。

`packages/flywheel-comm/src/db.ts` 的 `UNREAD_INSTRUCTIONS_SQL` 要求：

```sql
m.to_agent = ?
AND m.type = 'instruction'
AND m.state IN ('QUEUED','LEASED')
AND p.read_at IS NULL
AND datetime(p.expires_at) > datetime('now')
```

因此同一 runner、同一 carrier、同样 QUEUED/LEASED 的 response 结构上永远不进入结果。当前
`packages/flywheel-comm/src/index.ts` 只根据 `instructions.length` 打印 `No instructions.`，完全没有
检查 mailbox 里是否还有 response。

## 3. response 为何需要单独保留消费合同

`CommDB.insertResponse` 根据原 question 的 `from_agent` 把答复 enqueue 给 runner，类型固定为
`response`。`packages/teamlead/src/bridge/runner-mailbox-lane.ts` 不把 response 正文直接当普通指令：

- gate answer 只注入“该 gate 已答复”的无权威 doorbell；
- ordinary ask answer 注入 question id，并要求 runner 执行 `flywheel-comm check <id>`。

所以 inbox 不应直接返回/ACK response 正文。本单只需告诉 runner“仍有 live mailbox item”，再让
它走既有 `check` 权威路径。

## 4. 队列为何能长期 QUEUED（背景，不在本单修复）

默认 `inflightMaxBatches=3`。`claimRunnerBatch` 在目标 runner 已有 3 个未消费的 LEASED batch 时，
不再租出新 batch。三个苦主在复核时都恰有 3 个 distinct LEASED batches；后续 response 因此留在
QUEUED。这解释“有行但没排上”，但 Lead 明确要求不改租约/投递，本单只修自查可见性。

## 5. 可复用索引与查询形状

`mailbox_live` 是 partial index：

```sql
CREATE INDEX mailbox_live
ON mailbox(to_agent, seq)
WHERE state IN ('QUEUED','LEASED');
```

候选摘要 SQL 以 `to_agent=?` + 相同 state predicate 定位，再限定：

```sql
recipient_kind='runner'
AND carrier='inbox'
AND type IN ('instruction','response')
ORDER BY seq
```

第一轮设计评审指出：原候选额外添加的 `expires_at` 与 `superseded_by` 条件比实际 delivery claim
更窄。`claimQueueBatch` 对 QUEUED/LEASED runner row 不使用 expiry 或 supersede 条件；所以即使某行
`expires_at` 已过，它仍可能被实际租出。观察查询若排除它，会重造本单要消灭的假阴性。修订后的
查询只使用 delivery lane 的稳定身份/state 条件，并从 response row 的 `ref_id` 派生 distinct
question id。

在 646MB 生产 CommDB 上的只读 `EXPLAIN QUERY PLAN` 命中 `mailbox_live (to_agent=?)`，没有裸扫
mailbox。实现测试必须让 SQLite 自然选择该索引；不得用 `INDEXED BY` 把实现和 schema 名称硬耦合。

## 6. 已注入历史是另一条轴

Claude runner mailbox 使用 `on_delivery` settlement，transport 写入成功后 batch 可直接 ACKED；Codex
使用 `on_consume`。无论哪家，已消费/ACK 后都不属于 live backlog。于是即使 backlog 摘要为零，
也不能证明会话历史没有 `[lead-instruction <id>]`。第一轮设计评审建议给每次空 inbox 加 caveat；
Lead 的 `[lead-instruction 2222-ruling-byte-identical]` 明确否决该扩域：本单判据是队里是否还有待投
行，已投递且 ACKED 属于会话记忆/历史查询问题。空轮询是高频正常路径，永久 caveat 会退化成噪音，
还会稀释本单新增的“pending 非零”强信号。

因此本单不靠回放 ACKED rows 冒充“模型已处理”，也不改真空输出。已 ACKED 后发生压缩/换体遗忘的
风险如实记为已知未覆盖；建议后续设计显式历史查询命令，按需读取最近已注入 instruction。
对应 blocking finding 已由 Lead 监督登记为 `overruled`，ruling id
`d2ebf5e3-009a-4800-970c-6fc4ffd43160`；follow-up 风险继续保留，不得写成 resolved/fixed。

## 7. 测试缺口与映射

| 要求 | 现有覆盖 | 新增覆盖 |
|---|---|---|
| QUEUED response 可见 | 无；CLI 只测 instruction | CLI 黑盒构造 question→response，断言 pending 摘要、真实 question id 且无 `No instructions.` |
| 不消费 response | response 状态机分散覆盖 | command 测试连续两次调用都返回同一 pending count |
| expiry 与 claim 对齐 | 无 | 把 QUEUED response 的 expiry 改到过去，仍必须出现在摘要 |
| ACKED 历史边界 | 无 | 首次 inbox 消费 instruction，第二次仍精确输出 `No instructions.` |
| 真空字节兼容 | 精确断言 `No instructions.` | 保留原断言不改 |
| SQL 不裸扫 | unread/claim 有 query-plan 测试 | 新摘要 SQL 自然 `EXPLAIN` 命中 `mailbox_live` |
| 两家 runner pending 动作 | Codex capability + Claude snapshot | 参数化 Claude/Codex prompt 断言逐个 question id `check` |
| JSON/非空兼容 | CLI 既有用例 | 原数组与非空测试保持全绿 |
