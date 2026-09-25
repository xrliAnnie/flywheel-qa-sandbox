# Design Review — plan.md (Round 1)

Date: 2026-09-24
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向正确且在现有架构内可实现：C1–C5 直接命中本次事故的 title 权威、非 live 创建和维护标记响应问题，Lead 对摘要 tab 与验收边界的裁定也已被忠实纳入。但 C4/C6 目前仍存在可删掉可恢复回执身份、在成功创建后未记账、越过滚动上限/绝对上限以及绕过所谓“本轮零创建”的路径；C8/C9 也尚不能稳健地产出 Lead 要求的非空证据。

## What's Good (Keep)

- C1 把 `node:*` 负向护栏放到 `ensure_node_workspace` 的任何 cmux 调用之前，正好封住当前 `new-workspace` 在 `prepared` 回执校验之前已经发生的空壳窗口（`scripts/flywheel-cmux-sync.sh:2068`, `scripts/flywheel-cmux-sync.sh:2109`, `scripts/flywheel-cmux-sync.sh:2118`）。
- C2 保留 `admit_node_identity_for_window` 的最小身份合同，只在 live reconcile 补铸 authority title，与 FLY-1884 的首见准入顺序一致。
- C3 的“非 live 零创建”是最简单且符合 founder 最新契约的删减；保留已存在 tab 的状态改写与 TTL/cap 回收就足够。
- C5 复用 `watcher_mutation_latch_clear` 是对的：它已同时覆盖 marker、ops claim 和 QA claim，并且对非 watch mutator 保持原语义（`scripts/flywheel-cmux-sync.sh:14051-14060`）。
- 新旋钮登记、FLY-1364 CI 精确命令清册和 kill inventory 的交付面查找准确（`packages/config/src/feature-flags/truth.ts:528-537`, `.github/workflows/ci.yml:929-958`, `scripts/__tests__/ci-structure.test.sh:1482-1510`）。
- hermetic soak + 旧版阴性对照 + 生产外部 watchdog 的三层验收思路值得保留；问题在于当前具体合同，不在这个方向本身。

## Issues & Recommendations

1. **[BLOCKER] C4 把 `prepared`/历史回执等同于“无回执”，会删掉恢复机器必需的注册身份。** 计划规定“无当前 generation 的 committed ref”就直接删 registry/status（`plan.md:103-106`），但 node ledger 合法地存在 `prepared` 状态（`scripts/flywheel-cmux-sync.sh:1933-1939`）；它的恢复路径最终调用 `_node_workspace_guard`，而 guard 必须重读到同 exec/title 的 registry 行（`scripts/flywheel-cmux-sync.sh:1980-1985`, `scripts/flywheel-cmux-sync.sh:2062-2065`）。因此一次直删会留下永久无法 commit/close 的 prepared workspace/ledger，与计划声称的“不产生孤儿”相反。请把规则改成：任何 generation 下存在 exact exec/title receipt（prepared/committed/可疑 stale ref）都禁止直删；prepared 先走现有 reconcile，只有“全 ledger 零行且无可识别 workspace”才可直删。同时补齐 close 成功后到 ledger/registry/status 各步之间的 crash-injection 与重启收敛测试，明确每个中间态的恢复者。

2. **[BLOCKER] C4 所谓“不在 live 的最后一次重读”其实只是重读旧内存快照，仍可关闭/删除已重新 live 的 execution。** `RUNNER_EXPECTED_EXEC_IDS` 只在 roster read phase 从 Bridge 投影一次赋值（`scripts/flywheel-cmux-sync.sh:1181-1190`）；计划在 `_node_close_guard` 内再查同一变量（`plan.md:108-110`）并不能防住“roster 拍快照后 exec 恢复 live”的竞态，而无回执直删分支连 close guard 都不走。现有 terminal teardown 已示范在破坏性事务边界重拉 active/terminal roster（`scripts/flywheel-cmux-sync.sh:1784-1795`）。请为 prune 设计同等的 mutation-time fresh exact-live 查证，读取失败必须保留；它要同时包住 direct remove 和 guarded close。增加一个在初始快照后把目标 exec 翻成 live 的竞态测试，断言 cmux/ledger/registry/status 均零改动。

3. **[BLOCKER] C6 在 cmux mutation 之后才持久记账，不能交付“跨重启”上限，且两个上限都可在单轮被越过。** 计划要等 guard 放行、cmux rc=0、post-read 可读并 diff 出唯一 ref 后才写 create ledger/扣预算（`plan.md:145-152`）。现有 node 路径在 `new-workspace` 后仍有 JSON/generation/ref-diff/ledger 多个失败点（`scripts/flywheel-cmux-sync.sh:2109-2119`），view 路径也一样（`scripts/flywheel-cmux-sync.sh:10407-10420`, `scripts/flywheel-cmux-sync.sh:10443-10471`）。在这些点 kill 或 post-read 失败，workspace 已生成但计数仍为 0，重启可继续重放。另外，窗口已有 59 条时仍给 20 个预算，可到 79；workspace 已有 149 个时也可一轮到 169，所以 `WINDOW_MAX=60` 和 `CEILING=150` 并非真上限。请在 cmux 调用前用 mktemp+mv 持久一个计数的 reservation/attempt（ref 可先为 `-`）；只有 guard 明确阻断、证明 cmux 未被调用时才可安全取消，一旦调用过 cmux，不论 rc/post-read 结果都占用窗口与轮预算。轮初预算必须取 `min(configured, window_max-window_count, ceiling-workspace_count)`，并补 59/149 边界、调用后每个 crash point 的重启测试。还要修正操作员合同：在 60 条仍处于窗口内时只 `rm` latch 会立即再闩，不会像 `plan.md:160` 声称的那样恢复。

4. **[BLOCKER] C6 没有覆盖全部 `new-workspace` 路径，也没有为全部可创建入口定义初始化语义。** 计划只接入 node 和 `create_workspace_for_window`（`plan.md:151-153`），但 `ensure_v2_lead_workspace` 还会直接调用 `cmux_call_guarded ... new-workspace`（`scripts/flywheel-cmux-sync.sh:5312`, `scripts/flywheel-cmux-sync.sh:5386-5388`）；当 ledger 畸形或 latch 已闩时，这条路仍可创建，直接违反 `plan.md:156` 的“本轮零创建”。同时 `sync_once` 也开 additive round 并创建 view（`scripts/flywheel-cmux-sync.sh:13224-13227`, `scripts/flywheel-cmux-sync.sh:13265-13275`），`--rebuild-views --execute` 可在没有 `begin_cmux_additive_round` 的情况下走 V2/view create（`scripts/flywheel-cmux-sync.sh:12634-12655`, `scripts/flywheel-cmux-sync.sh:12716-12723`）；健康恢复后 event drain 还可在下一个 additive tick 前创建（`scripts/flywheel-cmux-sync.sh:13095-13107`, `scripts/flywheel-cmux-sync.sh:11521-11529`）。请把 gate 放到所有三个真实 `new-workspace` chokepoint，为每个可创建 mode 显式 begin/reset，并将进程初始状态定为 fail-closed。测试必须覆盖 watch bootstrap 失败后的 event replay、`--once`、`--rebuild-views` 和 V2 Lead create；“异常 owner”也不能用 chmod 伪装（`plan.md:162`），需直接测 stat/UID 校验。

5. **[HIGH] 共享轮预算存在无界 node 饥饿，风险表的“2–3 轮”没有成立前提。** 实际顺序是先遍历全部 missing view，然后才 `reconcile_node_presence`（`scripts/flywheel-cmux-sync.sh:11821-11832`）。如果每轮都有 20 个或更多 view 空缺，它们可每轮先耗尽预算，active-windowless node 则永远不会出现；`plan.md:244` 只在有限且小于约 60 的一次性 backlog 下才成立。请在不增加新运行开关的前提下给 node/view 一个确定性的公平合同（例如在同一总额下固定保留 node 配额），并用“连续多轮 >budget 个 missing view + active-windowless nodes”证明每轮 node 都有有界进展，同时总滚动上限不变。

6. **[HIGH] 只把 summary cap/TTL 挪到轮首会丢掉本轮新产生 summary 的 cap 约束。** 计划明确删除轮末调用（`plan.md:97-100`），但循环 2 会在它之后把任意多行转成 `unresolved-summary`/`terminal-summary`（`scripts/flywheel-cmux-sync.sh:2271-2310`）。因此一轮结束时仍可远大于 30，也会让 C8 的 `registry <= live + 30` 在合法输入上失败。保留轮首调用以防历史 backlog 挡住回收，但在循环 2 后再跑一次轮末 cap/TTL；此时 C3 已保证循环 2 零创建，不会重引入本次事故。增加 31 行在同一轮刚转 summary 的测试。

7. **[BLOCKER] C8 指定的阴性对照启动方式实际不能运行旧脚本，且 2 分钟 smoke 与 25 分钟 PASS 判据自相矛盾。** 脚本会根据自身 `BASH_SOURCE` 解析 `_CMUX_SYNC_SCRIPT_DIR`（`scripts/flywheel-cmux-sync.sh:21-43`），并在该目录缺少 `lib/cmux-mutator-process-census.sh` 时立即退出（`scripts/flywheel-cmux-sync.sh:202-217`）。所以 `git show ... > /tmp/pre.sh` 后执行（`plan.md:185`）只会失败启动，无法证明 harness 能复现病。请用 `git archive`/临时 worktree 物化同一旧 commit 的 `scripts/` 树，从其真实目录执行，并将“watcher 在观察窗内未提前退出、退出状态可预期、样本数达标”纳入阴/阳判据。另外 `plan.md:187` 的正式 PASS 需要最后 25 分钟，而 `plan.md:191` 用 `--minutes 2` 要求同样 PASS；请增加显式 `--smoke` 合同与缩放后的非空判据，不得让空时间窗 vacuous pass。

8. **[BLOCKER] C9 在整个观察窗失明时仍可打印 PASS，不满足 Lead 的“护栏覆盖全窗口”裁定。** 计划把采样失败记为 `NA` 并直接排除（`plan.md:195-198`），却把所有未触发情况都定义为 PASS（`plan.md:200`）。连续 40 分钟全为 NA、或只有两个有效样本时，这个实现会对一个从未计算过的斜率放行。请将观测可用性本身变成 fail-closed guard：至少 3 个有效带时间戳样本、限制最大样本间隔，连续超过 2 个 interval 的 NA 应自动写回 marker 并以 TRIPPED/INVALID 非零结束，而不是继续无保护观察。marker 写失败也必须重试并在结论中明示自动保护未建立；同时补上当前 usage 缺失的 `--out` 参数/默认值。

## Verdict

CHANGES REQUESTED — address items above
