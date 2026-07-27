CHANGES REQUESTED

# Flywheel v2 设计稿 v9 复审 R9

- 评审对象：`/tmp/design/design-v9.md`
- v9 SHA-256：`15306f3b03ea44c01a4007fdfd4c25f5f40affeb79672160d904bba79be47423`
- R8 基线：`/tmp/design/codex-verdict-r8.md`（SHA-256 `cb397b6ee43d919a9c4fedd741b3655df34a621b4ebbc21ab20335f6fc93d58a`）
- 仓库锚点：本地 `main@83a90791665372ee07b19bb8b48e5f5f2daf30ee`；本地 `origin/main@37bcb8e2d4d12869cd5afbc52700d37a5902ed1f`，checkout 落后 1 个提交，工作树无改动。
- 评审边界：只复核 R8 第 169-175 行列出的 R9 五项最小修改，并检查这些修改引入的新矛盾；R6/R7/R8 已闭合项没有重开。

## 结论

两项已实质闭合：

1. `processing_attempts` 的单 running DB 不变量、start 事务和三类 settlement CAS 合同成立（`design-v9.md:12-29`）。SQLite 3.51.0 的真实双连接交错中，第二个 running insert 被 `pa_one_running` 拒绝，最终同一 `message_uid` 只有一行 running。
2. 两张表的 DDL 已改为合法 SQLite；在 `PRAGMA foreign_keys=ON` 且父表存在时可原样建表、建三个 partial unique index，`foreign_key_check=0`（`:12-24`、`:64-74`）。founder `_f` predicate/index 也通过 immediate 与 scheduled 两个 R8 反例（`:47-60`）。

但仍有 2 个 HIGH 和 2 个 MEDIUM：

1. 队首 SLA 与 q=1 参数化公式互相矛盾，且两式都没有覆盖一条消息最多 5 个 processing attempt、每次换代与配额周期；
2. restart ledger 没有可恢复的 hold/threshold-claim 状态，spool→外部 meta-alert 的 crash window 也没有幂等投递协议；
3. founder 查询的谓词和索引正确，但 v9 仍以 `...` 代替 R8 要求的四条可执行 exact SELECT；
4. 父抑制子仍挡不住“子已 claim、父后 open、子再发送”，并引用了没有迁移进 schema 的 `suppressed_tier`。

因此 R9 不能批准。

## 阻断项

### HIGH-1：SLA 公式在 q=1 已自相矛盾，且遗漏 retry/换代的重复成本

v9 把队首硬保证写为：

```text
T_tick + T_deliver + (K+1)×T_max + T_switch
```

（`design-v9.md:35`），但紧接着一般公式在 `q=1` 时化为：

```text
T_tick + T_deliver + (K+2)×T_max + T_switch
```

（`:36`）。默认参数下分别是约 57 分钟和 67 分钟；同一个“最老 ready 非 founder”不能同时有两个硬上界。

`(K+2)×T_max` 的额外一项是可达的：普通消息 A 已在途且剩余接近 `T_max`，目标 B 在 A 运行期间成为当前最老 ready 非 founder；A 完成后配额允许 K 个 founder，再执行 B。仅转化时间就是“在途 A + K 个 founder + B”=`(K+2)×T_max`，已经推翻 `:35`。

更大的缺口来自 attempt 状态机本身。v9 要求失败累计 5 次才 dead（`:29`），`T_max` 又从每一行 `processing_attempts.started_at` 单独计时（`:32`）。在 founder 洪泛下，目标每次失败回到 pending/ready 后都可能再经历 K 个 founder 配额；每次超时还可能各有一次 `T_switch`。因此 ready→dead 的成本可包含：

```text
最多 5 个目标 attempt
+ 每个目标 attempt 前最多 K 个 founder attempt
+ 每次 retry due/tick/deliver 等待
+ 每次超时后的 probe/cutover
```

而 `:35-36` 只预算一个 `T_switch`，一般式也只按初始队列名次 q 计一轮普通消息。`:33` 的 `T_deliver≤60s` 只是“重试退避 cap”，不是 deliver 阶段的总 deadline；单次 sleep 有上限不等于持续失败能在有限时间内结束。这也使 `:37` 声称的“deliver 持续失败”wall-clock 断言无法从当前公式推出。

最小修订：

1. 只保留一个公式，并要求一般式在 `q=1` 时严格等于队首式；明确是否计入当前在途 work。
2. 引入目标及前序消息的剩余 attempt 上界（至少包含 `5-retry_count`），逐 attempt 计 founder 配额、retry due/tick、deliver 总 deadline 和 `T_switch`；或者把 SLA 明确降级为“单 attempt 被首次选中后的上界”，不得再声称 ready→applied/dead。
3. `T_deliver` 要定义为“从应投递到成功或将 attempt 结算失败的总时限”，不能只定义 backoff cap。
4. 用五次失败、每次前有 K 个 founder、每次 timeout+switch 的反例计算期望 deadline；不能只把场景名写入验收。

### HIGH-2：restart ledger 缺 durable hold/alert 状态机，指定 crash replay 仍不能成立

`:79-80` 只定义“append event→读最近 10 分钟计数→超限写 spool 并调用 meta-alert”，`:82` 却要求 resume “清除 hold”。文档没有定义 hold 存在哪里、何时原子建立、以后每次 wrapper 启动如何 fail-closed 检查，也没有定义“读计数、记录本次 restart、决定是否 exec child”的顺序。若只靠 10 分钟滑窗，旧事件自然过期后计数会降到 5 以下，child 会在没有 resume 的情况下再次被自动拉起；若靠 spool 兼作 hold，则必须明确其状态、原子创建/目录 fsync、损坏读取策略和 resume CAS。

`:83` 还要求“spool+meta-alert 恰一”并覆盖告警提交前/后崩溃，但 `:80-81` 没有 alert claim/receipt 或把稳定 episode id 传给具备幂等能力的 sink。可达交错：

1. 写 spool 后、发送前崩溃：若后继只按“spool 已存在”跳过，会漏告警；
2. 发送后、记录完成前崩溃：若后继重放，会重复告警。

当前仓库只证明独立通道存在，不证明 exactly-once：`scripts/flywheel-bridge-wrapper.sh:76-86` 在 Bridge 外调用 `meta-alert.sh`；`scripts/meta-alert.sh:33-53` 是基于 marker mtime 的 debounce + 本地文件/桌面 best-effort，没有送达 receipt；现有 wrapper 最后还会 `exec` 被监督进程（`scripts/flywheel-bridge-wrapper.sh:211-220`），并不是持续存活的监督者。因此 v9 需要明确这是一个新的启动 gate/状态机，而不能只引用现有 wrapper 先例。

最小修订：

1. 为每个 `child_key` 定义一份 crash-safe episode/hold 状态（例如 `active→held(alert_pending)→held(alert_attempted)→resumed`），以文件锁或单写进程保证原子阈值 claim；状态写采用临时文件 fsync + rename + 目录 fsync，或等价可证明协议。
2. 明确 restart event 的线性化点：第 1-5 次何时 fsync、何时 exec child，第 6 次如何在 crash replay 后仍必定被 hold。
3. 后续每次 OS supervisor 拉起 wrapper 时先读 durable hold；滑窗过期不得隐式解除 hold，只有带权限的 resume CAS 能解除。连续健康 30 分钟只定义 resume 后何时结束旧 episode。
4. durable incident spool 可以 exactly-once；外部 meta-alert 应写成“带稳定 episode key 的 at-least-once/debounce”，除非 sink 提供幂等 receipt。相应修正 `:83` 的“恰一”验收。

### MEDIUM-1：founder predicate 已正确，但 R8 要求的 exact SELECT 仍未落文档

`:47-55` 的 `_f/_nf` partial index 合法，`:59` 也明确了 founder 与非 founder 谓词；按其意图补全 SELECT 后，SQLite 反例与 query plan 都通过。

但 `:59` 仍以：

```text
... AND source_kind='founder' ...
... AND source_kind<>'founder' ...
```

描述四路查询，而不是 R8 第 65/172 行要求的四条可执行 SQL。`:60` 又要求“六路候选逐条 EXPLAIN”，但文档本身没有给出六条可直接交给迁移测试的 SELECT；本轮实测必须从 v7/v8 继承文本人工重建 `next_retry_at<=:now`、`ORDER BY` 和 `LIMIT 1`。

最小修订：原样贴出 immediate/scheduled × founder/non-founder 四条完整 SELECT（含 `:agent/:now`、ORDER BY、LIMIT 1），并让 query-plan 测试直接导入这些语句，消除实现自行补全的空间。谓词/索引本身无需再改。

### MEDIUM-2：父抑制子仍有 claimed 竞态，且 notification debt 没有可执行 schema

`:89` 的 claim predicate 只在领取时检查“无匹配 open parent”。以下交错仍合法：

1. child command 从 pending 成功 claim，当时 parent 尚未 open；
2. parent obligation 随后 open；
3. 已 claimed 的 child dispatcher 执行外部发送。

claim predicate 不会再次作用于已 claimed command，所以父子同时 open 时仍可能发送 child，直接推翻 `:92` 明列的“claim 后 parent open”验收。外部发送前再做一次普通查询仍是 TOCTOU；必须给 parent-open 与 send authority 一个可线性化的仲裁合同，或明确“child claim 先赢则允许 child 发”，并据此收窄验收。

持久 debt 也没有落到 schema。`:9` 明确 §1.1 沿用 v8；v8 的 obligations 增列不含 `suppressed_tier`，但 `:90` 直接要求 obligation 写该字段。真实迁移无处存这类 debt。另一个内部矛盾是：

- child command 在 parent open 前插入时，按继承的 §3.1 已推进 `last_notified_tier`；
- parent 后开时，`:90` 只让 command 留在 pending，并未回滚或分离这个进度；
- `:91` 却声称解抑时“此时才推进 last_notified_tier”。

这没有满足 R8 “被抑制的 debt 不得消耗 last_notified_tier”的合同。

最小修订：

1. 在 obligations 重建迁移中真实增加并约束 `suppressed_tier`，或给 commands 增加明确的 `suppressed` 状态/债务表；补 migration/FK/CHECK/replay 测试。
2. parent-open 事务必须原子处理匹配的 pending child command；对 claimed/sending 状态定义胜负与外部 effect 语义。若坚持严格抑制，需 dispatcher fencing token 与 parent-open 仲裁，不能只靠 claim 时一次查询。
3. 分离 `last_enqueued_tier`、`suppressed_tier`、`last_notified_tier`，明确各自在 enqueue、effect receipt、parent open、parent clear 时的单调转换。
4. 用真实 fault injection 执行 `:92` 四种交错，尤其是 claim commit 后、外部 send 前打开 parent。

## SQLite 实测

环境：SQLite `3.51.0`。为两张子表建立了最小合法父表 `mailbox(message_uid UNIQUE)` 与 `attempts(id PRIMARY KEY)`；v9 `:12-24`、`:64-72` 的 DDL 原样执行，未修写设计 SQL。

```text
ddl_tables|2
ddl_indexes|3
fk_violations|0
```

### `pa_one_running` 真实双连接交错

连接 A：`BEGIN IMMEDIATE`，插入 `pa-holder/message=ordinary-immediate/outcome=running`，保持事务 2 秒后提交。连接 B 在 A 持锁期间发起自己的 `BEGIN IMMEDIATE`；A 提交后，B 获得写锁并尝试插入同 message、不同 `attempt_no` 的第二行 running：

```text
holder_rc|0
contender_rc|1
Runtime error: UNIQUE constraint failed: processing_attempts.message_uid (19)
running_count|ordinary-immediate|1
```

这证明 `pa_one_running` 在 SQLite 的真实 writer 串行化下拒绝并发 start 产生第二行 running。该项闭合。

### founder 池谓词反例

数据：

- immediate：普通 `seq=1`，founder `seq=2`
- scheduled/due：普通 `seq=3`，founder `seq=4`

结果：

```text
generic_immediate|ordinary-immediate|lead
founder_immediate|founder-immediate|founder
nonfounder_immediate|ordinary-immediate|lead

generic_scheduled|ordinary-scheduled|lead
founder_scheduled|founder-scheduled|founder
nonfounder_scheduled|ordinary-scheduled|lead
```

计划：

```text
founder immediate:
SEARCH mailbox USING INDEX mailbox_pending_immediate_f (to_agent=?)

founder scheduled:
SEARCH mailbox USING INDEX mailbox_pending_scheduled_f
  (to_agent=? AND next_retry_at>? AND next_retry_at<?)
```

所以 R8 发现的“基础池被误称 founder 池”反例，在 v9 的 `_f` 谓词/索引语义下已关闭；剩余问题是 exact SELECT 未写全和上层 SLA 不成立，不是 `_f` 索引失效。

## R9 五项逐项裁定

| 项 | R9 状态 | 核对结果 |
|---|---|---|
| 1 单 running + CAS | 闭合 | DDL partial unique 实测拒绝真实双连接第二行 running；start IMMEDIATE、重放复用、三类 outcome CAS 与双行数回滚合同完整（`:24-29`）。 |
| 2 公平池 `_f` + SLA | 部分闭合 | `_f` 谓词、索引、immediate/scheduled 反例通过；exact SELECT 仍是省略号；SLA q=1 自相矛盾且遗漏多 attempt/多 switch（`:33-37`、`:47-60`）。 |
| 3 restart ledger + meta-alert | 未闭合 | 外置单一 authority、spool、kernel 恢复后投影方向正确；缺 durable hold/threshold claim 和 spool→alert crash-replay 状态（`:79-83`）。 |
| 4 父抑制子 | 未闭合 | matching key、pending claim predicate 与最新 tier 解抑方向正确；claimed→parent-open 竞态仍在，`suppressed_tier` 无迁移，tier 进度语义冲突（`:86-92`）。 |
| 5 两表可执行 DDL | 闭合 | 原样建表/建 index 成功，FK 检查为 0；activation 双 partial unique 保留（`:12-24`、`:64-74`）。 |

## R10 最小修改集

1. 统一并重算 ready→terminal SLA：q=1 必须等于队首式；纳入当前在途 work、剩余 processing attempts、每轮 K 配额、retry due/deliver 总 deadline 和逐次 switch。
2. 写出 durable restart episode/hold/alert 状态机与第 1-6 次的线性化顺序；把外部 meta-alert 验收改成稳定 key 的 at-least-once/debounce，或接入有幂等 receipt 的 sink。
3. 贴出四条完整 founder/non-founder SELECT。
4. 把 `suppressed_tier`/command suppression 落到迁移，并定义 parent-open 与 claimed/sending child 的胜负及 `last_notified_tier` 转换。
