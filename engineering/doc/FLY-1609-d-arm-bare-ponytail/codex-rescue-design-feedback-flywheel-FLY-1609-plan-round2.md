# Design Review — plan.md (FLY-1609, Round 2)

Date: 2026-08-03
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 已实质关闭首轮关于 ladder 语义、assembly 三值边界、分析 eligibility 和运维承诺的主要问题，整体方案仍然可行且改动面克制。但新增的 retry 接线没有把“D 注入只属于最终 D mode”和“刷新标签是否可信”带进运行时合同，存在两个可重现的归因/kill 反例；另有分析 epoch、CI 注册和边界测试尚未真正 fail-closed，因此还不宜进入生产实现。

## What's Good (Keep)

- 把 `armInject` 做进 `resolvePonytailRequested` 的纯 ladder，明确 `run > label > arm > project > default`，并让 unreadable labels 在 D 下无条件 selector-unavailable；这正确关闭了 Round 1 最重要的显式 off 越权风险。
- `skillAssemblyBaseArm` 覆盖 config barrel、Codex probe、prompt variant 和 adapter context，同时不扩大 core/claude-runner 的三值 assembly 类型；归因值与装配值的分层现在完整且一致。
- Task 3 的 D/C 行为矩阵、四桶 mutation guard、C-arm adapter/plugin/prompt sentinel，以及 corrected Claude-only mitigation 都应保留。
- Task 5 已把 `design_compare.py` 定义为未来四臂的权威入口，并加入 D=`on:%`、control=`off:%`、per-arm exclusions、condition 分布和 SQLite self-test；`final.py`/`analyze.py` 作为三 pilot 快照保留是合理的 scope cut。
- Task 3b 正确识别并准备补上 FLY-615 decoder 的生产空接缝；`off:run` 在 retry 中不得被 D 翻开的验收是必要的。

## Issues & Recommendations

1. **HIGH — `reresolve` retry 仍会把“标签刷新失败”误报成 readable，重新越过看不见的 `ponytail-off`。** 计划在 Task 3b 中说 selector/conflict 不带 frozen、改从 refreshed labels 重解（plan.md:77-83），但当前 `actions.ts:853-909` 在无 `LINEAR_API_KEY` 或 Linear 请求失败时只是保留 stored labels，没有输出 refresh status；`run-dispatcher.ts:799-869` 也没有对应状态字段。最终 Blueprint 对缺省 `ponytailInput` 固定构造 `labelStatus:"readable"`（`Blueprint.ts:983-995`）。因此，前驱为 `unavailable:selector:label_unreadable`、D retry 又遇到 Linear 不可用时，会把空/旧 labels 当可信并落到 `on:arm`，直接违反 §0 的 fail-closed 红线。建议 Task 3b 明确：reresolve 也必须传一个显式 `start_signal`；只有本次 fresh fetch 成功才是 `readable`，无 key/请求失败必须是 `unreadable`，不能用 stored labels 冒充成功读取。补齐“selector predecessor + refresh off/on/none”和“no key/refresh failure 仍 selector-unavailable”的端到端 retry 测试，conflict 同理。

2. **HIGH — frozen `source:"arm"` 会越过全局 kill，让已经切回 A 的 retry 继续运行 ponytail。** 计划要求 frozen request 在 `armInject` 前短路（plan.md:54），并把 predecessor `on:arm` / `unavailable:readiness:on:arm` 冻结送入 Blueprint（plan.md:77-83）。与此同时，skill resolver 在强制 `superpowers` 时会先于 sticky/override 返回 A（`skill-framework-mode.ts:161-181`）。于是 D 前驱在 kill 后 retry 会得到 `skill_framework_mode="superpowers"`，但 frozen request 仍解析为 `on:arm`；若 readiness 可用，实际装配成为 “A + ponytail”，与 §3 “全局 kill 停整个实验”不符，也污染 A 的装配合同。建议把 arm request 的有效性绑定到**最终 resolved mode**：mode 仍为 D 时可保留 frozen arm；mode 不再为 D 时必须丢弃 arm 注入并按本次可信 start signal、且 `armInject=false` 重解普通 FLY-615 ladder。增加精确反例：D predecessor 的 `on:arm` 和 readiness-unavailable 两种，在 env 强制 A 后 retry 均不得再得到 `on:arm`；当前真实 label/project 信号仍按普通 ladder 生效。

3. **权威分析入口仍允许默认生成跨 rollout 的错误 aggregate。** Task 5 承认 `%4` 对比必须从 rollout epoch 开始，却把 `--since` 设成可省、仅打印 banner（plan.md:93-98）。默认查询全部历史会让 A/B/C 纳入大量 `%3` 时期样本、D 只含上线后样本；警告不改变统计结果，权威入口仍可产出不可比四臂表。建议正常比较模式强制 `--since`，或在 ship 收尾时固化 rollout epoch；若保留历史 smoke，应要求显式 `--all-history`/`--allow-pre-rollout`，避免误操作。self-test 同时断言缺少 epoch 会拒绝运行、显式逃生参数才允许。

4. **新增 shell self-test 尚未明确注册进真实 CI。** 本仓库没有自动发现 `scripts/__tests__/*.test.sh` 的通用 runner；`.github/workflows/ci.yml:193-204` 甚至明确说明测试需逐项枚举。计划只列新增 `test-fly1609-design-compare.test.sh` 和本地 Task 6 运行，没有把 `.github/workflows/ci.yml` 纳入改动面或指定持久化 CI step。建议在 Task 5 明列新增 `ci.yml` step（例如紧邻 FLY-1356/分析相关门），否则 acceptance 所称 “self-test CI 门”不会存在。

5. **Round 1 #6 的事件持久化边界仍只写在用户声明/台账里，没有落入任务清单。** 当前 plan 只明确 start API D=200（plan.md:85-89）和验收表中的 StateStore D 回读（plan.md:110-114）；没有列出 event-route 或 DirectEventSink 的 D 持久化测试。现有 `event-route.test.ts:1007-1028` 只用 `bare`，而 `DirectEventSink.test.ts` 没有 skill-framework mode 的专门 round-trip 用例。建议在 Task 4/6 明列 `StateStore.fly1356-skill-framework.test.ts`、`event-route.test.ts`、`DirectEventSink.test.ts` 的 D 用例及预期列值，保持用户本轮所称的边界证据与可执行计划一致。

## Verdict

CHANGES REQUESTED — address items above
