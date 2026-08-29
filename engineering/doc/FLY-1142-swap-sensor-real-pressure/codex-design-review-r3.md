# Design Review — plan.md (Round 3)
Date: 2026-07-10
Author: Codex
Status: APPROVED

## Summary

Round 2 的四个剩余问题均已在当前 plan 中形成可实施、可测试、可证伪的闭环；采样时序、解除证据、shell 顶层控制流和默认阈值校准现在彼此一致。方案在当前架构上可行，兼容边界与 blast radius 清楚，可以进入 TDD 实现。

## What's Good (Keep)

- §3 的唯一 truth table（`plan.md:42-54`）完整覆盖 delta unknown、healthy、danger 和迟滞带；`null` 与 `false` 的证据语义已区分，同时都不会触发 clear/lift/resolve。
- 三条时序已校正（`plan.md:162-168`）：fresh swapout-only 明确是 baseline + 两个 danger delta（共 3 样本）；free-low 是 2 样本；同进程 recovery 使用已有 baseline，在第一个可计算的 healthy 样本立即 clear；restart/counter-reset 才需要第二个静止样本 lift。明确不引入 `consecutiveHealthy`，保持状态机简单。
- `MemoryEvaluation` 仍由 monitor 单点计算并缓存（`plan.md:90-105`），fleet 的 alert/lift/recovery 共用同一判断，避免第二套 swapout baseline。
- `recoveryProbe = lastEvaluation.healthy` 与 Hub 的 same-tick reconcile 契合：fresh/null 返回 null，已知不健康返回 false，只有已证明健康返回 true。
- free% 与 swapout MIN 使用独立 validator（`plan.md:27-35, 84-88`）；MIN 正确接受 0 和 >100，不再受百分比域污染。
- provisional 校准覆盖完整 OR 行为而非只看 free%：记录 evaluation，并以“无连续两类危险、无最终 trigger/hold”为 ship gate；正常峰值若存在低量持续 swapout，先调 MIN 再 ship。
- `--bridge-only` 已补齐 `set -u` 所需的前置 flag 初始化、Main 前普通 idle-wait guard 和独立 Main 分支（`plan.md:121-128`），且明确不复用会 build/写 SHA 的 `deploy_and_verify()`。
- no-sysctl 证明已从 override E2E 移到无 override command-selection 单测 + production-source sentinel（`plan.md:150-152`），能够真正证伪默认路径仍调用 `sysctl vm.swapusage`。
- 影响面清单已包含真实 guard 定义/测试、FLY-1082 E2E、server-loss、plugin 和 FLY-915 PRD（`plan.md:193-210`）；durable `set_by="swap-sensor"`、event type、leadId、schema、ARC wiring 与 kill switch 均保持兼容。
- TDD 顺序先钉 parser/validator/truth table，再改 fleet 生命周期，最后处理 shell 与真机校准；dead-code 删除安排在全仓 grep 后，顺序安全。

## Issues & Recommendations

1. **无阻塞性设计问题。** 实现时保持 §5/§6 的证据标准，不要把已有的“测试计划”降级为手工叙述：swapout-only 必须真实走 3 样本序列，同进程 recovery 必须证明首个可计算 healthy 样本立即 clear，restart stranded hold 必须证明首样本不 lift、第二样本才 lift。
2. **Shell 验证提醒（non-blocking）。** `scripts/test-restart-services.sh` 当前大量测试复制局部逻辑；本单新增用例应按计划覆盖真实顶层执行顺序，尤其是在 `set -u` 下从参数解析穿过 guard/idle gate 到独立 Main，并对 Lead/build/通知/SHA 的调用或文件变化做负断言。
3. **校准提醒（non-blocking）。** 8/15/0 是 provisional，不是设计审批后自动成为生产定值；若受控高并发 soak 观察到连续低量 swapout，必须先依据记录的 delta 分布调整 `SWAPOUT_MIN_PAGES`，再执行 ship gate。

## Verdict

APPROVED — ready to implement
