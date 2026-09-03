# FLY-2248 设计评审 R4 收口报告(给 Lead 裁定用)
日期: 2026-09-02 · 分支 flywheel-FLY-2248 · plan 头 26a9222aa(manifest rev 4,blob 861af12b)
Codex 战绩: R1 6B+4H+1M → R2 5B+3H → R3 4B+3H → R4 3B+5H(条数 11 → 8 → 7 → 8,R4 未再收敛)。

## 1. R4 相对 R3:增了什么 / 删了什么

**删(净减)**
- 两张欠条表各 7 个新列(2×7)→ 删,改为 1 张 `workflow_delivery_attempt`。
- `runner_turn_state`(R3 草稿里的 execution 级 turn 状态表)→ 删,复用 CommDB 既有 `three_stage_turn` 行。
- watch 对 undeliverable 的告警 → 删(只记 episode)。
- A7 的启动耗时/峰值 RSS 要求 → 删。
- 单独的 `hold_resume_operation` 表(R2)→ 早已并入 `workflow_delivery_operation`。

**增**
- 表:`workflow_delivery_attempt`(血统 + set-once 阶段时钟,StateStore)。StateStore 新表合计 5,CommDB 0。
- 列:CommDB `three_stage_turn` +2(`active_turn_id`,`turn_generation`)、`runner_phase_wakes` +2(`first_push_at`,`turn_generation`)。
- saga kind:`resident_expiry`(并入同一张 `workflow_delivery_operation`)。
- 告警 uid:`delivery_reroute_outcome:<attempt>`(saga 唯一触发)、`delivery_operation_stalled:<op>`。
- 接口:`residentHold.enter` 幂等 adopt + `residentHold.close` 补偿;`onTurnStarted`。
- 验收:A3(e)(f) barrier/交错测试;A7 (a)(b)(c);plan §5 第 12 条机制守卫(5 表 / 0 表 / 4 列 / 4 告警前缀)。

## 2. R4 未过项(Codex 8 条)——每条:一句话、归属里程碑、我评估的改动体量

| # | 严重度 | 一句话 | 归属 | 体量 | 需要谁定 |
|---|---|---|---|---|---|
| 1 | B | 「append-only」有两种可机器区分的解释:set-once CAS 行(现 plan)vs 逐事件 INSERT;仓库里真 append-only 表都有 no_update 触发器 | M1 | 小(选定义 + 禁覆盖非空/禁删除测试) | **Lead 定义** |
| 2 | B | CommDB 家族的 root 身份不唯一(各项目 `queue_seq` 会撞),原始行没有 g1 attempt 时首次改派会错铸 g1,child 回指 root 的投影规则缺 | M1/M2 | 中(root 加 project namespace;g1 物化规则;`contract_ref_json` 回指;baseline 补 launch) | 我 |
| 3 | B | 复用 `three_stage_turn`:nullable 列 `NULL+1` 永远 NULL;`grantTurn` 两处 upsert 换手不清 `active_turn_id`;重复 `turn/started` 幂等与重启后 g 的来源未定义 | M3 | 中(`NOT NULL DEFAULT 0`;换手事务收口;same-turn replay 合同) | 我 |
| 4 | H | `first_push_at` 写在 push claim 与「claim 不动时钟」自相矛盾;应写在 `completeRunnerReceiptWakePush` 的投递结果上 | M1 | 小 | 我 |
| 5 | H | `superseded_by_completion` 分支没写 `settled_at` → 永久 live attempt | M2 | 小(纠错) | 我 |
| 6 | H | `runner_shutdown_controls` 以 execution_id 为主键,`INSERT OR IGNORE` 后返回的可能是别的 request_id;既有 failed 行会让 expiry saga 永久停住 | M3 | 中(barrier 校验 request_id;requested/acked/failed 三种既有状态各一条处置) | 我 |
| 7 | H | A7 allowlist 缺 canonical 查询(`sqlite_autoindex_*` 过滤)与显式索引命名;alert 前缀不是 schema,要另做 allowlist 测试 | M0/A7 | 小 | 我 |
| 8 | H | research §1.4/§1.5/§3.2/§5/§6 仍有 R3 旧契约(IOU 表加列、旧 uid、launch「不用 attempt」、耗时要求) | 文档 | 小(同步 + 一致性测试) | 我 |

另:你要求的「5 张新表各一行为什么不能是现有表的列」已写好(附录),尚未入 plan(避免评审对象漂移)。

## 3. 我对三条出路的如实评估

- **(a) 再一轮 R5(违反你「不做 R5」)**:8 条里 5 小 3 中,都是闭合项、零新表;#1 需要你先定义。若你允许,R5 是「定义 #1 + 我改 8 条」的最后一轮,不再有 R6。
- **(b) 以当前 plan 放行、剩余转 implement 检查**:**我不能执行**——design_review 门要的 `design-review.json` 必须写 `status:"APPROVED"` 与 Codex 线程 id,而 Codex 四轮都是 CHANGES REQUESTED;我写 APPROVED 就是伪造评审结果(memory 有此前科的禁令)。(b) 只有你从 Bridge 侧 override 这道门才成立,且 8 条里 #1/#2/#3/#6 若不定,实现节点会自选解释。
- **(c) 拆单**:M1/M2/M4(合同 watch + 转移层 + 正门)本单;M3(常驻/turn 边界/清信)另立。未过项归属:#3、#6 属 M3(拆走);#1、#2、#4、#5、#7、#8 属 M1/M2/文档(仍在本单,仍需一轮闭合)。拆单能把两条中等体量的 M3 项移走,但本单还是要过一轮 Codex。

**我的建议**:(a) 一轮封顶,前提是你在回复里直接给 #1 的定义(建议:「generation 只追加、IOU 表不改、attempt 行允许 set-once CAS,禁覆盖非空值/禁删除」)。若你选 (c),同样需要一轮。

## 附录:5 张新表自证(待入 plan §3)

**5 张新表的自证(Lead 2026-09-02 要求:每张一行「为什么不能是现有表的列」;写不出的已合并)**:

| 新表 | 为什么不能是现有表的列 |
|---|---|
| `workflow_delivery_contract_episode` | 一条 episode 是「某张欠条在某阶段的一次卡住」,一张欠条一生可有多条、跨 8 个家族同一形状;现有欠条表都是每家族一张、每合同一行,若加列就得在 8 张表(其中 3 张在 CommDB)各加一套 opened/alerted/severe/closed 列——这正是 exploration §4.1 拒绝的「镜像词汇」。 |
| `workflow_delivery_attempt` | 血统 + set-once 阶段时钟需要「每一代一行、旧代不可改」;rework 唯一的代际表 `workflow_rework_route_revision` 被触发器禁止 UPDATE(`StateStore.ts:20739` 之后的 `no_update` 触发器),放不下 set-once 列;carrier / land / gate_holder 没有代际表;turn_wake / phase_wake / mailbox 的行在另一本账(CommDB)。只有一张跨家族的 append-only 台账能同时承载 generation 与时钟。 |
| `workflow_resident_hold` | 候选宿主是 `sessions`(每 execution 一行)。但常驻宽限有自己的 revision/state/deadline CAS 生命周期,而 `sessions` 行已被 FLY-2211 的 `lifecycle_revision` + 共享 execution mutation lease 保护(`execution-mutation-lease.ts`),在同一行上再放一套独立 CAS 会让 wake/expiry 的比较交换与 lifecycle 复核互相误判过期(memory:FLY-2211 「一次 TURN grant 误判过期」的同族问题)。独立的 1 行/execution 小表把两套 fence 隔开。 |
| `workflow_completion_drain_challenge` | 挑战发生在「完成被暂缓」的时刻,此时 `workflow_node_completion` 行**还不存在**(它就是被推迟的那条),没有可以挂列的完成行;挂到 `sessions` 又回到上一行的 fence 冲突。它还需要 `(execution, activation, business_digest) WHERE state='issued'` 的部分唯一索引来保证「同业务提交复用同一挑战」,这在宿主表上无法表达。 |
| `workflow_delivery_operation` | 三种跨库动作(改派 / 正门恢复 / 常驻到期)共用一张 saga 表已经是合并后的结果;现有 outbox 都是单用途且不跨 barrier(`workflow_alert_outbox` 只投告警,`workflow_carrier_redrive_receipt` 只记 carrier 正门回执),都没有 `client_request_id` 唯一约束与 staged/applied/sent/projected 四段状态。再合并只能并进 episode 表,而 episode 是只读观察、operation 是写侧动作,合并会让 watch 的「零写入」守卫失效。 |

合并结论:5 张各有一条现有表放不下的硬理由,未合并;机制守卫(StateStore 5 表 / CommDB 0 表 / CommDB 4 列 / 4 个告警 uid 前缀)作为实现期硬断言保留(§5 第 12 条)。
