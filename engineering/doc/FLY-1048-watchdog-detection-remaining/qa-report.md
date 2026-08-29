# FLY-1048 Watchdog detection 剩余实现 — QA 报告(PR-A)

Issue: FLY-1048 (https://linear.app/geoforge3d/issue/FLY-1048)
日期: 2026-07-09
基于: plan.md(同文件夹)+ PR #522(feat(watchdog): FLY-1048 PR-A — mechanical detection layer + minutes-scale cadence)

> **三段式 QA 最终结论:PASS —— 代码级(§1-§6)+ 真机 Discord E2E(§7,Annie/Tadashi 要求补测)双通过。**
> Round 1 = FAIL(6 个 `FLYWHEEL_*` env 未注册,CI 红);Implement commit `496c245d` 修好 → Round 2 代码级 PASS(CI 绿)。
> Annie 看报告指出「缺真 Discord E2E」(检测类功能验收标准 = 真机看到检测触发 + 通知真落 Discord),Tadashi 打回补测 →
> §7 529 Room 真机 E2E:`pane_error_stalled` 真消息落隔离 Discord 频道(链接为证)+ 重复错误签名/gap 扫描检测真触发。**16/16 PASS。**

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

**Round 1 = FAIL** —— 单一阻断项 = §2 的 feature-flag drift guard(CI RED)。
PR-A 逻辑本身健全、回归干净、lint/typecheck 均过;唯 env 登记缺失。
按三段式契约:QA 不自改代码;交回 Implement 阶段在本 branch 修,修后唤醒 QA 复验。

---

## 6. RE-TEST(round 2)—— PASS

**触发**:Implement 阶段推 commit `496c245d`「fix(config): register FLY-1048 watchdog env in
feature-flag registry (QA fix round 1)」,worktree 已在新 head(同目录,零 fetch)。`turn` 确认
`yours`(epoch=5)后复验。

**修复内容核对(仅动 `packages/config`,teamlead 代码逐字未变 → 我 round-1 的 189 项测试仍有效)**:

| 未登记 env | 修法 | 是否正确 |
|---|---|---|
| `FLYWHEEL_STUCK_ERRORSIG` | 注册进 `FEATURE_FLAGS`(name `stuck_errorsig`,opt_in/bool/default false,readSite stuck-candidate.ts) | ✅ |
| `FLYWHEEL_PANE_MULTIFRAME` | 注册进 `FEATURE_FLAGS`(name `pane_multiframe`,opt_in/bool/default false,readSite plugin.ts) | ✅ |
| `FLYWHEEL_DETECTION_GAP_SCAN` | 注册进 `FEATURE_FLAGS`(name `detection_gap_scan`,opt_in/bool/default false,readSite plugin.ts) | ✅ |
| `FLYWHEEL_GAP_SCAN_EVERY_N_TICKS` | 加入 `NON_FLAG_ALLOWLIST`(tuning knob,FLY-766 判例) | ✅ |
| `FLYWHEEL_FRAME_INTERVAL_MS` | 同上(tuning knob) | ✅ |
| `FLYWHEEL_FRAME_CAPTURES_PER_TICK` | 同上(tuning knob) | ✅ |

3 个布尔 gate 正式注册(不是塞 allowlist 糊弄)、3 个数值 knob 归 allowlist——**分类正确,drift guard 本身未被削弱/篡改**(guard 逻辑零改;只在 `NON_FLAG_ALLOWLIST` 加了 3 行带 reason 的条目)。

**复验证据(head `496c245d`)**:
- ✅ **CI「Build & Test」GREEN**(run 29027216717,pass,11m35s)—— round-1 唯一阻断项已消除,clean-env 权威确认。
- ✅ **`packages/config` 全量套件**:20 文件 / **359/359 PASS**(含 feature-flags-drift 的 3 项);config typecheck exit 0。
- ✅ **FLY-1048 teamlead 单测 + 927 sentinel**(重跑于新 head):13 文件 / **189/189 PASS**。
- ✅ teamlead 侧代码未改动 → round-1 已验的回归/lint/typecheck 结论继续成立。

**最终判定:PASS。** PR #522(PR-A)ship-ready:CI 绿、QA 双轮验收通过、字节兼容(全新 env default off)。
下一步 = 开 approve gate,等 founder 批 → 我(本 pipeline ship executor)执行 :cool: ship。
(范围提醒不变:FLY-1048 issue 级 done 仍需 PR-B / PR-C,另起 pipeline。)

---

## 7. RE-TEST(round 3)—— 真机 Discord E2E(529 Room),Annie/Tadashi 要求补测

**为什么补**:Round 2 只做了代码级(单测 + CI)。Annie 看报告直接指出检测类功能的验收标准 =
**真机看到它真的检测到 + 真的通知到**。她说得对——补跑 529 Room 隔离真机 E2E。

**方法(module-driven,零生产影响)**:跑 `scripts/qa-fly-1048-real-discord-e2e.mjs`——加载**真正的 #522
built dist**(`packages/teamlead/dist`,head `3b6b3bc2`),6 个开关全开,驱动真实检测代码路径;对 PR-A
唯一会通知 Discord 的 `pane_error_stalled`,用**真 `LeadAlertNotifier`** 把消息发到**隔离的 529 测试频道**
`#test-flywheel-alerts`(`1519421055805165842`,bot `TEST_BOT_TOKEN_1`)。全程隔离:temp alert/queue/claims
dir + `:memory:` StateStore + 测试 bot + 测试频道 —— **生产 Bridge/频道/claims.db 零触碰**(已核:生产
`alert-queue` 无 FLY-1048 文件、`claims.db` mtime 不变)。宿主本机跑着生产 Bridge,故**不部署/不重启任何 Bridge**。

**三场景 + 结果(16/16 PASS,`node scripts/qa-fly-1048-real-discord-e2e.mjs` → exit 0,可复跑)**:

| 场景 | 验的什么 | 真机结果 |
|---|---|---|
| ① pane 停「Not logged in」(Tadashi 例) | 冻在 idle 样式的 Lead pane 上 → 多帧 veto → `pane_error_stalled` + **真 Discord 消息** | ✅ 恰 1 条告警、kind 正确、body 不回显错误行(echo 免疫);**真消息** |
| ①b committed「Server error mid-response」fixture | 同上,用仓库里那份真 fixture | ✅ **真消息** |
| ② runner pane 反复刷同一错误(rolling ENOENT,文字变签名不变) | `FLYWHEEL_STUCK_ERRORSIG` 门 → 重复错误签名检测 → stuck CANDIDATE + 签名 kind | ✅ candidate=true、`errorSignature=enoent_loop`;门关 → 不 candidate(字节兼容) |
| ③ 分钟级 gap 扫描 | `evaluateGapSuspicion` 真判据:parked-unreported(漏①)+ ask 超时(漏②);已报过的 parked 不刷屏(R1) | ✅ 漏①漏②触发、R1 静默 |

**真 Discord 消息(隔离频道,链接为证 —— 最近一次跑)**:
- ① `pane_error_stalled`(Not logged in):`1524851301228478555`
  https://discord.com/channels/@me/1519421055805165842/1524851301228478555
- ①b `pane_error_stalled`(Server error):`1524851303052742656`
  https://discord.com/channels/@me/1519421055805165842/1524851303052742656
- 频道:https://discord.com/channels/1512577412069658634/1519421055805165842
- 消息标题实样:`⚠️ Lead pane error-stalled (flywheel-test-1 / pane_error_stalled)` + 建议动作 body(**不含**原始错误行)。

**诚实的范围说明(让验收可信)**:PR-A **唯一**会向 Discord 发用户可见通知的检测类 = 上面的
`pane_error_stalled`(Lead 侧)。runner 侧重复错误签名(②)在 PR-A 只**产出 candidate**(通知走既有
FLY-195 runner-stuck 路,非 PR-A 新增);gap 扫描(③)在 PR-A **只观测不通知**(plan 明确,通知面在 PR-C)。
故 ②③ 的真机验收 = 在**真 #522 dist 函数**上证「检测真触发」;真 Discord 通知的证据落在 ① / ①b。

**驱动脚本 + 证据**:`scripts/qa-fly-1048-real-discord-e2e.mjs`(随本 PR 提交,可复跑);
完整断言输出见 runner 侧 e2e-evidence 抓屏(16 项逐条 ✓)。

**最终判定不变:PASS。** 代码级(CI 绿 + 单测)+ 真机(检测触发 + 真 Discord 通知,隔离零污染)双通过。
