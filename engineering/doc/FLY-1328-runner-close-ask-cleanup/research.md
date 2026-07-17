# FLY-1328 runner close 不清未答 ask — 调研

Issue: FLY-1328 (https://linear.app/geoforge3d/issue/FLY-1328/fix-生命周期收尾漏了一格runner-close-不清它名下的未答-ask-pending-队列长期堆尸信噪比归零fly-1185)
日期: 2026-07-16
基于: exploration.md

方案已在 brainstorm gate 获 Tadashi 批准(A1 级联 + A2 sweep,resolved_via 列保留,
grace 15min / age 30min / UUID fail-closed / kill-switch 默认开)。本文是给
Implement 阶段的技术地图:改哪里、复用什么、不许碰什么、怎么测。

## 1. 代码地图(改动点)

### 1.1 `packages/flywheel-comm/src/db.ts` — 核心改动

**迁移(applyMigrations,~line 277-455)**:新增 nullable `resolved_via TEXT`
列。照抄现有模式(如 line 333 `kind` 列):`PRAGMA table_info` 探测 →
`ALTER TABLE messages ADD COLUMN resolved_via TEXT` → catch 吞
"duplicate column" 竞态(多进程并发 open 同 DB 是常态)。注意 line 459
`migrateMessageTypeConstraint` 的表重建 SQL(FLY-1279)列清单**不需要**改
——它只在 messages 表还没有 'ack_receipt' 约束时重建,生产早已过了这一步;
但若重建 SQL 在新列之后执行会丢列,所以**新列的 ADD COLUMN 必须放在
`migrateMessageTypeConstraint()` 调用(line 381)之后**,与 relay_state 等
既有列的处理顺序一致(它们都在 PRAGMA 探测块里、重建调用之前——重建后的表
再补列,顺序无碍;实现时按现有列的位置插入即可,并加单测覆盖"旧库升级后列存在")。

**`finalizeSession`(line 2093)— A1 级联**:事务内、gate retire 之后,加第二条
UPDATE:

```sql
UPDATE messages AS q SET
  resolved_at = datetime('now'),
  read_at     = COALESCE(read_at, datetime('now')),
  expires_at  = datetime('now'),
  relay_state = 'terminal_disposed',
  resolved_via = 'owner_closed'
WHERE q.from_agent = ?
  AND q.type = 'question'
  AND q.checkpoint IS NULL                 -- 只碰普通 ask;gate 条款零改动
  AND q.resolved_at IS NULL
  AND q.relay_state != 'terminal_disposed'
  AND q.created_at <= datetime('now', ?)   -- '-15 minutes' grace(常量注入)
  AND NOT EXISTS (
    SELECT 1 FROM messages r WHERE r.parent_id = q.id AND r.type = 'response'
  )
```

- kill-switch:`FLYWHEEL_ASK_HYGIENE === "0"` 时跳过这条 UPDATE(gate 条款
  照旧),即字节回退;
- 既有 gate UPDATE 同时补 `resolved_via = 'owner_closed'`(同一 disposition,
  语义诚实;Tadashi 已确认两层留痕);
- 返回值 `FinalizeSessionResult` 加 `retiredAskCount: number`(加法扩展;
  现有 `retiredQuestionCount` 语义不变 = gate 数,呼叫方零破坏)。

**常量**:`ASK_CASCADE_GRACE = '-15 minutes'`、A2 侧 `ASK_SWEEP_MIN_AGE_MS =
30 * 60_000`,硬编码 + 注释(与 FLY-1185 STABILITY_WINDOW_MS 同风格)。

### 1.2 `packages/teamlead/src/bridge/zombie-gate-hygiene.ts` — A2 sweep

现状:line 111-114 `if (q.checkpoint == null) continue`(引 FLY-161 边界)。
改法:该 continue 改为进入**新的 ask 分支**(gate 分支逻辑一个字节不动):

ask 分支谓词(全部满足才 retire):
1. `q.checkpoint == null` 且 kill-switch `FLYWHEEL_ASK_HYGIENE !== "0"`;
2. `from_agent` 匹配 UUID 形(`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`;
   不匹配 → continue,fail-closed——生产有 1 条 qa-fly1239 残留即此类);
3. `deps.db.getSession(q.from_agent)` 返回空(CommDB 注册行已删 = teardown
   证据;行还在 = completed-alive 可能,FLY-161 保证不破,continue);
4. StateStore `getSession` 缺失 或 `isStateStoreIrreversibleTerminalForZombie`
   (Z1 同款双证;**活 session + CommDB 行没了 ≠ ask 候选**——那是 Z2 形态,
   ask 不做 Z2,直接 continue,不 noteUnreachableRunner,避免给 FLY-1049
   的 gate 告警面掺噪);
5. age guard:`q.created_at` 为 canonical SQLite UTC 且早于 now - 30min
   (格式非法 → fail-open 跳过,同 FLY-1257 的时钟纪律);
6. 三相审计 + `retireQuestionGuarded(q.id, {expectedFromAgent, requireUnanswered:
   true})`(现成原语,from_agent 绑定 + 未答守卫 + 并发 answer 赢,零新 SQL)。

审计事件:复用三相骨架但**独立 event_type**(`ask_hygiene_retire_intent` /
`ask_hygiene_retired`),payload 带 `resolvedVia: 'owner_closed_sweep'`、
`kind`(report 与否)、`ageHours`。独立 type 的理由:zombie 的
dangling-intent reconcile(line 259)按 event_type 扫描,混用会把 ask intent
喂进 gate 的 reconcile 分类器;ask 分支自带同构的 reconcile(或共享
参数化的 reconcile helper——实现时二选一,倾向参数化复用)。

`retireQuestionGuarded` 需补一处:它目前不写 `resolved_via`。加可选参数
`opts.resolvedVia?: string`(不传 = 现行为,写 NULL;两个既有呼叫方
——zombie gate Z1 与 FLY-1099——不传则字节不变;gate Z1 可顺手传
'owner_closed_sweep'?**不传**,scope 纪律:gate 侧留痕已有三相事件,不动)。

**候选集来源**:gate-poller.ts:3521-3528 目前 `.filter(q => q.checkpoint !=
null ...)` ——去掉 checkpoint 过滤,把全量 pending 传进
`runZombieGateHygiene`(它内部自行分派 gate/ask 分支);eviction 记录的
两个排除集(evictedGateIds / evictionRetryAt)只对 gate 有意义,保留在
gate 分支路径上(ask 不经过 eviction 簿记)。注意 FLY-307 的 sql.js churn
契约:ask 分支对每个候选也要 `store.getSession`(谓词 4)——尸体首轮 178 个
getSession 触碰是一次性的,之后稳态候选 ≈ 0;首轮如担心 WASM 压力,分批
(每 pass 上限 N=50,剩余下轮)——实现时加常量 `ASK_SWEEP_BATCH_LIMIT = 50`。

### 1.3 `packages/teamlead/src/bridge/close-runner.ts` + `commdb-session-prune.ts` — 计数透传

- `FinalizeCommDbResult` 加 `retiredAskCount`(default 0);
- `finalizeCommDbSession` 从 `db.finalizeSession` 结果透传;
- close-runner 的审计事件 payload(`lead_close_runner*`)与
  `CloseRunnerResult` 加 `retiredAskCount`(加法字段,呼叫方零破坏);
- `pruneDeadTerminalCommDbSessions` 的 `onFinalizeOutcome` 同步透传。

### 1.4 `packages/config/src/feature-flags/registry.ts` — 注册 flag

照 `FLYWHEEL_ZOMBIE_GATE_RESOLVE`(line 1005)的条目形状注册
`FLYWHEEL_ASK_HYGIENE`:polarity default_on,valueKind bool,default true,
readSites = db.ts(finalizeSession)+ zombie-gate-hygiene.ts(ask 分支)。
registry 有 drift 测试(readSites 必须真实存在),别忘同步。

## 2. 不许碰(负面清单,每条有主)

| 禁区 | 属主 | 说明 |
|---|---|---|
| finalizeSession 的 gate UPDATE 谓词(checkpoint IS NOT NULL / review 豁免) | FLY-1238 / FLY-1257 | 只允许加 resolved_via 赋值 |
| zombie gate 分支(Z1/Z2/chronology/eviction 排除) | FLY-1099 / FLY-1257 / FLY-307 | ask 是新分支,不是改旧分支 |
| getPendingQuestions 及一切读面谓词 | FLY-1279 | 写面清账,读面零改 |
| purgeExpiredWithRefs 的 carve-out | FLY-1279 | retire 后自然过期即可,不改 purge |
| GatePoller relay 循环(每 tick 的 runner_question relay) | FLY-161 | survive-completion 契约原样 |
| `kind='report'` 的 founder-binding 排除 | FLY-1041 | 不特判 report |
| respond / check / gate 命令 | — | 行为不变(retire 后 respond 到不存在的 pending 已有既定失败路径) |

## 3. 关键机制备忘(实现时的"为什么")

- **relay 的持久性**:GatePoller relay 先 `appendLeadEvent` 落 StateStore
  lead_events(durable),再投递;question 行之后被 retire 不影响已入账事件
  的重投(dialog poller / FLY-109)。所以"已过 grace/age 的 retire"永远不丢
  内容——丢失只可能发生在"落库→首次 relay tick"的秒级窗口,这正是 grace/age
  存在的唯一理由。
- **`relay_state='protected'` 不可作 relay 证据**:只有 deliveryAckEnabled 时
  才写(gate-poller.ts:1730);生产 203 条 pending 里 175 条是 'open'。
- **CommDB session 行的生死**:registerSession(adapter spawn)→
  finalizeSession / deleteSession(teardown)/ boot prune(证明窗口已死)。
  parked-alive、completed-alive 的行都在 → 谓词 3 保护它们。
- **retire 后行的寿命**:expires_at=now → 下一次任意 CommDB open 的
  purgeExpired 删行。resolved_via 是小时级取证;天级取证 = StateStore 事件。
- **patrol cadence**:zombie pass 骑 `patrolDue`(默认每 20 tick ≈ 60s),
  部署后首轮即清存量。

## 4. 测试面

| 层 | 文件 | 内容 |
|---|---|---|
| CommDB 单测 | `flywheel-comm/src/__tests__/db.fly1238.test.ts` 旁新建 `db.fly1328.test.ts` | A1:级联 retire(过 grace 的 ask 清、grace 内的留、答过的免、gate 不受 ask 分支影响、resolved_via 写入);旧库迁移后 resolved_via 列存在;kill-switch=0 字节回退(反向兼容 sentinel:同输入下与今日行为逐字段一致) |
| zombie hygiene 单测 | `teamlead/src/bridge/__tests__/` 新建 `ask-hygiene.test.ts`(或并入 zombie 测试) | A2 谓词矩阵:UUID guard / CommDB 行存在→留 / StateStore 活→留 / age 内→留 / 全满足→retire+三相事件 / 并发 answer 赢 / batch limit / kill-switch=0 零副作用(intent 都不写,对齐 zombie 契约) |
| 计数透传 | close-runner 既有测试扩展 | retiredAskCount 出现在 result + 审计 payload |
| flag registry | registry drift 测试 | readSites 真实 |
| 真机 QA(implement 阶段自证 + 独立 QA) | 生产形态 comm.db 复制或 529 Room | 用真尸体样本跑一轮 sweep:178 清 / QA 残留留 / pending 前后对比;再造一个 close 场景验级联 + DONE report 不丢(close 前最后一刻 ask --report,确认 relay 事件仍到 Lead) |

反向兼容 sentinel 纪律(FLY-1281/1285 教训):kill-switch=0 的断言必须
突变验证——先证明 flag=1 时行为确实不同,再证明 flag=0 与旧行为一致;
fixture 按生产形态建(protection 默认开;注意 db.fly1238.test.ts 现在
是 delete protection env 跑的,新测试要两种模式都盖)。

## 5. 部署形态

纯 flywheel-comm(dist)+ Bridge 侧改动:CLI 侧(finalizeSession 被 Bridge
进程 require)与 GatePoller 都在 Bridge 进程内 → **生效需一次 Bridge 重启**
(随批量重启窗口走,不单独重);无 schema 破坏(加列迁移幂等,新旧代码可
共存同一 DB——旧代码不识 resolved_via 列不受影响,SELECT * 多一列无害)。
回滚 = FLYWHEEL_ASK_HYGIENE=0(无需回码)。
