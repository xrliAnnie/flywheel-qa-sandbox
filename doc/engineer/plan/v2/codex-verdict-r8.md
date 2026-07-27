CHANGES REQUESTED

# Flywheel v2 设计稿 v8 复审 R8

- 评审对象：`/tmp/design/design-v8.md`
- v8 SHA-256：`b6798997f0244f71473497721e41285d9c6aa10c4611d06208ebf12ee74d653e`
- R7 基线：`/tmp/design/codex-verdict-r7.md`
- 仓库锚点：本地 `main@83a90791665372ee07b19bb8b48e5f5f2daf30ee`；本地 `origin/main@37bcb8e2d4d12869cd5afbc52700d37a5902ed1f`，checkout 落后 1 个提交。
- 评审边界：只复核 R7 第 167-173 行的 R8 最小修改集，以及 v8 新增的 §0.5b、§2.11、§3.2；R6/R7 已闭合项没有重开。

## 结论

v8 的指定 SQLite 正向验证通过：两个 `_nf` partial index 可建，四路候选和 detector 均 `SEARCH` 命中对应索引；25 条 founder + 1 条普通消息的 immediate 与 scheduled 反例里，普通消息都由 `_nf` 路返回。runner 的 kernel query+重复 deliver、processing attempt 独立热表、obligations subject/recipient 分列、第二个 activation partial unique index和 SQLite 写纪律的方向也正确。

但仍有 3 个 HIGH 和 2 个 MEDIUM：

1. `processing_attempts` 没有“每消息最多一个 running”的 DB 不变量，重复 durable deliver 可并发开多个 attempt，随后一次进程崩溃可被重复计失败；
2. `(K+2)×T_max=60min` 不是“任一 ready 普通消息”的 wall-clock 上界，四路候选里的所谓 founder 池也没有 founder 谓词；
3. 重启风暴计数没有持久 authority，且 kernel 自己崩溃并停止重启时没有存活的 obligation writer；
4. 父抑制子没有定义 pending command 的 claim 抑制与解抑后的通知债务，两个验收方向都可被合法交错推翻；
5. activations/processing_attempts 代码块不是可执行 SQLite DDL；activations 的两个 partial unique index 在修正表 DDL 后本身有效。

因此 R8 不能批准。

## 阻断项

### HIGH-1：重复 deliver 可为同一消息建立多个 running attempt，crash/failure 不再是一消息一次

runner 会在未观察到消息终态前重复 `deliver(message_uid,payload)`，并明确依赖重复消费幂等兜底（`design-v8.md:22-24`）。但 attempt 表只有 `UNIQUE(message_uid, attempt_no)`（`:27-34`）；只要两个 start 分配不同的 `attempt_no`，二者就都可插入。start fence 只校验 mailbox pending 和当前 instance/generation/activation（`:35`），没有校验或约束“该 message 已有 running attempt”。这直接推翻“并发 start 同 message 只一行 running”的验收（`:40`）。

用修正了 `CHECK(...)`/`PRIMARY KEY` 拼写后的 v8 预期表结构实测：

```text
INSERT a-1(message=m-1, attempt_no=1, outcome=running)  -- 成功
INSERT a-2(message=m-1, attempt_no=2, outcome=running)  -- 成功
running_for_same_message|m-1|2
```

这不只是重复计算：若两行都属于随后死亡的同一个 activation，新世代按 `attempt_uid` 逐行 crash 结算（`:38`）可把一次进程死亡计成两次 `retry_count+1`，提前进入 dead；一条 late success 与另一条 explicit failure 的交错也没有 `outcome='running'` 的状态转换 CAS 合同。

最小修订：

1. 增加可执行 partial unique index，例如 `UNIQUE(message_uid) WHERE outcome='running'`；start 必须在一个 `BEGIN IMMEDIATE` 事务中同时校验 current registry、mailbox pending、无 running，并原子分配 attempt_no/稳定 attempt_uid。
2. deliver 重放在已有 running 时只复用该 attempt，不另开一行；若需要真正并行 speculative attempt，则必须另写赢家仲裁和一次失败计数合同，不能继续声称单 running。
3. success/explicit failure/crash 都以 `WHERE attempt_uid=? AND outcome='running'` CAS；涉及 retry/dead 的事务还必须校验 message 仍 pending，attempt CAS 与 mailbox CAS 的预期行数均为 1，否则整事务回滚。
4. 增加“deliver 在首次转化未完成时连续重试”“同 activation 多次 start 后 crash”“late success 与 failure/crash 交错”的验收。

### HIGH-2：`60min` 只可能约束受限队首场景，不是任一 ready 普通消息的 wall-clock 上界

v8 声明配额计数器重启归零且“上界仍成立”（`design-v8.md:41-42`），随后把“任一 ready 普通消息”从 ready 到终态的上界写成 `(K+2)×T_max=60min`（`:43-45`）。该式只包含 1 个在途项、K 个 founder 和目标自身；它没有包含：

- 目标前方任意数量的更老普通消息或晋升后同级的更老消息。单消费者下，仅 7 条同时 ready、各耗满 10 分钟的普通消息，就不可能保证第 7 条在 60 分钟内终态；
- ready 后等待 kernel tick、deliver 重试退避、垫片不可用、硬终止探针和换代的时间。`:24` 没有给这些阶段的最大间隔，`:43` 的 `T_max` 只从“单条转化”计时；
- 重启归零带来的额外 K 个 founder 周期。30 分钟晋升只能让目标进入 founder 同级，不能越过任意数量更老的同级行。

所以该保证至多适用于“当前最老 ready 非 founder、进程不重启、pull/deliver/cutover 延迟另有硬上限”的受限场景，不能量化为任一消息的固定 60 分钟 SLA。

候选合同还有一个独立矛盾：`:59` 把 v7 的基础分支称为“founder 池”，但它引用的 SQL 没有 `source_kind='founder'`。实测 immediate 队列为普通 `seq=1`、founder `seq=2` 时，基础分支与 `_nf` 分支都返回普通 `seq=1`，≤4 个候选里根本没有 founder；应用层无法执行承诺的 founder 有界优先。

最小修订：

1. 把保证精确限定为“最老 ready 非 founder”，或给一般第 q 条消息写出包含前序队列长度/容量与 admission 条件的可证明上界；固定 60 分钟不能量化任意深度的串行队列。
2. 给 kernel tick、deliver backoff、探针和 cutover 分别配置硬上限，并把它们纳入 ready→applied/dead 的 wall-clock 公式；T_max 应明确从 durable attempt start 还是 deliver 发起计时。
3. 配额状态要持久化，或重启时恢复一个不会增加已欠普通配额的保守状态；验收加入第 4 个 founder 后、强制普通选择前重启。
4. 真正写出四条 SQL。若要 founder 优先，founder 两支必须带 `source_kind='founder'`，并提供对应可界定扫描成本的索引/plan；不能把“全来源最早行”称为 founder 池。
5. wall-clock 验收同时覆盖多个普通消息排队、旧 founder backlog、deliver 一直失败、换代和配额边界重启。

### HIGH-3：重启风暴上限在 supervisor/kernel 故障下既不耐重启，也无法保证告警

§2.11 把 kernel 服务本身与桥、垫片、Lead 启动器一起置于监督树中，并要求第 6 次停止重启后创建恰一 obligation（`design-v8.md:79-82`）。但设计没有说明：

- 5 次/10 分钟计数存在哪里、由哪个稳定 logical child key 归并、supervisor 自己重启后如何恢复；
- 多个监督层（如 OS supervisor 与进程内 supervisor）如何共享同一计数，避免各自给出 5 次额度；
- 当超限对象就是唯一 kernel 服务时，谁还能执行 §3.1 所依赖的 kernel obligation 写事务（`:84-87`）；
- “第 6 次不再拉起”与“告警恰一条”之间的 crash/ack-loss 窗口如何以稳定 episode/effect key 重放。

这是可达的静默失效：内存计数随 supervisor 重启清零，风暴可无限继续；若计数不清零并停止 kernel，调用已死亡 kernel 创建 obligation 又永远不能完成。当前仓库已有 Bridge-independent fail-loud 通道作为现实先例（`scripts/flywheel-bridge-wrapper.sh:76-86`），v8 没有为 kernel-down 场景引入等价权威。

最小修订：

1. 在 kernel 之外定义 crash-safe restart ledger：稳定 child key、窗口算法、原子计数/阈值 CAS、supervisor 重启恢复和多层 supervisor 单一 authority。
2. 超限时先写独立 durable incident spool，并走不依赖 kernel/Bridge 的 meta-alert；kernel 恢复后以稳定 episode key 投影为 obligation。不得让外部 supervisor直接绕过 kernel 写 flywheel-v2.db。
3. 定义何时解除 hold、谁可人工恢复，以及连续健康多久后重置窗口。
4. 验收增加 supervisor 自身在第 4/5 次间崩溃、kernel 连续崩溃、告警提交前后崩溃、多监督层同时观察同一 child。

### MEDIUM-1：父抑制子缺 notification command 的持久状态机

§3.1 仍以 obligation id+tier 作为通知 `effect_key`（`design-v8.md:84-87`），§3.2 只说父 open 时抑制通知、父清后子补通知（`:88-89`）。以下交错没有被封住：

1. 子 obligation 先 open，四步事务已推进 `last_notified_tier` 并插入 pending command；
2. 父 obligation 随后 open；
3. dispatcher 不受任何已定义的 claim predicate 阻挡，仍可发送子 command，违反“父子同 open 时只发父”。

若实现选择 cancel 该子 command，则父清后 tier 已推进、同一个 `obligation_id+tier` effect key 又已占用，没有新 tier 变化来创建补发 command，反而违反“父清后子补通知”。仅说“抑制只作用通知层”不足以决定 pending/claimed/succeeded/canceled 各态的行为。

最小修订：

1. 定义机器可查询的父子匹配键/关系，不只给示例文案。
2. dispatcher claim 必须把“无匹配 open parent”作为领取条件；被抑制的通知保留显式 notification debt，不能消耗 `last_notified_tier`。
3. 父清账事务或 reconcile 必须原子解除 debt，并以稳定且不冲突的 effect key 使子通知重新可领取。
4. 验收覆盖 child-command-before-parent、parent-before-child、claim 后 parent open、父清账前后 crash replay。

### MEDIUM-2：声称可执行的 activation DDL 实际不能创建表

v8 的 activation 代码块使用 `id TEXT PK` 和 `state TEXT NOT NULL CHECK IN (...)`，随后称其为“可执行 DDL”（`design-v8.md:67-76`）。本机 SQLite 3.51.0 原样执行：

```text
Parse error ... near "IN": syntax error
no such table: main.activations
```

即使只把 `CHECK IN` 改成 `CHECK(state IN (...))`，SQLite 也把 `TEXT PK` 当作声明类型而不是主键：

```text
PRAGMA table_info(activations):
0|id|TEXT PK|0||0
duplicate_activation_ids|dup|2
```

`processing_attempts` 的 `TEXT PK` / `CHECK IN` 同样存在（`:27-34`）。另一方面，在改成 `TEXT PRIMARY KEY` 与合法 `CHECK(...)` 后，两个 activation partial unique index实测会拒绝同 session 第二条 active 行；约束方向正确。

最小修订：给出完整可执行的两张 `CREATE TABLE` DDL（合法 `PRIMARY KEY`、`CHECK(...)`、列类型、FK），配合 `PRAGMA foreign_keys=ON` 的真实迁移测试；保留已验证有效的两个 partial unique index。

## SQLite 实测

环境：`sqlite3 3.51.0`。按 v6 mailbox 列定义建立测试表，并原样执行 v8 第 49-57 行的 5 个索引。

```text
index_count|5
plan_immediate
SEARCH mailbox USING INDEX mailbox_pending_immediate (to_agent=?)
plan_scheduled
SEARCH mailbox USING INDEX mailbox_pending_scheduled
  (to_agent=? AND next_retry_at>? AND next_retry_at<?)
plan_immediate_nf
SEARCH mailbox USING INDEX mailbox_pending_immediate_nf (to_agent=?)
plan_scheduled_nf
SEARCH mailbox USING INDEX mailbox_pending_scheduled_nf
  (to_agent=? AND next_retry_at>? AND next_retry_at<?)
plan_detector
SEARCH mailbox USING COVERING INDEX mailbox_pending_age
  (to_agent=? AND created_at<?)
```

25 founder + 1 普通消息：

```text
immediate 旧 LIMIT 20: founder|20
immediate v8 _nf:     26|ordinary-26|lead
scheduled 旧 LIMIT 20: founder|20
scheduled v8 _nf:     26|ordinary-26|lead
```

所以 v8 第 47-65 行确实关闭了 R7 的“founder 前缀让普通候选不可见”和 detector exact SQL/query-plan 问题；本轮公平性阻断来自更上层的 selector/SLA 合同，而不是 `_nf` 索引失效。

## R8 修改集与 DR 新增逐项核对

| 项 | R8 状态 | 核对结果 |
|---|---|---|
| 1 runner pull + processing attempts | 部分闭合 | kernel 真 query+deliver 活性方向闭合；独立表和 success/failure/crash 结算方向正确；同消息单 running 未被约束。 |
| 2 公平候选 + T_max | 部分闭合 | `_nf` 两路与 25+1 反例实测通过；founder 池 SQL 不含 founder 谓词，任意消息固定 60min 上界不成立。 |
| 3 detector exact SQL | 闭合 | per-recipient SQL 明确，registry 枚举避免全局 GROUP BY，实测命中 age covering index。 |
| 4 obligations 重建 | 闭合 | 明确 nullable 重建、task/agent exactly-one、subject/recipient 分列与五类迁移验收；未发现本轮边界内新阻断。 |
| 5 activations | 部分闭合 | 双 partial unique 与原子换代/稳定重放方向闭合；表代码块不是可执行 SQLite DDL。 |
| DR §0.5b SQLite 写纪律 | 闭合 | IMMEDIATE、busy_timeout 工厂、短写事务、短读者、本地盘与禁非主线特性构成可验收纪律。 |
| DR §2.11 重启风暴 | 未闭合 | 缺持久计数 authority 与 kernel-down 告警路径。 |
| DR §3.2 父抑制子 | 未闭合 | 缺 command claim 抑制、notification debt 与解抑重放合同。 |

## R9 最小修改集

1. processing_attempts 加每 message 单 running DB 约束；start 和三类 settlement 使用明确 CAS/行数合同，并补重复 deliver/late settlement 交错。
2. 修正公平池 exact SQL；把 SLA 限定为可证明的队首范围或引入 backlog/capacity 参数，补齐 pull/deliver/cutover 上限与配额重启语义。
3. 为重启风暴定义 kernel 外的 durable restart ledger + kernel-independent incident spool/meta-alert，再幂等投影 obligation。
4. 为父抑制子定义匹配键、dispatcher claim predicate、notification debt 和父清后的幂等解抑。
5. 把 activations/processing_attempts 两段改为真实可执行 SQLite DDL并跑迁移。
