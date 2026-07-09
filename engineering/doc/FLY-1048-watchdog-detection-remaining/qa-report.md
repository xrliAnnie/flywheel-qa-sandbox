# FLY-1048 Watchdog detection 剩余实现 — QA 报告(PR-A)

Issue: FLY-1048 (https://linear.app/geoforge3d/issue/FLY-1048)
日期: 2026-07-09
基于: plan.md(同文件夹)+ PR #522(feat(watchdog): FLY-1048 PR-A — mechanical detection layer + minutes-scale cadence)

> **三段式 QA 阶段结论:FAIL(1 个真实、可复现、CI-blocking 缺陷)。**
> 缺陷来源 = PR-A 本身(新增 6 个 `FLYWHEEL_*` env 未注册),不是环境噪音。
> 修复归 Implement 阶段(QA 不自改代码,按三段式契约)。

---

## 0. QA 范围界定(重要)

本 branch / PR #522 = **仅 PR-A**(机械检测层 + cadence),**不含** PR-B(watchdog-judge)/ PR-C(统一升级流)。
已核对 `git diff origin/main...HEAD`:落地文件 = error-signatures / pane-frames / pane-live-region /
detection-suspicious / detection-gap-scan / focused-frame-scheduler / stuck-candidate(A3)/
LeadWatchdog(A4)/ LeadAlertNotifier + AlertChannelHub + infra-event-router + stuck-escalation
(pane_error_stalled 接线)/ plugin.ts(A5/A6/A7 wiring)/ gate-poller(A6 piggyback)。
**无** watchdog-judge.ts、**无** detection-escalation.ts、**无** StateStore detection_escalations 表。

- plan §1 明确「每 PR 独立可 ship」→ PR-A 单独 ship 合法,QA 只判 PR-A 的 ship-readiness。
- 但 plan D1 也写「1048 = 三个 PR 全落 + QA 覆盖整体才算 done」→ **issue 级 done ≠ PR-A merge**。
  给 Lead 的提醒:PR-A 通过后 FLY-1048 issue 仍需 PR-B / PR-C(另起 pipeline)。

---

## 1. 验收结果总表

| 检查项 | 结果 | 证据 |
|---|---|---|
| FLY-1048 专项单测(10 文件) | ✅ 159/159 PASS | error-signatures / pane-frames / detection-suspicious / detection-gap-scan / focused-frame-scheduler / gate-poller-gap-scan / LeadWatchdog-fly1048-multiframe / stuck-candidate / stuck-escalation-render / AlertChannelHub |
| 被改共享文件的既有回归测试 | ✅ PASS(clean env) | LeadWatchdog(含 927 acceptance/echo)、gate-poller、stuck-candidate、lead-runtime×2、infra-event-router、stuck-escalation、LeadAlertNotifier 全绿(392/393,唯一 1 个是 host env 污染,见 §3) |
| biome lint(10 改动文件) | ✅ clean | `biome check` — no fixes applied |
| typecheck(config + teamlead) | ✅ exit 0 | `tsc --noEmit` 两包均无错 |
| 全量 teamlead 套件 | ⚠️ 5686 PASS / 3 文件失败 | **3 个失败文件全是 host-env 假失败,均不在 PR-A diff**(见 §3) |
| **CI「Build & Test」** | ❌ **RED(阻断 ship)** | **config feature-flag drift guard 失败(见 §2)** |

---

## 2. ❌ BLOCKER:feature-flag drift guard 失败 → CI RED

**测试**:`packages/config/src/__tests__/feature-flags-drift.test.ts`
> `no silent new gate: every scanned FLYWHEEL_* is registered or allowlisted`

**现象**:PR-A 新增了 6 个经 **字面量 `process.env.FLYWHEEL_X`** 读取的 env,既没注册进
`FEATURE_FLAGS`(`packages/config/src/feature-flags/registry.ts`),也没进 `NON_FLAG_ALLOWLIST`
→ drift guard 判「静默新增 gate」→ 断言失败 → CI job **Build & Test 直接 RED**。

本地已复现(`vitest run feature-flags-drift.test.ts` → 1 failed / 2 passed),CI log 同因
(run 29025143085,exit 1)。

**6 个未登记 env(按性质)**:

| env | 性质 | 读点 |
|---|---|---|
| `FLYWHEEL_DETECTION_GAP_SCAN` | opt-in 布尔 gate | plugin.ts `gapScanTick` |
| `FLYWHEEL_PANE_MULTIFRAME` | opt-in 布尔 gate | plugin.ts `LeadWatchdog` config |
| `FLYWHEEL_STUCK_ERRORSIG` | opt-in 布尔 gate | stuck-candidate.ts `evaluateStuckCandidate` |
| `FLYWHEEL_GAP_SCAN_EVERY_N_TICKS` | 数值 tuning knob | plugin.ts |
| `FLYWHEEL_FRAME_INTERVAL_MS` | 数值 tuning knob | plugin.ts |
| `FLYWHEEL_FRAME_CAPTURES_PER_TICK` | 数值 tuning knob | plugin.ts |

**建议修复(Implement 阶段做,QA 不代改)**:
- 3 个 opt-in 布尔 gate → 二选一:
  - (推荐)加入 `NON_FLAG_ALLOWLIST` 并注明「internal ops lever,default-off,ops-flipped in
    `~/.flywheel/.env` + Bridge restart」——沿用 **FLY-927 rollout-lever 判例**
    (test 文件 line 138-152:`FLYWHEEL_ALERT_ROUTING` / `FLYWHEEL_ALERT_TICKETS` /
    `FLYWHEEL_CHECKPOINT_WATCHDOG` 同类);或
  - 正式注册进 `FEATURE_FLAGS`(category `kill_switch`/`feature`、polarity `opt_in`、带 `readSites`)。
- 3 个数值 tuning knob → 加入 `NON_FLAG_ALLOWLIST` 注明「tuning knob」——沿用
  **FLY-766 / FLY-725 tuning-knob 判例**(test 文件 line 111-137)。
- 改完 `cd packages/config && vitest run` 应全绿;顺带 `pnpm test:packages:run` 复跑一次确认 CI 绿。

**次要提醒(非 CI blocker,可在动 registry 时顺手补)**:
`detection-gap-scan.ts` 的 `defaultGapThresholds` 经 **变量下标 `env[name]`** 读取的 4 个阈值
env——`FLYWHEEL_GAP_ASK_UNANSWERED_MS` / `FLYWHEEL_GAP_UNCONSUMED_MS` /
`FLYWHEEL_GAP_PROGRESS_STALL_MS` / `FLYWHEEL_GAP_COMM_WINDOW_MS`——drift scanner 的正则抓不到
(该 guard 自述「full AST scanner is a follow-up」),**不会让 CI 失败**;但为文档完整,建议注册/allowlist 时一并列上,避免日后 AST 版 scanner 上线又一次 drift。

---

## 3. 全量套件 3 个失败文件 = host-env 假失败(逐一定性,均非 PR-A)

本 runner 自带生产 Bridge 的完整 env(46 个 `*BOT_TOKEN*`/`DISCORD_*` 已导出),且 TMPDIR/
browser-tmp 落在 `~/.flywheel/runner-state/<execId>/` 下 → 触发若干**环境敏感**测试的假失败。
均已核对**不在 PR-A diff**(`git diff --name-only origin/main...HEAD` 无这三文件及其 SUT)。

| 失败文件 | 根因 | 定性 |
|---|---|---|
| `LeadAlertNotifier.test.ts`(2) | 读到真实 `DISCORD_BOT_TOKEN`(= 生产 Simba token),而非测试的 `resolved-bot-token` | **已证**:`env -u DISCORD_BOT_TOKEN` 复跑 → **45/45 PASS**。纯 host env 污染。 |
| `codex-lead-runtime.test.ts`(~20,FLY-350/FLY-245) | SUT `resolveLeadWorkspace` 抛错:测试临时 workspace 落在 `~/.flywheel/runner-state/<execId>/browser-tmp/...`,与 `~/.flywheel` overlap(confinement 正确拒绝) | **已知环境问题**(memory: codex-lead-runtime TMPDIR-overlap)。CI 干净 TMPDIR 下通过。PR-A 未碰 lead-backends。 |
| `fly247-bash-suites.test.ts`(1 of 7) | hermetic bash 子测 `flywheel-fleet plan/apply/rollback/recover` 跑 135s 后失败,同文件另 6 个 fleet 子测全绿 | env/时序敏感的 hermetic bash flaky。PR-A 未碰 fleet/bash 代码。 |

→ **PR-A 触及的每一个文件的测试都通过;全量套件里唯一的失败全部是 host 环境产物。** 无 PR-A 回归。

---

## 4. 代码正确性抽查(对照 plan §2 A1-A8,均 OK)

- **A1 error-signatures**:4 kind 正则词边界防误伤;`normalizeErrorLine` 剥 ANSI/path/数字→稳定签名;
  `▏` quote 行跳过(echo 免疫)。✅
- **A2 pane-frames**:K=3 ring buffer + `computeFrameDeltas`(silenceDelta 要求 allSame + 空 prompt +
  span≥minSpan;repeatedErrorSig 跨 ≥2 帧;单帧 span=0 不下 c 结论)。✅
- **A3 stuck-candidate**:`FLYWHEEL_STUCK_ERRORSIG` 门控;签名 episode fingerprint pin 到 `sig:<hash>`
  抗 churn;`carryEscalation` 防 flag flip 中途双报;evidence 用 kind 非 raw line。✅
- **A4 LeadWatchdog**:`multiFrame` 门控(未设=单帧字节不变,927 fixture 双态绿);两道 veto
  (error-sig 冻结→`pane_error_stalled`;silent+frozen-thinking-residue→fireSuspicious);
  529 throttle 短路优先级不变;`pane_error_stalled` 全面接入 4 surface + titleFor/bodyFor 穷举 case
  (body 不回显匹配行)。✅
- **A5 detection-suspicious**:owner-Lead only + 安静 thread 帖(reason-only,无 pane,无 mention);
  `▏` 引用 paneTail 防 echo 二次触发;durable dedup(target+fingerprint);deliver 永不 throw;
  两 LeadRuntime formatEnvelope 显式分支。✅
- **A6 detection-gap-scan**:全 readonly + `probe()` 缺表/缺列降级为 no-signal、坏库 fail-closed 跳过 project;
  判据全多重与门(parked×无 lead 通信×无 founder-notified evidence 才 gap1);PR-A 内只观测不告警。✅
- **A7 focused-frame-scheduler**:间隔/冷却/每 tick 上限/失败 fail-closed(盲帧不下结论);verdict 映射正确。✅
- **A8 sentinel**:全新 env 未设 = 既有测试字节绿(159 专项 + 全量回归已证)。✅

wiring(plugin.ts):A6 gapScanTick env 在 tick 内读(热生效)、A7 capture 复用 session-capture、
A5 late-bound thread poster(alertDiscordOps 就绪后再挂)、`onGapScanTick`/`gapScanEveryNTicks` piggyback
零新 timer——均符合 plan。**结论:PR-A 机械层实现质量高,唯一硬伤是 env 未登记这一条 CI gate。**

---

## 5. QA 判定

**FAIL** —— 单一阻断项 = §2 的 feature-flag drift guard(CI RED)。
PR-A 逻辑本身健全、回归干净、lint/typecheck 均过;修好 env 登记 → CI 应转绿 → 可再验收。
按三段式契约:QA 不自改代码;此报告 + `qa-result --status fail` 交回 Implement 阶段在本 branch 修,
修后 push 同一 branch → 唤醒 QA 复验。
