# FLY-2048 cmux 僵尸收敛 — 探索
Issue: FLY-2048 (https://linear.app/geoforge3d/issue/FLY-2048/cmux-展示错误信息历史死视图死-workspace-不被清理越攒越多founder-8-25-直令马上修)
日期: 2026-08-25
基于: 无

## 1. 目标与边界

Founder 要求 cmux 不再展示已经死掉的 Flywheel runner。本单的不变量是:

> cmux 中由 Flywheel 管理的 runner workspace 集合 == 当前在世的 managed tmux runner window 集合。

管理集合继续由现有 `is_managed_runner_title()` 与 view ledger 证明；不把 founder 手开 tab、语音实况、默认 `Terminal N` 或 Lead roster workspace 误当 runner 清理。Lead 的存活权威仍由 roster/private socket 链处理，不借本单改写。

## 2. 当日真机分类账

取证时间:2026-08-25 12:17 PT。读取面为 `cmux --json --id-format both list-workspaces`、default tmux server 全量 window/session、`~/.flywheel/state/cmux-view-ledger` 与 helper orphan state。

| 类别 | 数量 | 权威证据 | 当前结果 |
|---|---:|---|---|
| cmux 全部 workspace | 78 | cmux JSON | 包含 runner 60、Lead-like 16、其他 2 |
| 在世 managed runner window | 4 | 全量 tmux window，`pane_dead=0`，title 过 producer grammar | FLY-1969 / 2007 / 2045 / 2048 |
| cmux managed runner workspace | 60 | cmux JSON + title grammar | 比在世集合多 56 |
| 死 workspace，`committed` 收据 | 25 | generation + ref + title + UUID | 现有 orphan reaper 能枚举，但不在 watcher 重活前缀执行 |
| 死 workspace，`prepared` 收据 | 31 | generation + ref + title + UUID | orphan reaper 拒绝；stock adoption 因已有 ledger 行也拒绝 |
| 显示缺失 | 0 | live title 与 cmux title 集合差 | 没有在世 runner 被漏显示 |
| 历史 attach helper 孤儿 | 2 | 严格 helper argv + PID/start tuple + target 缺席 + workspace 零 claim 的 durable 两轮观察 | 只告警，永不进 TERM/KILL state machine |

两个剩余 helper 分别指向已消失的 `cmux-FLY-2000-qa-...` 与 `cmux-FLY-2015-qa-...`，都已被 `cmux-attach-orphans` 记录为不同历史 PID/start incarnation。当日 Lead 手工 TERM 前的 25 个同类载体与这条代码路径一致。

## 3. 现有机器为什么不收敛

### 3.1 workspace 账本夹层

`orphan_pin_refs()` 只认 `ledger_committed_ref()`。而 `reap_unledgered_stock_workspaces()` 对任何已有 ledger ref 都报 `existing-ledger-authority` 并保留。因此:

```
prepared 死 workspace
  ├── 不是 committed → orphan reaper 不看
  └── 又不是 unledgered → stock adoption 不看
                         ⇒ 永久死条目
```

这 31 条并不是无权威数据:production 当前全是五字段 prepared 收据，有当前 cmux socket generation、exact ref、managed title 与 workspace UUID。对一个同时满足「无同名 source window、无 `cmux-<title>` view session、cmux 当前 exact object 仍与收据一致」的对象，这套证据足以执行 exact-ref close；不需要先把一个死 surface 修成 committed 才删。

### 3.2 历史 helper 只观测不执行

FLY-1944 已有完整的有界 helper-tree 回收机:严格 argv parser、PID/start incarnation、叶先根后 TERM→KILL、write-ahead delivery cap 和 terminal tombstone。workspace 正常 close 时会铸这个权威。

但 `discover_orphan_attach_helpers()` 对存量遗留 helper 在「target 精确缺席 + workspace 零 claim + 两个不同 additive round」后，仍硬编码为 `report-only`。它已经拿到铸树需要的同一份 process snapshot、exact helper root tuple 和严格 target/token，却不调已有 reap state machine。结果是 helper 每 2 秒显示「等待重建」到永久。

### 3.3 watcher 的清理排在重活长路径之后

`sync_additive_bootstrap()` 不跑 orphan workspace/helper cleanup。正常 `sync_additive()` 又先跑 roster、Lead reconcile、全 tmux 窗口 refresh/title reconcile、create/heal，最后才到 reaper。真机上污染的历史 `runner-*` session 令 bootstrap 一次需要数分钟；当日 log 可见 watcher 约每 8–10 分钟被 stalled rider 换新，清理经常不可达。

清理必须移到每个 bootstrap/additive pass 的前缀，让活视图的慢修复不再阻塞死视图的收敛。

### 3.4 人工全量清理被共享锁变成假入口

`--once` 与 `--reap-orphan-pins` 都通过 shared mutator lease。常驻 `--watch` 在时，`run_mutator_once()` 打印 skipping 后 rc=0：操作员看到「成功返回」，实际一个 workspace 也没清。已有 `--rebuild-views --handover` 证明 watcher 可以通过 ops claim 安全让出租约。全量 orphan cleanup 应复用这条原生交接，不再新造第二把锁。

## 4. 完成判据

1. 以 exact title 集合对账:managed cmux runner workspace 与在世 managed tmux window 零 extra、零 missing。
2. 生产 56 个存量死 workspace 全部收掉，4 个活 runner 保留。
3. 两个存量 orphan helper 的 exact PID/start tuple 经 TERM→KILL state machine 收敛为缺席，无关 decoy 不受影响。
4. 在隔离真 tmux/cmux fixture 注入一个假死 managed view/workspace/helper，自动路径在声明的健康 watcher SLA 内收掉。
5. 操作员命令在 resident watcher 存活时能完成 handover 并立即执行，不再返回假成功的 skipping。
