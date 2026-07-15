# Design Review — plan.md (Round 2)
Date: 2026-07-10
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 1 的六个方向性问题已基本被纳入：解除侧改成三态证据、delta 由 monitor 单点拥有、`--bridge-only` 独立于 deploy、影响面/E2E/校准均明显补全。剩余问题已不是方向争议，而是几处会让实现或验收与计划自相矛盾的控制流与采样时序，需要在进入实现前钉死。

## What's Good (Keep)

- `MemoryEvaluation` 把 event、delta、danger、healthy 与 inPressure 放在同一 evaluation 中，解决了 Round 1 的双 baseline/逻辑漂移问题；`fleet-sensors` 的 lift 与 recovery 都只消费 monitor 结论，架构边界清楚。
- 首样本和 counter regression 的 delta 改为 `null`，且 `healthy !== true` 时绝不 clear/lift/resolve，已经修正最关键的 durable-hold fail-open 风险。
- `parseVmStat` 的成功契约已收紧为七个 bucket + Swapouts 全部有效，业务字段 non-null、pageSize 仅诊断可选；纯页数比仍正确且 page-size immune。
- `recoveryProbe` 改读 `lastEvaluation.healthy`，不再用 `!inPressure` 把 fresh/pending 状态误当恢复；Hub 同 tick reconcile 的语义现在可以 fail-closed。
- `--bridge-only` 不复用 `deploy_and_verify()`、不 build/写 SHA/重启 Lead 的方向正确；新增 shell hermetic tests 和 guard allowlist 也是必要覆盖。
- plugin/server-loss/repair 人类文案、旧 FLY-1082 E2E seam、scar durable row、PRD/注释都已被纳入，机器标识符保持兼容，blast radius 控制合理。
- 8/15 被明确降级为 provisional default，并增加边界测试、soak 与快速下降验收；这比 Round 1 的单点经验值论证诚实得多。

## Issues & Recommendations

1. **采样 baseline 的时序在三处写成了互相矛盾的验收合同。** 按 `plan.md:97-105, 161-167` 的 monitor，只有“monitor 首个样本/计数器回退”会得到 `swapoutDelta=null`。因此 fresh monitor 的 swapout-only 场景不是两份样本即可 trigger：t0 只能建 baseline（danger=false），t1 的正 delta 是第 1 个 danger tick，t2 的正 delta 才是第 2 个 danger tick并 trigger；也就是“baseline + 两个连续 danger delta”，共 3 个样本。反过来，`plan.md:187` 的普通 pressure→recovery 场景已经有上一压力样本的 baseline；只要下一样本 free≥15 且 Swapouts 与上一样本相同，当场即可算 delta=0、healthy=true 并 clear，不会再出现“首恢复样本 delta unknown”，除非 Bridge 同时重启或 counter regression。建议把 §6 拆成三条精确序列：(a) fresh swapout-only = baseline + 两个递增样本；(b) 同进程 pressure episode = 第一个可计算且 healthy 的恢复样本立即 clear；(c) restart/counter-reset stranded hold = 第一个样本只建 baseline，第二个静止样本才 lift。若确实要求所有 recovery 都连续两个 healthy tick，则必须新增 `consecutiveHealthy` 状态和相应测试，而不能由现有 delta baseline 自然推出。另请给 `freePct` 已明显低、但 delta unknown 的交叉状态写明 truth table：当前 §3 说 unknown→healthy=null，而 §4.2/§5.2 又把 pending/danger 描述成 healthy=false；两者都不 resolve，但测试期望必须唯一。

2. **`--bridge-only` 跳过的区块会跳过变量初始化，但现有脚本在独立 Main 之前已经引用这些变量。** 当前 `PLUGIN_ONLY_RESTART` 在 `restart-services.sh:438` 初始化，`restart_bridge` 在 `536` 初始化；计划 §4.3 要 guard 掉 438-576。可是在 Main 之前，现有 idle-wait guard `restart-services.sh:642` 已执行 `[[ "$PLUGIN_ONLY_RESTART" != "true" && "$restart_bridge" == "true" ... ]]`。按计划直译，在 `set -u` 下 bridge-only 会在到达独立第三分支前就因 unbound variable 退出。建议明确把所有 mode/impact flags 在 guard 之前初始化，并将 642-649 的普通 deploy idle-wait 整体加 `BRIDGE_ONLY != true` guard，或把它移入 normal-deploy 分支；bridge-only 自己只在独立分支调用一次 `wait_for_idle`。shell test 要覆盖真实顶层执行顺序，而不只是复制一个简化 branch。`--dry-run` 的表述也建议改成“任何 service/deploy state 副作用前退出”；脚本在参数前已有 mktemp、参数后有互斥锁，这些可清理的协调副作用无需声称为零。

3. **provisional 校准目前只证明 free% 分支安静，没有校准默认更激进的 swapout OR 分支。** `plan.md:34, 189` 要求正常高并发 soak 不连续出现 `free<8`，但 `SWAPOUT_MIN=0` 下即使 free=22%，连续两个 30s 窗各换出 1 页也会触发 hold。Round 1 对 false hold 的主要不确定性恰恰是正常峰值下的低量持续 swapout。建议 soak 记录完整 `{timestamp, freePct, swapoutDelta, danger}`，ship gate 断言正常代表窗口既没有连续 free-low，也没有连续 `swapoutDelta>MIN`，最终没有 trigger/hold；若后者出现，先用观测分布调 MIN 再 ship。阈值校验域也需分开写清：0/负/NaN/>100 无效只适用于两个百分比 env；`FLYWHEEL_MEM_SWAPOUT_MIN_PAGES` 的默认就是 0，且调噪值完全可能 >100，应接受 non-negative finite integer（或明确的上限），不能复用百分比 validator。当前 `plan.md:35, 160` 容易让实现把合法 MIN=0/>100 判回 default。

4. **E2E 中“未调用 sysctl”的可观测断言仍不能证明默认生产路径已移除该依赖。** 在现有实现中，只要设置 `FLYWHEEL_SWAP_SENSOR_CMD`，旧 `readSwapUsage()` 本来就走 override 而不调用 `sysctl`（`machine-watermark.ts:62-70`）；所以在同一个 override E2E 里观察“sysctl 未命中”，旧代码也能满足，无法证伪根因依赖。vm_stat 格式成功解析会证明新 seam 生效，但这是另一件事。建议增加一个无 override 的 hermetic command-selection 测试：mock/spying `execFile`（或 PATH 中放记录调用的 `vm_stat`/`sysctl` stub），断言 `readMemoryPressure({})` 只执行 `vm_stat`，从未执行 `sysctl vm.swapusage`；再加 production-source grep sentinel，确保旧 command/string 不回流。E2E ③继续负责“高累计 Swapouts + healthy free 不触发、旧 hold 第二样本解除”，不要让 override 下的 no-sysctl 断言承担它证明不了的职责。影响文件清单还应显式加入真正承载 allowlist 的 `scripts/hooks/test-flywheel-restart-guard.py`，以及计划所说要更新的具体 PRD（`product/doc/FLY-915-infra-alerts-pipeline/prd.md`），而不是把 allowlist 归在 `scripts/test-restart-services.sh` 一行中。

## Verdict

CHANGES REQUESTED — address items above
