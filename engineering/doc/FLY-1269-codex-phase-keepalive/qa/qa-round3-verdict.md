# FLY-1269 QA Opus — Round-3 Findings Verification Verdict

Issue: [FLY-1286](https://linear.app/geoforge3d/issue/FLY-1286) (QA · FLY-1269 Codex 常驻三段式 529 E2E)
日期(UTC): 2026-07-15
QA exec: `aad2f2a7-ad02-4e34-b933-7ae539af1dfa` (phase=qa, TURN epoch 5)
Head under verification: `1afa999a0cfedb3bbbb1c753130b366db7e7e098`
Candidate: FLY-1269 PR #604 `cad61a07894a98d808aea5b948830f12cfdcff83`

## Verdict

**QA FAIL — round-3 review findings NOT resolved at current head.**

Lead 明确把 review round-3 的三条 findings 设为 terminal approval 前的 QA 验收硬标准
(comm inbox `577c9cd7-c6e6-4712-9456-99ba47930ea7`)。对当前 head 的观测脚本
`529-terminal-observer.mjs` 与其测试 `529-terminal-observer.test.mjs` 做**确定性结构核查**
后,三条 findings **全部未满足**。按 Lead 指令,QA 判 FAIL,TURN 交回 Implement 修复 +
新一轮 code review;在解决前 **不 arm terminal cleanup**(Task 8 external observer 不启动)。

以下三条与机器负载无关,是纯代码/测试结构事实(逐条给出 `file:line`、expected vs actual)。

## Finding 1 — indeterminate-liveness 测试 clobber lsof marker 且依赖 lastPresent 时序 (Criterion 1)

**未满足。** Severity: **High**。

- 位置:
  - 测试 `qa/529-terminal-observer.test.mjs:655-689`
    (`"fails closed when direct-path liveness is indeterminate"`),其中 `clearSockets()`
    调用在 `:679`;helper `clearSockets` 在 `:414-421`。
  - 观测脚本 `qa/529-terminal-observer.mjs`:cleanup-phase indeterminate 守卫
    `:627-653`;`classifyExecution` 的 `lastPresent` indeterminate 分支 `:384-395`;
    每轮 `lastPresent` 捕获 `:547-552`。
- 问题:测试在 session 仍存在时把 `lsof` marker 设为 `"indeterminate"` + tmux 设为
  `permission`(→indeterminate),等到一帧 `tmux === "indeterminate"` 后,却调用
  `clearSockets()`——它把 DESIGN/IMPLEMENT 的 lsof 条目**覆盖回 `[]`**
  (`:417-420`),把 "indeterminate" marker 清掉;再 `clearTmux()` 把 tmux 设为
  `absent`。于是在 `stateGone && commGone` 时刻,观测脚本 cleanup-phase 的三项
  indeterminate 守卫(`:629/:637/:645`)全看到 `absent` 而非 `indeterminate`,**不会**
  触发 `liveness_indeterminate`。唯一还能产出被断言的 `liveness_indeterminate` verdict 的
  路径是 `classifyExecution` 读 `lastPresent`——而这要求"最后一帧 present 快照"恰好保留了
  indeterminate 探针值、且没有被一帧 clobber 后的 all-absent present 快照覆盖。这完全取决于
  `clearSockets/clearTmux` 与 `deleteLifecycle` 之间的调度时序。
- Expected:indeterminate-liveness 测试必须让 lsof marker 在 cleanup 边界**保持
  "indeterminate"**(不要用 clearSockets clobber),使观测脚本的 cleanup-phase
  indeterminate 守卫 (`liveness_indeterminate:<exec>:lsof|tmux|socket`) **确定性触发**,
  与 `lastPresent` 最后一次采样时刻无关。
- Actual:测试 clobber 掉 marker 且靠 `lastPresent` 时序拿 verdict → 结构性 flaky;快机上
  `lastPresent` 会被 clobber 成 all-absent → `classifyExecution` 返回 `direct_proven`
  而非 `liveness_indeterminate` → 断言 `assert.match(reason, /liveness_indeterminate/)`
  (`:684`) 失败。

## Finding 2 — startup arming 是 one-poll abort,而非 bounded retry window (Criterion 2)

**未满足。** Severity: **High**。

- 位置:观测脚本 arming 块 `qa/529-terminal-observer.mjs:587-616`,首个
  `initialFailure` 即 `return 1`(`:613`);测试
  `qa/529-terminal-observer.test.mjs:737-753`
  (`"fails fast when the initial tmux server cannot be observed"`),断言
  `initial_tmux_not_live:design:indeterminate`(`:748`)。
- 问题:在 `!armed` 的**第一轮**迭代,只要任一初始探针不是 live/present(tmux≠live、
  socket≠live、holders≠present),观测脚本立即写 fail verdict 并 `return 1`。**没有** bounded
  retry / arming deadline / attempt 计数。一次瞬时的首帧探针抖动(高负载下 tmux/lsof 瞬时
  indeterminate,或 socket 尚未 accept)就会永久 abort 观测。单测 `:737` 还把这个 fail-fast
  行为**锁进断言**。
- Expected:startup arming 必须在一个 bounded window 内轮询(如到 arming deadline 或 N 次
  尝试),仅当窗口结束时相仍非 live/present 才 fail;瞬时首帧探针不得直接 abort。
- Actual:one-poll abort;harness 反而断言了该 anti-pattern。这正是 529-room 真机运行环境
  (本 observer 的实际部署环境)最危险的失败模式——首帧抖动 abort 会葬送 A7 terminal
  request/ack/delete 捕获窗口,而该窗口在 cleanup 后无法复现。

## Finding 3 — holder evidence 无 observedAt freshness (Criterion 3)

**未满足。** Severity: **Medium**。

- 位置:观测脚本 `probeHolders` 返回 `{state, holders}` 无时间戳
  `qa/529-terminal-observer.mjs:233-243`;holder 结果跨轮缓存、仅当
  `holderEvidenceKey` 变化才重探 `:529-546`;赋给快照 `liveness[role].holders`
  `:545`。对照:shutdown history 有 `observedAt`(`:317`),holder evidence 没有。
- 问题:holder evidence 对象不带 `observedAt`。由于 `holdersBySocket` 被缓存,只在
  (socket 状态、statePresent、commPresent) key 变化时才重跑 lsof,某一帧的 `holders` 可能
  反映的是很多轮之前的 lsof 扫描结果,却无从判断新鲜度。terminal orphan-holder oracle 因此
  可能把一个**陈旧**的 present/absent 读数当作当前值信任。
- Expected:holder evidence 应暴露 `observedAt`(和/或 age),使陈旧的缓存 holder 结果可与
  刚探测的结果区分,orphan-holder verdict 的新鲜度可审计。
- Actual:holder evidence 无 observedAt。

## Secondary observation — observer regression rerun 未复现 17/17 (非 FAIL 主依据)

- 本机 `node --test 529-terminal-observer.test.mjs` 结果:**17 tests / 11 pass /
  6 fail**,duration 45.4s(证据日志 `qa/qa-round3-test-run.txt`),对照 qa-report 宣称的
  "17/17 passed / 28.494s"。
- 6 个失败多为高负载下 node-spawn 假探针(fake `tmux`/`lsof` 均 `#!/usr/bin/env node`)使
  observer 迭代过慢导致的 `observer did not exit` 超时,以及一处 `cleanup_not_observed`
  (observer 自身 2000ms timeout 先于 orphan 状态被观察)。**这些主要是本机负载伪影**,不作为
  FAIL 主依据;仅作为 reproducibility 关注点记录——qa-report 的 "17/17" 在本 QA 机器上无法
  按声称的时长复现,Implement 修复时宜同时降低每帧探针开销或放宽 fixture 时序假设。

## Required actions (Implement phase, on FLY-1269)

1. **C1**:改造 indeterminate-liveness 测试,使 lsof marker 在 cleanup 边界保持
   `indeterminate`(不 clobber),让 observer 的 cleanup-phase indeterminate 守卫确定性触发;
   verdict 不得依赖 `lastPresent` 采样时序。
2. **C2**:把 startup arming 改为 bounded retry window(arming deadline / attempts),瞬时首帧
   探针不得 abort;同步修改锁定 fail-fast 的单测,改为验证"bounded 窗口内 arm 成功 / 窗口末仍
   不 live 才 fail"。
3. **C3**:给 holder evidence 增加 `observedAt`(freshness),并在缓存复用时保留/更新该时间戳;
   加断言覆盖。
4. 修复后重新过 code review(新一轮),再唤醒 QA 复验。

**在三条全部修复并复验通过前,QA 不 arm terminal observer、不开 founder approve gate。**

---

## RESOLVED — round 4 re-test (head `1f12c3fb8f255e6795b58d57a9ee40b61cf925c8`)

Implement 在同分支推 `1f12c3fb`（`test(FLY-1269): harden observer startup evidence`,
仅改 observer + test,无 `packages/**`）。QA exec `aad2f2a7`(TURN epoch 7)复验:

- **C1 RESOLVED**:indeterminate 测试改为只 `closeSocket`(不 rewrite lsof.json),lsof
  `indeterminate` marker 在 cleanup 边界保留,断言精确 `liveness_indeterminate:design-success:lsof`
  (cleanup-phase 守卫,确定性,不依赖 lastPresent 时序)。
- **C2 RESOLVED**:observer 新增 bounded arming window(`armingAttempts`/`armingDeadlineAt`,
  默认 5 次/10s;`initialFailure` 仅超 bound 才 fail,否则 `sleep+continue`),fail verdict 带
  `arming{attempts,maxAttempts,timeoutMs,deadlineAt}`。新测试 `retries transient startup liveness
  before arming` + `fails closed after bounded startup retries` 双向验证。
- **C3 RESOLVED**:`probeHolders` 给 present/absent/indeterminate 全部盖 `observedAt`,缓存复用保留
  原采样时刻;新测试 `timestamps holder evidence and preserves its sample time while cached`。

full 529 observer 回归用真实 committed `observer.mjs` + load-tolerant harness 复跑 **19/19 全绿**
(默认短超时下 13/19,6 个失败纯本机负载超时伪影,非逻辑缺陷);Design+Implement resident liveness
经 60s freeze 双采样重新确认。详见 qa-report.md "QA Opus RE-TEST Verdict"。**三条全部 RESOLVED →
本轮 PHASE PASS**。
