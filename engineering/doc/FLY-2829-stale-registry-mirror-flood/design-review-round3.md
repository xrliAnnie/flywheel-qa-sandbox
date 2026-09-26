# Design Review — plan.md (Round 3)

Date: 2026-09-24
Author: Codex
Status: CHANGES REQUESTED

## Summary

v3 继续显著收敛：6 列 create ledger、夹取后的公平配额、唯一创建包装器、有序 operator recovery、按 ref 分类的阴性对照和正确量纲的 watchdog coverage 都是可实现的改进。但三项核心安全声明仍没有被当前调用图支持——C4-b 没有进入每轮必经路径、watcher 重启会铸造新 budget epoch、ceiling 被加到复用的 rename/close guard 上；此外 C8 的 `other` 判据仍不够封闭。因此本轮仍需修改。

## What's Good (Keep)

- C4-b 不再假称现有 node absent/drift producer 已存在，而是明确把 producer、sidecar sweep、阈值、审计和真正的 close→ledger-remove crash seam 纳入本 issue；这个恢复模型本身是合理的（`engineering/doc/FLY-2829-stale-registry-mirror-flood/plan.md:117-126`）。
- C6 已统一为 6 列 schema，并把 `NODE_RESERVE`/`VIEW_CAP` 在低余额处正确夹取；预算 1 时 node=1、view=0，不再出现负容量（`engineering/doc/FLY-2829-stale-registry-mirror-flood/plan.md:159-180`）。
- 把三个创建入口集中到 `reserved_new_workspace` 是比三处复制 reservation/cancel 逻辑更简单、更可审计的设计；修订后的静态匹配也不再被现有注释和日志误计数。
- R2-4 已正确复用现有 `--probe-lease`：marker 先让 watcher 释放租约，账本只在 probe=0 后原子替换，然后才清 latch/marker。现有 `probe_mutator_lease` 的 0/1/2 语义能够承接该流程（`scripts/flywheel-cmux-sync.sh:14115-14126`）。
- C8 现在以起始 ref 集合分类 delta，允许 live fixture 对应的合法 `node:*`；C9 的 `minutes * 60 / interval + 1` 与 t=0 样本合同也关闭了 Round 2 的 vacuous PASS（`engineering/doc/FLY-2829-stale-registry-mirror-flood/plan.md:227-241`）。
- C1–C3、C5、summary 双端 cap、完整旧树 baseline 和 fail-closed blindness 等前两轮已认可部分均保持不变。

## Issues & Recommendations

1. **[BLOCKER] 新 C4-b 仍不可达于它要恢复的 stale/non-live 场景。** 当前 `reconcile_node_ledger` 的唯一调用点仍在 `ensure_node_workspace` 内（`scripts/flywheel-cmux-sync.sh:2040-2074`）；计划只描述扩展该函数的分支，却没有把它加入 `reconcile_node_presence` 的轮级顺序（`plan.md:97-126`）。当 live roster 为空时，循环 1 不会调用 `ensure_node_workspace`，所以 close-crash 留下的 current committed receipt、prepared-absent receipt 和旧 generation receipt 都不会执行一次 `node-absent` observation，测试所称“N 轮内收敛”无法发生。即便 exec 是 live，`ensure_node_workspace` 现有 committed-absent 分支还会在一次 JSON 快照后直接 `_node_ledger_remove`（`scripts/flywheel-cmux-sync.sh:2076-2087`），绕过新 multi-pass 合同。请在 `reconcile_node_presence` 完成 registry/roster/latch 门后、`prune_stale_node_rows` 之前无条件执行一次 `reconcile_node_ledger`，失败则整轮 preserve；同时删除或改写 `ensure_node_workspace` 的即时 committed-absent 删除，让它只消费 reconciler 的结论。增加“live roster 为空 + orphan node receipt”连续 N 轮测试，并让 close-crash 重启测试走真实 `reconcile_node_presence`，不能直接调用 reconciler。另请统一 drift 合同：正文只处理 committed drift（`plan.md:122`），测试却写 prepared-drift（`:126`）；要么两种 receipt 都观察并告警，要么把测试改成 committed-drift。

2. **[BLOCKER] `BUDGET_EPOCH = CMUX_ADDITIVE_ROUND_ID` 不能交付计划声称的“重启不重置”。** watcher 每次启动都会进入 `sync_additive_bootstrap`，先清空进程内 round id，再调用 `begin_cmux_additive_round`（`scripts/flywheel-cmux-sync.sh:11649-11656`）；该函数每次调用都会持久化一个新的 `epoch-sequence` 并赋给 `CMUX_ADDITIVE_ROUND_ID`（`scripts/flywheel-cmux-sync.sh:8880-8902`）。因此真实 restart 的首轮 `used_this_epoch` 必为 0，仍可再花 20；只有 600 秒窗口上限在跨重启生效，`plan.md:178` 的 durable per-round 声明和“restart within same epoch”测试并不代表生产启动路径。最简单的修复是直接用现有 create ledger 做一个短滚动窗口（例如最近 60 秒最多 20），使第一层也天然跨重启；若必须保留 additive-round 语义，就需要独立、稳定的 budget epoch，不能由每次 bootstrap 都递增的 round state 充当。测试必须真正启动、终止、再启动 watcher 两次，而不是在测试进程里人工保留同一个 `CMUX_ADDITIVE_ROUND_ID`。同时写死 reservation 的第 5 列取 `BUDGET_EPOCH`，并定义 event drain 已初始化 gate 后同一 pass 内 `sync_additive` 铸造新 round 时是继续旧 epoch还是强制重验，避免实现者使用可变的全局 round id。

3. **[BLOCKER] 把 `_workspace_ceiling_guard` 直接追加到三个现有 guard 会误伤 rename 和 close，违反“只停创建”。** 计划要求 `_node_workspace_guard`、`_create_generation_guard`、`_v2_lead_workspace_guard` 都在末尾调用 ceiling guard（`plan.md:181`），但其中两个 `*_workspace_guard` 不是 create-only：`_node_workspace_guard` 同时保护 node rename，并被 `_node_close_guard` 复用（`scripts/flywheel-cmux-sync.sh:1980-2032`, `scripts/flywheel-cmux-sync.sh:2123-2152`）；`_v2_lead_workspace_guard` 也保护 V2 Lead 的 rename-workspace/rename-tab（`scripts/flywheel-cmux-sync.sh:5011-5029`, `scripts/flywheel-cmux-sync.sh:5094-5107`）。工作区已达 150 时，按当前计划这些恢复和关闭操作都会被 ceiling 拒绝，正好与 `plan.md:190` 的“close/状态/剪枝照常”相反。请让唯一包装器组合一个 create-only guard：先调用传入的原 guard，再调用 `_workspace_ceiling_guard`，并只把这个组合 guard 交给 `cmux_call_guarded ... new-workspace`；不要修改共享 guard 的非创建语义。测试要在 count=150 时同时证明三个 create 都被阻断，而 node close、node title migration、V2 Lead title migration 仍可执行。

4. **[HIGH] C8 对 `other` 的处理仍未形成非歧义的阴性对照判据。** `plan.md:227` 只说其它新增计入 `other` 并报告，但 PASS 条件只明确了 Terminal≥20 与合法 node≤live fixture；如果同时冒出任意数量的其它 workspace，按字面仍可 PASS，这不能证明 harness 复现的是目标病因而非混合故障。请明确要求 `other == 0`（或逐项列出允许且有界的其它类别），并把 `terminal=<n> node=<n> other=<n>` 纳入固定末行。同步修正 usage：`plan.md:215` 仍列旧的 `--script <path>`，但正文实际合同是 `--script-dir`、`--baseline`、`--expect-growth` 与 `--smoke`（`:221-227`）；这些选项应在唯一 usage 中完整出现。

## Verdict

CHANGES REQUESTED — address items above
