# FLY-1628 pane-loss 结算 reconciler — 实施计划

Issue: FLY-1628 (https://linear.app/geoforge3d/issue/FLY-1628/pane-loss-reconcilertmux-体已灭但-commdb-仍-runningparked-全量重启会成批制造现无任何)
日期: 2026-08-04
基于: 无（本文档为 plan_only 档唯一文档；审计事实内嵌于 §2/§3）

---

## 0. 一句话总结

给 Bridge 的既有 residue-harvest 骨架加一个 **pane-loss 结算 face**：在 Bridge boot 与既有维护 pass 里，把「tmux 体已双重证实消失、但账面仍是 running/parked」的 runner session 结算掉（running 族自动转 `failed`，founder-bound 的 parked 族只记账+出恢复提案不动权威绑定），并顺手止住 `absent→indeterminate` 映射造成的 wake_failed 无限重发——零新 timer、零新表、零新 env flag、不自动重派。

## 1. 背景与范围裁定

### 1.1 现象（2026-08-03 19:23 事故）

全量重启后全舰 runner tmux 体消失，但账面没跟上：FLY-1624 在 StateStore 仍标 `running`，FLY-1482/FLY-1518 挂着死体等 gate/review，2 小时以上无自愈；watchdog 对空窗连发 4 次 `wake_failed`；`monitoring_lost` 只发 FYI 不改状态。

### 1.2 死因修正（eng-lead 2026-08-04 裁定，替代 issue 原文推断）

`restart-services.sh` 脚本本体**对 runner 完全无认知**（全文仅 1 处注释提及 runner，无任何 runner 代码路径）。真正嫌疑是 FLY-1482 新引入的 `restart_cmux_watcher()`（`scripts/lib/restart-cmux-watcher.sh:97`）`launchctl bootout com.flywheel.cmux-watcher`：生产 tmux server 若是该 launchd job 的后代，bootout 连带整棵进程树 → 全舰 runner window 同时消失。时间线支持：FLY-1482（`05e7b451`）2026-08-03 17:00 merge，19:23 事故 = 该 commit 首次全量部署。eng-lead 独立确认死因是「tmux server 死亡（QA 台架事故），非 restart-services 重启路径」。

**对设计的含义**：死因不唯一也不可控（bootout 连带 / QA 台架 / 未来任何 tmux server 崩溃都会成批制造）。所以修法必须是**与死因无关的账面结算**，而不是堵某一条产线。

### 1.3 继任交接与口径收窄

本 plan 由继任执行体（RC-6）完成。前任 WIP plan 的抢救提交经完整核查（全分支 git log / stash / dangling / 文件系统）不存在，已报 eng-lead；前任结论经 eng-lead 转述继承：

- **teardown 时结算、不做常驻巡逻**（不新增任何 FLY-1570 刚删掉的那类追人型 watchdog/poller）。
- **检测语义分 vendor**：2026-08-04 16:37 事故中，FLY-1625 的 claude 体死后靠既有 zombie 链 20 分钟才被抓；FLY-1634 的 Codex 常驻体**根本没死**——窗口消失对 codex 不等于 runner 死亡。
- **伤害②（等 founder 审批的 parked-alive runner 被无差别拆掉，需要保护/知情而非记账）不并入本单、暂不立单**（eng-lead 裁定 a33b0dc9）：restart-services.sh 是 FLY-1634（重启减法）的现役刀口，且「知情提示」尚无 restart 路径的事故背书。处置见 §8.1 boundary。

### 1.4 与 FLY-1383 的分工

FLY-1383 = 清存量（自然漂移的僵尸 + 归属 Lead 的域内 finalize 杠杆）；本单 = 关产线（成批制造后的自动结算）。本单复用 FLY-1383 五人收敛的安全规格（直连探测、阳性对照、双阴性才动手、indeterminate 跳过、永不 done=true、不 archive 活 thread），见 §5。

## 2. 根因矩阵：为什么现有每一层都接不住（三路代码审计结论）

| 机制 | 候选集/谓词 | 为什么不覆盖「体灭+账面 running/parked」 |
|---|---|---|
| FLY-817 `commdb-fsm-reconcile.ts` | CommDB running 行 × FSM ∈ 可删集 `{completed,rejected,deferred,shelved,terminated,approved}` | FSM 是活的 `running/parked` 就永远保留，根本不探 tmux（`:232`）；且 parked 声明一律 veto（`:251-272`） |
| FLY-1066③ `statestore-ghost-reconcile.ts` | StateStore `{pending,running}` × 同 pass CommDB **terminal** prune 提供的已证死 target | running 行结构性产不出证据（`:176-177`）；`awaiting_review/ship_parked` 不在扫描范围（`:22-25`） |
| FLY-324 `done-running-reconciler.ts` | `running && session_stage=completed && 无 route && 无 PR` | 重启死体从没上报过 completed stage（`:71-78`） |
| `reapOrphans`（HeartbeatService.ts:2150） | `getOrphanSessions`：`status='running' AND heartbeat_at IS NOT NULL AND heartbeat_at < now-60min`（StateStore.ts:6191） | **parked 族永远不是候选**；running 族依赖 heartbeat 老化 + 下述活锁 |
| zombie 链（`reconcileMonitorLoss` → `declareZombie`） | running 族 orphan 候选 × tmux `dead` 连续 2 streak × `probeTmuxServer()==="up"` | 舰队级 server 死亡时 `probeTmuxServer()!=="up"` → **streak 清零**（HeartbeatService.ts:1000-1002），永远到不了宣告阈值 = 活锁；parked 族同样不进候选 |
| crash-reaper（FLY-720） | orphan 候选 × `probeRunnerProcessLiveness==="dead_pin"`（`[exited]` 残窗） | **窗口整个消失 = `absent` = 显式甩给 reapOrphans**（crash-reaper.ts:216-220），回到上面两行的真空 |
| RunnerIdleWatchdog | `status==="running"` × capture | 窗口不存在 → capture 502 → `runner-status.ts:242-250` 编码成 `unknown` → `RunnerIdleWatchdog.ts:246-250` **静默 return**（谓词性失效） |
| cmux-sync `pane-died` 全局 hook（FLY-1110） | pane 死亡事件 → cmux workspace 卫生 | 只管 UI 从不写账面；`tmux kill-window`/server 死亡时 `pane-died` 语义上不 fire；重启窗口内 watcher 本身是死的 |
| `restart-services.sh` | Lead 侧有 FLY-1602 全套 replacement reconcile | **runner 侧零 reconcile**（重启前 wait-idle 默认 OFF 且只看 Bridge sessions_count；重启后只有 cmux UI refresh/播报） |
| FLY-1570 删除面 | 原 park-watch / receipt patrol / stuck 家族 | 已整体删除（-32k 行）——`wake_failed` 与 park 巡逻**现在没有任何消费者**，账面停在 parked 无人纠正是既成事实 |

**wake_failed 洪水的精确源头**（验收 3 的靶点）：GatePoller `staleApprovedShipReconcilePass`（gate-poller.ts:2995-3070）对 `approved_to_ship` 候选做 probe，`classifyStaleShipRunnerLiveness` 把 `absent`（窗口已消失）映射成 `indeterminate`（stale-approved-ship-reconciler.ts:144-150），走「无害幂等 re-wake」路径每 5 分钟一发、永远到不了一次性 `alertDead` 分支；叠加 `runner-wake.ts:232` 的 event_id 带 `Date.now()`（`wake-failed-<execId>-<Date.now()>`）使 insertEvent UNIQUE 去重完全失效。

**「parked」的字面账本**（术语澄清）：issue 说的 CommDB 实为两库三层——StateStore（`~/.flywheel/teamlead.db`）的 FSM 状态 `ship_parked/awaiting_review/approved_to_ship/design_done`；CommDB（`~/.flywheel/comm/<project>/comm.db`）的 `sessions.status` park 时**设计上保持 `running`**（FLY-626 done-but-alive 语义）；外加 FLY-1448 的 `workflow_engine_park` 投影表。三者之间零一致性约束。本单的结算对象以 **StateStore 状态**为准（它是 FSM 权威），CommDB 侧靠既有 terminal-commdb-sync / FLY-817 链自动跟进，不新增 CommDB 写路径。

## 3. 设计原则

1. **简单为主**（founder 直令 2026-08-04）：复用 residue-harvest 骨架与既有动词，零新 timer / 零新表 / 零新列 / 零新 env flag（master 开关 `FLYWHEEL_COMMDB_RESIDUE_HARVEST=0` 免费覆盖本 face）。
2. **结算，不巡逻**：只在 Bridge boot 的 residue sweep 与既有 ~hourly 维护 pass（FLY-1570 明确保留的「状态收敛对账」类）里跑；不新增任何独立 poller、不读 pane 内容、不追人。
3. **fail-closed**：任何 indeterminate（server 状态不明 / probe 报错 / CommDB 读失败 / 反查 ambiguous）= 跳过本轮。误放过的代价是下轮再看；误结算的代价是杀掉活 runner 的账——不对称，永远向跳过倾斜。
4. **terminal immunity**（FLY-228/229 Finding K）：terminal 状态一律不碰。样本 `d0bf4e5d`（账面 completed、体多活一天）在候选集之外，天然安全。
5. **不自动重派**：结算只记账+出提案；重派/重跑永远是 Lead/founder 的显式动作。
6. **founder authority 不可被 reconciler 作废**：`awaiting_review/approved_to_ship` 上可能挂着活的 founder 批准流（verify-approval 绑定）。自动转 terminal 会作废批准（既有纪律：blocked 路由作废活批准，同理适用）。故 parked 族 v1 只告知+提案（§4.4）。

## 4. 方案

### 4.1 新模块与接线

新文件 `packages/teamlead/src/bridge/pane-loss-reconcile.ts`，导出 `reconcilePaneLoss(projectName, deps)`。接线复制既有 face 的形状：

- `ResidueHarvesterDeps`（residue-harvest.ts:19-34）新增 `harvestPaneLoss`，per-project 循环（`:45-70`）里作为**第 4 步**（在 `harvestStateStoreGhosts` 之后——它面向的是相反方向的行，顺序无依赖，放最后最直观）。
- `createResidueHarvester`（plugin.ts:5012-5071）注入实现。由此免费获得：boot fire-and-forget sweep（plugin.ts:6446）+ ~hourly 维护 tick（plugin.ts:6082）+ 单飞 + master kill-switch。
- 每 face 独立 try/catch（骨架既有约定），本 face 异常不影响其他 face。

### 4.2 候选集与证据链（谓词）

候选：`store.getActiveSessions()` 中 `status ∈ {running, ship_parked, awaiting_review, approved_to_ship, design_done}` 的 session。排除：

- 宽限期：`started_at` 或 `stage_updated_at` 距今 < 10 分钟（新 spawn 的窗口创建 / FLY-1269 lazy window 竞态）。
- 有 pending complete marker（复用 `hasPendingCompleteMarker`，FLY-172 拥有真路由）。
- `adapter_type` 为 no-transport 后端（antigravity/kimi 等 `pr_handoff` 族按各自终态生命周期走，不适用 tmux 体语义）。

每个候选跑证据链（全部只读 tmux 命令、每步有超时、不抢 `~/.flywheel/locks/tmux-*.lockf`——FLY-1627 教训：任何抢 tmux 锁的常驻行为都可能饿死 Lead）：

```mermaid
flowchart TD
    A[候选 session] --> B{probeTmuxServer}
    B -- "down/unknown" --> SKIP1[跳过本轮\n阳性对照失败=尺子不可信]
    B -- up --> C{lookupTmuxTarget\nCommDB tmux_window}
    C -- error --> SKIP2[跳过 indeterminate]
    C -- found --> D{probeRunnerProcessLiveness}
    D -- alive --> KEEP[不碰 反向安全]
    D -- dead_pin --> OWN[留给 crash-reaper\n既有 owner]
    D -- indeterminate --> SKIP3[跳过]
    D -- absent --> E{discoverTmuxTargetByExecutionId\n@flywheel_exec_id 全窗反查}
    C -- gone --> E
    E -- found --> F[改用反查 target 重新 probe\nFLY-1319 stale-mapping 场景]
    E -- "ambiguous/indeterminate" --> SKIP4[跳过]
    E -- missing --> G{vendor 门}
    G -- claude-tmux --> SETTLE[双阴性成立 → 结算 §4.3/4.4]
    G -- codex-tmux --> ADV[仅 advisory §4.5\n常驻体可能未死]
```

要点：

- **阳性对照**（FLY-1383 规格）：`probeTmuxServer() === "up"` 是本 pass 的总闸——server 不可证明为 up 时所有候选一律跳过，杜绝 §2 的 streak-清零同款陷阱反向复现（我们不是清零重来，而是整轮不动手）。
- **双阴性**：权威 target（CommDB `tmux_window`，唯一可信路由）probe 为 `absent` **且** `@flywheel_exec_id` 全窗反查 `missing`。反查同时化解 FLY-1319「窗名映射过期」歧义——这正是 FLY-817 park-guard veto 所防的形态，我们用更强证据满足其安全意图而非绕过它。claude-tmux 下 pane 进程随窗口 SIGHUP 消亡，窗口级双阴性即体亡证据；不再引入 pgrep 级第三探针（简单为主；`remain-on-exit` 尸体属 `dead_pin`，归 crash-reaper）。
- 探针全部复用 `tmux-lookup.ts` 既有函数（`probeTmuxServer:333` / `lookupTmuxTarget:227` / `probeRunnerProcessLiveness:434` / `discoverTmuxTargetByExecutionId:76`），零新探测代码。

### 4.3 running 族的结算动词

`status === "running"`（含带 `runner_declared_states` park 声明的 running——声明是「活着等」，体已双重证实不在，声明失效）：

- `applyTransition(transitionOpts, execId, "failed", {trigger: "pane_loss_reconcile"}, {last_error: "pane_loss: tmux body absent (server up, target <t> absent, exec-id rediscovery missing)"})`。
- 动词选 `failed` 而非新造 `orphaned` 状态：与 orphan-reap（`Orphaned: no heartbeat…`）、zombie（`zombie: …`）同族先例一致，`last_error` 前缀 `pane_loss:` 已可区分与检索；新 FSM 状态要求全部消费者（display/reaper/close/QA）学习新词，违反简单为主。CRASH_PRESERVE 语义随 `failed` 免费获得（不 auto-archive thread，现场可查）。
- CommDB 侧零新写路径：transition 触发既有 `terminalCommDbSync.enqueue(failed)` → `markSessionTerminalStatus`，此后 FLY-638/817 墓地清扫按既有节奏收尾。
- 不触发任何 retry/respawn（与 orphan-reap 同语义：通知 Lead，行动归人）。

### 4.4 parked 族（founder-bound）的结算动词：记账+提案，不动权威

`status ∈ {ship_parked, awaiting_review, approved_to_ship, design_done}` 的双阴性死体：

- **不自动改 status**。这些状态上挂着 founder 批准流绑定（`review_question_id` / `pr_head_sha` / verify-approval / FLY-1448 park authority）；reconciler 自动转 terminal = 作废活批准，正是「reconciler 只能如实记账，破坏已经发生」要避免的第二次破坏。
- 落一条 durable 事件：`insertEvent({event_type: "runner_pane_loss_detected", event_id: "pane-loss-<execId>", source: "bridge.pane-loss-reconcile"})`——**稳定 event_id，天然幂等**（重复 pass 不重发）。
- 发 issue thread 状态说明 + 恢复提案（§4.6），提案含 Lead 一条命令收尾的 `close_runner --abandon <execId>` 指引（既有人工动词，ABANDON 路径 founder/Lead 拍板后执行）。
- 对验收 1 的偏差声明：「离开 running/parked」对 running 族自动达成；对 founder-bound 族改为「一个 reconcile 周期内可见的 thread 告知 + 一条命令的人工收尾」。理由如上——这是**有意的裁定请求点**，若 eng-lead/design review 判定 parked 族也应自动转（例如统一 `terminated`），实现侧只是把 §4.4 第一条换成 applyTransition，其余证据链/通知不变。

### 4.5 vendor 门

`vendor/adapter_type` 判定（StateStore `adapter_type` 列，`sendRunnerWake` 同款判据）：

- `claude-tmux`：按 §4.3/4.4 结算。
- `codex-tmux`：FLY-1634 实证窗口消失后 Codex 常驻体仍在服役。v1 **一律只 advisory**（同 §4.4 的事件+thread 说明，措辞标明「窗口消失但 Codex 体可能存活，需人工核实 `codex resume` 线程」），不改任何状态。codex 的进程级活性判定（CODEX_HOME 绑定探测）留 follow-up，不在本单堆机制。

### 4.6 通知路径与文案

复用 routed infra alert（`buildInfraAlertRouting`，infra-alert-wiring.ts:61 → `emitIssueThreadInfraNotification`，founder-thread-notifier.ts:627；undeliverable 自动落 ticket-queue fallback）。本家族第一个发 thread 通知的 face。每条包含：

1. 发生了什么（体消失时间窗 + 证据摘要：server up / target absent / 反查 missing）；
2. 账面处置（running→failed，或 parked 族「状态保留，等待人工裁定」）；
3. 恢复提案（该 issue 的 PR/gate 现状引用 + 建议动作：重派需 Lead/founder 显式发起；parked 族附 `close_runner --abandon` 指引）;
4. 明示「未自动重派」。

去重：`pane-loss-<execId>` 稳定 event_id 先查后发，每 execution 终身一条。

### 4.7 wake_failed 止血（验收 3）

两个最小修改，均在既有文件内：

1. `stale-approved-ship-reconciler` 的 `absent` 分流：probe 组合处（gate-poller.ts:3023-3031）对 `absent` 追加 `discoverTmuxTargetByExecutionId` 二次证据——found → 按反查 target 重新 probe（stale-mapping 自愈）；missing（且 server up）→ 归入 `dead`，走既有**一次性** `alertDead` 分支并停止 re-wake 循环；ambiguous/indeterminate → 维持现状（幂等 re-wake）。纯分类收紧，`classifyStaleShipRunnerLiveness` 的注释合同同步更新。
2. `runner-wake.ts:232` 的 event_id 去掉 `Date.now()`：改 `wake-failed-<execId>-<questionId|kind>`，让 insertEvent UNIQUE 对同源重试真正去重（遥测层，不影响任何行为路径）。

## 5. 安全规格（FLY-1383 五人收敛规格的落位）

| 规格 | 本设计落位 |
|---|---|
| 直连探测，不信中介 not-found | 全部 tmux-lookup 直连命令；CommDB 读失败 = indeterminate 跳过 |
| 阳性对照 | `probeTmuxServer()==="up"` 总闸（§4.2） |
| 双阴性才动手 | 权威 target absent + exec-id 全窗反查 missing |
| indeterminate = 跳过 | 证据链每个非绿分支都是 skip，无兜底猜测 |
| 永不 done=true / 不 archive 活 thread | 动词仅 failed（CRASH_PRESERVE 不 archive）；parked 族不动状态 |
| 自动化前 dry-run | 首个生产 pass 前以 `--dry-run` 形态跑一轮输出清单人工过目（QA 步骤，§7） |
| 反例 fixture | 活体必不误杀（对照组）；d0bf4e5d 型（terminal+体活）不在候选集 |

## 6. 数据/结构模型

零新表、零新列、零迁移。新增的只有两个 `insertEvent` 事件类型字符串：`runner_pane_loss_detected`（parked/codex advisory）与既有 `session_failed` 家族沿用（running 族 transition 自带）。`last_error` 新前缀 `pane_loss:`。

## 7. 测试与验收

### 7.1 TDD（vitest，`packages/teamlead`）

- `pane-loss-reconcile.test.ts`：证据链全分支表驱动（server down 全跳过 / target found+alive 不碰 / dead_pin 让位 / absent+反查 found 重探 / absent+missing+claude → failed / parked 族 → 事件+不改状态 / codex → advisory / 宽限期 / complete-marker 排除 / no-transport 排除 / event_id 幂等 / 通知 undeliverable fallback）。
- `stale-approved-ship-reconciler.test.ts` 扩展：absent+反查 missing → 一次 alertDead 后停环（对照：修前无限 re-wake 的红测先行）；absent+反查 found → 重探活体继续 re-wake。
- `runner-wake` event_id 去重回归。
- 反向兼容哨兵：`FLYWHEEL_COMMDB_RESIDUE_HARVEST=0` 时本 face 一行不跑（骨架既有开关语义）。
- 突变测试（防绿色谎言）：把「反查 missing」条件反转 → 双阴性用例必须变红。

### 7.2 真机 QA（529 房 / 独立 QA 节点执行）

映射 issue 四条验收：

1. **制造条件**：529 隔离房带 active claude runner，杀 tmux server（模拟 bootout 连带）→ 重启 slot Bridge → 首个 boot residue pass 内该 session 离开 `running`（→`failed`，`last_error` 前缀 `pane_loss:`）。
2. **thread 说明**：对应 issue thread 出现状态说明+恢复提案，且无自动重派（无新 session 行）。
3. **wake 回归**：制造 `approved_to_ship` 死体 → 观察 ≥3 个 backoff 窗口，`runner_wake_failed` 增量为 0、`alertDead` 恰 1 次（对照修前：每 5 分钟一发）。
4. **反向安全（对照组，硬门）**：同房并跑 ≥1 个活 claude runner + 1 个活 codex runner 穿越整个 pass——账面零变化、零通知。无对照组的 PASS 无效（healthy-control 纪律）。

### 7.3 全仓门

`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + Codex code review（xhigh）照常。

## 8. Boundary（本设计不做什么）

1. **伤害②（重启前保护/知情 founder-gated parked runner）**：per eng-lead 裁定不并入不立单。形态与建议记录在此供 FLY-1634 取用：全量重启前对 `awaiting_review/approved_to_ship` 且体活的 session 输出一行知情提示（「本次重启将带走 N 个正在等 founder 的 runner」），归 FLY-1634 成功判据输出层；待出现 restart 路径真实事故背书再立单。
2. **存量清理与域内 finalize 杠杆**：FLY-1383（含 `close_runner` 对 `ship_parked` 的 ABANDON/DONE 集缺口）。
3. **codex 进程级活性判定与自动结算**：v1 advisory-only，follow-up 另立。
4. **RunnerIdleWatchdog 的 `unknown` 静默 return**：谓词性失效确认存在，但修它=恢复 3s 级追人语义，与收窄口径冲突；boot+hourly 结算已覆盖本单验收，弃。
5. **`workflow_engine_park` 投影一致性纠偏**：FLY-1448 权威链自会收敛，本单不碰。
6. **Bridge 存活期间 parked 族死体的小时级延迟**：结算最快在下一个维护 pass（≤1h）。更快的检测=巡逻，违反口径；接受并明示。
7. **cmux-watcher bootout 连带拆 tmux server 的产线本身**：属 FLY-1482/1634 修架构的领域；本单只保证「无论谁拆的，账面一个周期内结清」。

## 9. Rejected alternatives

| 方案 | 弃因 |
|---|---|
| 新常驻 pane-loss 巡逻（独立 poller/秒级检测） | 与 FLY-1570 减法方向、eng-lead 收窄口径直接冲突 |
| 新 FSM 状态 `orphaned` | 全消费者学新词；`failed + last_error 前缀`已达可区分/可检索/可恢复 |
| parked 族自动转 terminated | 作废活 founder 批准（verify-approval/park authority 绑定）；改为记账+一条命令人工收尾 |
| teardown marker 文件（restart-services 落盘、Bridge boot 消费） | 多一个跨进程契约；boot 结算不需要知道「谁拆的」，双阴性证据自足 |
| 修 RunnerIdleWatchdog 谓词 | 见 §8.4 |
| pgrep 进程级第三探针（claude 族） | 窗口级双阴性已充分（pane 进程随窗 SIGHUP）；argv 无 exec-id，实现脆 |

## 10. 交付物与里程碑

- PR（单个）：`pane-loss-reconcile.ts` + residue-harvest face 接线 + stale-ship absent 分流 + wake event_id 去重 + 测试；本 plan 与 founder HTML 随分支进 main；CLAUDE.md 里程碑行 + doc 归档随 PR 最后一个 commit。
- 版本：v1.5x.x（ship 时取空号）。
- 实施顺序：RED（§7.1 全红测先行）→ GREEN → stale-ship 分流 → 通知 → 全仓门 → Codex code review → 529 QA → founder 批准 ship。
