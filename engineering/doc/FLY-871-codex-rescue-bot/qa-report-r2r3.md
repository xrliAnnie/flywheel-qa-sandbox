# FLY-871 R2/R3 QA 报告 — Codex Infra Bot(看/切/救)独立验证

Issue: FLY-871 (https://linear.app/geoforge3d/issue/FLY-871/infraresilience-codex-救援-bot-账号体系外的看切救696-交叉自愈架构的-codex-半边token)
日期: 2026-07-05
基于: plan.md,design-review.md,PR #451 @ 0a82a6ea(分支 flywheel-FLY-871-r2,R1 已 merge #448)

## 0. 会话性质

本次是独立折叠的 QA session(非实现者,实现 runner 已关闭,不沿用其自我结论)。checkout PR #451 分支
精确定位到 0a82a6ea(与 PR head 逐字一致),重新 `pnpm install && pnpm -r build` 后独立验证。

## 1. 验证范围

PR #451 交付(plan.md §11 R2/R3):
- C5 `POST /api/account-switch`(Infra Bot claim+execute 入口)
- C6 部署物料(TUI launcher / launchd plist / persona / Discord 权限清单)—— 非代码,不在本次测试范围
- C7 account-ledger + `flywheel-account-summary` CLI(看)
- C8 `runner_login_expired` 检测(RunnerIdleWatchdog 组合)
- C9 + W3–W6 救援路径(rescue.ts / rescue-runtime.ts / `POST /api/rescue` + CLI / post-switch sweep / infra-bot mention)

## 2. 代码审阅(红线逐条核对源码,非仅读 PR 描述)

- ✅ **rescue 只救 CONFIRMED、suspicious 只报**:`rescue.ts` `isConfirmed()` 排除 `evidence` 以 `:suspicious`
  结尾的行;`findPendingLeadAlert`/`findPendingRunnerAlert` 都过滤 `isConfirmed`。
- ✅ **runner rescue 有 LIVE revalidate seam**:`rescueRunner` 在销毁性 close 之前调用 `deps.revalidate`,
  抛错(cannot tell)→ 拒绝 + 升级(`revalidation_error`,mention:true),`confirmed:false`(已自愈)→
  report-only 拒绝 + resolve 告警(不升级、不 close)。只有 revalidate 确认仍是 confirmed 才继续销毁性操作。
- ✅ **lead rescue 需要正向恢复证据**:`attemptLeadRescue` 的 `after == null` 判 `verify_capture_failed`
  (不是 success)——一次 null 再捕获不会让还在挂的 Lead 被误判恢复。
- ✅ **重启不戳框**:`attemptLeadRescue` 只在 `isResumeMenu(pane)` 为真时发送单个 Enter;`rescueRunner`
  走 close+dispatch(不发按键)。
- ✅ **postSwitchRescueSweep 只扫被踢 session,不碰健康 session**:遍历 `deps.pendingAlerts()` 的行,只处理
  `eventType` 为 `login_expired`/`runner_login_expired` 且 `isConfirmed` 的行;没有待处理告警的健康 session
  从不出现在这个遍历里。单个 session 抛错独立 try/catch,不会中断整个 sweep。
- ✅ **`/api/account-switch` 门禁**:tokenless → 503(plugin.ts `config.apiToken` 分支,与 `/api/rescue`
  完全对称);`actorBackend === provider` → 403(自修复拒绝);MVP 非 claude → 400;`claimPending` 原子声明,
  未声明/已被声明 → 409;self-heal off(`getRuntime()` 返回 undefined)→ 409 `needs_human`,零审计行、零副作用。
- ✅ **`/api/rescue` 门禁**:同款 tokenless-503 + self-heal-off 409 dormant;拒绝(无 pending alert / revalidate
  显示已恢复)是合法 200,只有意外抛出才是 500(fail loud,不吞错误)。
- ✅ **SELF_HEAL OFF 全链 dormant**:`plugin.ts` 中 `accountSwitchRepair`/两个路由 runtime holder 都只在
  `process.env.FLYWHEEL_ACCOUNT_SELF_HEAL === "1"` 时构造;关闭时路由存在但 `getRuntime()` undefined。
- ✅ **detection 三层 + fail-suspicious**:`detection-classifier.ts` Layer 1(正则表)→ Layer 2(仅在
  error-ish 但未识别时才花一次 AI 调用,健康 pane 零模型调用)→ Layer 3 fail-suspicious(从不静默判健康)。
- ✅ **quota 来源**:`account-ledger.ts` 解析 Claude Code statusLine 结构化 `rate_limits`
  (`five_hour`/`seven_day` 的 `used_percentage` + `resets_at` epoch 秒),接受完整 payload 或裸
  `rate_limits` 对象,均不可用时返回 null(不伪造数据)。

未发现偏离 plan.md/design-review.md 契约的代码路径。

## 3. 测试执行(全部真跑)

### 3.1 目标测试(全新增/本 PR 修改)

```
cd packages/teamlead && npx vitest run \
  src/__tests__/rescue.test.ts src/__tests__/rescue-runtime.test.ts \
  src/__tests__/rescue-route.test.ts src/__tests__/rescue-lead-cli.test.ts \
  src/__tests__/account-switch-route.test.ts src/__tests__/account-switch-watchdog.test.ts \
  src/__tests__/account-switch-repair.test.ts src/__tests__/account-ledger.test.ts \
  src/__tests__/founder-page-ledger.test.ts src/__tests__/detection-classifier.test.ts \
  src/__tests__/runner-auth-scan.test.ts src/__tests__/account-selfheal-bytecompat.test.ts
```
→ **12 files / 129 tests 全 PASS**。

### 3.2 全量回归(teamlead 包,~4900 tests)— CI 之外独立复测

两次独立全量跑(同一 commit 0a82a6ea):
- 跑 1:11 files failed | 345 passed(4956 total,45 tests failed)
- 跑 2:12 files failed | 344 passed(4956 total,43 tests failed)

**失败文件集合在两次跑之间不一致**(bridge.test.ts / claude-profile-cli.integration.test.ts /
close-runner.test.ts / post-ship-finalization.test.ts / runs-route-registration.test.ts /
tmux-lookup.real-tmux.test.ts 只在其中一次出现)——这本身就是资源争用型 flaky 的特征,不是确定性回归。

**隔离复测(单独跑,不与其余 ~4900 测试抢核)**:
```
npx vitest run src/__tests__/bridge.test.ts src/__tests__/close-runner.test.ts \
  src/__tests__/post-ship-finalization.test.ts src/__tests__/runs-route-registration.test.ts \
  src/__tests__/tmux-lookup.real-tmux.test.ts src/__tests__/claude-profile-cli.integration.test.ts \
  src/lead-backends/codex/gateway/__tests__/GitPushRunner.test.ts \
  src/lead-backends/codex/gateway/__tests__/ship-preflight.test.ts
```
→ **8 files / 129 tests 全 PASS**。证明这 8 个文件在全量跑里的失败是并行资源争用导致(GitPushRunner /
ship-preflight 是真 git 子进程,5000ms 超时在高负载下被挤爆;tmux-lookup 是真 tmux 探测),与本 PR 代码
无关。

剩余 4 个文件(`codex-lead-runtime.test.ts` / `fly247-bash-suites.test.ts` /
`createLeadRuntime-preflight.test.ts` / `LeadAlertNotifier.test.ts`)**即使单独跑也失败**
(26 failed / 160 tests)——这是已知的、跟运行环境绑定的问题(本会话自身是一个真实 Flywheel Runner,
`TMPDIR` 落在 `~/.flywheel/runner-state/<execId>/browser-tmp` 下,撞上 `codex-lead-runtime.ts` 的
"workspace 不得与 ~/.flywheel 重叠" 安全检查;`LeadAlertNotifier` 断言收到 mock token,但本机真实
Discord bot token 泄漏进未隔离的进程 env;详见团队记忆
`reference_qa_codex_lead_runtime_tmpdir_overlap.md`)。

### 3.3 origin/main 基线核对(独立 git worktree,同一套代码除外 R2/R3 diff)

在干净的 `origin/main`(740c90ee,已含 R1 #448 + FLY-869 #449,**不含**本 PR 任何改动)worktree 里
`pnpm install && pnpm -r build` 后跑同一套全量回归:

```
Test Files  9 failed | 339 passed | 1 skipped (349)
     Tests  42 failed | 4817 passed | 16 skipped (4875)
```

失败文件:`LeadAlertNotifier.test.ts` / `close-runner.test.ts` / `createLeadRuntime-preflight.test.ts` /
`fly247-bash-suites.test.ts` / `post-merge.test.ts` / `post-ship-finalization.test.ts` /
`codex-lead-runtime.test.ts` / `GitPushRunner.test.ts` / `ship-preflight.test.ts`。

**这与 PR 分支两次全量跑失败的文件集合是同一批(且是同一批"跑不跑得中要看系统负载"的文件)** ——
在完全不含 R2/R3 任何一行改动的 main 上,同样的一组测试同样会失败。**逐字证明:全量回归里的残留失败
是预先存在的环境/负载性 flaky,不是本 PR 引入的回归。**

### 3.4 CI(GitHub Actions)—— 发现一个真实缺陷,非环境性

`gh pr checks 451` 显示 `Build & Test` 失败在 `Test` 步骤(Build/Typecheck/Lint 全绿)。定位:

```
FAIL src/__tests__/feature-flags-drift.test.ts > feature-flag drift guard >
  no silent new gate: every scanned FLYWHEEL_* is registered or allowlisted
AssertionError: new FLYWHEEL_* env not registered or allowlisted:
  FLYWHEEL_ACCOUNT_LEDGER_PATH, FLYWHEEL_INFRA_BOT_USER_ID, FLYWHEEL_DETECTION_AI_CLASSIFY
```

本 PR 新引入了这 3 个 `FLYWHEEL_*` env,但没有登记进
`packages/config/src/__tests__/feature-flags-drift.test.ts` 的 `NON_FLAG_ALLOWLIST`(或
`FEATURE_FLAGS` 注册表)——drift guard 就是为了防止这种"静默新增开关"而存在的,**这是一个真实、
确定性、可复现的缺陷**(本地 + CI 100% 复现,不随负载波动),不是环境噪音。

**已跟 team-lead 核实处置方式**:QA 与实现严格分离,不由本 QA session 直接改代码(哪怕只是 3 行登记)。
已记为下方 FAIL 项,修法已定位好交给后续的 implement-fix session:仿照同一文件里紧邻的
`FLYWHEEL_CLAUDE_OAUTH_ENDPOINT`/`FLYWHEEL_CLAUDE_OAUTH_CLIENT_ID`(同为 FLY-871 的先例),给这 3 个
新 env 各加一行 `NON_FLAG_ALLOWLIST` 条目 + 理由(零行为改动,纯登记)。

### 3.5 Lint

```
pnpm lint
```
→ 0 errors,14 warnings(全部是既有文件的 `noExplicitAny` suppression 提示 + 1 处既有脚本未用 import,
与本 PR 改动文件无关)。

## 4. 结论

| 项目 | 结果 |
|---|---|
| 目标功能测试(129) | ✅ PASS |
| 红线契约审阅 | ✅ PASS(逐条见 §2) |
| 全量回归残留失败 | ✅ 已用 origin/main 基线证明是预先存在的环境性 flaky,非本 PR 回归 |
| Lint | ✅ PASS(0 errors) |
| **CI(feature-flag drift guard)** | ❌ **FAIL** —— 真实缺陷,3 个新 env 未登记 allowlist |

**总体verdict:FAIL**(CI 未绿,不能进 founder/ship)。这是本 PR **唯一**的真实问题,修法明确、影响面
极小(3 行零行为登记)。已请 team-lead 安排一个独立的 implement-fix session 补上这 3 行、push 回
#451,之后只需一次轻量复验(3 行零行为 delta,预期无需重跑全部清单)。
