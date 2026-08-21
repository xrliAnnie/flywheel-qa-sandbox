# FLY-1925 patrol_tick 名册加「圈」维度 — 探索

Issue: FLY-1925 (https://linear.app/geoforge3d/issue/FLY-1925/巡检tick-patrol-tick-名册加圈维度每-run-附当前节点棒持有者开圈状态-让有人在等不存在的圈直接印成红灯founder)
日期: 2026-08-20
基于: 无

---

## 1. 背景与事故形态

founder 2026-08-20 06:44 原话:「我们那个 Bridge Ticket logic 是不是需要调整,来确保以后不管是你还是其他 lead 遇到这种情况,都能正确处理。」

当晚三单(FLY-1855 / FLY-1859 / FLY-1887)同款死等:

- QA 停驻(守纪律 park,等 post-ship);
- 实现体守纪律轮询 `flywheel-comm turn`,一直收 `not-yours`,持续等棒;
- **发棒的圈不存在**——没有任何非终态返工圈(rework delivery)/ pending attempt / land 步骤会导致 TURN 转移到等待者;
- founder 逐个 pane 点开才发现,定性「巡检机制名存实亡」。

patrol_tick(FLY-1687)每 60min 给 Lead 发名册,但名册只有
`- FLY-1855 [abcd1234] (implement, running)` 这样的 4 列声明。「圈」这一层
(棒在谁手 / 谁在等棒 / 返工圈开没开)在名册上完全不可见——Lead 要跨
teamlead.db + comm.db 多张表手工 join 才看得出,认真巡检也看不出。

## 2. 现状审计(代码事实,as-of 2026-08-20 `main` f8f2176e2)

### 2.1 tick 注入面

- `packages/teamlead/src/bridge/patrol-tick.ts` — `runLeadPatrolTickPass`:
  per-(project, lead) due 判断 → `roster.map(rosterEntry)` 生成
  `PatrolRosterEntry { identifier, sessionRole, status, executionId8 }` →
  `appendLeadEvent` → mailbox 投递。roster 来自
  `StateStore.getPatrolRosterSessions(projectName)`(sessions 表 6-status:
  `running, ship_parked, awaiting_review, approved_to_ship, pending, design_done`)。
- 接线在 `plugin.ts:8083`(`createLeadPatrolTickPass` deps),由 GatePoller
  60s rider 驱动,pass 级 single-flight。

### 2.2 tick 渲染面

- `packages/teamlead/src/bridge/hook-payload.ts::formatPatrolTick` — Mailbox
  与 CommDB 两个 Lead runtime 共用的唯一 renderer。固定两句模板 + 名册行。
- token 消毒已存在:`canonicalPatrolToken`(grammar `^[A-Za-z0-9._-]{1,64}$`,
  命中指令词 `check|verify|suggest|inspect|建议|怀疑|该查` 即哈希转义)+
  `PATROL_STATUSES` allowlist。**新增字段必须走同一消毒纪律**(echo
  immunity / 防注入)。

### 2.3 「圈」的账面分布(两库四表 + 三表)

**comm.db(per-project,`commDbPathForProject(projectName)`)**:

| 表 | 关键列 | 语义 |
|---|---|---|
| `three_stage_turn` | issue_id → holder_exec_id, phase, epoch, target_run_id/node_id/attempt, activation_id | 棒:每 issue 至多一行,当前持有者 |
| `turn_wait_ledger` | (execution_id, holder_exec_id, epoch), first_seen_at, asked_at, no_turn_streak | **等棒账本**:runner poll 到 `not-yours` 时写入;拿到棒 `clearTurnWaitOnGrant` 清 |
| `runner_declared_states` | execution_id, kind(`parked`/`long_task`), expires_at | 停驻声明(QA park 走这) |
| `turn_wake_outbox` | state(`pending`/`sent`/`acked`/`cancelled`) | 待发/在途的 TURN wake |

注:issue 描述说「跨 teamlead.db 三张表」——实测棒与等待账在
**comm.db**,不在 teamlead.db;圈与节点在 teamlead.db。设计按真实账面来。

**teamlead.db(StateStore)**:

| 表 | 关键列 | 语义 |
|---|---|---|
| `workflow_run` | run_id, issue_id, current_node_id, current_qa_attempt, status | run 主行 |
| `workflow_run_node` | (run_id, node_id, attempt), state(`admitted`→`running`→`done`/`superseded`), execution_id | attempt 账:`admitted`/`running` = pending attempt |
| `workflow_rework_delivery` | request_id, state(`pending`/`turn_granted`/`wake_delivered`/`replacement_pending`/`completed`/`held`/`needs_lead`) | 返工圈投递态;非 `completed` = 圈开着(`held`/`needs_lead` = 开着但卡住) |
| `land_operation` | issue_id, state(`intent`/`running`/`partial`/`completed`/`held`), current_step | land 收尾圈 |

**join 键**:`three_stage_turn.issue_id` 与 `sessions.issue_id` 同形态(现有
`turn-belt-reconcile.ts:167` 直接以 `turn.issue_id` 查
`getActorSessionsForIssue`,已是生产 join 先例)。

### 2.4 已有机制的盲区(为什么当晚没人报警)

- `turn-belt-reconcile.ts`(FLY-921)只处理 **stale turn = holder 死了**:
  holder 活着(QA 守纪律停驻)时永不触发。
- `turn_wait_ledger` 的 `askAfterMs` 一次性 `turn-wait:` question(FLY-1614)
  只覆盖「holder 还在但迟迟不交」;它是一次性的,且不判「圈存不存在」。
- patrol_tick 名册纯 4 列,不含任何圈信息。
- **当晚形态 = holder 活着 + waiter 守纪律 + 无发棒源**,三个机制都不覆盖。

## 3. 交付物(issue 原文拆解)

tick 名册每个 run 附四列:

1. **current_node/attempt** — `workflow_run.current_node_id` + 该 node 的最新 attempt;
2. **棒持有者** — `three_stage_turn` 的 holder execId8 + phase + epoch;
3. **开着的返工圈** — `workflow_rework_delivery` 非终态 + `land_operation.current_step`;
4. **红灯判定** — 存在「等待中的 exec(turn-poll / parked)且无对应
   pending attempt / 开圈」→ 该行标 🔴 waiting-for-nonexistent-loop,
   tick 正文**置顶**列出。

纯读账面拼进现有 tick 消息,**零新告警通道**(tick 本来就发,只是把已有
信息拼上去,不违 no-new-alert-layers)。

## 4. 关键设计问题与取向

### Q1 圈维度按什么组织:per-session 加列,还是 per-issue 分组?

圈(棒 / 返工圈 / land)是 **issue 级**状态;等待(turn-poll / parked)是
**exec 级**状态。roster 现在是扁平 session 列表。

- **选项 A(取)**:名册按 issue 分组渲染——issue 主行带圈四列,其下缩进
  session 行(带各自等待态)。红灯是 issue 级判定,置顶汇总。
- 选项 B:每 session 行拖 8+ 列,一行超长、圈信息在多 session 时重复。弃。

### Q2 红灯谓词:多精确?

红灯必须**可解释且保守**——它是 Bridge 对**自己账本**的自洽性检查
(「我账上有人在等,但我账上不存在会发棒给它的圈」),不是对地面真相的
预判。误报会立刻透支这个符号的信任。

取向(精确谓词在 research 定稿):对 issue I,红灯当且仅当:

1. 存在 roster 内(非终态)exec E,E 在 comm.db 有活跃等待证据
   (`turn_wait_ledger` 有行,或 `runner_declared_states` 有未过期
   `parked` 且 E 不是当前 holder);且
2. 账上不存在任何「会导致 TURN 转移」的 pending 源:
   - 无非终态 `workflow_rework_delivery`(含 `held`/`needs_lead`——这两态
     算「圈开着但卡住」,**不是**「圈不存在」,不红灯、但要在圈列可见);
   - 无 `admitted`/`running` 的 `workflow_run_node` attempt 绑给**其他**
     exec(别人正在干活,棒稍后自然轮转,不红灯);
   - `land_operation` 无活动步骤;
   - `turn_wake_outbox` 无 `pending`/`sent` 未 ack 的 wake;
3. 数据可判:任何一张表读失败 → 该 issue 圈列标「⚠️ 账面不可读」,
   **不判红也不判绿**(fail-honest,绝不把探针失败当结论——记忆里的
   已知失效模式)。

### Q3 Bridge 读 comm.db:通路与失败姿态

Bridge 已有成熟先例(`turn-wake-patrol.ts`):
`new CommDB(commDbPathForProject(projectName))` + finally close。patrol pass
每 project 开一次 **readonly**(`getEffectiveDeclaredState` 已声明
readonly-tolerant:no-such-table → 空账,不 throw)。每 60min 每 lead 读
几张小表,量级无虞。

### Q4 与 FLY-1687「Bridge = 纯闹钟」合同的关系

FLY-1687 的 founder 裁定是「零预判零指令」。本卡是 **founder 本人点名的
合同修订**:名册从 4 列声明扩为「圈维度声明 + 账面红灯」。定位必须讲清:

- 红灯 = **账面自洽性检查的输出**,与名册一样是「Bridge 账本的待核声明」,
  不是对 pane 地面真相的断言,更不是指令;
- 名册头部的「此名册是待核声明,不是结论」合同句保留,红灯行自带一句
  固定事实陈述(「按账面,X 在等 TURN,但账上无任何会向它发棒的开圈」),
  不含「该查什么/建议动作」;
- Lead 收到红灯后做什么,仍归 Lead 侧规则(FLY-1855 的地盘,本卡不折入)。

### Q5 边界:与 FLY-1855 互补不重叠

- FLY-1855 管「Lead 做没做」(巡检六步可执行化 + 留痕),已进 QA 段,
  founder 明确本内容不得折入;
- 本卡管「名册给不给看得见的红灯」——纯 Bridge 侧数据拼装 + 渲染。
- Lead 侧 `runner-patrol-rules.md` 是否加「红灯含义」一小节:倾向**不加
  执行步骤**,tick 红灯行文案自解释;是否加一句符号说明在 plan 里定。

### Q6 消毒与注入面

新增 payload 字段(node id / phase / execId8 / 圈状态)全部过
`canonicalPatrolToken` 或新的等价 allowlist;红灯行的解释文字是 Bridge
模板**固定字符串**,永不插值 runner 可控文本。

### Q7 验收锚

复现当晚 FLY-1855 形态于测试库(exec 在 `turn_wait_ledger` 等棒 + 无
admitted/running attempt + 无非终态 rework delivery + 无 land 步骤),
断言 tick 渲染出置顶 🔴 行。另配阴性对照:圈开着(rework delivery
pending)时同一 waiter **不**红灯。

## 5. 不做什么(honest boundary)

- 不自动救灯:红灯只是可见性,不触发任何 wake / re-grant / respawn
  (自动补圈是另一张卡的事,且 founder 只要了「印成红灯」);
- 不加新告警通道 / 新 timer / 新 flag;
- 不改 Lead 巡检执行步骤(FLY-1855);
- 不改 turn belt / rework 引擎的任何写路径——本卡**纯读**。
