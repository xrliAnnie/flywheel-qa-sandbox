# FLY-2268 常驻收信与清信 — 设计修正
Issue: FLY-2268 (https://linear.app/geoforge3d/issue/FLY-2268/引擎loop稳定性-fly-2248-b-工人常驻收信与完成前清信m3常驻宽限-turn-边界-durable-状态-drain)
日期: 2026-09-04
基于: plan.md（pinned blob `bceb504ae310702412604aa2956675f7a5e95707`）

## 治理状态

本文件是 FLY-1404 §6 所定义的 pinned plan 增量修正。`plan.md` 及其 blob 保持不变；下列三项裁定只撤销对应的错误实现细节，其余计划与验收条件全部保留。

## 逐字裁定

### `keepalive-narrowing-drops-doorbell`

不收窄。`phase_keep_alive` 仍对所有三阶段 Codex 工人生效（维持现状），loop 目标只是在其上叠加 M3 的常驻宽限/drain 语义；批次门铃对非 loop 工人必须与现在一样投递。新增阳性测试：非 loop 工人收到批次门铃。

- 撤销：把现有 `phase_keep_alive` / 批次门铃资格收窄为仅 loop target。
- 保留：用通用 loop-target 身份决定常驻宽限与 drain，不在新实现面硬编码角色名。

### `commdb-gate-deploy-write-outage`

受控重建门不得在 receipt 缺失时对 writer fail-loud。receipt 不存在时，writer 走既有（迁移前）写路径并记一次性 warn（每进程一次）；receipt 存在且校验通过时走新路径；receipt 存在但校验不过时才 fail-loud。部署窗口（dist 落盘至 Bridge 完成迁移）内 CommDB 写入零失败，并以测试固定。

- 撤销：旧主键且 receipt 缺失时禁止所有 writable open。
- 保留：receipt 存在后的备份、binding、schema 完整性校验及校验失败 fail-loud。

### `commdb-gate-lost-race-false-stale`

旧主键探测与 receipt 读取必须放进同一个 `BEGIN IMMEDIATE` 事务内，拿到写锁后重新检查（double-check after lock）；输掉锁竞争的 writer 在库已迁移后必须正常写入，不得抛 stale。新增并发测试：两个 writer 同时进入，一个迁移，另一个复查后成功写入。

- 撤销：以锁外旧主键/receipt 观察直接决定锁内迁移或 stale。
- 保留：仍由单个受控事务完成 exact-request 主键重建和原子提交。

## 复审范围

复审只重提上述三个 findingKey。若没有新的阻塞级 finding，则实施节点按本增量修正继续执行 pinned plan。

## 2026-09-04 exact-blob round 2 增量裁定

下列五项是 Lead 对 review `c405dfb1-9a82-4040-b29d-82474bea363c` 的逐字裁定。它们属于实现正确性修复，不授予 finding acceptance；修复后必须重新走 exact-blob review 并凭 reviewer 自身结论通过。

### `snapshot-phaserole-null-breaks-rollback`

逐字裁定：snapshot phaseRole must be restored/never null so phase-controller recovery and rollback work.

- 撤销：三阶段 Codex 上下文写不可变 launch snapshot 时把已有 `phaseKeepAlive.role` 丢成 `null`，以及 capability digest 默认忽略该 role。
- 保留：loop-target 身份继续用独立 `residentLoopTarget.nodeId` 表达；它不替代既有三阶段 phase controller 身份。

### `unowned-turn-started-claims-ownership`

逐字裁定：an unowned turn or a started marker never claims ownership - ownership is decided only by the recorded holder.

- 撤销：dispatch 窗口外任意 `turn/started` 通知向 `ownedTurnIds` 自行加 id 并写 durable started。
- 保留：RPC response 或同一 pending dispatch 中可独立归属的 started marker 负责 claim；后续同 id 通知只做幂等确认。

### `reown-reconcile-refusal-blocks-arming`

逐字裁定：reown reconcile returning not_holder is a normal outcome, it must not block arming nor consume a revive.

- 撤销：把 `not_holder` 当 reconcile 异常，进而阻断 watch/revive 的 receiver arm 或消耗 recovery attempt。
- 保留：真正的 durable active-turn mismatch 仍 fail-closed；reconcile 必须先于 receiver arm。

### `preflight-binding-liveness-fail-hard-boot`

逐字裁定：stale preflight must degrade with a logged warning, never abort Bridge boot.

- 撤销：三次拿不到稳定 source binding 后以 `commdb_schema_preflight_stale` 中止 Bridge 启动。
- 保留：backup 缺失、损坏、schema/receipt 非法等完整性错误仍 fail-loud；stale 只记录 warning 并留待后续 boot 重试。

### `commdb-gate-lock-on-every-writable-open`

逐字裁定：the repeated CommDB gate-lock concern is subsumed under the existing zero-write-failure correction: the gate must not take an exclusive lock per open and must not do O(db) validation.

- 映射：本 finding 归入既有 `commdb-gate-deploy-write-outage` 零写失败裁定，不是新增机制。
- 撤销：每次 writable open 无条件 `BEGIN IMMEDIATE`，以及持迁移写锁做 backup sha256 / `quick_check` / source 全量校验。
- 保留：当前 schema 与 legacy-without-receipt 都走无迁移锁快路径；只有 legacy+receipt 进入一次迁移锁，拿大锁后 double-check；O(db) 校验在锁外完成并用同连接 `PRAGMA data_version` 跨越校验到加锁的竞态。

## 后续复审范围

下一轮可重提最初三个 governed finding 与本轮五项；若出现这八项之外的新阻塞级 finding，实施节点停止并再次询问 Lead。

## 2026-09-04 exact-blob round 3 增量裁定

Lead 对 review gate `eef90454-8fec-440c-84dd-769233df4af6` 的逐字总裁定：Ruling: YES - all three are implementation-correctness corrections, fix them in code, record the ruling in design-correction.md, pinned blob untouched.

### `consumer-proven-bypasses-doorbell-fence`

逐字裁定：consumer-proven must never bypass the doorbell liveness fence - supervisor candidates that are Codex nodes without a phase wake reader go through the same fence as everyone else, or are excluded from the candidate set; no second liveness path.

- 撤销：Bridge supervisor 候选身份可通过 `consumerProven` 跳过 `runnerDoorbellConsumerIsLive`，并为没有 phase wake reader 的 Codex 工人铸造 durable doorbell。
- 保留：StateStore 继续决定 receiver 生命周期候选；doorbell 是否可铸造仍只由既有 CommDB reader-liveness fence 决定。非 reader 工人的 mailbox member 不 ACK、不生成 `runner_phase_wakes`。

### `supervisor-arm-throw-starves-remaining-candidates`

逐字裁定：supervisor arm/watcher/alert failures are isolated per candidate: catch, record, continue the loop - one failure never aborts reconcile or starves later workers.

- 撤销：任一 candidate 的 watcher start/stop/rearm 或 alert 异常中断整个 reconcile/health/close 扇出。
- 保留：沿用既有 `receiver_stalled` 事件面记录单 worker 故障；失败的 arm 保留 pending registration 并在下一维护 tick 重试，不新增告警面。

### `commdb-gate-deploy-write-outage`（governed repeat）

逐字裁定：stale races in the writable gate warn and return legacy-writable, never throw - this is the same zero-write-failure correction already ruled, make the code actually do it this time.

- 撤销：receipt source binding stale 或锁等待后的 `data_version` stale 从 writable opener 硬抛，令部署窗口 writer 失败。
- 保留：已取得的迁移事务先 rollback；一次性告警后返回 legacy-writable 连接并保留 receipt，等待 Bridge 后续 preflight 刷新。备份缺失、损坏、schema/receipt 非法仍 fail-loud。

## Round 4 closeout 边界

Lead 逐字裁定：Scope note: this is the third round producing new HIGHs (3 governed -> 4 new -> 2 new). Round 4 is a closeout round: if it returns any HIGH outside the ten already ruled, stop and send me the findings diff; do not fix blind.

### Round 4 闭环证据

Round 4 仅重提已治理的 `consumer-proven-bypasses-doorbell-fence`：前一批只闭合了 `mailbox-batch:` 分支，普通单条 instruction 仍可直接进入 `enqueueRunnerPhaseWake`。本次把 reader-liveness 检查提升到 `enqueueRunnerReceiverDelivery` 的共同事务入口，batch 与非 batch 两条路径均在落 wake / ACK mailbox 之前经过同一既有 fence；无 reader 的两种对照都断言 `no_consumer`、零 wake、mailbox 未 ACK。
