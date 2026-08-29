# FLY-1193 OOM 告警 debounce — QA 验证报告

Issue: FLY-1193 (https://linear.app/geoforge3d/issue/FLY-1193)
日期: 2026-07-12
基于: plan.md / research.md / min-calibration.md + 已提交实现(fleet-sensors.ts / AutoRepairBot.ts)

---

## 判定:PASS(功能验收通过)+ QA 直接修复了一处 CI-blocking 格式错误

三段式 QA 阶段独立复核已提交实现。**debounce 功能本体正确、设计一致、测试全绿**;
同时发现并当场修复了实现阶段遗留的一处 **CI lint 红**(本单自己的 evidence 脚本没跑
`biome format`),使 PR 可 ship。以下是逐项证据。

---

## 1. 验收对齐(issue 原文 → 实证)

| issue 验收标准 | 落点 | 证据 |
|---|---|---|
| 繁忙机器瞬时 dip(任一 danger 分支)N 秒内自愈 → **不 page、不 re-deliver、不广播** | `maybePage` 在 `elapsedMs < N*1000` 直接 return | 单测 ①、②a、②b + E2E 场景① 全绿:hold 静默置→清、零 alert、零 broadcast |
| 只有**持续 ≥ N 秒**的 pressure episode 才告警 | `elapsedMs >= N*1000` 才发 alert + 广播 | 单测 ②(121s)、②a(精确边界 119.999s 静默 / 120.000s 才 page)+ E2E ② |
| throttle-hold 行为不受影响(trigger 即置、自愈静默解除) | `ensureSensorHold()` 在 trigger 时静默置位;`liftSensorHold` 只清 swap-sensor 自己的 hold | 单测 ①/restart-safety 组 + E2E ①/④ |
| N=0 逃生口逐字回退旧行为 | `pageDebounceSecFromEnv` 显式 0 → trigger tick 立即 page | 单测 ③/13 + E2E ③ |
| FLY-1142 restart-safety 状态机逐字不动 | `machine-watermark.ts` 状态机零改(仅 MIN 默认值仍为 0) | `machine-watermark.test.ts` 31 测全绿;MIN 默认 `machine-watermark.ts:134` = 0 |

## 2. 独立跑测结果

| 套件 | 结果 |
|---|---|
| `fleet-sensors.test.ts`(含本 QA 新增 2 例) | **46/46 PASS** |
| `machine-watermark.test.ts`(FLY-1142 状态机回归) | **31/31 PASS** |
| alert/ticket/escalation 相关 7 套(告警管道回归) | **72/72 PASS** |
| `scripts/qa-fly-1193-debounce-e2e.mjs`(真机 E2E,真 StateStore + 真 vm_stat parse 缝) | **5/5 场景 PASS**(①spike-零page ②sustained-一page ③N=0 ④restart-mid-debounce ⑤restart-after-page identity 稳定) |

> **诚实标注**:本机内存受压(正是本单要治的病),`vitest run` 全量套件被系统 reap
> (exit 144,非测试失败;截断前可见测试全绿)。改动面只在 `fleet-sensors.ts`
> (`AutoRepairBot.ts` 仅注释),故聚焦跑了直接相关的 149 个单测 + 5 E2E 全绿。全量套件在
> GH runner(内存充足)上跑;CI 的 Build & Test 之前红是**卡在 Lint 步**(见 §4),不是测试步。

## 3. QA 新增测试(硬化 debounce 边界,非重实现)

`fleet-sensors.test.ts` 新增 2 例,补齐既有测试的空档(既有测试只覆盖 elapsed≈0 spike 与
elapsed 121s sustained 两个极端):

1. **`debounce boundary`**:精确验「≥ N」契约 —— elapsed = N−1ms 仍静默、elapsed = N 恰好
   page。锁死阈值本身,防将来 `>` vs `>=` 的 off-by-one 让 sub-N episode 误 page 而无声回归。
2. **`multi-tick spike self-healing before N`**:复刻生产 2026-07-12 09:04:31→09:05:01
   (30s)`alert_threads` episode 形态,泛化到 ~95s —— 一个**跨多个 tick 持续存在**却在 N 前
   自愈的真 pressure episode,断言**零 page、零 Lead 降载广播**,仅 hold 静默置→清。这是本
   issue 现场事故的直接回归锚(既有 ① 只在 elapsed≈0 恢复,不能证明「盘桓一会但仍 < N」被过滤)。

## 4. QA 发现并修复:CI lint 红(实现阶段遗留)

**发现**:PR #569 的 CI「Build & Test」红。根因定位:

- CI 报的 lint 项分两类。**主仓侧**(`FLY-1070/qa-e2e-harness.mjs` lone-block、
  `AgentTeamTransportFactory.ts` noStaticOnlyClass、`DirectEventSink.test.ts` 等
  suppressions/unused)—— 与本单**字节一致于 origin/main**,单独 lint 这些文件
  `biome check` **exit 0(全是 warning,不 fail CI)**,即 main 本身没红。
- **真扳机 = 本单自己的两个 evidence 脚本**(`evidence-replay-gate.mjs`、
  `evidence-soak-collect.mjs`)有 **biome format 错误** —— 实现阶段提交时没跑
  `biome format`。format 违规在 biome 里是 **error**(fail CI)。full-tree 的另一个 "error" 是
  本机 `.flywheel/runs/.../design-review.json` 本地 gitignored 产物,**不在 CI checkout 内**。

**修复**(QA 当场,scope 只限本单文件):`biome check --write` 两个 evidence 脚本
(纯 format + organizeImports,确定性 auto-fix)。修复后:

```
biome check engineering packages scripts  → Found 13 warnings, exit=0   (已提交树零 error → CI 转绿)
biome check <两个 evidence 文件>            → exit 0 (CLEAN)
```

主仓侧的 13 个 warning **不碰**(非本单职责,动它=越界 cleanup,且可能撞其他 in-flight 分支)。

## 5. 代码正确性复核要点(独立看过)

- **解耦**:hold(机器面保护)在 `swapTick` 的 trigger/inPressure 分支即置(比旧
  alert→AutoRepairBot 绕一圈**更早**),page/广播走 `maybePage` 的 debounce —— 与设计一致。
- **广播幂等**:`broadcastLoadShed` 用 `swap-broadcast:<episodeId>:<leadId>` 作 dedupeId,
  经 `plugin.ts:6498 notifyLeadInstruction` → `CommDB.insertInstruction` 的
  **INSERT OR IGNORE**(`db.ts:517-523`)去重;partial failure 不置 latch、下 tick 补齐
  (单测 8b)。
- **fail-loud**:hold 置位失败 → 独立 `swap-holdfail:` eventId 告警,不被正常 page 的
  claims 掩盖;空/畸形 episode 锚一律 `needs_human`(单测 9/10/8e-vi)。
- **restart-safety**:in-memory latch 重启丢 → fresh monitor 重新 2-tick 确认 + 重计 N;
  durable hold 只在 PROVEN health 才 lift(FLY-1142 逐字保留,单测 restart 组 + E2E ④/⑤)。

## 6. MIN 重校准(承 min-calibration.md,gate-owner Tadashi 决定项)

维持 **MIN=0**:繁忙峰值窗 soak(61 样本)+ 离线 replay 显示 MIN=0 + N=120 下 busy trace
**零 page**;无正样本时不安全调大 MIN(§5-6)。plan §5-1 的「pre-ship ≥2h busy soak」时长
未达字面(实采繁忙峰值 ~30min),这是 **gate-duration 改约**决定,已由实现阶段
`flywheel-comm ask` 知会 Tadashi(383146c0)—— 本 QA 不推翻该 gate-owner 决定,仅如实记录。
ship 本身 founder-gated + plan §4-4 部署后 ≥1 天 standing 观测窗兜底。

## 结论

功能验收 **PASS**。QA 额外修掉一处本单自带的 CI-blocking format 错误 + 加 2 个 debounce 边界
硬化测试。已提交树 lint 零 error、149 单测 + 5 E2E 全绿。可进入 founder-gated ship。
