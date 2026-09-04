# FLY-2229 冷却回退 — 设计纠偏
Issue: FLY-2229 (https://linear.app/geoforge3d/issue/FLY-2229/切号死锁-switch-cooldown-让唯一可切目标变成-no-targetschoolpersonal-切换-30-分钟后)
日期: 2026-09-04
基于: plan.md

本文件按 FLY-1404 记录设计审查通过后的增量纠偏。`plan.md` 是已经固定的历史设计，不回写、不重开 design gate；实现、PR body 与 milestone 采用下列裁定。

## 废除概念

- 废除 quota fallback 决策点的 model-defer 分支及其测试矩阵。`quota-monitor.ts` 已在 quota scope 非空时清除 pending model detection；人为绕过该清除逻辑只会制造运行时不可达的测试状态。
- 废除 5h-dominant 来源进入 cooldown fallback 的 monitor 级探测。来源不是 7d-dominant 时必须在 freshness/usage I/O 前短路。
- 废除“给 `BlockedEpisode` 增加可选字段便天然向后兼容”的假设。其运行时解析器使用严格 key allowlist，任何持久化扩展都必须同步更新解析边界。

## 保留器官

- 保留 quota scope 非空这一条可达性断言；不添加人工 model coexistence seam。
- 保留 selector 的不同窗口判定为权威 gate，并直接单测 source 与 target 同为 5h-hot 时拒绝；monitor 的 source-7d 条件只负责 pre-I/O short-circuit。
- 如果实现持久化 fallback context，必须同步扩展 `BLOCKED_EPISODE_KEYS` / `hasOnlyKeys` 路径，并证明变更前、不含新增字段的 episode 仍可读取。
- cooldown exception 仍是 selector 针对本次尝试签发的单目标、live-verified 能力；manual、repair、5h-only、非 preferred target 和多目标输入全部 fail closed。

## Reviewer 原话引用

> My round-3 HIGH was wrong — quota trigger and model detection cannot coexist at the fallback point, so rule 8's deferral branch is dead code and its new test matrix is unconstructible

> Dropping the cheap source-7d precondition makes every 5h-triggered no_target tick spend a guaranteed-futile freshness probe, usage API call and store write

> NEW — rule 10 persists new BlockedEpisode fields, but the state parser is a strict key allowlist whose rejection resets the ENTIRE monitor state; the plan never names it

## Lead 裁定原话

> APPROVED acknowledged. Take all three advisories into the implementation, no re-review: (1) drop the model-defer arm and its test — reviewer is right quota-monitor.ts already clears pending model detection when quota scope non-null; keep one assertion fallback path only entered with non-null quota scope instead of artificial seam; (2) restore dominantWindow(source)===7d as pre-I/O short-circuit AND keep selector same-window refusal defence-in-depth unit test; (3) if BlockedEpisode persists fallback context, extend BLOCKED_EPISODE_KEYS/hasOnlyKeys strictly and make reader tolerate episodes before change.

> correct — do not touch the pinned plan blob. Record the three decisions as a design-correction.md next to the plan (the FLY-1404 incremental-correction file: abolished/retained/verbatim reviewer quote) inside the implementation commit, plus the PR body and milestone. Continue.
