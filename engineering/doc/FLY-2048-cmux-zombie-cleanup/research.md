# FLY-2048 cmux 僵尸收敛 — 调研
Issue: FLY-2048 (https://linear.app/geoforge3d/issue/FLY-2048/cmux-展示错误信息历史死视图死-workspace-不被清理越攒越多founder-8-25-直令马上修)
日期: 2026-08-25
基于: exploration.md

## 1. 现有能力资产

本单不需要新造 GC 框架。`scripts/flywheel-cmux-sync.sh` 已有四组可复用原语:

| 能力 | 现有入口 | 可复用的安全性 |
|---|---|---|
| runner workspace 身份 | `is_managed_runner_title()` | 与 producer grammar 对齐，排除 Lead/手工 tab |
| orphan 判定 | `orphan_pin_refs()` + `close_orphan_workspace_pin_if_still_orphan()` | cmux/tmux 失败均 fail-closed；close 前重读 exact ref/title/source/view |
| ledger 身份 | `ledger_exact_receipt_state()` + `ledger_exact_receipt_uuid()` | 当前 generation 内唯一 prepared/committed 收据，拒绝冲突行 |
| exact close | `close_ledger_workspace_ref()` + `_ledger_close_guard()` | generation/ref/title/UUID 与额外 guard 都在最后 mutation 前重证 |
| helper census | `cmux_process_snapshot_records()` + `cmux_attach_helper_records_from_snapshot()` | 严格 argv，不认 prose 子串 |
| helper 树回收 | `_attach_reap_tree_payload()` + `_attach_reap_state_upsert()` + `advance_attach_reap_state()` | exact PID/start tuple；有界 TERM/KILL；write-ahead 与 tombstone |
| watcher 交接 | `publish_ops_rebuild_claim()` + `maintenance_entry_allowed ops_rebuild` | resident watcher 让出 shared lease，操作方重证 claim owner |

因此最小正确改动是打通三个已有断点，而不是加一个平行 janitor。

## 2. prepared 收据是否足以删死 workspace

### 2.1 证据强度

当前 production 的 31 个 prepared 死 workspace 都有五字段收据:

```
prepared|<current socket generation>|workspace:N|<managed title>|<UUID>
```

prepared 表示 create 事务还没完成 tab/surface 命名与 attach 读回，不表示 object 不属于 Flywheel。关闭它不应只靠 prepared 一个信号，但下列合取足以构成 exact-object 权威:

1. 收据 state 在 `{prepared, committed}` 中唯一；
2. generation 仍是当前 cmux socket identity；
3. ref/title/UUID 与 cmux 当前 object 逐字一致；
4. title 过 managed runner grammar；
5. 全 tmux 库存中无同名活 source window；
6. 无同名 `cmux-<title>` view session；
7. 最后 close guard 内再跑一次 2–6。

现有 `close_ledger_workspace_ref()` 已有 2、3、7 的结构，只把 state 写死成 committed。将「期望 receipt state」作为一个默认 `committed` 的可选参数，orphan 路径按枚举到的 exact state 传入，可保持其他所有 close caller 字节级语义不变。

### 2.2 legacy prepared 边界

四字段 legacy prepared 行没有 UUID，不进自动 orphan close。现有 committed legacy 语义不改。本单生产存量全为五字段，不需要为已不存在的数据形态放宽权威。

## 3. 存量 helper 的回收权威

### 3.1 两轮 absent 观测已经足够

`discover_orphan_attach_helpers()` 已经对每个候选执行:

- 从一份完整 process snapshot 严格解析 helper root；
- 带 PID/start incarnation 和 v2 token（legacy 为 `-`）；
- 目标 tmux session/private socket 必须是可解释的 exact absence；
- 当前 workspace inventory 与 birth records 对该 target 的 claim 必须为 0；
- 同一 fingerprint 必须出现在两个不同 additive round。

这不是 title/PID 猜测，而是「这个 exact Flywheel helper incarnation 的目标与 cmux 所有者都已连续缺席」。第二轮时用同一 snapshot 构建根为该 PID 的后代树，写入现有 `reapv1` 状态，即可复用已评审过的信号边界。

铸态必须仍受现有 per-pass budget 与 max tree size 限制。超大树、snapshot 不可读、state symlink/malformed、target/workspace 重现任一情形均不发信号。

### 3.2 SLA

健康 watcher 下:

- orphan 第一次观测:最坏等1 个 60s additive cadence；
- 第二轮铸树:再等 60s；
- TERM 与 KILL 推进:两个现有 15s healthy tick。

因此从「target/workspace 可证缺席」起的健康路径最坏约 150s（不包括已明示的 census/cmux 不可读 fail-closed 窗口）。

## 4. 清理顺序

将下列死状态快路径放在 `sync_additive_bootstrap()` 与 `sync_additive()` 的 birth snapshot 之后、Lead/window 慢 reconcile 之前:

1. `advance_attach_reap_state()`；
2. `discover_orphan_attach_helpers()`；
3. `reap_orphan_workspace_pins()`。

`advance_attach_reap_state()` 在 healthy 15s tick 已有一次，前缀调用是为 bootstrap 还没进 watch loop 的重活窗口。这三个入口全部幂等，并且只处理已经死的 exact 身份；不需要一个新 scheduler。

workspace 自动 SLA 继续使用现有 300s orphan grace:最坏 60s 首见 + 300s grace + 60s 下轮，即健康 watcher 下≤420s。事件 close-request 的即时路径不变。

## 5. 操作员入口

`--reap-orphan-pins --handover` 应作为明确的全量 runner zombie cleanup:

1. 只读枚举当前 orphan plan；
2. 发布已有 ops-rebuild claim；
3. watcher 在 maintenance checkpoint 释放 lease；
4. operator 以 `ops_rebuild` mode 获得 lease；
5. 重枚举、逐 ref 跑现有 final revalidation chokepoint，无 grace 关闭；
6. 释放 lease/claim，watcher 自动重获 lease。

不修改 `--once` 的 aggressive 语义，也不让它抢锁。操作员需要的是一个真正可执行的全量死对象清理入口，不是第二个与 watcher 并发的 full sync。无 `--handover` 时仍 fail-closed 且返回非零，不再把「没执行」伪装成 rc=0。

## 6. 弃选方案

| 方案 | 弃选原因 |
|---|---|
| 按 title 直接 close 所有多余 tab | title 不是所有权，会误杀 founder 同名 workspace |
| 先修复每个 prepared surface 再转 committed | 死对象不需要先消耗慢 cmux RPC 变健康才能删；会继续阻塞 reaper |
| helper 内部自杀 | helper 无 cmux workspace inventory 与外部树的可见性，会绕过 durable delivery cap |
| watcher 对 helper 直接 `pkill -f` | 无 incarnation/ancestry 重证，绕过现有已验证 state machine |
| 让 `--once` 强抢 watcher lock | 会产生两个 cmux mutator；已有 maintenance claim 是原生解法 |
| 只缩短 5min grace | 不解决 prepared 夹层、report-only helper 与清理不可达问题 |
| 加新依赖/守护进程 | 标准 shell 与已有 watcher/state machine 已满足需求，增加生产面反而扩大故障面 |
