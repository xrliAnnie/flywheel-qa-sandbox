# FLY-2155 QA 侧 actor 复用对齐 implement 侧 — 探索

Issue: FLY-2155 (https://linear.app/geoforge3d/issue/FLY-2155/引擎不对称-体做完留着继续用只对-implement-生效qa-侧新一轮必须换体而活着的旧体反过来把起跑道占死-死结)
日期: 2026-08-29
基于: 无

## 1. 问题(founder 的设计意图 vs 现状)

Founder 的设计意图(2026-08-29 原话):节点做完之后体留在那,下一次有新任务(比如继续测试)可以继续做,context 不丢。**不要执意开新的 QA 体。**

现状:这个能力只做了一半。

- **implement 侧成立**:返工 route 带 `preferred_actor_execution_id`,rework coordinator 先 probe 该 actor 存活,活着就 wake(投 turn),只有判 dead 才 materialize 替身。FLY-2139 的 implement 体 `5e6eafcf` 一个体连做两轮返工,context 完整保留 —— 正是 founder 要的形状。
- **QA 侧不成立且互相锁死**:引擎给 QA 的新一轮在关键分支上只会铸新 execution;新体起不来(runway 被活着的旧体占死);10 分钟 hard TTL 后 rollback 冻 run,且不重置 node 行,留下永久幽灵占位;三扇正门(operator rework / re-qa / 引擎自行推进)全部走不通。

## 2. 机制审计的关键发现(比 issue 文本更深一层)

对 FLY-2139 生产 run `8b8a7fd7` 的 `workflow_run_event` 逐条取证(见 research.md)后,病根清单修正为六条:

| # | 病根 | 位置 | 说明 |
|---|------|------|------|
| A | **非 rework 的 edge traversal 无条件铸新 execution** | `StateStore.commitWorkflowTransitionTx`(~L38467) | `successorExecutionId = gate? undefined : reworkAuthority? undefined : (input ?? randomUUID())` —— 只要当时没有 active verification path,implement→qa 的推进就铸新体,完全无视 qa 节点已有活着的 actor。FLY-2139 seq 96 即此分支(path 已被提前 completed)。 |
| B | **preferred actor 选择器选「账面最近」而非「活着的」** | `commitWorkflowTransitionTx` chained 分支 + `openOperatorRework`(两处同型) | 都取「目标节点最近一次带 execution_id 的 attempt」。幽灵(从未启动、已被 rollback 的 execution)排在活着的旧体前面 —— FLY-2139 seq 740 的 chained rework 首选了幽灵 `52b963f6`,而活着的 `5871392f` 被跳过,导致 5 次 `actor_session_missing` 投递失败 → `rework_retry_exhausted` → run 再次冻住。 |
| C | **runway(起跑道)只认 session 不可逆终态才释放** | `run-dispatcher.currentInflightEntry` + `isStateStoreIrreversibleTerminalForZombie` | 活着的旧 QA 体占住 (issue, qa) 的 in-memory 起跑道,新铸的体永远起不来。 |
| D | **`rollbackUnlaunchedWorkflowAdmission` 不重置 workflow_run_node** | `StateStore` ~L24338 | 吊销凭证/关 claim/session 标 failed/ledger 标 abandoned,唯独 node 行仍 `admitted` 绑着幽灵 → `openOperatorRework` 撞 `target_attempt_already_reserved`;幽灵还成为病根 B 选择器的首选。 |
| E | **`openOperatorRework` base revision 只认 `sessions.pr_head_sha`** | `StateStore` ~L32100 | QA 这类不写 head 的角色永远 `base_revision_unavailable`,「返工到 QA」这扇门结构性封死。 |
| F | **`materializeWorkflowReworkReplacement` 不把死体 session 标终态** | `StateStore` ~L26999 | 若死体 session 仍 status='running'(pane 死了但没被收割),替身照样被 runway 挡住 —— 与 C 组合成残留死结。 |
| G(附带)| **probe 对「已 rollback 的幽灵」按 retryable hold 处理** | rework coordinator | rollback 回执是幽灵已死的持久证据,却还要 5×~2min 重试 + needs_lead 冻结才轮到 dead 判定(FLY-2139 19:08→20:03 共 55 分钟)。 |

**重要修正**:chained rework 机制(verification path active 时)其实**已经**会把 QA 节点的历史 actor 填进 `preferred_actor_execution_id` —— 「QA 侧结构性铸新体」只发生在 path 不 active 的 fallback 分支(病根 A)。但病根 B 让 chained 分支在幽灵存在时同样失效。两处都要修。

## 3. 方案空间

### 方向一(选定):「新一轮 = 复用请求」,统一走既有 rework 投递机制
edge traversal 的 fallback 分支在目标节点存在历史 actor 时,不再铸新 execution,而是走与 chained rework 相同的「preferred actor + coordinator probe + wake/replacement」通道;选择器改为「最近一个 session 非不可逆终态的 actor 优先」。存活判定天然异步,而 traversal 是同步 SQL 事务 —— 把判定留给 coordinator 正是 implement 侧已验证的形状,不新造机制。

- 优点:复用已在生产验证过的投递/probe/replacement 全套機制;不新增表;QA/implement 行为对称,founder 心智模型成立。
- 代价:edge traversal 的 fallback 分支要长出一条「造 reuse 请求」的路径(复用 rework request 表,authority 标记来源)。

### 方向二(否决):让新铸的 execution 「继承」旧体的 pane/session
新 execution 起跑时如果发现同 (issue, role) 有活体,把新 execution 绑到旧 pane 上继续跑。
- 否决理由:execution_id 是全链路的身份锚(凭证、claim、CommDB 注册、TURN、worktree),换绑等于造第二套身份映射,正是 FLY-2076 被 founder 叫停的「长机制」方向。

### 方向三(否决):把 runway 释放判据放宽(旧体活着也放行新体)
- 否决理由:两个活 runner 共享同一 worktree/TURN 是数据损坏级风险;runway 的排他语义是对的,错的是「明明该 wake 旧体却去起新体」。

### 方向四(否决):只修三扇门(operator rework / re-qa 接线),不动引擎推进
- 否决理由:门修好了也只是「死结发生后人工能解」,每次新一轮仍然铸新体重跑,founder 反对的浪费照旧发生。门要修(D/E 两条),但主体必须是引擎侧复用。

## 4. 边界

- 本单只做 **run 内**的 QA 新一轮复用(同 run 同 node 的下一个 attempt)。**跨 run 复用**(同 issue 新开 run 时收养旧体)是更大的身份/凭证问题,不在本单;founder 意图里的「下一次新任务」在 run 内语境下已闭环。
- `re_qa_unavailable`(deps.reQa 生产未接线)是独立的门,修复价值在方向一落地后大幅下降(引擎自己会走通),本单不接线,只在 plan 中说明理由。
- FLY-2154(告警缺 released_reason)、FLY-2096(receipt 死结族)、FLY-2072(引擎病根 Epic)互链不并入。
