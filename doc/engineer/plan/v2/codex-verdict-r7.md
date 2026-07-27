CHANGES REQUESTED

# Flywheel v2 设计稿 v7 复审 R7

- 评审对象：`/tmp/design/design-v7.md`
- v7 SHA-256：`aa7953ef0c1fc95e3ab8fe1a9f4a85713bd6d6284c645d58f6df01bf5dd86fb3`
- R6 基线：`/tmp/design/codex-verdict-r6.md`
- v5 继承基线：`/tmp/design/design-final.md`
- 仓库锚点：本地 `main@83a90791665372ee07b19bb8b48e5f5f2daf30ee`；本地 `origin/main` 引用为 `37bcb8e2d4d12869cd5afbc52700d37a5902ed1f`，checkout 落后 1 个提交。
- 评审边界：只按 R6 第 186-194 行的 7 组最小修改集核对闭合性，并检查 v7 新引入的矛盾；R6 已判闭合的 8 项没有重开。

## 结论

v7 已正确关闭 shim 独立 ack、outbox 完成定义、N5 三分、terminal task→successor、open episode 历史语义、mailbox-vs-command claim 术语和缺失场景清单等问题；两条 mailbox 领取分支的 SQLite 索引也实测通过。

但仍有 3 个 HIGH 和 1 个 MEDIUM：

1. runner 的“周期 pull”仍被写成可丢的 `hint`，processing-attempt 又没有成功结算和 attempt-start authority fence，无法可靠区分成功、旧世代越权启动和真实 crash；
2. `LIMIT 20` 候选集会把 ready 普通消息挡在公平选择器之外，K=4 和时间上界可被直接反例推翻；侦测查询也没有 exact SQL，无法完成承诺的 query-plan 证明；
3. v7 声称保留 v5 obligations schema，却没有把继承的 `target_task_id NOT NULL` 改为 nullable，agent target 仍然无法入库；同时把 backlog subject 与通知收件人混成同一个 `target_agent_id`；
4. activations 约束允许同一个 `session_ref` 同时绑定两个 active attempt，换代、旧 activation terminal 和 capability revoke 也没有被定义为一个原子事务。

因此 R7 不能批准。

## 阻断项

### HIGH-1：runner 活性仍依赖可丢 hint；processing-attempt 没有完整、受 fence 保护的生命周期

v7 先明确门铃只降时延、不承担活性（`design-v7.md:6,26-30`），但 runner 的低频机制仍写成“回合边界 + kernel 周期 hint”（`:29`）。`hint` 的正式接口也只是向 vendor session 注入“有新消息”门铃（`:71-74`）。空闲 runner 没有回合边界；如果周期 hint 丢失，文中没有 consumer-side 周期 pull、kernel 直接 query+deliver，或对 hint/deliver 的 durable retry/确认机制。于是“无新流量且门铃丢失仍最终 applied/dead”的验收（`:89-90`）对 runner 仍没有机器保证。当前 Lead 现实代码的 `start()` 首拉、1s/30s timer 和 single-flight 是实际 pull，不是仅发送 hint（`packages/teamlead/src/bridge/lead-inbox-loop.ts:22-24,124-153,367-382`）。

attempt 归因也只定义了：

- 开始前写一条 `started` event（`design-v7.md:37-38`）；
- 显式失败结算（`:39`）；
- 新世代把旧世代“未完成”记录结算成 crash（`:40-41`）。

缺少两个必要状态转换：

1. 成功转化时，没有要求在“业务行 + `pending→applied`”同一事务把该 attempt 结算为 `succeeded`（`:22-25,38-41`）。因此成功提交后崩溃与真正转化中崩溃在 attempt ledger 上不可区分。
2. attempt-start 是 events 写，不属于 `:24` 列出的 mailbox applied/retry/dead CAS；`:38` 没有要求同时校验 `state='pending'` 和当前 `{instance_id,generation,activation_id}`。旧世代可在 cutover 后写出一条新的 started event，随后被新世代错误归因为实际 crash failure。

把 started record 放在会被归档的 events 表，还需要定义 open attempt 的 archive eligibility；否则活着卡死时间足够长时，启动 reconcile 可能失去热区归因证据。v7 没有给出该规则。

最小修订：

1. runner 的周期机制必须独立于 vendor 回合和可丢 hint：例如 kernel timer 实际查询 ready mailbox，并 durable/retriable 地 `deliver(message_uid,payload)`，或 runner 自身保持有确认的周期 pull；due scheduler 重启后必须重建最早 due，并在未观察到 pull/终态前重试。
2. 为 processing-attempt 定义可查询的完整状态机。start 事务必须校验 pending + 当前 instance/generation/activation；成功必须与业务行和 applied 在同一事务结算；explicit/crash failure 必须按稳定 attempt id exactly-once 结算，并只作用于仍 pending 的消息。
3. 若继续复用 events，明确 started/succeeded/failed/crash 的关联键、未完成判定 SQL和 open attempt 不得被归档的规则；更直接的方案是独立小表。
4. 增加 cutover 后旧世代 attempt-start 被拒、成功 apply 后立即崩溃不计 crash、started event 面临 archive tick 的交错验收。

### HIGH-2：公平选择器看不到候选集之外的普通消息，K=4 与时间上界不成立

公平合同要求连续 founder 最多 K=4，随后必须处理最老 ready 非 founder（`design-v7.md:42-46`）。实际查询却只从 immediate 和 scheduled 分支各取前 20 条，再在最多 40 条中应用公平选择（`:47-55`）。这两支 SQL 都没有为非 founder 保留候选。

本机 SQLite `3.51.0` 用 v6 mailbox schema、v5 两个 partial index 和 v7 新 age index 实测：

```text
分支 1: SEARCH mailbox USING INDEX mailbox_pending_immediate (to_agent=?)
分支 2: SEARCH mailbox USING INDEX mailbox_pending_scheduled
        (to_agent=? AND next_retry_at>? AND next_retry_at<?)
```

两支索引命中本身通过。但插入同一收件人的 25 条 immediate founder（seq 1-25）和 1 条已 ready 普通消息（seq 26）后，v7 分支 1 的 `LIMIT 20` 候选为：

```text
founder|20
```

全表最老 ready 非 founder 明明是 `seq=26`，应用层却看不到它。处理 4 条 founder 后重新查询，下一批仍可全是 founder；若前方有 N 条 founder，普通消息会等待约 N 条，而不是 K 条。持续 founder 洪泛验收（`:92,101`）也不能修复查询本身。

时间上界同样没有真正量化。`:43,46,92` 只写“一条转化时长”或“分钟级”，没有配置的 `T_max`、超时终止/换代点和从 ready 到 applied/dead 的精确定义；`(K+1)×转化时长+超龄提升` 仍是符号表达式，不是可执行的 wall-clock 断言。

侦测 query-plan 也无法按原文完成：v7 只给了 age index DDL（`:55-59`），没有给 detector 的 exact SQL。按 per-recipient 推导：

```sql
... WHERE to_agent=:me AND state='pending' AND created_at<=:cutoff
    ORDER BY created_at LIMIT 1
```

实测为：

```text
SEARCH mailbox USING COVERING INDEX mailbox_pending_age
  (to_agent=? AND created_at<?)
```

若 detector 是一次全局 `GROUP BY to_agent`，实测则是：

```text
SCAN mailbox USING COVERING INDEX mailbox_pending_age
```

两种 plan 和成本不同；设计不能用未给出的查询声称“侦测查询命中对应索引”（`:59,84`）。

最小修订：

1. 把公平配额落实到 SQL 候选合同：至少独立查询最老 ready 非 founder（immediate/scheduled 都覆盖），或使用不会被 founder 前缀遮挡的分层 cursor/索引；配额状态也要定义持久或明确的进程内恢复语义。
2. 给出完整、可执行的三类 exact SQL 和 DDL：ready immediate、ready scheduled、公平兜底/aging，以及 detector；逐条附真实迁移和 `EXPLAIN QUERY PLAN` 断言。
3. 定义单条转化硬上限 `T_max` 及卡死后的硬终止/换代动作，并按“ready 时刻→applied/dead 时刻”重新推导包含当前在途项和自身处理时间的上界。
4. 验收加入“普通消息在前 20 候选之外”和 immediate/scheduled 两类都被 founder 前缀遮挡的反例。

### HIGH-3：agent obligation 在继承 schema 下仍无法入库，且 subject 与通知 recipient 被混为一列

v7 的 §1.1 标题明确“同 v5 全部保留 + 新增”，然后只说 obligations 增列（`design-v7.md:19-20`）。但 v5 的 `target_task_id` 是 FK `NOT NULL`。v7 没有声明删除该 NOT NULL 或重建表，所以即使新增 `target_kind='agent'`、`target_agent_id` 和 exactly-one CHECK，agent 行仍必须伪造一个 task id。

按继承约束实测插入：

```sql
INSERT INTO obligations(
  state,target_task_id,episode_key,target_kind,target_agent_id
) VALUES(
  'open',NULL,'mailbox_backlog:runner-1','agent','lead-1'
);
```

结果为：

```text
NOT NULL constraint failed: obligations.target_task_id
```

此外，§3.1 把 `target_agent_id` 写成“收件人的监督者”（runner→owning Lead、Lead→founder，`design-v7.md:79-81`），但验收又称“目标 runner terminal 时告警到 owning Lead”（`:94`）。这混淆了：

- episode 的 subject：谁的 mailbox 积压；
- obligation 的负责/销账对象；
- notification command 的当前收件人。

若 runner-1 的 episode 行直接 target 到 lead-1，schema 中没有 agent target 指向 runner-1；owner 换代后还会保留旧 lead target。`episode_key` 文本里藏着 runner id 不能替代结构化 FK/authority。

最小修订：

1. 明确 obligations 表重建迁移：`target_task_id` 改为 nullable，`target_agent_id` 作为 backlog subject，DB CHECK 保证 task/agent exactly one，并分别定义 FK 或 registry revalidation。
2. 通知收件人不要复用 subject 列；在同一 kernel 事务按当前 registry/监督关系推导 active supervisor，或增加语义明确的 recipient 字段。owner 变化与 terminal recipient 必须重新验证路由。
3. 增加真实迁移测试：旧 task obligation 保真、agent insert 成功、两类双空/双填均失败、runner owner 换代后通知新 owner、runner terminal 后 subject 仍可审计且通知活监督者。

### MEDIUM-1：activation binding 没有封住同一 session 的双 active，换代也未原子化

terminal task→successor 规则已经恢复正确（`design-v7.md:61-65`）。但 activations 的唯一约束只有“每 attempt 至多一个 active activation”（`:65`），没有“每 session_ref 至多一个 active activation”。按 v7 约束，以下状态合法：

```text
attempt 1 -> same-session, active
attempt 2 -> same-session, active
```

SQLite 实测插入后得到 `same-session|2`。这与“resume 可复用外部 session，但旧 activation 置 terminal、旧 capability 撤销”的同一句合同冲突（`:65`）。

同时，旧 attempt/activation 终止、旧 capability revoke、新 attempt/activation 建立和 consumer-registry cutover 没有被明确规定为一个 immediate transaction。`:66` 只列“crash-replay 验收”，不能阻止崩溃窗口留下双 active 或无 active。`UNIQUE(attempt_id) WHERE state='active'` 在 SQLite 迁移中还必须实现为单独的 partial unique index，不能作为表内 UNIQUE constraint 原样执行。

最小修订：

1. 增加 `UNIQUE(session_ref) WHERE state='active'` 的 partial index，或给可复用 execution body 单独建表并让 activation FK 到它，同时保持每 body 单 active generation。
2. 明确一个 kernel immediate transaction 完成旧 activation terminal、capability revoke、新 attempt/activation、registry cutover；稳定 activation id/request id 保证 crash replay 幂等。
3. 给出 executable DDL，并验收在每个可注入 crash 点重放后恰有一个 active activation、一个 current generation、旧 capability 全部拒绝。

## R6 最小修改集逐项核对

| # | R7 状态 | 核对结果 |
|---|---|---|
| 1 | 部分闭合 | 注册首拉、Lead 周期 pull、due scheduler、terminal recipient 方向已补；runner 仍靠可丢 hint，attempt 缺成功结算与 start fence。 |
| 2 | 部分闭合 | registry、事务 cutover、进程内 single-flight、mailbox apply/retry/dead fence 已补；processing-attempt start 不在该 fence 内，activation 约束另见 MEDIUM-1。 |
| 3 | 闭合 | shim 无 ack、proposal 只进 kernel、outbox 完成定义和 N5a/b/c 一致（`design-v7.md:70-76,98`）。 |
| 4 | 未闭合 | 两条基础索引实测通过；公平候选集可遮挡普通消息，时间上界未量化，detector exact SQL 缺失。 |
| 5 | 部分闭合 | terminal task→successor 已恢复；activation/session 单活和原子换代未封住。 |
| 6 | 未闭合 | 单事务四步、tier、effect_key 已补；继承的 target_task_id NOT NULL 使 agent row 不可入库，target 又与 notification recipient 混淆。 |
| 7 | 闭合 | open episode/历史行数、mailbox-vs-command claim 术语、N5/N10/N12 和 N13-N22 场景文字均已补（`design-v7.md:4-10,82,96-101`）；场景指向的实现合同仍受上述 #1/#4/#6 阻断。 |

## R8 最小修改集

1. 把 runner 的周期驱动从可丢 hint 改为真正的 pull/query+deliver 活性机制；补 processing-attempt 的 start fence、同事务 success settlement、exactly-once failure settlement 和归档规则。
2. 重写公平候选 SQL，保证 K 配额所需的最老 ready 非 founder 一定进入候选；定义 `T_max` 和精确 wall-clock 上界。
3. 给出 detector exact SQL，并对 ready 两分支、公平兜底/aging、detector 分别跑真实 `EXPLAIN QUERY PLAN`。
4. obligations 迁移显式把 `target_task_id` 改 nullable；区分 backlog subject 与当前通知 recipient，并补 owner 换代测试。
5. activations 增加 active session 唯一约束，并把旧 activation/capability、新 attempt/activation 和 registry cutover 定义成一个可幂等重放的事务。
