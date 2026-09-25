# Design Review — plan.md (Round 4)

Date: 2026-09-24
Author: Codex
Status: CHANGES REQUESTED

## Summary

v4 已经实质关闭 Round 3 的四个主问题：node-ledger 收敛器进入真实轮级路径，短滚动窗口替代了会被重启重置的 additive epoch，ceiling 被限制在 create-only 组合 guard，阴性对照也要求 `other == 0`。但 create-ledger schema 与其 `-` 审计值相互冲突，prepared receipt 仍有一个无法进入 absent/drift 的永久 deferred 状态，而且 restart smoke 的多个判据彼此不可同时满足；这些会让实现 fail-closed 卡死或让 CI 证据无法成立，因此尚不能批准实施。

## What's Good (Keep)

- `reconcile_node_ledger` 现在在 roster/registry/latch 门之后、prune 之前由 `reconcile_node_presence` 无条件调用，失败冻结后续 node mutation；同时移除 `ensure_node_workspace` 的即时 committed-absent 删除，终于让 current-generation absent receipt 只有一个多轮阈值路径（`engineering/doc/FLY-2829-stale-registry-mirror-flood/plan.md:99`, `:121-127`）。
- 用 create ledger 的 60 秒 rolling burst 替代 additive-round budget epoch 是正确的跨重启模型；reservation 先落盘、非 guard 失败继续占额度、long window 与 workspace ceiling 继续收紧，安全层次清楚（`plan.md:166-187`）。
- `_reserved_create_guard` 只包裹 `new-workspace`，没有修改复用的 `_node_workspace_guard` / `_v2_lead_workspace_guard`，因此达到 ceiling 时 rename、close 和 title migration 仍能恢复系统（`plan.md:183-188`；共享 guard 的现有复用见 `scripts/flywheel-cmux-sync.sh:1980-2032`, `:2123-2152`, `:5011-5029`）。
- 阴性对照现在按起始 ref 集分类，并把 `other == 0` 纳入 PASS；usage 也已列出 `--script-dir`、`--baseline`、`--expect-growth`、`--smoke`、`--restart-every`、fixture 与输出目录（`plan.md:217`, `:229`）。
- R1/R2 已收敛的 live mutation-time 复核、prepared/old-generation 保守处理、双端 summary cap、operator ledger transaction、生产 watchdog blindness/coverage 合同均保持不变。

## Issues & Recommendations

1. **[BLOCKER] create ledger 会把计划自己写出的 `round=-` 判成畸形，导致非 additive 创建路径永久 fail-closed。** C6 明确要求 reservation 在 `CMUX_ADDITIVE_ROUND_ID` 为空时把第 5 列写成 `-`（`plan.md:180`），但 §4 又要求该列通过 `_additive_round_id_valid`（`plan.md:253`）；实际 validator 只接受 `数字-数字`，`-` 必然失败（`scripts/flywheel-cmux-sync.sh:1279-1285`）。这不是只影响日志：`--rebuild-views --execute` 的当前入口不会调用 `begin_cmux_additive_round`（`scripts/flywheel-cmux-sync.sh:12764-12815`），所以它第一次 reserve 就能产生一行随后无法再校验、取消或提交的账本，后续所有创建都会 fail-closed。把 schema 定为 `round == "-" || _additive_round_id_valid "$round"`（或为所有 pass 铸造独立的合法 audit id，但不要重新把它用于预算），并增加一条真实 rebuild create → reservation commit/cancel → 下一 pass 仍可读取账本的测试。

2. **[BLOCKER] C4-b 对 prepared receipt 的 surface-only drift 仍没有 producer，会永久阻塞该 exec 的 prune/recovery。** v4 只在“workspace title 不等于 node title且不在允许集”时观察 `node-drift`（`plan.md:122`）。但现有 `complete_node_title_migration` 先调用 `_node_workspace_guard`，该 guard 同时要求 workspace title 在允许集、且 single-surface title 为 node title 或 status command（`scripts/flywheel-cmux-sync.sh:2000-2007`, `:2022-2032`）。因此 workspace title 已正确、但 founder 只改了 tab/surface title时，migration 会被拒绝；ref 又存在，所以不是 `node-absent`；正文的 workspace-only drift 条件也不成立。receipt 和 registry row 会一直 deferred，且没有一次性告警。prepared migration 被拒后，应从同一完备快照同时分类 workspace title 与 single-surface title：任一超出 guard 的允许集都进入 `node-drift`；committed 行仍可保持其现有 readiness 合同。补一个“workspace title 正确、surface title 自定义”的 prepared-drift 测试，断言达到阈值后告警一次、保留 receipt、不改名。

3. **[BLOCKER] restart smoke 的规范目前不可同时满足，也没有定义能证明跨 PID rolling cap 的观测数据。** 普通 smoke 仍要求“第 60 秒后 workspace 不增长”且把整个 `calls.log` 的 `new-workspace` 总数限制为一个 budget（`plan.md:228`），但 restart 场景使用 25 个 windowless live fixture、`BURST_MAX=20`，又要求创建跨至少两个 watcher PID（`:230`）；正确实现必须等首批额度退出 60 秒窗口后再创建剩余 5 个，这正会在 60 秒后增长，而且总调用数可合法达到 25。与此同时 shim 只规定“每次调用追加 `calls.log`”（`:221`），没有 timestamp / watcher identity schema；共同有效性前提只描述一个 watcher 的存活与一个 exit 143（`:224-225`）；CI 测试条目也只写 `--smoke --minutes 2`，没有要求 `--restart-every 30`、25-row live fixture、sliding-window 断言或跨 PID 断言（`:234`）。请把普通稳定性 smoke 与 restart-budget smoke 分成两个明确 verdict（或给 `--restart-every` 单独覆盖判据）：restart 模式检查任意 `BURST_SECONDS` 窗口调用数 `<= BURST_MAX`、至少两个 watcher instance 确实创建、每个计划内 TERM 都为 143、替换进程在有界时间内存活，而不要套用“60 秒后零增长/全程总数 <=20”。为 shim log 固定 `epoch|watcher_instance|verb|...`（由启动 wrapper 显式导出 watcher identity，不能猜进程树），并在 smoke test 条目中写出完整 invocation 与断言。顺带把 `plan.md:232` 的通用固定末行改成按 mode 定义；它目前仍与 `:229` 的 negative 详细末行冲突。

## Verdict

CHANGES REQUESTED — address items above
