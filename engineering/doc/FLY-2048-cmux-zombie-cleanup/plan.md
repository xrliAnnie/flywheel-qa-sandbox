# FLY-2048 cmux 僵尸收敛 — 实施计划
Issue: FLY-2048 (https://linear.app/geoforge3d/issue/FLY-2048/cmux-展示错误信息历史死视图死-workspace-不被清理越攒越多founder-8-25-直令马上修)
日期: 2026-08-25
基于: research.md

## 0. 实施假设与验收口径

1. 「cmux 展示 == 在世会话」在本单精确指 **Flywheel-managed runner workspace** 与在世 managed runner tmux window 的 title 集合相等。Lead roster workspace、founder 手开 tab、语音实况不属于 runner GC 集合。
2. 一条五字段 prepared 收据，加上当前 generation/ref/title/UUID 读回、managed grammar、无 source/view 与最后 guard 重证，是关闭该死 workspace 的充分权威。四字段 legacy prepared 不自动关闭。
3. 严格 helper incarnation 在两个**相隔至少 60s** 的 observation 中都满足 target absent + workspace claim 0，是铸入已有 bounded reap state machine 的充分权威。自动路径天然由 60s additive cadence 提供间隔；人工路径也必须等待同一最小间隔，不能靠瞬时递增 round id 冒充第二份证据。
4. 健康 watcher 下的明示上界:workspace 自动收敛≤420s；helper 自动收敛≤150s。tmux/cmux/process census 不可读时仍 fail-closed，该故障窗口不计入健康 SLA。人工命令的 observation 间隔默认 60s，测试可用受校验 env 缩短。

## 1. RED:prepared workspace 必须进统一 orphan 路径

文件:`scripts/test-cmux-sync.sh`。

先加失败测试:

1. 当前 generation 的五字段 `prepared|generation|ref|managed-title|UUID` + 无 source/view → `orphan_pin_refs()` 枚举，经 grace 或 one-shot 走 exact close，ledger 行被删。
2. 四字段 legacy prepared → 不枚举、不 close。
3. prepared 收据但 UUID/ref/title/generation 任一漂移 → final guard 拒绝，workspace/ledger 零 mutation。
4. prepared 收据但同名 source window 或 view session 重现 → 保留。
5. 现有 committed、unledgered stock、Lead/手工 workspace 回归不变。
6. `process_close_requests()` 的 prepared 快路径:exact prepared orphan 立即关闭；predicate skip(rc=1) 丢弃旧 marker，inventory/close uncertainty(rc=2) 仍只重排一次。该 Bridge 明确信号路径不受 orphan-reaper kill switch 控制，和现有 committed 语义一致。

## 2. GREEN:close guard 接受明确的 expected receipt state

文件:`scripts/flywheel-cmux-sync.sh`。

最小改动:

1. `orphan_pin_refs()` 用 `ledger_exact_receipt_state()` 读唯一 state；接受 committed，及有合法 UUID 的 prepared。
2. `close_orphan_workspace_pin_if_still_orphan()` 在最后重证同一 state/UUID，把 state 传给 close seam；其三个 caller（grace reaper、one-shot、`process_close_requests()`）都得到相同 exact-receipt 安全条件。
3. `close_ledger_workspace_ref()` 新增默认值为 `committed` 的 expected-state 参数；`_ledger_close_guard()` 按它检查 exact receipt state。其他 caller 不传参，语义不变。
4. close 成功后继续用 `_ledger_remove()` 删 exact row，不加新状态文件。

## 3. RED:historical helper 两轮后必须进 bounded reap

文件:`scripts/__tests__/fly1944-helper-reap.test.sh`。

改写现有「永远 report-only」用例并加阳性对照:

1. workspace 仍 claim target → orphan state/reap state 都为空。
2. 第一个 absent round → 只写 `orphanv1`，零信号。
3. 第二个 distinct round，exact helper 仍在 → 写一条 `reapv1`，orphan observation 清掉。
4. 随后 healthy tick → 叶先根后 TERM；deadline 后 KILL；tuple 缺席后 GC tombstone。
5. 实际 helper shell + 实际阻塞 child + 无关 decoy 的隔离进程测试:目标树归零，decoy 存活。
6. target/workspace 在第二轮重现、PID/start 复用、树超上限、process census rc=2、reap state malformed/symlink → 零信号。
7. per-pass budget 耗尽→未处理 helper 保留 observation，下轮续跑。

## 4. GREEN:orphan discovery 复用现有 reapv1 机器

文件:`scripts/flywheel-cmux-sync.sh`。

在 `discover_orphan_attach_helpers()` 第二轮分支中:

1. 用当轮已有 process snapshot 与 helper root PID 调 `_attach_reap_tree_payload()`；
2. 沿用 `attach_reap_limits()` 的 max tree processes/deliveries；
3. tree id 绑定 orphan fingerprint + target/token + root + payload；
4. 用 `_attach_reap_row()` 生成 `ref=-, uuid=-, phase=term-issued` 的现有 schema；
5. `_attach_reap_state_upsert()` 成功才从 orphan observation 中移除；失败/超大则保留观察并发去重告警，不直接 `kill`。

不改 helper 脚本，不新增另一套信号算法。

## 5. RED/GREEN:清理必须在慢 reconcile 之前可达

文件:`scripts/test-cmux-sync.sh`、`scripts/flywheel-cmux-sync.sh`。

加顺序测试，mock WAL preflight 与 refresh 重活为独立阶段，断言 bootstrap/additive 的完整顺序:

1. `reconcile_v2_lead_workspaces()` 与 additive 的 `register_hooks_on_new_sessions()` 保持在现有 deferral 点之前；
2. `prepare_linked_view_state pre` 成功重建当轮 `CMUX_WAL_BLOCKED_VIEWS`；
3. `advance_attach_reap_state()`、`discover_orphan_attach_helpers()`、`reap_orphan_workspace_pins()`；
4. `recover_restored_transactions()`、`prepare_linked_view_state post`、`repair_view_invariants()` 等 refresh 重活；
5. 其余 workspace title/heal/create reconcile。

实现把现有 `refresh_linked_sessions()` 在 `prepare_linked_view_state pre` 后切成一个最小 tail seam；普通 `--refresh` 仍按 pre+tail 完整执行。watcher 路径保持 Lead reconcile/hooks 的现有先后关系，先跑 pre，再跑三个清理入口，最后跑 tail，并删掉 additive 后段重复调用。`RESTORED_BOOTSTRAP_PASS=1` 必须从 bootstrap pre 之前一直覆盖到 tail 结束，RED 直接断言 tail 的 restored budget 仍是 2×。其余 RED 必须证明:pre 失败时零清理且 Lead/hooks 已执行；tail 的任一步骤失败/卡住时三个清理入口已经执行。这样不改 Lead 权威，不把 cleanup 压回全 tmux window refresh 后，同时保留 construction-collision/WAL close guard。

`sync_once()` 也纳入同一契约:quiet/non-quiet 都必须先成功跑 `prepare_linked_view_state pre` 才能进入任何 orphan workspace close；non-quiet 后续复用 refresh tail。pre 不可读时 fail-closed 返回非零，不把空 blocked set 当作授权。

## 6. RED/GREEN:新增真正可执行的人工全量清理

文件:`scripts/test-cmux-sync.sh`、`scripts/flywheel-cmux-sync.sh`。

命令:`flywheel-cmux-sync --converge-runners --handover`。名称刻意区别于已有 `cleanup_stale_workspaces()` / `cleanup_stale_conservative()` 的 pane-died 延迟清理。

先测:

1. 缺 `--handover`、重复/未知参数 → rc!=0，零 claim/零 cmux mutation。
2. 活 watcher 持锁 → command 发布 exact ops claim，watcher 让出，command 取得 `ops_rebuild` lease 后才 mutate；新动词同时加入 `scripts/lib/cmux-mutator-process-census.sh` 的 mutator argv allowlist，畸形 owner 文件下 census 仍能认出活进程，禁止双 mutator。
3. 交接后 inventory 漂移 → 重枚举为准，只关仍满足 final guard 的 exact refs。
4. claim/lease 不可读或等待超时 → rc!=0，零 mutation，只释放自己的 claim。独立变量 `FLYWHEEL_CMUX_CONVERGE_HANDOVER_SECONDS` 默认 600s、上限 900s，覆盖 15s checkpoint 与当日实测约 3min 的已在飞 bootstrap；不改 `--rebuild-views` 的 `FLYWHEEL_CMUX_OPS_HANDOVER_SECONDS` 90s/300s 契约。超时日志明确要求检查 watcher heartbeat/lease owner 后重试，不伪报成功。
5. 成功/失败/INT/TERM → lease 与 claim 都按 exact owner 释放。
6. 完整清理每轮都重新 `begin_cmux_additive_round()`，并依次重跑 `cmux_attach_birth_cache_prime()`、`prepare_linked_view_state pre`，再调用已有 `reap_orphan_pins_oneshot()` / `discover_orphan_attach_helpers()`；两轮相隔默认 60s，第二轮不得复用第一轮 birth cache。ops claim 下 `reconcile_roster_read_phase()` 按设计空转，因此不调用；Lead helper 需要 roster 时由既有 `derive_lead_roster()` 惰性推导，失败即整轮 census inconclusive。随后调用 `advance_attach_reap_state()` 与 stock adoption exact guard；没有 title-only close。阳性测试在删除第二轮 re-prime 时必须变红。
7. handover claim 也进入 watcher 已有的 mutation latch：若 claim 在长 pass 中途到达，下一条安全边界设置本 pass 的 stop latch，持久队列保留未处理尾部，`watcher_finish_pass()` 立即复用 `watcher_maintenance_checkpoint()` 交出 lease。不能只在 tick 之间检查，否则大体量 `CLEANUP_PENDING` 可让人工入口等满 600 秒。
7. 旧 `--once` / `--reap-orphan-pins` 的所有假成功出口逐一改为非零并提示使用 `--converge-runners --handover`:（a）`run_mutator_once` 的 live owner；（b）malformed lease；（c）`maintenance_entry_allowed` 拒绝；（d）`sync_once()` 自己的 watcher `pgrep` guard。`--once|""` 裸默认调用同样 fail-loud；usage 不再宣称冲突时已经清理。`--refresh` 等内部 best-effort caller 保留原 skip 语义。

实现复用 `publish_ops_rebuild_claim()` / `maintenance_entry_allowed ops_rebuild` / `acquire_mutator_lease ops_rebuild` / `release_ops_rebuild_claim()`。`prepare_linked_view_state pre` 不是只读 probe：它可隔离/删除 construction WAL、退役 owned `fwstage-*`、rename session，并更新 keeper inventory；这些是既有崩溃恢复语义，仍在 exact lease 下执行。不修改 resident watcher 锁协议，不停/重启服务。

代价:claim 出现后 watcher 会在下一个 maintenance checkpoint 让出 lease；park 期间 event 仍落盘但 `drain_events` / close-request / additive create 暂停。人工命令至少引入约 60s 新 runner 可见性延迟，极端为 handover 等待 + observation + cleanup。只在没有计划中的 runner start/close 变更窗口执行，并在验收记录 claim→yield、实际 park、release→watcher-resume 三段时长。

## 7. 定向与全仓验证

按顺序执行:

1. `/bin/bash scripts/__tests__/fly1944-helper-reap.test.sh`
2. `/bin/bash scripts/test-cmux-sync.sh`
3. `/bin/bash scripts/test-cmux-sync-hooks-integration.sh`
4. `bash -n scripts/flywheel-cmux-sync.sh scripts/flywheel-view-attach.sh scripts/lib/cmux-mutator-process-census.sh`
5. `shellcheck -S error scripts/flywheel-cmux-sync.sh scripts/flywheel-view-attach.sh scripts/lib/cmux-mutator-process-census.sh`
6. `pnpm lint`
7. `pnpm -r build`
8. `pnpm test:packages:run`
9. 新增/changed `scripts/__tests__/*.test.sh`

不在宿主跑 provisioning 测试。

## 8. 真机验收

在当前 worktree 字节上执行，不重启 Bridge/watcher:

1. 快照 cmux JSON（ref/title/UUID）、view ledger、view WAL 目录、keeper inventory、在世 managed tmux titles、helper PID/start tuples。
2. 执行 `scripts/flywheel-cmux-sync.sh --converge-runners --handover`。
3. 等 resident watcher 推进 helper TERM→KILL，以存档 tuple 重证缺席。
4. 重读 managed 集合，必须 `extra=0, missing=0`；当日基线即从 `display=60/live=4/extra=56` 收敛到 `display=4/live=4/extra=0/missing=0`。
5. 确认 4 个活 workspace 的 ref/title/UUID 未变，Lead/manual/语音 workspace 未被关闭。
6. 在隔离 cmux socket + 隔离 tmux server 注入一个 managed 假死 workspace/view/helper，跑自动 bootstrap/additive/tick 节奏的加速时钟 fixture，必须在对应 SLA 内收敛；阳性对照删掉第二轮或铸态调用时测试必须变红。
7. 同时报 cmux 总数的边界:当日静态基线若无并发新增，`78 → 22`；剩余预期为 16 个 Lead-like + 2 个其他边界外 workspace + 4 个在世 runner。验收逐项列出这 22 个，不能只报 runner 子集后让侧栏剩余项来源不明。
8. 记录 claim→watcher yield、watcher park、claim release→watcher resume 的实测时长；执行窗口内不安排 runner 启停，并确认积压 event 在恢复后被 drain。
9. 对账 view WAL 与 keeper inventory 的前后差异；若 pre recovery 有写入，逐条证明它是既有 WAL/keeper 恢复动作而非 runner GC 的旁路 mutation。

## 9. 交付

1. 设计 review 通过后 TDD 实现。
2. 定向、全仓、真机对账都通过后进入 code review；CHANGES 逐轮修到 APPROVED。
3. PR 最后一个 commit 新增 `engineering/doc/milestones/FLY-2048.md`，格式遵循 `engineering/doc/milestones/README.md`，不改 `CLAUDE.md`。
4. push feature branch、开 PR，通过 `complete --route needs_review --pr <N>` 交回 DAG；不 merge、不请 ship approval、不投重启票。
