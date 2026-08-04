# FLY-1628 pane-loss 结算 reconciler — 实施计划

Issue: FLY-1628 (https://linear.app/geoforge3d/issue/FLY-1628/pane-loss-reconcilertmux-体已灭但-commdb-仍-runningparked-全量重启会成批制造现无任何)
日期: 2026-08-04
基于: 无（本文档为 plan_only 档唯一文档；审计事实内嵌于 §2/§3）

---

## 0. 一句话总结

给 Bridge 的既有 residue-harvest 骨架加一个 **pane-loss 结算 face**：spawn 时在既有 `session_params` 里留下一枚 **server-generation 凭证**（`{socket_path, server_start_time}`，从 `tmux new-window -P -F` 建窗命令原子取样、经 `onTmuxWindowOpened` 回调作为 launch 的 pre-commit 必要步骤写入，零迁移）；既有维护 pass 里，凭证 socket 匹配且当前 server `start_time` **不等于**凭证值 ⇒ 承载该 session 的 server 化身已死、pane 进程必已随 SIGHUP 消亡 ⇒ 把「体已灭、账面仍 running」的 claude runner 结算成 `failed`。founder-bound 的 parked 族、codex 族、无凭证存量行只记账+出恢复提案；同世代/无凭证的 `absent` 严格遵守 FLY-1319 合同（absent ≠ 死亡）。与 FLY-1082 ServerLossCoordinator 以**调用顺序**串行化 ownership，并给 coordinator 补最小 vendor 门（活 codex 不再被舰队迁移误埋）。零新表、零新列、零新 env flag、零新 timer、不自动重派。

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

FLY-1383 = 清存量（自然漂移的僵尸 + 归属 Lead 的域内 finalize 杠杆）；本单 = 关产线（成批制造后的自动结算）。本单复用 FLY-1383 五人收敛的安全规格（直连探测、阳性对照、正向证据才动手、indeterminate 跳过、永不 done=true、不 archive 活 thread），见 §5。**凭证是 spawn 时留的 ⇒ 部署前已存在的死体行没有凭证，只吃 advisory**——它们的收尾归 FLY-1383 的人工杠杆；本单关的是「今后每次 server 死亡再生产一批」的产线。

## 2. 根因矩阵：为什么现有每一层都接不住（三路代码审计 + Codex R1/R2 补全）

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

### 2.2 舰队级 owner：FLY-1082 `ServerLossCoordinator` 为什么 08-03 没开火

`server-loss.ts` 是「13 runner 同死」loss shape 的**现任 owner**（HeartbeatService.check() 内、crash-reaper 之前运行，migrate=failed + 分组通知 + fleet ticket）。它有两条腿，08-03 都可解释为未触发（三个代码锚定的假设，按可能性排序；行为日志取证归 implement/QA 段）：

1. **boot leg 的 ALL-gone 脆性**（`server-loss.ts:286-297`）：server up + 首个 check 时要求 `running.length >= FLYWHEEL_TMUX_MASS_LOSS_MIN(3)` 且 **`verdicts.every(v => v === true)`——任何一个 target 判 present/indeterminate 都整体否决**。现场 6 个 `runner-fly758it` zsh 空壳窗恰好会让部分 target 判 present → 整批零结算。
2. **boot leg 是 one-shot**（`server-loss.ts:149,189-190` `firstCheck`）：Bridge boot 首个 check 时若 tmux server 还没被 cmux watcher 重建，走 server_down leg → socket inspection 非 `dead` → 开 durable hold（`:270-283`）；hold 后续解除时 firstCheck 已消费，fresh leg 永不再评估。
3. **候选集 running-only**（`:191` `getRunningSessions().filter(isTmuxBacked)`）：parked 族从不进 coordinator 视野——1482/1518 型死体结构性不归它管。

**coordinator 的 vendor 盲区（Codex R2 证伪了 v1 可以不动它的想法）**：`isTmuxBacked`（`server-loss.ts:111-114`）含 `codex-tmux`；plugin 注入的 `targetGone`（plugin.ts:9300-9312）在 CommDB target gone 或窗口 absent 时直接返回 `true`，**从不探测 detached Codex 体** ⇒ 活着的 detached Codex（FLY-1634 实证形态）在 clean fresh leg 贡献的是 `true` 而非否决，会被舰队迁移成 `failed`；server_down leg 同样把它列入 casualty。这违反本单验收 4 的硬门，v1 必须补最小 vendor 门（§4.8）。

### 2.3 ownership 划分（每种 loss shape 唯一 owner）

| loss shape | owner | 动作 |
|---|---|---|
| server **provably down**（tick leg） | ServerLossCoordinator（+§4.8 vendor 门） | 既有：episode + migrate(failed) + 分组通知；codex/未知 adapter 改 hold-out+advisory |
| server fresh + **满员** ALL-gone（boot leg） | ServerLossCoordinator（+§4.8 vendor 门） | 既有；codex/未知 adapter 不进 casualty |
| **健康 server 上的 per-session 残局**（脏 fresh / boot leg 错过 / hold 解除后 / 个别窗被拆） | **本单新 face** | generation 凭证不匹配 → 结算（§4） |
| parked 族死体（任何成因） | **本单新 face** | advisory + 恢复提案（§4.4） |
| codex 族窗口消失 | **本单新 face** | advisory（§4.5） |
| `[exited]` 尸体 pane（dead_pin） | crash-reaper（不动） | 既有 |

**串行化（Codex R2 B3 + R3 B2：让位检查不是互斥，要「顺序 + 进程内 in-flight holder + fence 内同步终查」三件套）**：

1. **coordinator in-flight holder**（进程内）：每次 `serverLoss.check()` 的调用被同步包上 `coordinatorInFlight` 标记（重叠的 check 共享/跳过同一 promise）。pane-loss face 必须在 **pass 入口**与 **§4.3 fence 内、同步 `applyTransition` 之前**两处都看到「not in flight」——JS 单线程调用栈上，fence 内的同步检查 + 同步 transition 关闭了「check 刚启动尚未 arm episode」的窗口，无需表或 lease。
2. **`coordinatorFirstCheckDone` holder**：仅在一次**完整返回**（含其内部 fail-closed 返回）的 coordinator check 之后置真；check 抛异常不置真（下 tick 重试）。coordinator 未构造/禁用 → 恒假 → face 恒跳过并一次性 log（诚实：无 owner 串行化则 face 不跑）。**plugin 构造顺序不动**——boot residue sweep 里本 face 因 gate 为假而空跑，首次真实运行在首个 heartbeat check 的 maintenance tick（默认 ≤5 分钟，仍满足验收 1 的「一个 reconcile 周期内」）。**tick-0 单飞补跑（Codex R6 H2）**：boot sweep 可能仍在 `runFullPass()` 里占着单飞，tick-0 的调用会得 `skipped_in_flight`（residue-harvest.ts:43-45），而下次尝试按小时模数要等 ~1h——因此 tick-0 遇 in-flight 时 **coalesce 恰一次补跑**：当前 owner 结束后立即跑一个 post-coordinator full pass，然后回归既有小时节奏（骑既有单飞机制，零新 timer）。
3. **周期顺序**：`HeartbeatService.check()` 内把 detached maintenance 派发移到 serverLoss/liveness 段**之后**，且必须放在 `finally`/post-catch 位置**恰好一次**——保持既有「core 段抛错不得吞 maintenance」的语义（HeartbeatService.ts:529-539 的现约定，Codex R3 M4；加抛错回归测试）。
4. **mutex 内重查**：§4.3 fence 在 transition 之前再查 `getServerLossEpisode()` / `listActiveTmuxHolds()` / `coordinatorInFlight`，任一非空/在飞 → 放弃本轮。
5. 互动测试从**空 ledger 并发释放两条路径**开始，覆盖两种 barrier 顺序（face 先进 fence vs coordinator 先 arm）+「residue pass 横跨下一个 heartbeat tick」形态。

### 2.4 wake_failed 洪水的精确源头（验收 3 的靶点）

GatePoller `staleApprovedShipReconcilePass`（gate-poller.ts:2995-3070）对 `approved_to_ship` 候选做 probe，`classifyStaleShipRunnerLiveness` 把 `absent` 映射成 `indeterminate`（stale-approved-ship-reconciler.ts:144-150）→「无害幂等 re-wake」每 5 分钟一发、永远到不了一次性 `alertDead`；叠加 `runner-wake.ts:232` event_id 带 `Date.now()` 使 insertEvent UNIQUE 去重失效。

### 2.5 术语澄清：「parked」的字面账本

issue 说的 CommDB 实为两库三层——StateStore（`~/.flywheel/teamlead.db`）的 FSM 状态 `ship_parked/awaiting_review/approved_to_ship/design_done`；CommDB（`~/.flywheel/comm/<project>/comm.db`）的 `sessions.status` park 时**设计上保持 `running`**（FLY-626 done-but-alive 语义）；外加 FLY-1448 `workflow_engine_park` 投影表。本单的结算对象以 **StateStore 状态**为准，CommDB 侧靠既有 terminal-commdb-sync / FLY-817 链自动跟进，不新增 CommDB 写路径。

## 3. 设计原则

1. **简单为主**（founder 直令 2026-08-04）：复用 residue-harvest 骨架与既有动词；零新表 / 零新列（凭证入既有 `session_params` JSON）/ 零新 env flag（master 开关 `FLYWHEEL_COMMDB_RESIDUE_HARVEST=0` 免费覆盖本 face）/ 零新 timer。
2. **结算，不巡逻**：只在 boot residue sweep 与既有 ~hourly 维护 pass（FLY-1570 明确保留的「状态收敛对账」类）里跑。
3. **destructive-verdict 合同**（FLY-1329，destructive-verdict.ts:1-33）：销毁永不从 liveness 单独推出；`absent` 只证明「按这个名字找不到窗」；activity 证据不参与判定（判定必须可复现）。自动结算唯一 authority = **generation 凭证不匹配**（§4.2）：spawn 时记录的 `{socket_path, server_start_time}` 与当前同 socket server 实测值**不等**——等值比较，免疫时钟回拨；socket 显式指定，免疫多 socket 混淆（本机实存 `default`/`atlas`/`fly1571-spike` 多 socket）。
4. **fail-closed**：任何 indeterminate（server/socket 探测失败、CommDB 读失败、反查 ambiguous、adapter 未知、凭证缺失/损坏）= 跳过或降级 advisory，永不 mutate。
5. **terminal immunity**（FLY-228/229 Finding K）：terminal 状态一律不碰。样本 `d0bf4e5d`（账面 completed、体多活一天）在候选集之外。
6. **不自动重派**：结算只记账+出提案；重派/重跑永远是 Lead/founder 的显式动作。
7. **founder authority 不可被 reconciler 作废**：parked 族 v1 只告知+提案（§4.4）。

## 4. 方案

### 4.1 新模块与接线

新文件 `packages/teamlead/src/bridge/pane-loss-reconcile.ts`，导出：

- `reconcilePaneLoss(projectName, deps)` — face 主体；
- `evaluatePaneLossEvidence(session, probes)` — 纯证据核（供 §4.7 stale-ship 复用）。

接线复制既有 face 形状：`ResidueHarvesterDeps`（residue-harvest.ts:19-34）新增 `harvestPaneLoss`，per-project 循环（`:45-70`）第 4 步；`createResidueHarvester`（plugin.ts:5012-5071）注入实现。免费获得 boot sweep + ~hourly 维护 tick + 单飞 + master kill-switch。每 face 独立 try/catch。

deps 全部注入（store / probes / notifier getter / `coordinatorFirstCheckDone` holder / `mutate` 开关 / now）。QA 与 dry-run 靠注入 `mutate:false` 实现 report-only（断言：零 transition、零事件、零 Discord/raw enqueue）。

### 4.2 generation 凭证与证据链（谓词）

**凭证写入（建窗命令原子取样，Codex R2 B1 + R3 B1 的回答）**：凭证必须与**它要授权结算的那个 body** 绑定，而不是与 spawn 流程的任意时点绑定（`emitStarted` 是 fire-and-forget、先于 adapter 建窗——那里取样会出现「凭证记 server A、体建在 server B」的 AC4 反例）。落点：`TmuxAdapter` 的 `tmux new-window` 扩展 `-P -F '#{window_id}|#{socket_path}|#{start_time}'`，**从创建窗口的同一条命令**原子取回三元组；经**已声明但从未被调用**的 `onTmuxWindowOpened` 回调（`packages/core/src/adapter-types.ts:357-367`，Blueprint 已转发）把 `pane_loss_generation: {socket_path, server_start_time}` 并入该 session 的 `session_params`（既有 JSON 列 + 既有 update 路径，零迁移；fresh 与 retry 两个 Bridge 绑定位点显式接线）。

**launch 不变量（Codex R4 B1 + R6 B1）**：「不存在与 stale 凭证共存的已 commit/存活 claude 体」，且必须 **crash-atomic**——普通 direct 路径（`ctx.launchCommitPath` 缺失时 `new-window` 直接 exec Claude，TmuxAdapter.ts:560-600）在「`new-window` 返回后、凭证落盘前」被 SIGKILL 会留下带 stale 凭证的活体，单靠异常处理杀窗封不死。因此**每一个 auto-migratable claude-tmux 体（含 direct 路径）都过既有 per-launch token gate**：窗口先以 bounded 等待壳创建 → 原子取回三元组 → 同步 merge 持久化并**回读核对** → 才释放该 launch token 让 Claude exec。持久化/释放前的任何 crash 只留下一个永远成不了 Claude 的 bounded gate 壳。`onTmuxWindowOpened` 合同对 claude 从 best-effort 升级为 **required**。这是既有 launch-gate primitive 的小扩展，不是 claims/TTL/新表。这封死 RetryDispatcher 同 execution 重驱（run-dispatcher.ts:608-666：durable launch claim 无 commit marker 时重放同 execId）的反例：attempt 1 在 server A 落凭证 A → crash 于 commit 前 → replay 在 server B 建体、第二次写失败——若凭证是 best-effort，`session_params` merge 会保留 A，活 B 体旁边躺着 A 凭证。mandatory-pre-commit 语义下该路径直接 fail launch，不产生带错误凭证的活体。从未 stamp 过的 execution 的失败仍是凭证缺失 → advisory（fail-safe）。这是「一枚落在既有表/既有位点的小凭证」，不是前任的 claims 机制。

**凭证判定**：结算 authority = 凭证存在且完好 ∧ 用凭证的 `socket_path` 显式探测（`tmux -S <socket> display-message -p '#{start_time}'`，新 tri-state helper `probeTmuxServerStartTime(socketPath)`）成功 ∧ **当前值 ≠ 凭证值**。语义：tmux window/pane 进程不能脱离创建它们的 server 化身存在（claude runner 不 detach，server 死亡即 SIGHUP 收割）；`start_time` 是 server 进程级常量（tmux format.c/server.c），同 socket 不等 ⇒ 换代 ⇒ 旧代 pane 必已消亡。**同值 ⇒ 同代 ⇒ `absent` 遵守 FLY-1319 合同只 advisory**；无凭证（存量行/写失败）⇒ advisory。

**候选**：`store.getReadoptCandidateSessions()`（五状态集 `{running, ship_parked, awaiting_review, design_done, approved_to_ship}`，StateStore.ts:5214——**不是** `getActiveSessions()`，后者缺 `design_done` 且仓库明示不得加宽）过滤 `project_name === projectName`。排除（每条 fail-closed）：

- 有 pending complete marker（复用 `hasPendingCompleteMarker`，FLY-172 拥有真路由）；
- `adapter_type` 为 no-transport 后端 → 跳过；未知 adapter 值 → advisory-only 永不 mutate；legacy 空值 = claude 默认（`isTmuxBacked` 同款）；
- **launch 宽限**（Codex R2 H5 修正后）：仅适用于 **advisory 路径**（无凭证/同代 absent），`started_at` < 10 分钟内不发 advisory（防 spawn 竞态刷 thread 噪音）。**凭证不匹配的 mutation 路径不吃任何 activity/launch 宽限**——凭证本身已证明旧代 body 不可能在当前 server 上拥有 pane，首个 post-coordinator maintenance pass 必须当场结算（验收 1 的 SLA 依据；boot sweep 里 face 被 §2.3 gate 有意跳过）。

**pass 前置**（任一不满足 → 本 pass 整体跳过）：`coordinatorFirstCheckDone()` 为真；`getServerLossEpisode()` 无活跃 episode 且 `listActiveTmuxHolds()` 为空；`probeTmuxServer() === "up"`。

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
    E -- missing --> G{generation 凭证}
    G -- "无凭证/损坏" --> ADV0[advisory only 存量行]
    G -- "socket 匹配且 start_time 相等 同代" --> ADV1[advisory only\nFLY-1319 合同]
    G -- "socket 匹配且 start_time 不等 换代" --> H{vendor 门}
    G -- "socket 探测失败" --> SKIP5[跳过]
    H -- claude-tmux --> I{状态族}
    H -- "codex-tmux/未知" --> ADV2[advisory §4.5]
    I -- running --> SETTLE[结算 §4.3 经 TOCTOU fence]
    I -- parked 族 --> ADV3[advisory+提案 §4.4]
```

反查（`discoverTmuxTargetByExecutionId`）只用于**豁免** stale-mapping 活体，`missing` 不构成任何证据（`@flywheel_exec_id` 发布是 best-effort，TmuxAdapter.ts:604-620）。

### 4.3 running 族的结算（两段式：async 取证段 → 单同步 fence，Codex R5 B1/B2 定稿）

销毁段在 **issue-lifecycle mutex**（statestore-ghost-reconcile 同款，`:143-147`）内执行，分两段：

**async 取证段**（mutex 内，允许 await）：**最后一个 awaited 操作必须是 generation probe**——`probeTmuxServerStartTime(凭证.socket_path)` 重取当前值。tmux 子进程探测（含此前的 target/rediscovery probe）全部发生在这一段。

**单同步 fence**（generation probe resolve 之后，到 transition 为止**零 await**；StateStore/CommDB 均为 better-sqlite3 同步读，complete marker 为同步 fs 检查）：

1. **re-read session 行**：`project_name` 一致、`status === "running"` 严格相等、`lifecycle_revision` 与候选读取时一致；
2. **re-read 并重解析 `session_params.pane_loss_generation`**：必须与**取证时的凭证元组逐字段相等**（`socket_path` + `server_start_time`）——缺失/损坏/任一字段变化 → 放弃。这一步不可省：`setSessionParams` 是 JSON 列直写、**不 bump `lifecycle_revision`**（StateStore.ts:6321-6328），revision 检查看不见同 execution 重放体的 mandatory 凭证重写。**最终 mismatch 判定用这枚 fresh 重读的元组**对比 probe 值；
3. **re-read CommDB target**（同步读）：与取证时严格一致——取证时 `found:<t>` 则必须仍 `found:<t>`（**变成 gone 也算变化，放弃**）；取证时 `gone` 则必须仍 `gone`（挡「探测后 `activateSessionForWake`/adapter 重绑新活窗」，前任 R3 反例）；
4. re-check `hasPendingCompleteMarker` 仍为假；
5. re-check `getServerLossEpisode()` / `listActiveTmuxHolds()` 为空、`coordinatorInFlight` 为假（§2.3 串行化第 4 条——放在 fence 内是因为 async 取证段挂起期间下一个 heartbeat 可能同步置起 in-flight 并 arm episode）；
6. **插 detected 证据事件**（§4.6 的 `pane-loss-<execId>`，稳定 id 只去重插入本身，**不去重结算判定**——若本步后崩溃，下一 pass 见行仍 running 必须重评估重试 transition）；
7. 同步执行 `applyTransition(transitionOpts, execId, "failed", {trigger: "pane_loss_reconcile"}, {last_activity_at, last_error: "pane_loss: server generation superseded (socket=<s>, recorded=<T0>, current=<T1>); target <t> absent; rediscovery missing"})`——canonical 路径，terminal invariants（`terminal_at`/`terminal_lifecycle_id`/revision bump/settlement intent/display+terminal-sync fanout）随之维持，**绝不绕过它写裸 SQL**（前任 R3 Blocker 6 的教训）；**不用 `execFileSync` 之类阻塞探测替代此结构**；
8. **检查 `TransitionResult.ok`**，非 ok 不记结算、不通知。

**残余窗口的诚实声明**：launch 不变量覆盖**每一条**生产 claude 绑定/重驱路径（RetryDispatcher pre-commit 重驱、`RunDispatcher.start()` 接受 caller-supplied execution id 的 generalized/successor 形态等——不依赖路径清单的穷尽性）：任何新体都必须成功重写凭证才获运行资格。因此「新体出现但凭证仍是旧值」结构性不存在；「新体出现且凭证已重写」被 fence 第 2 步的凭证等值重读当场看见（`setSessionParams` 不 bump revision，故必须显式比对元组）。codex（有 ensure/reopen 重建路径）在本设计下永不 mutate。前任试图用 claims 把同类窗口收敛到零，五轮未收敛（§9）。

### 4.4 parked 族（按 authority 拆分）

`{ship_parked, awaiting_review, approved_to_ship, design_done}` 的换代死体，v1 一律**不自动改 status**，理由分开陈述：

- `awaiting_review` / `approved_to_ship`：挂着**活的 founder 批准流绑定**（`review_question_id`/`pr_head_sha`/verify-approval/FLY-1448 park authority）。自动转 terminal = 作废活批准。
- `ship_parked` / `design_done`：无 founder 绑定，但它们是 DAG gate-carrier / phase-handoff 的 wake 目标（FLY-1441/1448 承运人语义）——自动结算会撕开 wake-carrier 绑定，需要 DAG 层配套改动，超出本单最小半径。**明确声明：这两类行在 v1 保持 active 是设计决定，人工 SLA 归属 Lead**；FLY-1383 的域内 finalize 杠杆是它们的收尾出口。验收 1 的措辞据此收窄（§7.2）。

每条 parked/codex/存量 advisory：

- **advisory 前 re-read**（Codex R3 M4）：录 detected 戳/投递前重读 session 行——status 仍在候选集、`lifecycle_revision` 未变；已恢复/已 terminal 的行绝不收到过期 close 提案；
- durable 检测事件（§4.6 stamps）；
- thread 通知含**真实工具调用**（不是 shell 伪命令）：`close_runner` with `{"execution_id": "<execId>", "abandon": true, "reason": "<按证据分型的 reason>"}`，由 Lead 拍板后执行；
- **文案按证据分型**（不许对未证明的事下断言）：凭证换代 parked → 「body 随上代 tmux server 消亡」；codex → 「窗口已消失，Codex 常驻体**可能仍存活**，先核实 codex resume 线程再决定」；无凭证/同代 absent → 「窗口按账面目标找不到（absent ≠ 死亡，FLY-1319 合同），需人工核实」；
- 明示「该行保持 active 直到 Lead 处置；未自动重派」。

### 4.5 vendor 门

- `claude-tmux`（含 legacy 空值行）：按 §4.3/4.4。
- `codex-tmux`：FLY-1634 实证窗口消失后 Codex 常驻体可存活（detached 进程不随 tmux 消亡）→ 换代凭证对 codex **不构成体亡证据**。一律 advisory（措辞标明「窗口已消失但 Codex 体可能存活，需人工核实 codex resume 线程」），不改任何状态。codex 进程级活性判定留 follow-up。
- 其他未知 adapter：advisory-only，永不 mutate（fail-closed）。

### 4.6 通知路径：at-least-once 两段戳（含类型完备的 fallback）

**直连 `emitIssueThreadInfraNotification`**（founder-thread-notifier.ts:627，call-site 照抄 plugin.ts:5336-5376 的 land notifier：resolveLeadForIssue → getChatThreadByIssue → 直接调用）。fallback：`onUndeliverable` → raw `leadAlertNotifier.alert()`——其 `AlertPayload.eventType` 要求 `AlertEventType` 联合体成员（LeadAlertNotifier.ts:508-515），**新增成员 `runner_pane_loss`** 并**补全 exhaustive `KIND_CONTRACTS` 条目**（kind-contract.ts 缺项= 设计上的编译/启动失败）：取值用**现有合法联合体**（Codex R4 M3）`{ owner: "claude", arc: "human_by_design" }`（与相邻 provider-agnostic infra kind 一致）。**delivered 判定（Codex R4 H2：`skipped:"duplicate"` 是 claim 所有权证据不是投递证据**——claim 赢了但 crash 于 POST 前的进程会让下个 debt pass 收到 duplicate）：每次 raw fallback 尝试用**新 attempt id**；notified 戳只在 `result.sent === true` 或 `result.queued === true` 时落；`skipped === "duplicate"` / `deadLettered` = 未投递，下 pass 继续重试。at-least-once 允许「POST 后戳前崩溃」产生一条重复消息——比静默丢失诚实。

**stamps 语义（Codex R2 H4）**：

- `pane-loss-<execId>`（detected/evidence）：在 fence 内、transition **之前**插入（§4.3 同步 fence 第 6 步）；稳定 id 只去重插入，不去重决策——行仍 running 时每个后续 pass 重评估重试。
- `pane-loss-notified-<execId>`（delivered）：thread 投递**被接受**后插入；**raw fallback 的 accepted/queued 也算 delivered**（记录渠道于 payload），杜绝每小时重复入队。
- **通知债的发现集**（崩溃恢复）：(a) `failed` 且 `last_error LIKE 'pane_loss:%'` 且无 notified 戳的行（transition 后崩溃）；(b) 有 detected 戳且无 notified 戳的 advisory 行。每个 pass 补投；文案从**当前**处置状态派生。
- **boot 补投**：notifier holder 在 plugin 组装点绑定时，直接触发一次通知债 drain（一次函数调用，无 timer）——避免 boot 期结算的首次通知等到下一个小时 pass。

### 4.7 wake 止血（验收 3）

1. **stale-approved-ship 分流**：`RewakeSessionProbe` 合同扩展携带 `adapter_type` 与 `session_params` 凭证；probe 组合处（gate-poller.ts:3023-3031）对 `absent` 复用 `evaluatePaneLossEvidence`——
   - claude + 反查 found → 按反查 target 重探（stale-mapping 自愈）；
   - claude + 反查 missing + **凭证换代** → 归入 `dead`，走既有一次性 `alertDead` 并停 re-wake 循环；alert 前 **re-read** 当前 `status === "approved_to_ship"` 与 `review_question_id`/`pr_head_sha` 绑定未变；
   - claude 同代/无凭证 absent、codex、未知 vendor → 维持现状 `indeterminate`（幂等 re-wake）；
   - `classifyStaleShipRunnerLiveness` 纯函数保持字节兼容，分流在调用方组合层实现，注释合同同步更新。
2. **`runner-wake.ts:232` event_id 去 `Date.now()`**：改 `wake-failed-<execId>-<questionId ?? session.review_question_id ?? kind>`（`actions.ts:507` 的 approval_wake 无 WakeDetail → 从 session 行补 `review_question_id`，两代 review 绑定各记一次；均无 → kind 兜底并接受同 kind 合并）。

### 4.8 ServerLossCoordinator 最小 vendor 门（Codex R2 B2）

定义**唯一的 auto-migratable 谓词**（`claude-tmux` + 批准过的 legacy 空值默认），并在 coordinator **所有** casualty 路径一致使用（Codex R3 H3）：初始检测（两条腿）、**活跃 server-down episode 的 claimed 扩展**（server-loss.ts:346-367）、**pending 迁移重建**（`:370-385`）、`hasPendingMigrations`、通知/ticket casualty 清单与 completion 记账（`:391-521, :762-776`）。被排除的（codex-tmux/未知 adapter）running 行**每个 check 都**进 `heldExecutionIds`（继续压制 per-runner reapers）；**升级前的 durable episode 里已 claim 的 codex id 在重放时同样拒绝迁移并从记账中忽略/移除**。行为变化方向 = 只减少迁移（narrowing），与 AC4 对齐。测试：clean-fresh ALL-gone 与 server-down 两形态各含活 detached codex（断言「零 codex/未知迁移」而非否决 claude 迁移）；活跃 episode 扩展形态；预置含 codex id 的 durable episode 重放形态。

## 5. 安全规格（FLY-1383 五人收敛规格 + destructive-verdict 合同的落位）

| 规格 | 本设计落位 |
|---|---|
| 直连探测，不信中介 not-found | 全部 tmux-lookup 直连命令；CommDB 读失败 = indeterminate 跳过 |
| 阳性对照 | `probeTmuxServer()==="up"` + 凭证 socket 的 start_time 可取值 |
| **正向证据才 mutate** | generation 凭证不匹配（等值比较、socket 显式、spawn 时落于 session_params）；absent/反查 missing 只用于豁免活体 |
| indeterminate = 跳过 | 证据链每个非绿分支都是 skip/advisory |
| 永不 done=true / 不 archive 活 thread | 动词仅 failed（CRASH_PRESERVE）；parked 族不动状态 |
| TOCTOU fence | mutex + 两段式（最后 await = generation probe → 单同步 fence）+ re-read(status/revision/project/**凭证元组等值**/CommDB target/episode/holds/inFlight/marker) + `TransitionResult.ok` |
| dry-run | 注入 `mutate:false` 的 report-only 调用（QA harness），无新 CLI/flag |
| 反例 fixture | 活体对照组；同代 absent 不 mutate；无凭证不 mutate；d0bf4e5d 型（terminal）不在候选集 |

## 6. 数据/结构模型

零新表、零新列、零迁移、零新 env flag。新增：`session_params` JSON 新键 `pane_loss_generation`（`tmux new-window -P -F` 原子取样 → `onTmuxWindowOpened` 回调写入）；`insertEvent` 事件 `runner_pane_loss_detected` / `runner_pane_loss_notified`；`AlertEventType` 成员 `runner_pane_loss` + exhaustive `KIND_CONTRACTS` 条目；`last_error` 前缀 `pane_loss:`；只读探针 helper `probeTmuxServerStartTime(socketPath?)`（tmux-lookup.ts，tri-state）；进程内 `coordinatorInFlight` / `coordinatorFirstCheckDone` holder。

## 7. 测试与验收

### 7.1 TDD（vitest，`packages/teamlead`）

- `pane-loss-reconcile.test.ts` 表驱动全分支：
  - pass 前置：coordinator 首查未完成让位 / episode 活跃让位 / hold 活跃让位 / server down 跳过；
  - 凭证：无凭证 → advisory / 凭证损坏 → advisory / socket 探测失败 → 跳过 / **同代 absent → advisory 不 mutate（FLY-1319 反例）** / **时钟回拨（当前 start_time 早于凭证值）→ 仍判换代结算（等值比较语义）** / 换代+claude+running → failed / 换代+parked → advisory / 换代+codex/未知 → advisory；
  - 证据链：target alive 不碰 / dead_pin 让位 / absent+反查 found 重探（活体 → 不碰）/ **marker 发布失败的同代活体 → advisory 不 mutate（Codex R1 B2 反例）**；
  - 排除：complete marker / no-transport / project 过滤 / advisory launch 宽限（<10min 不发）/ **凭证换代路径无任何 activity/launch 宽限（首个 post-coordinator pass 当场结算）**；
  - TOCTOU：探测期间 running→approved_to_ship → 放弃 / lifecycle_revision 变化 → 放弃 / **CommDB target 重绑（含 found→gone）→ 放弃（前任 R3 反例）** / fence 内 episode/hold 出现 → 放弃 / server 再换代 → 放弃 / `TransitionResult.ok=false` → 不记结算不通知 / **凭证在取证与 fence 间被重写（Codex R5 B1 fixture：阻塞最终 generation probe → 写入凭证 B + 活 B 体 + registration/marker 双缺 → 释放 probe → 断言零 mutation）** / **barrier：coordinator 在最终 generation probe 挂起期间启动 → probe resolve 后 face 必须让位（Codex R5 B2 fixture）**；
  - crash 边界（Codex R2 H4）：detected 已插但 transition 未发生 → 下一 pass 重试 transition / transition 已发生但 notified 缺 → 通知债从 `last_error LIKE 'pane_loss:%'` 补投 / `mutate:false` → 零 transition 零事件零投递零 raw enqueue；
  - 通知：sink 未就绪 → 债保留、holder 绑定时 drain 补投 / raw fallback accepted/queued 记 delivered / 幂等；
  - **与 coordinator 互动（空 ledger 并发释放，Codex R2 B3 + R3 B2 形态）**：并发跑 coordinator check 与 face pass，两种 barrier 顺序（face 先进 fence / coordinator 先 arm）+ residue pass 横跨下一个 heartbeat tick，断言至多一个 owner 迁移、无双迁移、无 codex mutation；
  - **凭证 A→B 换 server fixture（Codex R3 B1 反例）**：取证前 server 换代，体建在 B、registration+marker 双失败——断言 **活体存在 ⇒ 凭证必为 B**、**凭证缺失 ⇒ 无存活窗口（launch 已 abort）**、绝无「活 B 体旁挂 A 凭证」、活体不被 mutate；
  - advisory 前 re-read：已恢复/已 terminal 的行不收过期提案；
- HeartbeatService 顺序回归：coordinator/liveness 段抛错 → maintenance 仍恰好派发一次（finally 语义，Codex R3 M4）。
- `server-loss.test.ts` 扩展（§4.8）：clean-fresh ALL-gone / server-down 各含活 detached codex → 零 codex/未知迁移、进 heldExecutionIds、episode 收尾不被阻塞；**活跃 episode 扩展**含新出现 codex 行 → 不迁移；**预置含 codex id 的 durable episode 重放** → 拒迁移+记账忽略。
- `stale-approved-ship-reconciler.test.ts` 扩展：修前红测（absent 无限 re-wake）→ 修后凭证换代 absent 一次 alertDead 停环；同代/无凭证 absent 维持 re-wake；codex absent 维持；alert 前绑定 re-read 变化 → 放弃。
- `runner-wake` event_id：同绑定重试去重；两代 review 绑定各记一次；无 questionId 从 session 行补。
- 凭证写入（`onTmuxWindowOpened` 接线，fresh + retry 两位点，claude 一律过 launch token gate 含 direct 路径）：成功路径 / `-P -F` 解析或持久化失败 → **launch abort、刚建窗口被 kill、token 不释放**（launch 不变量）/ **crash fixture（Codex R6 B1）：`new-window` 返回后、凭证落盘前杀掉 adapter/Bridge → 重启对账 → 断言无 Claude 体被释放（只剩 bounded gate 壳）、无活体可被 mutate** / 从未 stamp 的 execution → 凭证缺失（绝无 pre-body 值）；
- **tick-0 单飞补跑（Codex R6 H2）**：暂停 boot owner 横跨 tick 0 → 观察 `skipped_in_flight` → owner 结束后恰一次 post-coordinator full pass 补跑，不等小时模数；
- **同 execution 重驱 replay fixture（Codex R4 B1 反例）**：预置凭证 A + 建窗后 commit 前 crash + 同 execId 在 server B 重放 + 第二次 parse/写失败 + registration+marker 双失败——断言不存在「带 A 凭证的活 B 体」、pane-loss 零 mutation；
- 通知投递：claim 赢了但 POST 前 crash → 下个 debt pass 新 attempt id 重试、duplicate 不落 notified 戳、最终 sent/queued 才落（Codex R4 H2 fixture）；
- 反向兼容哨兵：`FLYWHEEL_COMMDB_RESIDUE_HARVEST=0` 时本 face 一行不跑；coordinator vendor 门外的行为逐字节不变。
- 突变测试：把凭证等值比较改成恒真 → 同代反例必须变红；把 TOCTOU 的 CommDB target 重读摘掉 → rebind race 用例必须变红。

### 7.2 真机 QA（529 房 / 独立 QA 节点执行）

映射 issue 四条验收（验收 1 措辞按 §4.4 收窄：**running 族（有凭证）**在首个**完成的** post-coordinator maintenance pass 当场自动离开（含 tick-0 单飞补跑语义，§2.3.2）；parked 族一个周期内可见 thread 告知+一条工具调用收尾指引；无凭证存量行 advisory）：

1. **制造条件（healthy fresh server 形态）**：529 隔离房起 active claude runner（凭证已落）→ kill tmux server → **重建空 server** → 重启 slot Bridge → **首个 coordinator check 之后的第一个 heartbeat maintenance pass 内**（默认 ≤5 分钟，= 一个 reconcile 周期；boot sweep 里 face 因 §2.3 gate 有意跳过）该 session `running→failed`，`last_error` 前缀 `pane_loss:`（无宽限延迟）。（server 保持 down 的形态归 coordinator，其 vendor 门由 §7.1 单测覆盖。）
2. **thread 说明**：issue thread 出现状态说明+恢复提案+真实 close_runner 调用体，且无自动重派（无新 session 行）。
3. **wake 回归**：制造凭证换代的 `approved_to_ship` 死体 → 观察 ≥3 个 backoff 窗口：`runner_wake_failed` 增量 0、`alertDead` 恰 1 次。
4. **反向安全（对照组，硬门）**：同房并跑 ≥1 个活 claude runner + 1 个活 codex runner 穿越整个 pass——账面零变化、零通知；另加同代 absent 构造（改 CommDB target 指向不存在窗名）→ 只 advisory 不 mutate。无对照组的 PASS 无效。

### 7.3 全仓门

`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + Codex code review（xhigh）照常。

## 8. Boundary（本设计不做什么）

1. **伤害②（重启前保护/知情 founder-gated parked runner）**：per eng-lead 裁定不并入不立单；形态与建议记录在此供 FLY-1634 取用（重启前对 `awaiting_review/approved_to_ship` 且体活的 session 输出一行知情提示）。
2. **存量清理与域内 finalize 杠杆**：FLY-1383。**部署前已存在的死体行没有凭证 → 只吃 advisory**，收尾靠 FLY-1383 人工杠杆；本单关的是产线。
3. **codex 进程级活性判定与自动结算**：v1 advisory-only。
4. **coordinator boot-leg ALL-gone 脆性与 one-shot 修复**：v1 只加 vendor 门（§4.8）；脏残局由本 face 接住，coordinator 谓词大改留待事故背书。
5. **RunnerIdleWatchdog 的 `unknown` 静默 return**：修它=恢复秒级追人语义，与收窄口径冲突；弃。
6. **`workflow_engine_park` 投影一致性纠偏**：FLY-1448 权威链自会收敛。
7. **Bridge 存活期间 parked 族死体的小时级延迟**：接受并明示。
8. **ship_parked/design_done 的自动结算**：需 DAG wake-carrier 配套，v2 候选。
9. **tmux `start_time` 秒级精度的安全假阴性**：同一秒内 server 重建会比出相等值 → 该行走 advisory（漏一次自动清理，不误杀活体；下次换代自然分辨）。若未来要求秒内重建也必须自动结算，需给凭证加额外世代判别子——目前不加（简单为主，方向安全）。

## 9. Rejected alternatives

| 方案 | 弃因 |
|---|---|
| 新常驻 pane-loss 巡逻 | 与 FLY-1570 减法方向、eng-lead 收窄口径直接冲突 |
| 新 FSM 状态 `orphaned` | 全消费者学新词；`failed + last_error 前缀`已达可区分/可检索 |
| absent+反查 missing 双阴性作为结算证据 | 违反 destructive-verdict/FLY-1319 合同（marker 发布 best-effort） |
| `serverStart > started_at` 墙钟不等式作为 authority | 非世代凭证：时钟回拨可误杀同代活体；多 socket（default/atlas/fly1571-spike 实存）可比对到无关 server——改为 spawn 时落盘的 `{socket_path, start_time}` 等值凭证 |
| activity（heartbeat/近期流量）参与判定 | destructive-verdict 明文排除；只入通知文案 |
| parked 族自动转 terminated | 作废活 founder 批准 / 撕开 DAG wake-carrier 绑定 |
| spawn 时持久化 pane PID 作为死亡证据 | pid 复用需 start-time 佐证、macOS 探针坑多；socket+server start_time 更简单且同等正向 |
| 修 ServerLossCoordinator boot-leg 代替新 face | parked/codex advisory 不适配其 migrate 机制；running-only 候选集与 one-shot 语义都需大改；v1 只做 vendor 门 |
| teardown marker 文件 | 多一个跨进程契约；generation 凭证自足 |
| routed infra alert 路径 | 需扩 KIND_CONTRACTS/ISSUE_PROGRESS_KINDS 且受 `FLYWHEEL_ALERT_ROUTING` 门控；直连 notifier + raw fallback（一个诚实的 AlertEventType 成员）更小 |
| CommDB claims / TTL lease / step-receipt / body-generation primitive 跨库 saga（前任 R1–R5 方向） | 线性化泥潭实证：前任与 Codex 走到 R4 仍剩 5 个 blocker。本设计以 StateStore-only mutation（canonical applyTransition）+ 顺序串行化 + parked/codex advisory 从结构上避开跨库写，残余窗口以 §4.3 fence + 诚实声明处理（Codex R2 已确认此为可接受的 residual-risk boundary） |
| 修 RunnerIdleWatchdog 谓词 | 见 §8.5 |

## 10. 交付物与里程碑

- PR(单个)：`pane-loss-reconcile.ts`（face + 证据核）+ `new-window -P -F` 凭证取样与 `onTmuxWindowOpened` 接线 + `probeTmuxServerStartTime` + residue-harvest face 接线 + coordinator vendor 谓词（全路径）+ HeartbeatService.check() finally 顺序调整 + in-flight/first-check holders + stale-ship 分流（probe 合同扩展）+ wake event_id 去重 + `AlertEventType` 成员与 KIND_CONTRACTS 条目 + 测试；本 plan 与 founder HTML 随分支进 main；CLAUDE.md 里程碑行 + doc 归档随 PR 最后一个 commit。
- 版本：v1.5x.x（ship 时取空号）。
- 实施顺序：RED（§7.1 全红测先行，含 FLY-1319 反例、时钟回拨、空 ledger 并发互动测试）→ GREEN（凭证写入 → 证据核 → face → 接线 → coordinator vendor 门 → check() 顺序）→ stale-ship 分流 → 通知两段戳 → 全仓门 → Codex code review → 529 QA → founder 批准 ship。
