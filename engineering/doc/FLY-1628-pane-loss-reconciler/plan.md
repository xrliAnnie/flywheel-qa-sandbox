# FLY-1628 pane-loss 结算 reconciler — 实施计划

Issue: FLY-1628 (https://linear.app/geoforge3d/issue/FLY-1628/pane-loss-reconcilertmux-体已灭但-commdb-仍-runningparked-全量重启会成批制造现无任何)
日期: 2026-08-04
基于: 无（本文档为 plan_only 档唯一文档；审计事实内嵌于 §2/§3）

---

## 0. 一句话总结

给 Bridge 的既有 residue-harvest 骨架加一个 **pane-loss 结算 face**：在 Bridge boot 与既有维护 pass 里，用**可复现的正向死亡证据（server-generation proof：当前 tmux server 的 `#{start_time}` 晚于 session 注册时间 ⇒ 承载它的 server 化身已死，pane 进程必已随 SIGHUP 消亡）**把「体已灭、账面仍 running」的 claude runner 结算成 `failed`；founder-bound 的 parked 族与 codex 族只记账+出恢复提案；同世代的 `absent` 严格遵守 FLY-1319 合同（absent ≠ 死亡）只 advisory。与 FLY-1082 ServerLossCoordinator 按 loss shape 划分唯一 owner，episode/hold 活跃时本 face 整体让位。零新 timer、零新表、零新 env flag、不自动重派。

## 1. 背景与范围裁定

### 1.1 现象（2026-08-03 19:23 事故）

全量重启后全舰 runner tmux 体消失，但账面没跟上：FLY-1624 在 StateStore 仍标 `running`，FLY-1482/FLY-1518 挂着死体等 gate/review，2 小时以上无自愈；GatePoller 对 `approved_to_ship` 死体每 5 分钟 re-wake 一次（`runner_wake_failed` 连发）；`monitoring_lost` 只发 FYI 不改状态。现场残留 6 个 `runner-fly758it` zsh 空壳窗——这个细节是 §2.2 根因假设的关键。

### 1.2 死因修正（eng-lead 2026-08-04 裁定，替代 issue 原文推断）

`restart-services.sh` 脚本本体**对 runner 完全无认知**（全文仅 1 处注释提及 runner，无任何 runner 代码路径）。真正嫌疑是 FLY-1482 新引入的 `restart_cmux_watcher()`（`scripts/lib/restart-cmux-watcher.sh:97`）`launchctl bootout com.flywheel.cmux-watcher`：生产 tmux server 若是该 launchd job 的后代，bootout 连带整棵进程树 → 全舰 runner window 同时消失。时间线支持：FLY-1482（`05e7b451`）2026-08-03 17:00 merge，19:23 事故 = 该 commit 首次全量部署。eng-lead 独立确认死因是「tmux server 死亡（QA 台架事故），非 restart-services 重启路径」。

**对设计的含义**：死因不唯一也不可控。修法必须是**与死因无关的账面结算**，而不是堵某一条产线。

### 1.3 继任交接与口径收窄

本 plan 由继任执行体（RC-6）完成。前任 WIP plan 的抢救提交经完整核查（全分支 git log / stash / dangling / 文件系统）不存在，已报 eng-lead；但前任与 Codex 的 design review Round 2–4 feedback 从 /tmp 完整回收（前任走的是 CommDB claims/TTL lease/step-receipt 的跨库 saga 路线，R4 仍剩 5 个 blocker、R5 进行中被杀——其教训与竞态反例已折入本 plan §4.3 fence 与 §9）。前任结论经 eng-lead 转述继承：

- **teardown 时结算、不做常驻巡逻**（不新增任何 FLY-1570 刚删掉的那类追人型 watchdog/poller）。
- **检测语义分 vendor**：2026-08-04 16:37 事故中，FLY-1625 的 claude 体死后靠既有 zombie 链 20 分钟才被抓；FLY-1634 的 Codex 常驻体**根本没死**——窗口消失对 codex 不等于 runner 死亡。
- **伤害②（等 founder 审批的 parked-alive runner 被无差别拆掉，需要保护/知情而非记账）不并入本单、暂不立单**（eng-lead 裁定 a33b0dc9）。处置见 §8.1 boundary。

### 1.4 与 FLY-1383 的分工

FLY-1383 = 清存量（自然漂移的僵尸 + 归属 Lead 的域内 finalize 杠杆）；本单 = 关产线（成批制造后的自动结算）。本单复用 FLY-1383 五人收敛的安全规格（直连探测、阳性对照、正向证据才动手、indeterminate 跳过、永不 done=true、不 archive 活 thread），见 §5。

## 2. 根因矩阵：为什么现有每一层都接不住（三路代码审计 + Codex R1 补全）

### 2.1 per-session 机制矩阵

| 机制 | 候选集/谓词 | 为什么不覆盖「体灭+账面 running/parked」 |
|---|---|---|
| FLY-817 `commdb-fsm-reconcile.ts` | CommDB running 行 × FSM ∈ 可删集 `{completed,rejected,deferred,shelved,terminated,approved}` | FSM 是活的 `running/parked` 就永远保留，根本不探 tmux（`:232`）；且 parked 声明一律 veto（`:251-272`） |
| FLY-1066③ `statestore-ghost-reconcile.ts` | StateStore `{pending,running}` × 同 pass CommDB **terminal** prune 提供的已证死 target | running 行结构性产不出证据（`:176-177`）；`awaiting_review/ship_parked` 不在扫描范围（`:22-25`） |
| FLY-324 `done-running-reconciler.ts` | `running && session_stage=completed && 无 route && 无 PR` | 重启死体从没上报过 completed stage（`:71-78`） |
| `reapOrphans`（HeartbeatService.ts:2150） | `getOrphanSessions`：`status='running' AND heartbeat_at IS NOT NULL AND heartbeat_at < now-60min`（StateStore.ts:6191） | **parked 族永远不是候选**；running 族依赖 heartbeat 老化 + 下述活锁 |
| zombie 链（`reconcileMonitorLoss` → `declareZombie`） | running 族 orphan 候选 × tmux `dead` 连续 2 streak × `probeTmuxServer()==="up"` | 舰队级 server 死亡时 `probeTmuxServer()!=="up"` → **streak 清零**（HeartbeatService.ts:1000-1002），到不了宣告阈值；parked 族不进候选 |
| crash-reaper（FLY-720） | orphan 候选 × `probeRunnerProcessLiveness==="dead_pin"` | **窗口整个消失 = `absent` = 显式甩给 reapOrphans**（crash-reaper.ts:216-220），回到上面两行的真空 |
| RunnerIdleWatchdog | `status==="running"` × capture | 窗口不存在 → capture 502 → `runner-status.ts:242-250` 编码成 `unknown` → `RunnerIdleWatchdog.ts:246-250` **静默 return** |
| cmux-sync `pane-died` hook（FLY-1110） | pane 死亡事件 → cmux workspace 卫生 | 只管 UI 从不写账面；kill-window/server 死亡时 `pane-died` 不 fire |
| `restart-services.sh` | Lead 侧有 FLY-1602 全套 replacement reconcile | **runner 侧零 reconcile**（wait-idle 默认 OFF 且只看 Bridge sessions_count） |
| FLY-1570 删除面 | 原 park-watch / receipt patrol / stuck 家族 | 已整体删除（-32k 行）——`wake_failed` 与 park 巡逻现在没有任何消费者 |

### 2.2 舰队级 owner：FLY-1082 `ServerLossCoordinator` 为什么 08-03 没开火（Codex R1 Blocker 1 的回答）

`server-loss.ts` 是「13 runner 同死」loss shape 的**现任 owner**（HeartbeatService.check() 内、crash-reaper 之前运行，`plugin.ts` 注入 migrate=failed 迁移 + 分组通知 + fleet ticket）。它有两条腿，08-03 都可解释为未触发（三个代码锚定的假设，按可能性排序；行为日志取证归 implement/QA 段）：

1. **boot leg 的 ALL-gone 脆性**（`server-loss.ts:286-297`）：server up + 首个 check 时要求 `running.length >= FLYWHEEL_TMUX_MASS_LOSS_MIN(3)` 且 **`verdicts.every(v => v === true)`——任何一个 target 判 present/indeterminate 都整体否决**。现场 6 个 `runner-fly758it` zsh 空壳窗恰好会让部分 target 判 present → 整批零结算。ALL-or-nothing 的聚合守卫在「干净满员死亡」下工作，在「脏残局」下失效——这正是本单要补的洞。
2. **boot leg 是 one-shot**（`server-loss.ts:149,189-190` `firstCheck`）：Bridge boot 首个 check 时若 tmux server 还没被 cmux watcher 重建（restart-services 的 watcher 重启在 Lead 波次之后），走 server_down leg → socket inspection 非 `dead` → **开 durable hold**（`:270-283`）；hold 后续解除时 firstCheck 已消费，fresh leg 永不再评估。
3. **候选集 running-only**（`:191` `getRunningSessions().filter(isTmuxBacked)`）：parked 族（awaiting_review/ship_parked/…）从不进 coordinator 视野——1482/1518 型死体结构性不归它管。

### 2.3 ownership 划分（每种 loss shape 唯一 owner）

| loss shape | owner | 动作 |
|---|---|---|
| server **provably down**（tick leg） | ServerLossCoordinator（不动） | 既有：episode + migrate(failed) + 分组通知 |
| server fresh + **满员** ALL-gone（boot leg） | ServerLossCoordinator（不动） | 既有 |
| **健康 server 上的 per-session 残局**（脏 fresh / boot leg 错过 / hold 解除后 / 个别窗被拆） | **本单新 face** | server-generation proof → 结算（§4） |
| parked 族死体（任何成因） | **本单新 face** | advisory + 恢复提案（§4.4） |
| codex 族窗口消失 | **本单新 face** | advisory（§4.5） |
| `[exited]` 尸体 pane（dead_pin） | crash-reaper（不动） | 既有 |

**互斥规则**：本 face 每个 pass 开头读 `store.getServerLossEpisode()` 与 `store.listActiveTmuxHolds()`——**任一活跃 → 本 face 本 pass 整体让位**（fail-closed stand-down）。coordinator 在 HeartbeatService 主链内、本 face 在 residue 骨架内，调度互不嵌套；让位规则保证任一时刻至多一个 owner 在动同一族行。加互动测试（§7.1）。

coordinator 自身的 vendor 盲区（`isTmuxBacked` 含 codex-tmux；server_down 下 codex 本地驾驶席确随 server 死，但 detached 常驻体可能存活）：fresh leg 的 ALL-gone 谓词天然被活 codex 否决（不会误埋）；server_down leg 的语义「本地驾驶席已死、线程可 resume」在通知文案中已成立。**v1 不动 coordinator**；其 vendor 精细化列入 §8 boundary。

### 2.4 wake_failed 洪水的精确源头（验收 3 的靶点）

GatePoller `staleApprovedShipReconcilePass`（gate-poller.ts:2995-3070）对 `approved_to_ship` 候选做 probe，`classifyStaleShipRunnerLiveness` 把 `absent` 映射成 `indeterminate`（stale-approved-ship-reconciler.ts:144-150）→「无害幂等 re-wake」每 5 分钟一发、永远到不了一次性 `alertDead`；叠加 `runner-wake.ts:232` event_id 带 `Date.now()` 使 insertEvent UNIQUE 去重失效。

### 2.5 术语澄清：「parked」的字面账本

issue 说的 CommDB 实为两库三层——StateStore（`~/.flywheel/teamlead.db`）的 FSM 状态 `ship_parked/awaiting_review/approved_to_ship/design_done`；CommDB（`~/.flywheel/comm/<project>/comm.db`）的 `sessions.status` park 时**设计上保持 `running`**（FLY-626 done-but-alive 语义）；外加 FLY-1448 `workflow_engine_park` 投影表。本单的结算对象以 **StateStore 状态**为准，CommDB 侧靠既有 terminal-commdb-sync / FLY-817 链自动跟进，不新增 CommDB 写路径。

## 3. 设计原则

1. **简单为主**（founder 直令 2026-08-04）：复用 residue-harvest 骨架与既有动词，零新 timer / 零新表 / 零新列 / 零新 env flag（master 开关 `FLYWHEEL_COMMDB_RESIDUE_HARVEST=0` 免费覆盖本 face）。
2. **结算，不巡逻**：只在 boot residue sweep 与既有 ~hourly 维护 pass（FLY-1570 明确保留的「状态收敛对账」类）里跑；不新增独立 poller、不读 pane 内容、不追人。
3. **destructive-verdict 合同**（FLY-1329，destructive-verdict.ts:1-33）：销毁永不从 liveness 单独推出；`absent` 只证明「按这个名字找不到窗」（FLY-1319 事故合同）；activity 证据（heartbeat/近期流量）**不参与判定**（判定必须可复现）。本设计的自动结算全部建立在**正向 authority（server-generation proof，§4.2）**之上，`absent` 在同世代下只产 advisory。
4. **fail-closed**：任何 indeterminate（server/generation 探测失败、CommDB 读失败、反查 ambiguous、adapter 未知）= 跳过或降级 advisory。误放过的代价是下轮再看；误结算的代价不对称。
5. **terminal immunity**（FLY-228/229 Finding K）：terminal 状态一律不碰。样本 `d0bf4e5d`（账面 completed、体多活一天）在候选集之外。
6. **不自动重派**：结算只记账+出提案；重派/重跑永远是 Lead/founder 的显式动作。
7. **founder authority 不可被 reconciler 作废**：`awaiting_review/approved_to_ship` 上可能挂着活的批准流绑定。parked 族 v1 只告知+提案（§4.4）。

## 4. 方案

### 4.1 新模块与接线

新文件 `packages/teamlead/src/bridge/pane-loss-reconcile.ts`，导出：

- `reconcilePaneLoss(projectName, deps)` — face 主体；
- `evaluatePaneLossEvidence(session, probes)` — 纯证据核（供 §4.7 stale-ship 复用）。

接线复制既有 face 形状：`ResidueHarvesterDeps`（residue-harvest.ts:19-34）新增 `harvestPaneLoss`，per-project 循环（`:45-70`）第 4 步；`createResidueHarvester`（plugin.ts:5012-5071）注入实现。免费获得 boot sweep（plugin.ts:6446）+ ~hourly 维护 tick（plugin.ts:6082）+ 单飞 + master kill-switch。每 face 独立 try/catch。

deps 全部注入（store / probes / notifier getter / mutate 开关 / now），QA 与 dry-run 靠注入 `mutate:false` 实现 report-only（无新 CLI、无新 flag）。

### 4.2 候选集与证据链（谓词）

**候选**：`store.getReadoptCandidateSessions()`（五状态集 `{running, ship_parked, awaiting_review, design_done, approved_to_ship}`，StateStore.ts:5214——**不是** `getActiveSessions()`，后者缺 `design_done` 且仓库明示不得加宽）过滤 `project_name === projectName`。排除（每条 fail-closed）：

- 宽限期：`max(started_at, stage_updated_at, last_activity_at, heartbeat_at)` 中**最新的可解析时间戳**距今 < 10 分钟；全部不可解析 → 跳过。
- 有 pending complete marker（复用 `hasPendingCompleteMarker`，FLY-172 拥有真路由）。
- `adapter_type` 为 no-transport 后端（antigravity/kimi 等）→ 跳过；**未知/缺失 vendor 视作 claude-tmux 仅当行无 `vendor` 且无 `adapter_type`（legacy 行，与 `isTmuxBacked` 同款默认）**，其余未知值 → advisory-only，永不 mutate。

**pass 前置**（任一不满足 → 本 pass 整体让位/跳过）：

1. `store.getServerLossEpisode()` 无活跃 episode 且 `store.listActiveTmuxHolds()` 为空（§2.3 互斥）；
2. `probeTmuxServer() === "up"`（阳性对照：尺子不可信则整轮不动手）；
3. **`probeTmuxServerStartTime()`**（新增小 helper，`tmux display-message -p '#{start_time}'`，tri-state：epoch 秒 / indeterminate）成功取值。

**每候选证据链**（全部只读 tmux 命令、每步有超时、不抢 `~/.flywheel/locks/tmux-*.lockf`——FLY-1627 教训）：

```mermaid
flowchart TD
    A[候选 session] --> C{lookupTmuxTarget\nCommDB tmux_window}
    C -- error --> SKIP2[跳过 indeterminate]
    C -- found --> D{probeRunnerProcessLiveness}
    D -- alive --> KEEP[不碰 反向安全]
    D -- dead_pin --> OWN[留给 crash-reaper]
    D -- indeterminate --> SKIP3[跳过]
    D -- absent --> E{discoverTmuxTargetByExecutionId\n@flywheel_exec_id 全窗反查}
    C -- gone --> E
    E -- found --> F[改用反查 target 重新 probe\nFLY-1319 stale-mapping 自愈]
    E -- "ambiguous/indeterminate" --> SKIP4[跳过]
    E -- missing --> G{server-generation proof\nserverStart > session.started_at + 60s?}
    G -- 否 同世代 --> ADV1[advisory only\nabsent 不是死亡证据 FLY-1319 合同]
    G -- 是 --> H{vendor 门}
    H -- claude-tmux --> I{状态族}
    H -- codex-tmux/未知 --> ADV2[advisory §4.5]
    I -- running --> SETTLE[结算 §4.3 经 TOCTOU fence]
    I -- parked 族 --> ADV3[advisory+提案 §4.4]
```

**server-generation proof 的语义**（自动结算的正向 authority，Codex R1 Blocker 2 的回答）：tmux window 不能脱离创建它的 server 化身存在；pane 内进程在 server 死亡时被 SIGHUP 收割（claude runner 不 detach）。因此「当前 server 的 start_time 晚于 session 注册时间（+60s 时钟余量）」⇒ 该 session 的窗口与 pane 进程所在的 server 化身**已整体消亡** ⇒ 正向、可复现的死亡证据，与 `dead_pin` 同级，不依赖 marker 发布是否成功（`@flywheel_exec_id` 发布是 best-effort，TmuxAdapter.ts:604-620——所以反查 `missing` 单独**不**构成证据，只用于排除 stale-mapping 活体）。同世代（session 在当前 server 上注册）的 `absent` 遵守 destructive-verdict 合同：只 advisory，永不 mutate。多 socket 场景：`lookupTmuxTarget`/探针全部走默认 socket（与 registration 同源）；QA PATH-shim 教训（TMUX_TMPDIR 不隔离）说明生产单 server 假设成立，仍在 §7.1 加「同世代 absent 不 mutate」的负例测试兜底。

### 4.3 running 族的结算（经 TOCTOU fence，Codex R1 Blocker 3 的回答）

慢速探测全部完成后，销毁段在**issue-lifecycle mutex**（statestore-ghost-reconcile 同款，`:143-147`）内执行：

1. **re-read** `store.getSession(execId)`：`project_name` 一致、`status === "running"` 严格相等（探测期间迁移到 approved_to_ship 等 → 放弃本轮）、`lifecycle_revision` 与候选读取时一致；
2. **re-read CommDB target**（`lookupTmuxTarget` 再取一次）：必须与取证时一致（同值或仍 gone）；**发生变化 → 放弃本轮**——这挡住「探测后 `activateSessionForWake`/adapter 把 target 重绑到新活窗」的竞态（前任 R3 Blocker 2 的生产反例）；
3. re-check `hasPendingCompleteMarker` 仍为假；
4. re-probe `probeTmuxServer() === "up"` 且 generation proof 仍成立（server 未在探测期间再换代）；
5. 同步执行 `applyTransition(transitionOpts, execId, "failed", {trigger: "pane_loss_reconcile"}, {last_activity_at, last_error: "pane_loss: tmux server generation superseded (serverStart=<T> > sessionStart=<S>); target <t> absent; rediscovery missing"})`——canonical 路径，terminal invariants（`terminal_at`/`terminal_lifecycle_id`/revision bump/settlement intent/display+terminal-sync fanout）随之维持，**绝不绕过它写裸 SQL**（前任 R3 Blocker 6 的教训）；
6. **检查 `TransitionResult.ok`**，非 ok 不记结算、不通知。

**残余窗口的诚实声明**：若同一 execution 在取证与 fence 之间被重建了新体、且 re-register 与 `@flywheel_exec_id` 发布**双双失败**（两者均 best-effort，TmuxAdapter.ts:585-601,691-712），CommDB target 不变、反查 missing，fence 无法看见新体。这个组合在 claude 路径没有生产入口：claude 体只在 spawn 时创建窗口（宽限期覆盖），运行中的 claude session 不存在体重建路径（wake 是 mailbox 写、cmux-sync/FLY-169 只管 workspace 不建 runner 窗），codex（有 ensure/reopen 重建路径）在本设计下永不 mutate。若未来引入 claude 体重建机制，fence 第 2 步的 target 重读是接缝位。前任试图用 CommDB claims 把该窗口收敛到零，五轮未收敛（§9）。

动词选 `failed` 而非新造 `orphaned`：与 orphan-reap / zombie 同族先例一致，`last_error` 前缀 `pane_loss:` 可区分可检索；CRASH_PRESERVE 语义免费获得（不 auto-archive thread）。带 `runner_declared_states` park 声明的 running 行：声明是「活着等」，server-generation proof 直接证伪其前提——但仍按 destructive-verdict 精神把 park 声明记入通知文案。CommDB 侧零新写路径（transition 触发既有 `terminalCommDbSync.enqueue(failed)`）。不触发任何 retry/respawn。

### 4.4 parked 族（按 authority 拆分，Codex R1 High 5 的回答）

`{ship_parked, awaiting_review, approved_to_ship, design_done}` 的 generation-proven 死体，v1 一律**不自动改 status**，但拆开陈述理由：

- `awaiting_review` / `approved_to_ship`：挂着**活的 founder 批准流绑定**（`review_question_id`/`pr_head_sha`/verify-approval/FLY-1448 park authority）。自动转 terminal = 作废活批准。
- `ship_parked` / `design_done`：无 founder 绑定，但它们是 DAG gate-carrier / phase-handoff 的 wake 目标（FLY-1441/1448 承运人语义）——自动结算会撕开 wake-carrier 绑定，需要 DAG 层配套改动，超出本单最小半径。**明确声明：这两类行在 v1 保持 active 是设计决定，人工 SLA 归属 Lead**（advisory 落到 Lead 的 issue thread，included 工具调用见下），FLY-1383 的域内 finalize 杠杆是它们的收尾出口。验收 1 的措辞据此收窄（§7.2）。

每条 parked/codex advisory：

- durable 检测事件：`insertEvent({event_type: "runner_pane_loss_detected", event_id: "pane-loss-<execId>", source: "bridge.pane-loss-reconcile"})`（稳定 id，幂等）；
- thread 通知（§4.6）含**真实工具调用**（不是 shell 伪命令）：`close_runner` with `{"execution_id": "<execId>", "abandon": true, "reason": "pane_loss: body died with previous tmux server generation"}`，由 Lead 拍板后执行；
- 明示「该行保持 active 直到 Lead 处置；未自动重派」。

### 4.5 vendor 门

`vendor`/`adapter_type` 判定（`isTmuxBacked` 同款 legacy 默认，§4.2）：

- `claude-tmux`（含 legacy 空值行）：按 §4.3/4.4。
- `codex-tmux`：FLY-1634 实证窗口消失后 Codex 常驻体可存活（detached 进程不随 server SIGHUP）→ generation proof 对 codex **不构成体亡证据**。一律 advisory（事件+thread 说明，措辞标明「窗口已消失但 Codex 体可能存活，需人工核实 codex resume 线程」），不改任何状态。codex 进程级活性判定留 follow-up。
- 其他未知 adapter：advisory-only，永不 mutate（fail-closed）。

### 4.6 通知路径：at-least-once 两段戳（Codex R1 High 6 的回答）

**不走 routed infra alert**（`runner_pane_loss_detected` 不在 `AlertEventType`/`KIND_CONTRACTS`/`ISSUE_PROGRESS_KINDS` 联合体内，且 routed 路径受 `FLYWHEEL_ALERT_ROUTING` 门控）。改用**直连 `emitIssueThreadInfraNotification`**（founder-thread-notifier.ts:627，call-site 模式照抄 plugin.ts:5336-5376 的 land notifier：resolveLeadForIssue → getChatThreadByIssue → 直接调用），`onUndeliverable` 落 `leadAlertNotifier` raw sink。

**时序**：boot residue sweep（plugin.ts:6446）先于 notifier 组装（`:7185`）——通知依赖以 **late-bound getter** 注入（holder 模式，仓库既有惯例）；getter 为空或投递失败时**不阻塞结算**。

**at-least-once 语义**（不承诺 exactly-once）：两个独立稳定戳——

- `pane-loss-<execId>`（detected，检测即插，幂等去重结算判定）；
- `pane-loss-notified-<execId>`（delivered，仅在 `emitIssueThreadInfraNotification` 返回已投递后插入）。

每个 pass 对「有 detected 无 notified」的行重试投递（含 boot 期 sink 未就绪的行、崩溃窗口的行）。重复投递的极小窗口（投递成功后崩溃、notified 戳未落）接受为 at-least-once 的固有代价。

### 4.7 wake 止血（验收 3；Codex R1 High 4 / Med 9 的回答）

1. **stale-approved-ship 分流**：`RewakeSessionProbe` 合同扩展携带 `adapter_type` 与 `started_at`；probe 组合处（gate-poller.ts:3023-3031）对 `absent` 复用 §4.1 的 `evaluatePaneLossEvidence` 证据核——
   - claude + 反查 found → 按反查 target 重探（stale-mapping 自愈）；
   - claude + 反查 missing + **generation proof 成立** → 归入 `dead`，走既有一次性 `alertDead` 并停 re-wake 循环；alert 前 **re-read** 当前 `status === "approved_to_ship"` 与 `review_question_id`/`pr_head_sha` 绑定未变；
   - claude 同世代 absent、codex、未知 vendor → 维持现状 `indeterminate`（幂等 re-wake）；
   - `classifyStaleShipRunnerLiveness` 纯函数保持字节兼容，分流在其调用方组合层实现，注释合同同步更新。
2. **`runner-wake.ts:232` event_id 去 `Date.now()`**：改 `wake-failed-<execId>-<questionId ?? session.review_question_id ?? kind>`（`actions.ts:507` 的 approval_wake 无 WakeDetail → 从 session 行补 `review_question_id`，两代 review 绑定各记一次；均无 → kind 兜底并接受同 kind 合并）。测试：同一绑定重试去重、两个先后 review 绑定各记一次。

## 5. 安全规格（FLY-1383 五人收敛规格 + destructive-verdict 合同的落位）

| 规格 | 本设计落位 |
|---|---|
| 直连探测，不信中介 not-found | 全部 tmux-lookup 直连命令；CommDB 读失败 = indeterminate 跳过 |
| 阳性对照 | `probeTmuxServer()==="up"` + start_time 可取值，双前置 |
| **正向证据才 mutate** | server-generation proof（与 dead_pin 同级）；absent/反查 missing 只用于排除活体与 stale-mapping，不构成证据 |
| indeterminate = 跳过 | 证据链每个非绿分支都是 skip/advisory |
| 永不 done=true / 不 archive 活 thread | 动词仅 failed（CRASH_PRESERVE）；parked 族不动状态 |
| TOCTOU fence | issue-lifecycle mutex + re-read(status/lifecycle_revision/project) + marker/server re-check + `TransitionResult.ok` |
| dry-run | 注入 `mutate:false` 的 report-only 调用（QA harness），无新 CLI/flag |
| 反例 fixture | 活体对照组；同世代 absent 不 mutate；d0bf4e5d 型（terminal）不在候选集 |

## 6. 数据/结构模型

零新表、零新列、零迁移、零新 env flag。新增 `insertEvent` 事件类型字符串：`runner_pane_loss_detected` / `runner_pane_loss_notified`（session_events 通用表）。`last_error` 新前缀 `pane_loss:`。新增只读探针 helper `probeTmuxServerStartTime()`（tmux-lookup.ts，tri-state）。

## 7. 测试与验收

### 7.1 TDD（vitest，`packages/teamlead`）

- `pane-loss-reconcile.test.ts` 表驱动全分支：
  - pass 前置：episode 活跃让位 / hold 活跃让位 / server down 跳过 / start_time indeterminate 跳过；
  - 证据链：target alive 不碰 / dead_pin 让位 / absent+反查 found 重探（活体 → 不碰）/ **同世代 absent+反查 missing → advisory 不 mutate（FLY-1319 反例）** / generation-proven+claude+running → failed / parked 族 → 事件+不改状态 / codex → advisory / 未知 adapter → advisory / legacy 空 adapter → claude 路径；
  - 排除：宽限期（含全时间戳不可解析）/ complete marker / no-transport / project 过滤；
  - TOCTOU：探测期间 running→approved_to_ship → 放弃 / lifecycle_revision 变化 → 放弃 / **CommDB target 在取证后被重绑到新活窗 → 放弃（前任 R3 反例）** / 窗口在 fence 前重建（server 再换代）→ 放弃 / `TransitionResult.ok=false` → 不记结算不通知；
  - **@flywheel_exec_id 发布失败的活体**（marker 从未发布 + CommDB target stale + 同世代）→ advisory，绝不 mutate（Codex R1 Blocker 2 反例）；
  - 通知：sink 未就绪 → detected 落、notified 缺 → 下一 pass 补投；投递失败重试；幂等（detected 已存在不重复结算判定）；
  - 与 ServerLossCoordinator 互动：活跃 episode 下两路径并跑，无双迁移、无 codex mutation（Codex R1 Blocker 1 要求的 interaction test）。
- `stale-approved-ship-reconciler.test.ts` 扩展：修前红测（absent 无限 re-wake）→ 修后 generation-proven absent 一次 alertDead 停环；同世代 absent 维持 re-wake；codex absent 维持；alert 前绑定 re-read 变化 → 放弃。
- `runner-wake` event_id：同绑定重试去重；两代 review 绑定各记一次；无 questionId 从 session 行补。
- 反向兼容哨兵：`FLYWHEEL_COMMDB_RESIDUE_HARVEST=0` 时本 face 一行不跑。
- 突变测试：把 generation 比较反转（`<` ↔ `>`）→ 结算用例必须变红；把 TOCTOU re-read 摘掉 → race 用例必须变红。

### 7.2 真机 QA（529 房 / 独立 QA 节点执行）

映射 issue 四条验收（验收 1 措辞按 §4.4 收窄：**running 族**一个周期内自动离开；parked 族一个周期内可见 thread 告知+一条工具调用收尾指引）：

1. **制造条件（healthy fresh server 形态，对齐 §2.3 ownership）**：529 隔离房起 active claude runner → kill tmux server → **重建空 server**（模拟 08-03 脏残局：server up、旧 target absent）→ 重启 slot Bridge → 首个 boot residue pass 内该 session `running→failed`，`last_error` 前缀 `pane_loss:`。（server 保持 down 的形态归 ServerLossCoordinator，不在本单 QA。）
2. **thread 说明**：issue thread 出现状态说明+恢复提案+真实 close_runner 调用体，且无自动重派（无新 session 行）。
3. **wake 回归**：制造 generation-proven `approved_to_ship` 死体 → 观察 ≥3 个 backoff 窗口：`runner_wake_failed` 增量 0、`alertDead` 恰 1 次（对照修前每 5 分钟一发）。
4. **反向安全（对照组，硬门）**：同房并跑 ≥1 个活 claude runner + 1 个活 codex runner 穿越整个 pass——账面零变化、零通知；另加一个**同世代 absent** 构造（改 CommDB target 指向不存在窗名）→ 只 advisory 不 mutate。无对照组的 PASS 无效。

### 7.3 全仓门

`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + Codex code review（xhigh）照常。

## 8. Boundary（本设计不做什么）

1. **伤害②（重启前保护/知情 founder-gated parked runner）**：per eng-lead 裁定不并入不立单。形态与建议记录在此供 FLY-1634 取用：全量重启前对 `awaiting_review/approved_to_ship` 且体活的 session 输出一行知情提示，归 FLY-1634 成功判据输出层；待 restart 路径真实事故背书再立单。
2. **存量清理与域内 finalize 杠杆**：FLY-1383（含 `close_runner` 对 `ship_parked` 的 ABANDON/DONE 集缺口）。部署时已存在的死体行由本 face 的 generation proof 同样覆盖（start_time 对存量行成立），无需迁移。
3. **codex 进程级活性判定与自动结算**：v1 advisory-only。
4. **ServerLossCoordinator 的 vendor 精细化与 boot-leg 脆性修复**：v1 不动（§2.3 分析表明 fresh leg 不会误埋活 codex；脏残局由本 face 接住）。若未来事故证明 coordinator 需要 per-session claims，届时以本 face 的证据核为素材单独立单。
5. **RunnerIdleWatchdog 的 `unknown` 静默 return**：修它=恢复秒级追人语义，与收窄口径冲突；弃。
6. **`workflow_engine_park` 投影一致性纠偏**：FLY-1448 权威链自会收敛。
7. **Bridge 存活期间 parked 族死体的小时级延迟**：结算最快在下一个维护 pass（≤1h）。更快=巡逻，违反口径；接受并明示。
8. **ship_parked/design_done 的自动结算**：需 DAG wake-carrier 配套，v2 候选（§4.4）。

## 9. Rejected alternatives

| 方案 | 弃因 |
|---|---|
| 新常驻 pane-loss 巡逻（独立 poller/秒级检测） | 与 FLY-1570 减法方向、eng-lead 收窄口径直接冲突 |
| 新 FSM 状态 `orphaned` | 全消费者学新词；`failed + last_error 前缀`已达可区分/可检索 |
| absent+反查 missing 双阴性作为结算证据 | 违反 destructive-verdict/FLY-1319 合同（marker 发布 best-effort，missing 证明不了不存在）——改为 server-generation 正向 authority |
| activity（heartbeat/近期流量）参与判定 | destructive-verdict 明文排除（判定必须可复现）；只入通知文案 |
| parked 族自动转 terminated | 作废活 founder 批准 / 撕开 DAG wake-carrier 绑定 |
| spawn 时持久化 pane PID 作为死亡证据 | 新机制+只覆盖增量行；generation proof 零机制且覆盖存量 |
| 修 ServerLossCoordinator boot-leg 代替新 face | parked/codex advisory 不适配其 migrate 机制；running-only 候选集与 one-shot 语义都需大改一个多轮 review 加固过的模块，半径更大 |
| teardown marker 文件（restart-services 落盘、Bridge boot 消费） | 多一个跨进程契约；generation proof 自足 |
| CommDB claims / TTL lease / step-receipt / body-generation primitive 跨库 saga（前任 R1–R5 方向） | 线性化泥潭实证：前任与 Codex 走到 R4 仍剩 5 个 blocker（claim TTL 双语义、kill-switch 穿透、TURN saga 顺序矛盾、engine-park union 与生产账本不符…）。本设计以 StateStore-only mutation（canonical applyTransition）+ 让位规则 + parked/codex advisory 从结构上避开跨库写，残余窗口以 §4.3 fence + 诚实声明处理 |
| routed infra alert 路径 | 需扩 AlertEventType/KIND_CONTRACTS 联合体且受 FLYWHEEL_ALERT_ROUTING 门控；直连 notifier 更小 |
| 修 RunnerIdleWatchdog 谓词 | 见 §8.5 |

## 10. 交付物与里程碑

- PR（单个）：`pane-loss-reconcile.ts`（face + 证据核）+ `probeTmuxServerStartTime` + residue-harvest face 接线 + stale-ship 分流（probe 合同扩展）+ wake event_id 去重 + 测试；本 plan 与 founder HTML 随分支进 main；CLAUDE.md 里程碑行 + doc 归档随 PR 最后一个 commit。
- 版本：v1.5x.x（ship 时取空号）。
- 实施顺序：RED（§7.1 全红测先行，含 FLY-1319 反例与互动测试）→ GREEN（证据核 → face → 接线）→ stale-ship 分流 → 通知两段戳 → 全仓门 → Codex code review → 529 QA → founder 批准 ship。
