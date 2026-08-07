# FLY-1648 热循环收口 — 调研

Issue: FLY-1648 (https://linear.app/geoforge3d/issue/FLY-1648/workflow-引擎批0-热循环收口held-rework-死账手术fly-1150fly-1596-恢复循环加退避与终态)
日期: 2026-08-06
基于: exploration.md

## 1. 两条热循环路径的精确解剖

### 1.1 held rework 恢复分支(`workflow-engine-dispatcher.ts:758-821`)

每 tick(1s)对 `listWorkflowReworkDeliveries({states:["pending","turn_granted","held"], now})` 的每条 held 行:

```
delivery.state==='held' && run.status==='held' && last_error==='persisted_target_missing'
  → getLatestWorkflowReworkRoute
  → probeTerminalLaunchLiveness(route.preferred_actor_execution_id)   ← 每 tick 一次 tmux 探针
  → liveness==='dead'
  → materializeWorkflowReworkReplacement({recoverHeldPaneLoss:true})  ← 每 tick 一次写事务
  → target node (implement,2) state='failed' ∉ {pending,admitted}
  → { ok:false, reason:'rework_replacement_target_changed' }          ← StateStore.ts:20279
  → log 一行 + result.held += 1;delivery/run 零变化 → 下一 tick 完全相同
```

失败分支(`dispatcher:814-819`)与异常分支(`807-813`)都**不触碰 delivery 行**——`hold_count` 永远 0、`next_retry_at` 永远 NULL。这就是无界热循环的全部机制。

### 1.2 merge completion 扫描(`workflow-engine-dispatcher.ts:556-736`)

候选来自 `listRunnerShipHoldersForMergeProbe()`(`StateStore.ts:32474`):holder `state IN (materializing,awaiting_review,approved)` **AND run.status='active'**。已有两类出列记号:observation `quarantined`、`runner_ship_merge_deadend:{q}:{state}:{head}:{fp}` checked event(FLY-1624)。但 **completion 失败没有任何出列记号**:

```
probe.state==='merged' (观测 projection 已持久化,valid,head 匹配)
  → completeWorkflowGateRunAfterShip(...)                             ← StateStore.ts:33152
     事务内顺序:holder 校验 → candidate/subject/observation/rogue 校验
     → resolveEngineWorkflowShipClaims ✓(生产已过——否则失败 reason 会是 ship_claims_invalid)
     → UPDATE sessions SET status='completed'
        WHERE execution_id=? AND status IN ('awaiting_review','approved_to_ship')
          AND review_question_id=? AND lower(pr_head_sha)=?           ← 33306-33320
     → carrier session 37282acb 状态是终态 'blocked' → 0 行
  → recordRunnerShipCompletionFailureTx(carrier_session_mismatch)
     = checked event(幂等,只落一次)+ enqueueWorkflowEngineAlertTx(escalationUid 去重,只发一次)
  → { ok:false } → dispatcher:727 log 一行 → 下一 tick 候选原样再来
```

要点:**失败事件与告警已经是一次性的**(checked uid);无界的是「每 tick 重跑完成事务 + log」本身。

## 2. 三条账的合法终态判定

| 账 | 事实 | 合法终态 | 依据 |
| -- | -- | -- | -- |
| `rework:389336…`(FLY-1150) | route 指向 (implement,2,exec 0555207c),node 已 `failed`;route/request 不可变表 | delivery → **`needs_lead`**,run 保持 held | `needs_lead` 是 schema 内建终态;FLY-1638 已把「重试预算耗尽」定义为转 needs_lead;FLY-1434 `openOperatorRework` 对「run held + needs_lead delivery」有完整复活路径(quiescence 验证 + `rework_needs_lead_cleaned` + 凭据吊销) |
| `rework:e26a21…`(FLY-1596) | 同构:(implement,2,exec 695938e5) 已 `failed` | 同上 | 同上 |
| `workflow-gate:8213…`(FLY-1596 run fee58f20) | holder approved+bound,head f95c4b42 与已 merge 的 PR #778 观测一致,claims 有效;唯一拦路是 carrier session 已终态 `blocked` | **run → completed**(带 carrier disposition 记账),session 不动 | merge 证据真实且全部校验通过;run 完成是事实。session `blocked` 是它自己的账(runner 走 blocked 路线退出,FLY-1505 deflect),终态免疫(FLY-228/229)禁止回写;run event 里记 `carrierDisposition` 才是诚实账 |

`blocked` ∈ `ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES`(`StateStore.ts:382-390`:completed/failed/terminated/blocked/rejected/deferred/shelved),已有导出的判定函数 `isStateStoreIrreversibleTerminalForZombie`。

## 3. 手术的并发与执行形态验证

### 3.1 跨进程写是受支持模式(FLY-663 之后)

`StateStore.openDatabase`(`StateStore.ts:1320-1334`):better-sqlite3 + `journal_mode=WAL` + `synchronous=NORMAL` + `busy_timeout=5000`,注释明确写「retry transient locks (e.g. a cross-process WAL reader / checkpoint)」。写入即持久,无内存镜像(sql.js 时代的「必须经 RUNNING Bridge」约束已随 FLY-663 失效——`scripts/fly1165-archive-done-threads.mjs` 头注的旧告诫是 sql.js 时代产物)。

### 3.2 与旧栈 tick 的竞态推演(手术安全性)

- **rework 结账 vs 恢复分支**:手术把 delivery `held→needs_lead`(CAS `WHERE state='held' AND last_error='persisted_target_missing'`)。若旧栈 tick 恰在途中(已读到 held、正探活),它随后的 `materializeWorkflowReworkReplacement` 事务会**重读** delivery:`heldPaneLossRecovery` 谓词不再成立 → run.status='held'≠'active' → 返回 `rework_replacement_context_changed`,**零变异**。下一 tick lister 不再返回该行。安全。
- **gate 收口 vs merge 扫描**:手术把 run `active→completed`(CAS `WHERE status='active' AND current_node_id=?`)。旧栈 tick 若同时进完成事务,`runnerShipMutationHolder` 重读 run_status:`completed` 分支做幂等 replay 校验(`33221-33245`)——手术已写 `runner_ship_completed:{questionId}` run event,replay 匹配 → `{ok:true, idempotentReplay:true}`。下一 tick `r.status='active'` 过滤把 candidate 出列。安全。
- 双写冲突:WAL 单写者互斥 + busy_timeout 5000ms + 双方全部 CAS 化;最坏情况一方拿到 SQLITE_BUSY 重试或事务谓词失配而空转一次。

### 3.3 迁移面

`StateStore.create()` 无条件跑 `migrate()`。手术脚本**从 merge 后的 main checkout 构建产物运行**,应用的 schema 与 r4 将部署的完全一致;本单自身**零 schema 变更**(hold_count/next_retry_at/needs_lead 全部既存)。旧栈(4857d999)对 main 相对它的增量迁移(#780/#783/#778/#779/#784)按仓库惯例是幂等加性(FLY-1448:migration 仅容忍真实 duplicate column),旧查询不触新列。风险登记在 plan §7。

## 4. 防再发机制的既有骨架核对(全部实measured,零发明)

1. **退避存储**:`workflow_rework_delivery.hold_count` + `next_retry_at` 列既存;lister `StateStore.ts:20158-20163` 已带 `(next_retry_at IS NULL OR next_retry_at <= ?)` —— 写列即退避,lister 零改动。
2. **退避公式与预算**:FLY-1638 路径(`StateStore.ts:20794-20801`)`60_000 * 2^(holdCount-1)`,`holdCount >= 5` → `needs_lead`。新路径逐字复用(1m/2m/4m/8m → 第 5 次失败终态,前后共 ≈15 分钟)。
3. **终态告警形态**:同路径 `20935-20959`:进入 needs_lead 那一刻 `enqueueWorkflowEngineAlertTx` 一次 severe(escalationUid = checked event uid,天然去重)。红线核对:这不是 watchdog/陪跑——是既有终态入口告警形态的复用,之后永久静默。
4. **completion 失败的进程内计数**:dispatcher 已有 `shipReadyFounderRetries: Map`(`dispatcher:886-897`)做进程内退避的先例。completion 失败计数采用同形态(重启清零 → 重启后最多再失败 N 次即写 durable memo,有界)。
5. **completion 终态记号**:照抄 `runner_ship_merge_deadend` 的「checked event → lister 排除」模式(`StateStore.ts:32508-32518`),新增 uid 形态 `runner_ship_completion_deadend:{questionId}:{head}`,lister 加一条同款排除探询。**不加第二个告警**——`recordRunnerShipCompletionFailureTx` 已在首次失败时发过一次 severe(`33387-33411`),memo 只是执行「停止重试」。

## 5. 回归面(必须不被破坏的行为)

- **健康 held pane-loss 恢复**(FLY-1628 主场景):target node 仍 pending/admitted + actor 真死 → materialize 成功换人。成功路径零改动;新逻辑只挂在 `ok:false` 之后。
- **pending/turn_granted 投递失败的既有退避**(FLY-1638):不同方法、不同调用点,但共享 `hold_count` / `next_retry_at`。held pane-loss 成功恢复会让同一 request 经 `replacement_pending` 回到投递链,所以成功臂必须同时把两列重置为 `0 / NULL`;否则 held 恢复的旧预算会污染后续投递预算与 stall 扫描。终态 `needs_lead` 复活仍由 `openOperatorRework` 创建新 request,预算从 0 起。
- **needs_lead 复活路径**(FLY-1434):其谓词是 `run.status='held'` + delivery `needs_lead`。新 settle 保持 run held ✓、delivery needs_lead ✓ —— 正好落在复活路径的合法输入域内。
- **merge probe 预算/memo**(FLY-1624):completion dead-end memo 让 candidate 整体出列,GraphQL 消耗只降不升。
- **FLY-1505 deflect**:carrier 已终态的收口臂只在「question+head 逐字匹配 + 终态」时放行,deflect 写下的 blocked 会话本身不被改写。

## 6. 关键否决项(调研中排除的方案)

- **直改 SQL / 删行**:`workflow_rework_request`/`workflow_rework_route_revision` 带 immutable 触发器(UPDATE/DELETE 直接 ABORT);delivery 虽可写,但绕过 StateStore 会漏 run event、凭据吊销、告警与 CAS。弃。
- **把 blocked session 复活成 completed 来喂过 UPDATE**:伪造 session 台账,违反终态免疫。弃。
- **恢复分支对「target 已终态」立即判死(不走 5 次预算)**:需要在恢复分支里做失败原因分类学,分类错一个就把可自愈账误判死。统一 5 次预算 + 退避,15 分钟到终态,简单且足够快。弃(记入 plan 备选)。
- **给恢复循环加 env 开关**:违反 Annie「不加新 flag」铁律(FLY-1466)。常量内联。弃。
