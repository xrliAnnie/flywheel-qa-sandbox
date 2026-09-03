# FLY-2271 daemon 自动切号失败零证据 — 实施计划
Issue: FLY-2271 (https://linear.app/geoforge3d/issue/FLY-2271/切号器daemon-自动切号在-token-轮转后必失败委托模式对-stale-active-marker不修复直接-46)
日期: 2026-09-02
基于: research.md

> **For agentic workers:** 本 DAG implement node 按 Task 顺序 inline 执行,每个 Task 先写 RED 测试再最小实现,不派发 successor、review 或 QA node。Steps 使用 checkbox(`- [ ]`)语法追踪。Lead 裁定(2026-09-02,question `310f97fc`):A–E 全部纳入;Task 4(部署层 D)必须是**可摘除**的独立 lib + restart-services 里最小一处 hook,不碰 takeover/admission 段(与 FLY-2280 并行);台架必须包含「运行中 daemon 为旧码」一幕。

**Goal:** 让 quota-monitor 自动切号失败时**必留证据**(子进程 exit code、是否启动、stderr 标记行摘要进 `quota-monitor.log`、告警 body、状态文件与 bash 审计),把「委托子进程缺 atomic-apply marker」这一契约错配从 `active_marker_drift` 里分离出来单独分类,让 daemon 对真正的 marker drift 采用与手动 CLI 同一套一次性严格 `reconcile` + 重试(不加开关),并让部署波次重启仍在跑旧码的 daemon。隔离台架复现 token 轮转 / 真 drift / 旧 daemon 三场景的修前修后对照。

**Architecture:** bash 原语 `flywheel-claude-profile` 仍是唯一 Keychain 写者且 FLY-1201 的委托零 mutation 边界不变;它只把 `begin_audit` 提到 APPLY 门之前并给契约错配独立的 exit 48 + stderr 标记。Node adapter 在**每一种** typed error 上挂同一个已脱敏的子进程证据载体 `ApplyChildEvidence`,executor 把最后一次子进程的证据透传进每个终态 `SwitchResult`;daemon 直接消费该载体,**永不**从 `Error.message` 反解证据。daemon 在锁外用现有 `reconcileClaudeProfile`(改为结构化返回)做一次性 drift 修复后重读 snapshot 再重试恰好一次。部署层新增 source-only lib `restart-quota-monitor.sh`,只在 daemon health marker 的 `(pid, processStartTime)` 与活进程一致**且**其 `runtimeTreeSha256` 等于磁盘 dist 哈希时判定 `current`,否则 `kickstart -k`。

**Tech Stack:** Bash 3.2(macOS)、TypeScript 5 / Node 22、Vitest 3、pnpm monorepo、launchd、既有 `lead-alert.sh` strict delivery。

---

## 1. 稳定标识与显示标签(实现不得改名)

| 类型 | 值 | 消费者 |
|---|---|---|
| bash exit code | `48` = atomic-apply 契约错配(零 mutation) | Node adapter、审计 exit 行、台架 |
| bash stderr 标记 | `FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH` | Node adapter(execFile 以 signal 字符串返回 code 时的备份)、台架 |
| 审计 `probeSummary` | `atomic_apply_contract_mismatch` | 审计消费者、台架 |
| 子进程证据载体 | `ApplyChildEvidence { exitCode: number \| null; childStarted: boolean \| null; detail: string }`(detail 已脱敏、≤ 600 UTF-8 字节) | adapter → executor → daemon / CLI |
| Node error | `ApplyContractMismatchError`;所有 typed error 与兜底错误都带 `evidence: ApplyChildEvidence` | executor |
| `SwitchResult.failed.reasonCode` | `apply_contract_mismatch` | daemon、CLI、告警 body |
| `SwitchResult.applyEvidence?: ApplyChildEvidence` | 最后一次尝试的 profile 子进程证据;`failed` 与 `no_account` 终态都带 | daemon 日志/告警/state、CLI stderr |
| `SwitchResult.applyProfileChildStarted?` | 保留(FLY-2265 合同),取值 = `applyEvidence.childStarted ?? undefined` | 手动 CLI fallback 审计判定 |
| daemon 日志事件 | `account_switch_failed`、`account_switch_reconcile`(`trigger: drift_recovery \| witness`);JSON 里 `exitCode: number\|null`、`childStarted: boolean\|null` 保持原始类型 | 运维 grep、台架 |
| 告警 body 字段 | `reason=… ; degraded=… ; exit=<n\|none>; child=<started\|not_started\|unknown>; detail=<≤600B>`(label 只在告警文本渲染) | #alerts 读者 |
| state 键(三个可选) | `pendingSwitchFailure.applyExitCode?: number\|null`、`childStarted?: boolean\|null`、`detail?: string`(≤ 600 UTF-8 字节) | state parser、再告警 |
| episode 身份 | `reasonCode + degraded + applyExitCode + childStarted`;`detail` 变化只就地更新、**不**重置 realert 计时 | `openSwitchFailureEpisode` |
| daemon CLI flag | `flywheel-quota-monitor --runtime-tree-sha` | 部署 lib |
| 部署 lib 出参 | `QUOTA_MONITOR_RESTART_STATE ∈ current\|restarted\|planned\|not_loaded\|degraded\|unverifiable`,`QUOTA_MONITOR_RESTART_DETAIL` | restart-services 报告 |
| 部署 lib env seams(子进程测试用) | `FLYWHEEL_RQM_RUNTIME_SHA_BIN`、`FLYWHEEL_QUOTA_HEALTH_MARKER`(daemon 既有名)、`FLYWHEEL_QUOTA_PIDFILE`(daemon 既有名)、`FLYWHEEL_RQM_PS_BIN`、`FLYWHEEL_RQM_LAUNCHCTL_BIN` | `test-restart-services.sh` 假仓 |

**告警文案(founder 可读)**:`apply_contract_mismatch` 的 body 前缀固定为 `daemon runtime predates the switch script; restart quota-monitor (the deploy wave restarts it automatically once FLY-2271 Task 4 lands)`;`active_marker_drift` 经 reconcile 重试仍失败时 detail 前缀 `drift persisted after reconcile: `;reconcile 本身失败时 detail 前缀 `reconcile <outcome>: `。

**三个纯函数(都在 `apply-child-evidence.ts`,零 I/O)**:
- `redactSecrets(text)`:**非白名单**脱敏,用于任何面向操作者的文本:`sk-ant-[A-Za-z0-9_-]{8,}`、`Bearer\s+\S+`、`"?(accessToken|refreshToken|access_token|refresh_token)"?\s*[:=]\s*"?[^"\s,]+`、`(token|secret|password)=\S+` 一律替换为 `<redacted>`,并去除控制字符。
- `summarizeApplyFailure(rawStderr, fallbackMessage?)`:**只接受原始子进程 stderr**。(1) 只保留以 `FLYWHEEL_[A-Z_]+` 开头的行与第一条以 `Error:` 开头的行,以 ` | ` 连接;(2) 一行都没保留时(如 spawn ENOENT 没有 stderr)回落为 `redactSecrets("Error: " + fallbackMessage)`;(3) `redactSecrets`;(4) 按 UTF-8 字节截到 600,省略号 `…` 计入预算,不切断多字节字符。对已摘要过的输入幂等,用测试锁住。
- `formatFailureDetail(prefix, sanitizedDetail, maxBytes = 600)`:把**代码自有的**前缀(`drift persisted after reconcile: ` / `reconcile <outcome>: <reason>: `)与已脱敏的载体 detail 拼接,只做一次 UTF-8 字节截断(省略号计入)。前缀永不经过白名单(否则会被整段丢掉——Codex R2 #1)。**daemon** 用它组装最终 detail;手动 CLI 沿用 `manualFailureDetail(redactSecrets(...))` 与既有固定标记行(`FLYWHEEL_MANUAL_RECONCILE_FAILED` 等,FLY-2265 行为不变),不接 `formatFailureDetail`。

**reconcile 结果与进程状态的配对**(`ReconcileMachineResult.outcome`):`already_consistent|repaired` 仅当 exit 0 且 JSON 合法;`no_credential` 仅当 exit 10;`unresolvable` 仅当 exit 20;信号终止 / 非 0·10·20 的 exit / spawn 失败 → `execution_failed`(带 `exitCode: number|null`);exit 与声明的 outcome 不配对、或 JSON 不合法 → `malformed`。`detail` 永远是 `summarizeApplyFailure(stderr)`,成功也保留(`FLYWHEEL_STALE_ACTIVE_RECONCILED a b` 是有用证据)。

**模型上限(model-cap)路径的合同**:durable 的 `pendingSwitchFailure` episode **只服务账号额度触发**(现状不变);model-cap 分支仍是即时 `deps.alert`,但其日志与 body 同样必须带 `exit/child/detail`,并有测试。这一收窄写进 milestone 与 PR body。

**部署 lib 的 dry-run**:`DRY_RUN=true` 时允许只读的 `launchctl print`,零 mutating 动作;若判定需要重启,state 为 `planned`(新增,不冒充 `current`),detail 写明原因。

## 2. 文件边界

| 文件 | 动作 | 职责 |
|---|---|---|
| `packages/claude-runner/bin/flywheel-claude-profile` | 修改 | `begin_authenticated_switch_audit`:委托分支先 `begin_audit` 再检查 APPLY;缺失 → summary/marker/exit 48。其余行为逐字节不变 |
| `packages/claude-runner/test/claude-profile.test.ts` | 修改 | 48 契约测试、审计 entry/exit 断言、stderr 无 token 断言 |
| `packages/teamlead/src/account-heal/apply-child-evidence.ts` | 新建 | `ApplyChildEvidence`、`ReconcileMachineResult` 类型;`redactSecrets`、`summarizeApplyFailure`、`formatFailureDetail`;`childEvidenceFromError(err, stderr)`;零 I/O |
| `packages/teamlead/src/__tests__/apply-child-evidence.test.ts` | 新建 | 三个纯函数的保留/脱敏/截断/幂等/前缀用例 |
| `packages/teamlead/src/account-heal/switch-executor.ts` | 修改 | `ApplyContractMismatchError`;所有 typed error 带 `evidence`;reasonCode 联合;`SwitchResult.applyEvidence`;candidate loop 只在拿到真实载体时更新 `lastEvidence`,并在 19 处 `failed`/`no_account` 终态统一透传;`applyWithHeartbeat` 不再用新实例替换带证据的 `LockLeaseLostError`;成功的 `applyProfile` 返回 `evidence: {exitCode:0, childStarted:true, detail:""}` |
| `packages/teamlead/src/account-heal/claude-profile-cli.ts` | 修改 | catch 块新增 48/标记分支;每个 typed 分支经 `childEvidenceFromError` 挂证据;成功路径返回 evidence;`reconcileClaudeProfile` 分「执行 / 解析」两段并返回 `ReconcileMachineResult`(outcome 与 exit 配对) |
| `packages/teamlead/src/account-heal/account-switch-cli.ts` | 修改 | `deps.reconcile` 返回结构化结果,只看 `.ok`;失败行追加 `exit=<n>`;`manualFailureDetail` 的输出先过 `redactSecrets` 再进 stderr 与 fallback 审计;fallback 审计条件**不变**(`applyProfileChildStarted !== true`),只是现在拿到的是真值 |
| `packages/teamlead/src/account-heal/quota-monitor-state.ts` | 修改 | `PendingSwitchFailure` 三个可选证据字段,白名单 + parser |
| `packages/teamlead/src/account-heal/quota-monitor.ts` | 修改 | `QuotaMonitorDeps.reconcileMachine`;drift-recovery;结构化失败日志;告警 body 带证据;episode 身份规则 |
| `packages/teamlead/src/account-heal/quota-monitor-runtime.ts` | 修改 | 把 `reconcileMachine` 传进 deps;机器见证结果记 `account_switch_reconcile trigger=witness` |
| `packages/teamlead/src/account-heal/quota-monitor-cli.ts` | 修改 | `runtimeTreeShaCommand(argv, hash)` 可注入;入口早分支(不碰 pidfile/marker/wake) |
| `packages/teamlead/src/__tests__/{claude-profile-cli,switch-executor,account-switch-cli,quota-monitor,quota-monitor-idle-e2e,quota-monitor-state,quota-monitor-runtime,quota-monitor-cli}.test.ts` | 修改 | 对应用例;`quota-monitor-idle-e2e` 只补 `reconcileMachine` 桩(它也构造 `QuotaMonitorDeps`) |
| `scripts/lib/restart-quota-monitor.sh` | 新建(Task 4,可摘除) | source-only 状态机 + seams |
| `scripts/__tests__/restart-quota-monitor.test.sh` | 新建(Task 4) | seam 脚本化的合同测试;登记进 `.github/workflows/ci.yml` |
| `scripts/restart-services.sh` | 修改(Task 4,最小) | source 新 lib;`converge_nonlead_daemons` 之后一处调用 + WARNING/alert_warning |
| `scripts/test-restart-services.sh` | 修改(Task 4) | 假仓 cp 列表加入新 lib(否则 source 失败) |
| `scripts/qa-fly-2271-switch-evidence-e2e.sh` | 新建(Task 5) | 三场景隔离台架,含「旧 daemon 真实运行」一幕 |
| `engineering/doc/FLY-2271-daemon-switch-evidence/evidence/` | 新建(Task 5) | 台架产出的对照表与日志摘录 |
| `engineering/doc/milestones/FLY-2271.md` | 新建(Task 6) | PR literal last commit |

**不碰**:`reconcile_stale_active_locked` 及 FLY-1201 三档语义;`applyFailureDiagnostic` 截断策略、`manual-switch-audit.ts` 与 CLI 的 fallback 审计条件(FLY-2265);`quota-monitor-alert.ts` 路由表;restart-services 的 takeover/admission/build 段;候选选择、Keychain 写、CAS、通知 outbox。

**founder 轮换规则的归属(Lead 2026-09-02 对账,明确写出,不静默略过)**:founder 9-1 12:54 的规则「剩下所有能用的号里选 reset 最早的」**不由本单实现,已由 FLY-2240(#1027)承接**:`packages/teamlead/src/account-heal/account-candidate-selector.ts` 的 `verifyAndRankCandidates` 对 live 验证通过的候选按有效 weekly reset(`sevenD.resetsAt`,缺失时用账本观测值,未知排最后)升序排列(`rank()`,L142-146),并按 `headroomPolicy` 优先 5h 未到 trigger 的账号、全部越线时降级并标 `headroomDegraded`(FLY-2240 milestone 已记录)。本单**范围外、零改动**:daemon 与手动 CLI 的候选顺序仍完全来自该 selector;Task 3 的 drift 重试只是在 reconcile 后从**同一批已排序候选**里过滤掉新的 active,不重排、不新增选择逻辑。若 founder 规则未来要变(例如加权 5h/7d),由 FLY-2240 的 selector 单独立单承接。

## 3. 回滚边界与迁移

- 每个 Task 一个 commit,可独立 revert。bash 与 Node 的顺序无关:旧 daemon 遇新 bash 的 48 → 走既有兜底 `apply_failed`(仍 fail-closed);新 daemon 遇旧 bash 永远收不到 48。
- state:三个可选键,不升 `version`;旧 state 缺键解析为 `undefined`;回滚后新键被严格 parser 拒 → 整份 state 回落默认(既有行为,只丢 episode 计数,不丢账号真相)。Task 3 的 revert 说明里写明这一点。
- 部署 lib 回滚 = 删除 hook 一段 + lib 文件;daemon 仍按 KeepAlive 运行。
- 审计日志:48 的 entry/exit 是新增行,不改既有行格式。

## 4. 负向守卫(每条都有测试)

1. stderr、detail、state、告警 **不含 token 字节**:bash 测试用 fake keychain 值断言;Node 测试向 stderr 注入伪 `sk-ant-…`、`Bearer …`、`"accessToken":"…"` 三种形态,断言摘要、日志、state、body 都不含。
2. drift-recovery **最多一次** reconcile、**最多一次**重试;第二次 drift 不再 reconcile。
3. `apply_contract_mismatch` **不**触发 reconcile、不轮候选、不标记账号。
4. reconcile 只在 executor 返回后(锁外)调用;测试用 `lockDepth` 断言为 0。
5. 证据贯穿:真实形态的 exit-48 子进程错误 → adapter → 真 executor → daemon poll,标记行必须出现在日志、persisted episode 与告警 body 三处(集成测试)。
6. 部署 lib:marker 三元组 `(runtimeTreeSha256, pid, processStartTime)` 与活进程 + 磁盘哈希全部一致才 `current`;marker 缺失/不安全/pid 不符/启动时间不符/哈希不符 一律重启;job 不在域 → `not_loaded` 且不 bootstrap;`kickstart -k` 后 30s 内 pid 或启动时间未变 → `degraded`,不阻断部署;`DRY_RUN=true` 时零 mutating 动作(只读 `print` 允许)且需要重启时 state=`planned`。
7. 部署 lib 在调用方的 `set -euo pipefail` 下**任何输入**(pidfile/marker 缺失、畸形、symlink、他人所有、读失败、`ps` 失败)都 `return 0` 并给出真实 state;库测试本身以 `set -euo pipefail` 运行。
8. 台架任一断言失败 exit 1;基线与旧 daemon 各用**独立 detached worktree** 构建;每个 `{场景, 版本, 入口路径}` 组合用独立 scratch fixture(从不可变种子复制),互不污染;旧 daemon 一幕触发前先断言活 pidfile/health marker 记的是旧 pid 与旧哈希且 ≠ 当前磁盘哈希。
9. 手动 CLI 的 stderr 与 fallback 审计文本经 `redactSecrets`;daemon drift 重试不丢第一次尝试的 `applyReports`。

---

## Task 1: bash — 契约错配审计前置与独立 exit 48

**Files:**
- Modify: `packages/claude-runner/test/claude-profile.test.ts`
- Modify: `packages/claude-runner/bin/flywheel-claude-profile`

- [ ] **Step 1: 写失败测试**

新 `describe("FLY-2271 atomic-apply contract mismatch")`:用 `seedCoherentActive("personal")` + 真 holder marker,调用 `spawnAuthenticatedPrimitiveSync(["use","school"], {FLYWHEEL_CLAUDE_LOCK_DELEGATED: String(process.pid), FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: syncingQuotaStub()})`——**不传** `FLYWHEEL_ATOMIC_SWITCH_APPLY`。断言:

```ts
expect(result.status).toBe(48);
expect(String(result.stderr)).toContain("FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH");
expect(String(result.stderr)).toContain("restart the quota-monitor daemon");
expect(String(result.stderr)).not.toContain("FLYWHEEL_STALE_ACTIVE");
const lines = readFileSync(auditLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
expect(lines.map((l) => [l.cmd, l.phase, l.exitCode, l.probeSummary])).toEqual([
  ["use", "entry", null, "identity_check_pending"],
  ["use", "exit", 48, "atomic_apply_contract_mismatch"],
]);
expect(lines[1].details.reason).toMatch(/FLYWHEEL_ATOMIC_SWITCH_APPLY=1/);
// 零 mutation
expect(readFileSync(stateFile, "utf-8")).toBe(<seed 时的 live 值>);
expect(readFileSync(join(pool, ".active"), "utf-8")).toBe("personal");
expect(readFileSync(accountsStore)).toEqual(beforeStore);
// 红线:stderr 与审计文件不含 live token 字节
expect(String(result.stderr)).not.toContain(<live accessToken 字节>);
expect(readFileSync(auditLog, "utf8")).not.toContain(<live accessToken 字节>);
```

再给既有「delegated mode detects true marker drift but performs zero repair mutation」补两条断言:审计恰好 entry + exit(46, `stale_active_unresolvable`),stderr 不含 live token。这条现在就应 GREEN,作为顺序不变的对照。

- [ ] **Step 2: 运行并确认 RED**

```bash
pnpm --filter flywheel-claude-runner exec vitest run test/claude-profile.test.ts -t "contract mismatch"
```

Expected: FAIL,status 为 46 且审计文件为空(或不存在)。

- [ ] **Step 3: 最小实现**

`begin_authenticated_switch_audit` 委托分支改为:

```bash
	if [[ "$command" == "use" && "${FLYWHEEL_ATOMIC_SWITCH_AUDIT_CMD:-}" == "next" ]]; then
		AUDIT_DETAILS_JSON='{"selectedBy":"atomic-cli"}'
		begin_audit next "$target" identity_check_pending
	else
		begin_audit "$command" "$target" identity_check_pending
	fi
	if [[ "${FLYWHEEL_ATOMIC_SWITCH_APPLY:-}" != "1" ]]; then
		AUDIT_SUMMARY="atomic_apply_contract_mismatch"
		echo "FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH" >&2
		fail_code 48 "delegated profile mutation requires FLYWHEEL_ATOMIC_SWITCH_APPLY=1; the parent runtime predates the atomic-apply contract — restart the quota-monitor daemon"
	fi
```

把 L142 的 FLY-871 注释(现列 30/31)扩一句:`48 = atomic-apply contract mismatch (FLY-2271)`。脚本没有统一的 exit code 表,不新造。不改任何其他函数。

- [ ] **Step 4: 运行并确认 GREEN**

```bash
pnpm --filter flywheel-claude-runner exec vitest run test/claude-profile.test.ts
```

Expected: 全文件 PASS(含 FLY-2240 的 forged-delegation、FLY-1201 三档、`spawnManualSwitchWithReconcile` 路径)。

- [ ] **Step 5: 提交**

```bash
git add packages/claude-runner/bin/flywheel-claude-profile packages/claude-runner/test/claude-profile.test.ts
git commit -m "fix(FLY-2271): audit and classify atomic-apply contract mismatch"
```

## Task 2: Node — 子进程证据载体、契约错配错误、结构化 reconcile

**Files:**
- Create: `packages/teamlead/src/account-heal/apply-child-evidence.ts`
- Create: `packages/teamlead/src/__tests__/apply-child-evidence.test.ts`
- Modify: `packages/teamlead/src/account-heal/switch-executor.ts`
- Modify: `packages/teamlead/src/account-heal/claude-profile-cli.ts`
- Modify: `packages/teamlead/src/account-heal/account-switch-cli.ts`
- Modify: `packages/teamlead/src/__tests__/claude-profile-cli.test.ts`、`switch-executor.test.ts`、`account-switch-cli.test.ts`

- [ ] **Step 1: 写失败测试**

`apply-child-evidence.test.ts`:
- `redactSecrets`:`sk-ant-oat01-FAKE…`、`Bearer abc.def`、`"accessToken":"xyz"`、`refresh_token=…`、`password=…` 全部变 `<redacted>`,控制字符去除,普通文本原样。
- `summarizeApplyFailure("noise\nFLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH\nError: delegated … sk-ant-oat01-FAKE\nRecovery: …")` → `"FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH | Error: delegated … <redacted>"`;超过 600 字节按 UTF-8 尾截且 `…` 计入预算、不切断多字节;空 stderr 且无 fallback → `""`;空 stderr + `fallbackMessage:"spawn flywheel-claude-profile ENOENT"` → `"Error: spawn flywheel-claude-profile ENOENT"`;**幂等**:`summarize(summarize(x)) === summarize(x)`。
- `formatFailureDetail("drift persisted after reconcile: ", "FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE personal")` → 前缀**保留**;`formatFailureDetail("reconcile unresolvable: anchor_ambiguous: ", r.detail)` 同;总长按 UTF-8 截到 600 含 `…`;空前缀恒等。
- `childEvidenceFromError({code: 48, stderr, profileChildStarted: true})` → `{exitCode: 48, childStarted: true, detail: <summary>}`;`code: "SIGTERM"` → `exitCode: null`;缺 `profileChildStarted` → `childStarted: null`;spawn ENOENT(无 stderr、`profileChildStarted:false`)→ `detail: "Error: spawn flywheel-claude-profile ENOENT"`(回落自 `error.message`,经脱敏)。

`claude-profile-cli.test.ts`:
- `it.each([48])` 与 `code:"SIGTERM"+stderr 含标记` → `ApplyContractMismatchError`,`.evidence` 为 `{48|null, childStarted, detail 含标记}`;分类先于 46/47 与 `FLYWHEEL_TARGET_IDENTITY_MISMATCH`。
- 46/47 → `ActiveMarkerDriftError.evidence.exitCode === code`;message 仍是 `errText.trim()`(FLY-1201 既有合同)。
- 30/31/32/34/36/37/38/39 与兜底错误(FLY-2265 `applyFailureDiagnostic`)都带 `evidence`;兜底错误保留 `profileChildStarted`。
- `reconcileClaudeProfile`(分执行/解析两段,outcome 与 exit 配对):execFile 成功 + stdout `{"outcome":"repaired","from":"a","to":"b"}` + stderr 含 `FLYWHEEL_STALE_ACTIVE_RECONCILED a b` → `{ok:true, outcome:"repaired", from:"a", to:"b", exitCode:0, detail:"FLYWHEEL_STALE_ACTIVE_RECONCILED a b"}`(**成功也要捕获 stderr**);`already_consistent` → ok;exit 0 但 stdout 非 JSON → `{ok:false, outcome:"malformed", exitCode:0}`;抛 `{code:10, stdout:'{"outcome":"no_credential"}'}` → `outcome:"no_credential", exitCode:10`;`{code:20, stdout:'{"outcome":"unresolvable","reason":"anchor_ambiguous"}'}` → `reason:"anchor_ambiguous"`;**配对错误**(exit 0 却声明 `unresolvable`、exit 20 却声明 `repaired`)→ `malformed`;`code:"SIGTERM"`(无合法 JSON)→ `{outcome:"execution_failed", exitCode:null}`;exit 1 → `execution_failed, exitCode:1`;spawn ENOENT(无 stdout)→ `outcome:"execution_failed", exitCode:null, detail:"Error: spawn … ENOENT"`;未知 outcome 字符串 / 超长(>256)`from|to|reason` / 非法 label → `outcome:"malformed"`。

`switch-executor.test.ts`:
- applyProfile 抛 `new ApplyContractMismatchError("…", {exitCode:48, childStarted:true, detail:"FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH | Error: …"})` → `{outcome:"failed", reasonCode:"apply_contract_mismatch", applyEvidence:{…同上}, applyProfileChildStarted:true}`,`applyProfile` 恰好 1 次,store 不变、无账号被标记。
- 抛 `ActiveMarkerDriftError` 带 evidence → `applyEvidence.exitCode: 46`。
- 候选循环:第一候选 `TargetStaleError`(evidence exit 30)、第二候选 `TargetQuotaExhaustedError`(evidence exit 32)→ `no_account` 且 `applyEvidence.exitCode === 32`(最后一次)。
- **exit 39 保留证据**:applyProfile 抛带 `evidence:{exitCode:39,…}` 的 `LockLeaseLostError` → `failed/lock_lease_lost` 且 `applyEvidence.exitCode === 39`(`applyWithHeartbeat` 不得用无证据的新实例替换)。
- **子进程成功后 fence 失败**:applyProfile resolve `{identitySynced:true, identityChecks:[], evidence:{exitCode:0, childStarted:true, detail:""}}` 但 `validateLease` 返回 false → `failed/lock_lease_lost` 且 `applyEvidence` 为该成功载体。
- 抛没有 `evidence` 的普通 `Error` 时,先前候选留下的真实载体不被全 null 的合成值覆盖(`lastEvidence` 只在 catch 到真实载体时更新;若从未有过载体则为 `undefined`)。

`account-switch-cli.test.ts`:
- harness 的 `reconcile` 改为返回 `{ok:true, …}` / `{ok:false, …}`;既有两条 drift 用例断言不变。
- 新增:`failed/apply_contract_mismatch, applyEvidence:{exitCode:48, childStarted:true, …}, applyProfileChildStarted:true` → rc 1,stderr 行 `FLYWHEEL_MANUAL_SWITCH_FAILED reason=apply_contract_mismatch exit=48 details=…`,`reconcile` **未**被调用,`auditFailure` **未**被调用(bash 已写 entry/exit 对)。
- 对照:`apply_failed, applyProfileChildStarted:false`(ENOENT)→ `auditFailure` 被调用(FLY-2265 行为不变)。
- **脱敏**:`reason` 含 `sk-ant-oat01-FAKE`、`Bearer x.y`、`"accessToken":"z"`、`token=q` 四种形态 → stderr 行与 `auditFailure` 收到的 `reason` 都不含原文、含 `<redacted>`;**截断边界**:`reason` 超过 2048 字节且 `Bearer ` 前缀恰落在被截掉的窗口外、secret 尾巴落在保留窗口内 → 输出仍不含该尾巴(证明脱敏在截断之前)。
- **no_account 也带 exit**:`{outcome:"no_account", reasonCode:"target_quota_exhausted", earliestReset:null, applyEvidence:{exitCode:32, childStarted:true, detail:"FLYWHEEL_TARGET_QUOTA_EXHAUSTED school"}}` → rc 32,stderr 含 `FLYWHEEL_MANUAL_SWITCH_FAILED reason=target_quota_exhausted exit=32`。
- **reconcile reason 枚举**:`deps.reconcile` 返回 `outcome:"unresolvable", reason:"anchor_ambiguous"` → 既有 `FLYWHEEL_MANUAL_RECONCILE_FAILED` 行为不变;adapter 测试里 `reason:"sk-ant-oat01-FAKE"`(非枚举)→ `malformed`。

- [ ] **Step 2: 运行并确认 RED**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/apply-child-evidence.test.ts src/__tests__/claude-profile-cli.test.ts src/__tests__/switch-executor.test.ts src/__tests__/account-switch-cli.test.ts
```

Expected: FAIL(模块不存在 / 类型不存在 / reconcile 返回 boolean)。

- [ ] **Step 3: 最小实现**

`apply-child-evidence.ts`:
```ts
export interface ApplyChildEvidence { exitCode: number | null; childStarted: boolean | null; detail: string }
export interface ReconcileMachineResult { ok: boolean; outcome: "already_consistent"|"repaired"|"no_credential"|"unresolvable"|"malformed"|"execution_failed"; from?: string; to?: string; reason?: string; exitCode: number | null; detail: string }
export function redactSecrets(text: string): string;                                      // 规则见 §1
export function summarizeApplyFailure(stderr: string, fallbackMessage?: string, maxBytes = 600): string;
export function formatFailureDetail(prefix: string, sanitizedDetail: string, maxBytes = 600): string;
export function childEvidenceFromError(error: unknown, stderr: string): ApplyChildEvidence;   // detail = summarizeApplyFailure(stderr, error.message)
```
`switch-executor.ts` 的 `applyWithHeartbeat`(L619/634/640 现各 `new LockLeaseLostError(lockPath)`):若被包装的错误已是带 `evidence` 的 `LockLeaseLostError`,原样抛出;`applyProfile` 成功返回值增加可选 `evidence`,post-child fence 失败时把它作为 `applyEvidence` 透传。

`switch-executor.ts`:
```ts
export class ApplyContractMismatchError extends Error {
  constructor(detail: string | undefined, public readonly evidence: ApplyChildEvidence) {
    super(`profile child rejected the atomic-apply contract (daemon runtime predates the switch script)${detail ? `: ${detail}` : ""}`);
    this.name = "ApplyContractMismatchError";
  }
}
// 其余 typed error 各加 `public readonly evidence?: ApplyChildEvidence`(可选,构造签名尾部追加,不破坏既有调用)
// reasonCode 联合加 "apply_contract_mismatch"
// SwitchResult 加 applyEvidence?: ApplyChildEvidence
// 类型守卫(executor 内唯一读取证据的方式;childEvidenceFromError 只在 adapter 边界使用):
function evidenceOf(error: unknown): ApplyChildEvidence | undefined { /* error?.evidence 形状合法才返回,否则 undefined */ }
// candidate loop:每次 catch `const ev = evidenceOf(err); if (ev) lastEvidence = ev;`(普通 Error 不覆盖已有载体)
// applyProfile 成功:`const ok = await deps.applyProfile(...); if (ok?.evidence) lastEvidence = ok.evidence;` 在 post-child fence 检查之前记录
// applyWithHeartbeat:heartbeat 丢失时若被包装的子进程错误带 evidence(任何 typed error,不只 LockLeaseLostError),
//   抛出的父级 LockLeaseLostError 附同一 evidence;已是带 evidence 的 LockLeaseLostError 原样抛出
// withReports 扩为 withReports(outcome, reports, lastEvidence):19 处 failed/no_account 终态统一带 applyEvidence 与 applyProfileChildStarted
```

`claude-profile-cli.ts` catch 块:`const evidence = childEvidenceFromError(err, errText)`;在 46/47 分支之前:
```ts
if (e.code === 48 || /FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH/.test(errText)) {
  throw new ApplyContractMismatchError(evidence.detail || undefined, evidence);
}
```
每个既有 typed 分支把 `evidence` 传入;兜底 `Object.assign(applyFailureDiagnostic(err, errText), { evidence })`。

`reconcileClaudeProfile`:第一段 `execute` 返回 `{stdout, stderr, exitCode: number|null, spawnFailed: boolean, message}`(成功与失败都收 stderr);第二段 `parse` 纯函数:先按 exit 分档(0 → 期望 `already_consistent|repaired`;10 → `no_credential`;20 → `unresolvable`;其他/null/spawnFailed → `execution_failed`),再校验 JSON(`outcome` 与档位配对、`from/to` 满足 `PROFILE_LABEL`、`reason` ≤ 256 且无控制字符),不配对或不合法 → `malformed`;`detail = summarizeApplyFailure(stderr, message)`。成功路径 `applyProfile` 返回 `{identitySynced, identityChecks, freshened?, evidence:{exitCode:0, childStarted:true, detail:""}}`。

`account-switch-cli.ts`:`reconcile: () => Promise<ReconcileMachineResult>`;drift 分支 `if (!(await deps.reconcile()).ok)`;`const detail = manualFailureDetail(redactSecrets(result.reason))`(**先脱敏再截断**,否则截断可能只剩 secret 尾巴让脱敏器认不出)同时用于 stderr 行与 `auditFailure.reason`;终态失败行统一由一个 `formatManualFailureLine(result)` 生成:`failed` 与 `no_account` 都在 `applyEvidence?.exitCode` 为数字时插入 ` exit=<n>`(`no_account` 行形如 `FLYWHEEL_MANUAL_SWITCH_FAILED reason=target_quota_exhausted exit=32`)。fallback 审计条件保持 `result.applyProfileChildStarted !== true`;`applyFailureDiagnostic` 本身不动。

`reconcileClaudeProfile` 的 `parse` 对 `reason` 只接受 bash 实际会发出的有限集合 `{keychain_unreadable, probe_unavailable, anchor_ambiguous}`(`fail_live_identity` 的第二参数),其他值 → `malformed`;因此进入 `formatFailureDetail` 前缀的 `reason` 永远是枚举值,不需要再脱敏(`r.detail` 已由 `summarizeApplyFailure` 脱敏)。

- [ ] **Step 4: 运行并确认 GREEN**

重复 Step 2,再跑 `pnpm --filter flywheel-teamlead exec tsc --noEmit -p .`。Expected: 全 PASS、零类型错误。

- [ ] **Step 5: 提交**

```bash
git add packages/teamlead/src/account-heal/apply-child-evidence.ts packages/teamlead/src/account-heal/switch-executor.ts packages/teamlead/src/account-heal/claude-profile-cli.ts packages/teamlead/src/account-heal/account-switch-cli.ts packages/teamlead/src/__tests__/apply-child-evidence.test.ts packages/teamlead/src/__tests__/claude-profile-cli.test.ts packages/teamlead/src/__tests__/switch-executor.test.ts packages/teamlead/src/__tests__/account-switch-cli.test.ts
git commit -m "feat(FLY-2271): carry profile child evidence through typed switch results"
```

## Task 3: daemon — 证据落盘、告警带证据、一次性 reconcile + 重试

**Files:**
- Modify: `packages/teamlead/src/account-heal/quota-monitor-state.ts`、`quota-monitor.ts`、`quota-monitor-runtime.ts`
- Modify: `packages/teamlead/src/__tests__/quota-monitor-state.test.ts`、`quota-monitor.test.ts`、`quota-monitor-idle-e2e.test.ts`、`quota-monitor-runtime.test.ts`

- [ ] **Step 1: 写失败测试**

`quota-monitor-state.test.ts`:
- `pendingSwitchFailure` 带 `applyExitCode: 48, childStarted: true, detail: "FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH | Error: …"` round-trip 保留;三键缺失 → `undefined`;`applyExitCode: null` / `childStarted: null` 合法;`detail` 601 字节、含控制字符、或含孤立代理项(`"\ud800"`,JSON 解析后仍是不合法字符串,`Buffer.from(s,"utf8").toString() !== s` 可检出)→ 整份 parse 走既有「无效 → 默认 state」路径;legacy 无 `pendingSwitchFailure` 用例不变。(文件级非法 UTF-8 字节在 `readFileSync(...,"utf8")` 阶段就被替换,不在本 parser 的职责内。)

`quota-monitor.test.ts`(harness 加 `reconcileMachine: vi.fn()`,默认 `{ok:true, outcome:"already_consistent", exitCode:0, detail:""}`;`quota-monitor-idle-e2e.test.ts` 的 deps 加同款桩):
1. **契约错配证据**:`switchImpl` 返回 `{failed, reason:"…", reasonCode:"apply_contract_mismatch", applyEvidence:{exitCode:48, childStarted:true, detail:"FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH | Error: delegated profile mutation requires …"}, applyProfileChildStarted:true}`。断言 `outcome=switch_failed`;`log` 收到 JSON `{event:"account_switch_failed", trigger:{kind:"quota",scope:"5h"}, reasonCode, exitCode:48, childStarted:true, detail}`(布尔/数字原型);告警 body 精确等于 `daemon runtime predates the switch script; restart quota-monitor (the deploy wave restarts it automatically once FLY-2271 Task 4 lands)\nreason=apply_contract_mismatch; degraded=false; exit=48; child=started; detail=FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH | Error: delegated profile mutation requires …`;`reconcileMachine` **未**调用;persisted 的 `pendingSwitchFailure` 三字段与日志一致。
2. **贯穿集成**(负向守卫 5):不用 `switchImpl` 桩,改用真 `switchAccount` + `makeClaudeProfileSwitchDeps({execFile: 注入抛 {code:48, stderr:"FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH\nError: delegated …", profileChildStarted:true}})` + 临时 store/lock,跑 `pollOnce`;断言标记行同时出现在 `log`、persisted state、告警 body。
3. **drift 一次修复后成功**:`switchImpl` 第一次 `{failed, active_marker_drift, applyEvidence:{46,true,"FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE personal"}}`、第二次 `switched`。`reconcileMachine` 返回 `{ok:true, outcome:"repaired", from:"shopping", to:"business", exitCode:0, detail:"FLYWHEEL_STALE_ACTIVE_RECONCILED shopping business"}`;harness 在 reconcile 时把 `activeName="business"`、`generation+=1`。断言:`reconcileMachine` 1 次且调用时 `lockDepth===0`;`events` 顺序 `switch:…` → `lock:start` → `lock:end` → `switch:…`(第二次 input `observedAccount==="business"`、`observedGeneration` 新值、`preferredOrder` 不含 `business`);`log` 含 `{event:"account_switch_reconcile", trigger:"drift_recovery", outcome:"repaired", from, to, exitCode:0, detail}`;最终 `outcome=switched`,无 `account_switch_failed` 告警。
4. **drift 持续**:两次都 drift → `switchImpl` 恰好 2 次、`reconcileMachine` 恰好 1 次、`switch_failed`,detail 以 `drift persisted after reconcile: ` 开头,`exit=46`。
5. **reconcile 失败**:`{ok:false, outcome:"unresolvable", reason:"anchor_ambiguous", exitCode:20, detail:""}` → `switchImpl` 1 次、`switch_failed`、detail 以 `reconcile unresolvable: anchor_ambiguous: ` 开头。
6. **重试后 active 即唯一候选**:reconcile 后 `activeName` 变成 `preferredOrder[0]` → 不再调 `switchImpl`,`outcome=noop_already_switched`,`pendingSwitchFailure` 清空。
7. **episode 身份**:同 reasonCode/degraded/exit/child、detail 不同的两次失败 → 同一 episode(`startedAt` 不变、`alertCount` 不重置),persisted `detail` 更新为最新;`applyExitCode` 变化 → 新 episode。再告警(`episodeRealertMinutes` 后)body 使用最新 detail。
8. **红线**:`applyEvidence.detail` 已脱敏是上游职责,但 daemon 侧再断言:`reason` 里塞 `sk-ant-oat01-FAKETOKEN` 时日志与 body 不含它(daemon 不使用 `reason`)。
9. 既有 `maps typed switch exhaustion …`:`no_account` 路径 body 追加 `exit=none; child=unknown; detail=`(`applyEvidence` 缺失时),仍 `toContain("freshness_unavailable")` 等——按新格式更新断言。
10. **applyReports 不丢**:第一次 `switchImpl` 返回 drift 且 `applyReports:[{identityChecks:[{label:"school", checkpoint:"pre_write", verdict:"mismatch", expectedKey:<64hex>, actualDigest:<64hex>}], freshened:{name:"shopping", identityProof:{email,uuid}}}]`(真实 `ApplyProfileReport` 形状,`consumeApplyIdentityReports` 要求 mismatch 同时带 `expectedKey` 与 `actualDigest`),reconcile 成功后第二次返回 `switched`(用例 A)或 active 即唯一候选 → noop(用例 B)→ 两个用例都断言 `identityMismatchEpisodes` 含 school,且 `freshened` 事实被消费。`mergeApplyReports(a, b)` 保留每份 report 的 `freshened`,`identityChecks` 按 `(label, checkpoint, verdict, expectedKey, actualDigest)` 全字段去重。
11. **model-cap 路径**:model 触发下 `switchImpl` 返回 `failed/apply_contract_mismatch` 带 evidence → `log` 有 `account_switch_failed`(`trigger:{kind:"model",models}`、`exitCode:48`、`childStarted:true`、`detail`),即时告警 body 含 `exit=48; child=started; detail=…`;`pendingSwitchFailure` 保持 `null`(合同收窄:durable episode 只服务账号额度触发)。

`quota-monitor-runtime.test.ts`:
- 注入 `reconcileMachine` 返回 `{ok:true, outcome:"repaired", …}` 且机器见证判 `needsReconcile` → `log` 收到 `{event:"account_switch_reconcile", trigger:"witness", outcome:"repaired", …}`;`ok:false` 时保留既有 `could not reconcile` 文案 + 同事件。
- 断言 drift 时 `pollOnce` 通过 deps 调用了 `reconcileMachine`(注入 `switchAccount` 返回 drift 一次)。

- [ ] **Step 2: 运行并确认 RED**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/quota-monitor-state.test.ts src/__tests__/quota-monitor.test.ts src/__tests__/quota-monitor-idle-e2e.test.ts src/__tests__/quota-monitor-runtime.test.ts
```

Expected: FAIL(deps 缺 `reconcileMachine` 类型错误 / body 不含 exit / 新键被 parser 拒)。

- [ ] **Step 3: 最小实现**

`quota-monitor-state.ts`:接口加 `applyExitCode?: number | null; childStarted?: boolean | null; detail?: string`;`SWITCH_FAILURE_KEYS` 加三键;parser:各键 `undefined` 合法;`applyExitCode` 为 `null` 或整数;`childStarted` 为 `null` 或布尔;`detail` 为 string、`Buffer.byteLength ≤ 600`、无控制字符、`Buffer.from(detail,"utf8").toString() === detail`;否则返回 `undefined`。写入前由 daemon 侧 `summarizeApplyFailure` 保证已截断。

`quota-monitor.ts`:
- `QuotaMonitorDeps.reconcileMachine: () => Promise<ReconcileMachineResult>`。
- 内部 `attemptSwitchWithDriftRecovery(deps, input, preferredOrder)`:
  ```ts
  const first = await deps.switchAccount(input);
  let switched = first;
  let detailPrefix = "";
  if (first.outcome === "failed" && first.reasonCode === "active_marker_drift") {
    const r = await deps.reconcileMachine();                      // 锁外
    deps.log(JSON.stringify({ event: "account_switch_reconcile", trigger: "drift_recovery", ...r }));
    if (r.ok) {
      const fresh = await deps.withAccountsLock(() => deps.readSnapshot());
      const order = preferredOrder.filter((n) => n !== fresh.activeName);
      if (fresh.activeName !== null && order.length === 0) {
        switched = { outcome: "noop_already_switched", activeAccount: fresh.activeName };
      } else {
        switched = await deps.switchAccount({ ...input, observedAccount: fresh.activeName ?? "", observedGeneration: fresh.store.generation, preferredOrder: order });
        if (switched.outcome === "failed" && switched.reasonCode === "active_marker_drift") detailPrefix = "drift persisted after reconcile: ";
      }
    } else {
      detailPrefix = `reconcile ${r.outcome}${r.reason ? `: ${r.reason}` : ""}${r.detail ? `: ${r.detail}` : ""}: `;
    }
  }
  // 两次尝试的 applyReports 合并:每份 report 的 freshened 原样保留,identityChecks 按全字段去重,第一次的身份证据不丢
  return { switched: { ...switched, applyReports: mergeApplyReports(first.applyReports, switched.applyReports) }, detailPrefix };
  ```
- 失败分支(L1531):`const ev = switched.applyEvidence`;`const detail = formatFailureDetail(detailPrefix, ev?.detail ?? "")`(前缀不过白名单;≤ 600);`deps.log(JSON.stringify({event:"account_switch_failed", trigger, reasonCode, exitCode: ev?.exitCode ?? null, childStarted: ev?.childStarted ?? null, detail}))`;账号额度触发 → `openSwitchFailureEpisode(deps, state, reasonCode, false, attemptedKinds, {applyExitCode, childStarted, detail})`;model-cap 分支保持即时 `deps.alert`,其 body 追加同一格式的 `exit/child/detail`(不开 durable episode——合同收窄见 §1)。
- `openSwitchFailureEpisode`:新 episode 判定 = `reasonCode || degraded || applyExitCode || childStarted` 任一不同;相同则 `episode.detail = detail`(就地更新,不动 `startedAt/alertCount/activeDelivery`)。
- `attemptSwitchFailureDelivery`:`body = [prefixFor(reasonCode), `reason=${reasonCode}; degraded=${degraded}; exit=${applyExitCode ?? "none"}; child=${label(childStarted)}; detail=${detail ?? ""}`].filter(Boolean).join("\n")`,`label: true→started, false→not_started, null/undefined→unknown`。

`quota-monitor-runtime.ts`:deps 加 `reconcileMachine`;机器见证分支 `const r = await reconcileMachine(); log(JSON.stringify({event:"account_switch_reconcile", trigger:"witness", ...r})); if (!r.ok) log("quota monitor could not reconcile the live Claude identity")`;`opts.reconcileMachine` 类型改为返回 `ReconcileMachineResult`。

- [ ] **Step 4: 运行并确认 GREEN**

重复 Step 2;再跑 `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/quota-incident.test.ts src/__tests__/account-switch-repair.test.ts`(共享 `QuotaMonitorDeps`/`SwitchResult` 的邻居)与 `tsc --noEmit`。Expected: 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/teamlead/src/account-heal/quota-monitor-state.ts packages/teamlead/src/account-heal/quota-monitor.ts packages/teamlead/src/account-heal/quota-monitor-runtime.ts packages/teamlead/src/__tests__/quota-monitor-state.test.ts packages/teamlead/src/__tests__/quota-monitor.test.ts packages/teamlead/src/__tests__/quota-monitor-idle-e2e.test.ts packages/teamlead/src/__tests__/quota-monitor-runtime.test.ts
git commit -m "feat(FLY-2271): keep switch failure evidence and recover marker drift in the daemon"
```

## Task 4(可摘除): 部署波次重启跑旧码的 quota-monitor

> 若 Lead 决定拆单,整个 Task 4 连同其 commit 一起摘除,Task 1–3、5、6 不依赖它。

**Files:**
- Modify: `packages/teamlead/src/account-heal/quota-monitor-cli.ts`、`packages/teamlead/src/__tests__/quota-monitor-cli.test.ts`
- Create: `scripts/lib/restart-quota-monitor.sh`、`scripts/__tests__/restart-quota-monitor.test.sh`
- Modify: `scripts/restart-services.sh`(source 一行 + hook 一段)、`scripts/test-restart-services.sh`(cp 列表)、`.github/workflows/ci.yml`(登记新 shell suite)

- [ ] **Step 1: 写失败测试**

`quota-monitor-cli.test.ts`:
- 纯函数 `runtimeTreeShaCommand(argv, hash)`:`(["--runtime-tree-sha"], () => "abc")` → `"abc"`;其他 argv → `null`;默认 `hash` 参数为 `() => runtimeTreeSha256(dirname(fileURLToPath(import.meta.url)))`,单测用临时目录放两个 `.js` 文件、注入 `() => runtimeTreeSha256(tmpDir)` 断言返回 64 位 hex(源码目录下没有 `.js`,不能用默认参数直接调)。
- 集成:`pnpm --filter flywheel-teamlead build` 后 `spawnSync(node, [dist/account-heal/quota-monitor-cli.js, "--runtime-tree-sha"], {env:{FLYWHEEL_QUOTA_PIDFILE: scratch, FLYWHEEL_QUOTA_RUN_MARKER: scratch2, FLYWHEEL_QUOTA_HEALTH_MARKER: scratch3}})`:rc 0、stdout 64 hex、三个 scratch 文件都不存在(早分支无副作用)。

`restart-quota-monitor.test.sh`(仿 `converge-nonlead-daemons.test.sh`;**测试脚本自身 `set -euo pipefail`**,与调用方一致;seams:`_rqm_launchctl`、`_rqm_runtime_sha`、`_rqm_health_marker_path`、`_rqm_pidfile_path`、`_rqm_read_record <path> <field>...`(Node 安全读取器,见 Step 3)、`_rqm_process_start_time <pid>`、`_rqm_now_ms`、`_rqm_sleep`;每个 seam 的默认实现读同名 env(`FLYWHEEL_RQM_*` / `FLYWHEEL_QUOTA_HEALTH_MARKER` / `FLYWHEEL_QUOTA_PIDFILE`),函数覆盖与 env 注入两种方式都可用;pass/fail 计数):
1. marker 三元组 `(sha==disk, pid==pidfile.pid, processStartTime==pidfile.processStartTime==活进程)` → `current`,launchctl 只有 `print`。
2. sha 不同、三元组其余一致,job 在域,kickstart 后 pidfile 变新 pid + 新 start time → `restarted`,launchctl 序列恰为 `print`, `kickstart -k`。
3. job 不在域(`print` 非 0)→ `not_loaded`,零 kickstart、零 bootstrap。
4. marker 缺失、进程 30 秒前启动(pidfile 新)→ **重启**(不存在年龄豁免)。
5. marker sha 等于 disk 但 `pid` 属于另一个进程 / `processStartTime` 与 pidfile 不符 → 重启。
6. marker 为 symlink / 非 0600 / 非本 uid(用 seam 让读取器报告 uid 不符)/ 超 64KB / 字段类型不对 → `_rqm_read_record` 拒绝 → 视为不可信 → 重启,detail 含 `marker unsafe`。
7. **pidfile 各种坏形态**(缺失、非 JSON、缺 `pid`/`processStartTime`、symlink、他人所有、读失败、`_rqm_process_start_time` 失败)→ 函数 **rc 0**,detail 说明原因;整个测试脚本在 `set -euo pipefail` 下不中断。
8. **kick 前 pidfile 读不到、kick 后同一个旧 tuple 重新可读** → **不得** `restarted`:旧 tuple 未知时只能凭「kick 之后新写的 health marker」判定(见 Step 3),否则 `degraded`。
8b. **旧 tuple 未知 + 同一 epoch 秒内的新 marker**:kick 前 pidfile 读失败;seam `_rqm_now_ms` 返回 `1700000000400`,kick 后 pidfile 变为合法新 tuple、`_rqm_process_start_time` 与之一致,health marker 三元组匹配新进程、哈希等于磁盘、`completedAt=1700000000900`(与 kick 同一 epoch 秒,仅晚 500ms)→ 必须 `restarted`(整数毫秒直接比较,不做秒级截断);对照:`completedAt=1700000000300`(早于 kick)→ 不得 `restarted`。
9. **kick 后新 tuple 指向一个已死的 pid**(`_rqm_process_start_time` 对新 pid 失败或与 tuple 不符)→ 不得 `restarted`,继续等待直至超时 → `degraded`。
10. kickstart 后 30s(`_rqm_sleep` 计数 60 次)pid 与 start time 均未变 → `degraded`,函数 rc 0。
11. `_rqm_runtime_sha` 失败 → `unverifiable`,零 launchctl 动作。
12. `DRY_RUN=true`(restart-services 的既有变量,由 `--dry-run` 设置):需要重启时 state=`planned`、detail 含原因,launchctl 只有只读 `print`;不需要重启时照常 `current`。
13. **跨平台**:记录文件(marker/pidfile)的安全校验与解析由同一个 `node -e` 读取器完成(`lstat` 非 symlink/regular、`uid` 等于 `process.getuid()`、mode 0600、size ≤ 64KB、JSON 字段类型),不依赖 `stat -f`;本 suite 在 macOS 与 Linux 都 GREEN(CI 的 Ubuntu job 会跑 `test-restart-services.sh`)。

`test-restart-services.sh`(CI Ubuntu job 以子进程跑真实 `restart-services.sh`,函数覆盖不可注入):假仓里放可执行 `fake-runtime-sha`(`FLYWHEEL_RQM_RUNTIME_SHA_BIN`)、假 pidfile + 假 health marker(`FLYWHEEL_QUOTA_PIDFILE` / `FLYWHEEL_QUOTA_HEALTH_MARKER`,三元组一致,**显式 `chmod 600`**)、假 `ps` 与 `launchctl` shim(`FLYWHEEL_RQM_PS_BIN` / `FLYWHEEL_RQM_LAUNCHCTL_BIN`,`ps -o lstart= -p <pid>` 返回与 pidfile 相同的字符串);cp 列表加入 `scripts/lib/restart-quota-monitor.sh`;断言完整 restart 波次的日志含 `quota-monitor restart: current` 行,且 launchctl shim 日志无 `kickstart`。

- [ ] **Step 2: 运行并确认 RED**

```bash
pnpm --filter flywheel-teamlead build
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/quota-monitor-cli.test.ts -t "runtime-tree-sha"
bash scripts/__tests__/restart-quota-monitor.test.sh
bash scripts/__tests__/ci-shell-suite-enumeration.test.sh
```

Expected: 第二、三条 FAIL(函数/lib 不存在);第四条在新增 suite 未登记前 FAIL。

- [ ] **Step 3: 最小实现**

`quota-monitor-cli.ts`:
```ts
export function runtimeTreeShaCommand(argv: readonly string[], hash: () => string = () => runtimeTreeSha256(dirname(fileURLToPath(import.meta.url)))): string | null {
  return argv.length === 1 && argv[0] === "--runtime-tree-sha" ? hash() : null;
}
// 入口:const sha = runtimeTreeShaCommand(process.argv.slice(2)); if (sha !== null) process.stdout.write(`${sha}\n`); else main().catch(…)
```

`scripts/lib/restart-quota-monitor.sh`(source-only,Bash 3.2):
```bash
restart_quota_monitor() {
  local label="com.flywheel.quota-monitor" domain="gui/$(id -u)"
  local disk_sha="" tuple="" live_pid="" live_start="" reason="" i new_tuple="" new_pid="" new_start="" rc=0 kick_at_ms=""
  _rqm_set_outcome unverifiable "quota-monitor restart did not run"
  disk_sha=$(_rqm_runtime_sha) || { _rqm_set_outcome unverifiable "runtime tree sha unavailable"; return 0; }
  _rqm_launchctl print "${domain}/${label}" >/dev/null 2>&1 || { _rqm_set_outcome not_loaded "job not in domain; left to convergence"; return 0; }
  # 一次性、errexit-safe 的 pidfile 读取:校验 regular/0600/本 uid/≤4KB/JSON 含整数 pid 与非空 processStartTime;
  # 任何失败返回非零 + 空 tuple,调用处只用 `|| rc=$?`,绝不让 set -e 逃逸。
  tuple=$(_rqm_read_pidfile) || rc=$?
  if (( rc != 0 )); then reason="pidfile unreadable or malformed (rc=$rc)"
  else
    live_pid="${tuple%%|*}"; live_start="${tuple#*|}"
    if ! _rqm_marker_is_trusted; then reason="marker unsafe or missing"
    elif [[ "$(_rqm_marker_field runtimeTreeSha256)" != "$disk_sha" ]]; then reason="runtime tree differs from disk"
    elif [[ "$(_rqm_marker_field pid)" != "$live_pid" || "$(_rqm_marker_field processStartTime)" != "$live_start" ]]; then reason="marker does not describe the pidfile process"
    elif [[ "$(_rqm_process_start_time "$live_pid" 2>/dev/null || true)" != "$live_start" ]]; then reason="pidfile process is not alive with the recorded start time"
    fi
  fi
  [[ -n "$reason" ]] || { _rqm_set_outcome current "marker matches live process and disk build"; return 0; }
  if [[ "${DRY_RUN:-false}" == "true" ]]; then _rqm_set_outcome planned "dry-run: would kickstart ($reason)"; return 0; fi
  kick_at_ms=$(_rqm_now_ms)                      # 毫秒,与 daemon 写 marker 的 Date.now() 同一时间域
  rc=0; _rqm_launchctl kickstart -k "${domain}/${label}" || rc=$?
  (( rc == 0 )) || { _rqm_set_outcome degraded "kickstart failed rc=$rc ($reason)"; return 0; }
  for (( i = 0; i < 60; i++ )); do
    _rqm_sleep 0.5
    rc=0; new_tuple=$(_rqm_read_pidfile) || rc=$?
    (( rc == 0 )) || continue
    new_pid="${new_tuple%%|*}"; new_start="${new_tuple#*|}"
    # 新 pid 必须活着且启动时间与 tuple 一致(排除死 pid / 复用 pid)
    [[ "$(_rqm_process_start_time "$new_pid" 2>/dev/null || true)" == "$new_start" ]] || continue
    if [[ -n "$live_pid" ]]; then
      # 旧 tuple 已知:tuple 必须变化
      [[ "$new_pid" != "$live_pid" || "$new_start" != "$live_start" ]] || continue
      _rqm_set_outcome restarted "$reason; pid $live_pid -> $new_pid"; return 0
    fi
    # 旧 tuple 未知:只认 kick 之后新写的 health marker(tuple 与活进程一致、哈希等于磁盘、completedAt > kick_at_ms)
    if _rqm_marker_is_trusted && [[ "$(_rqm_marker_field runtimeTreeSha256)" == "$disk_sha" \
        && "$(_rqm_marker_field pid)" == "$new_pid" && "$(_rqm_marker_field processStartTime)" == "$new_start" ]] \
        && (( $(_rqm_marker_field completedAt) > kick_at_ms )); then
      _rqm_set_outcome restarted "$reason; fresh marker from pid $new_pid after kick"; return 0
    fi
  done
  _rqm_set_outcome degraded "no conclusive post-kick process evidence within 30s ($reason)"
  return 0
}
```
默认 seams:`_rqm_runtime_sha` = `"${FLYWHEEL_RQM_RUNTIME_SHA_BIN:-$FLYWHEEL_DIR/packages/teamlead/bin/flywheel-quota-monitor}" --runtime-tree-sha`;marker 路径 `${FLYWHEEL_QUOTA_HEALTH_MARKER:-$HOME/.flywheel/quota-monitor.health.json}`;pidfile `${FLYWHEEL_QUOTA_PIDFILE:-$HOME/.flywheel/quota-monitor.pid}`;`_rqm_process_start_time` = `"${FLYWHEEL_RQM_PS_BIN:-/bin/ps}" -o lstart= -p <pid>`(与 pidfile `processStartTime` 同格式,来源 `pidfile.ts`);`_rqm_launchctl` = `"${FLYWHEEL_RQM_LAUNCHCTL_BIN:-launchctl}"`;`_rqm_now_ms` = `node -e 'process.stdout.write(String(Date.now()))'`(整数毫秒;不用 `date +%s`,避免同一秒内 marker 被判「不新鲜」——测试 #8b:kick 后同一 epoch 秒内写出的 marker 必须被接受为 `restarted`)。**记录读取器**:`_rqm_read_record <path> <field>...` 是一个 `node -e` 脚本(不用 `stat -f`,macOS/Linux 同一份):`lstat` 必须 regular、非 symlink、`uid === process.getuid()`、mode 0600、size ≤ 64KB,再 `JSON.parse` 并按字段类型校验(pidfile:整数 `pid` + 非空 `processStartTime`;marker:64hex `runtimeTreeSha256` + 整数 `pid` + 非空 `processStartTime` + 整数 `completedAt`),以 `|` 分隔输出请求字段;任何失败非零退出。`_rqm_read_pidfile`、`_rqm_marker_is_trusted`、`_rqm_marker_field` 都建立在它之上,且只在 `||` 列表 / `$( … || true)` 中调用。所有失败路径 `return 0`。

`restart-services.sh`:L75 后 `source "${FLYWHEEL_DIR}/scripts/lib/restart-quota-monitor.sh"`;`converge_nonlead_daemons` 与 `census_launchd_fleet` 之间插入:
```bash
    # FLY-2271: converge only puts back daemons that left the domain; a running
    # quota-monitor kept pre-FLY-2240 code across three deploy waves. Restart it
    # only when its health marker does not describe the live process on the
    # freshly built dist.
    restart_quota_monitor
    log "quota-monitor restart: ${QUOTA_MONITOR_RESTART_STATE} ${QUOTA_MONITOR_RESTART_DETAIL}"
    case "$QUOTA_MONITOR_RESTART_STATE" in
        degraded|unverifiable)
            alert_warning "quota-monitor-restart-${QUOTA_MONITOR_RESTART_STATE}" \
                "quota-monitor restart ${QUOTA_MONITOR_RESTART_STATE}" \
                "${QUOTA_MONITOR_RESTART_DETAIL}"
            ;;
    esac
```
(实现时对齐 `alert_warning` 的实际参数顺序;不改 `restart_report_launchd_census` 签名。)

`.github/workflows/ci.yml`:在 shell suites 步骤加 `bash scripts/__tests__/restart-quota-monitor.test.sh`。

- [ ] **Step 4: 运行并确认 GREEN**

重复 Step 2 四条命令,再跑 `bash scripts/test-restart-services.sh`(整套,确认 cp 列表补齐后 source 不再失败)。Expected: 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/teamlead/src/account-heal/quota-monitor-cli.ts packages/teamlead/src/__tests__/quota-monitor-cli.test.ts scripts/lib/restart-quota-monitor.sh scripts/__tests__/restart-quota-monitor.test.sh scripts/restart-services.sh scripts/test-restart-services.sh .github/workflows/ci.yml
git commit -m "feat(FLY-2271): restart a stale quota-monitor on the deploy wave"
```

## Task 5: 隔离台架——三场景修前修后对照(含旧 daemon 一幕)

**Files:**
- Create: `scripts/qa-fly-2271-switch-evidence-e2e.sh`
- Create: `engineering/doc/FLY-2271-daemon-switch-evidence/evidence/README.md`(台架产出)

- [ ] **Step 1: 写台架**

脚本参数:`<token-rotation|true-drift|old-daemon|all> [--baseline <ref>] [--old-daemon-ref <ref>]`。默认 `--baseline` 为空(只跑当前树);`--old-daemon-ref` 默认 `155e1e78a^`(FLY-2240 之前最后一个 commit)。

**构建被测树与对照树**:台架启动时先 `pnpm --filter flywheel-teamlead build` 当前树(不假设 dist 是新的);对照树一律 `git worktree add --detach "$ROOT/tree-<name>" <ref>` + `pnpm install --offline --frozen-lockfile` + `pnpm --filter flywheel-teamlead build`(build 脚本要 `git rev-parse HEAD`,所以必须是 worktree 而不是 `git archive`);baseline 树与 old-daemon 树**各自独立**,失败即 `fail`,不静默降级。**哈希比较不依赖 Task 4 的 `--runtime-tree-sha` flag**:台架用 `node --input-type=module -e 'import {runtimeTreeSha256} from "<current-tree>/packages/teamlead/dist/account-heal/runtime-tree-hash.js"; …'` 对任意 dist 目录算哈希(同一算法,Task 4 摘除时仍可用)。cleanup 顺序:**先 kill 所有 daemon/server 进程并 `wait`**,再 `git worktree remove --force` 两棵树,最后 `rm -rf $ROOT`。

**fixture 隔离**:先生成一份不可变种子(pool 三槽 `personal/school/business` + anchors + identity-map、store、config、`.claude.json`、keychain state),每个 `{场景, 版本(baseline|current), 入口(manual|daemon)}` 组合从种子 `cp -R` 到独立 scratch 目录再跑,互不污染;每个组合各自的审计日志、daemon 日志、alert sink。

复用 `qa-fly-1256-quota-daemon-e2e.sh` 的 scaffolding(fake `security`、mock usage+identity server、alert sink、隔离 tmux socket)。

- **token-rotation**:keychain state 里 personal 的 accessToken 改成 `personal-rotated`(mock identity 把它映射到 personal 的 uuid/email)。手动:`<tree>/packages/claude-runner/bin/flywheel-claude-profile use school`;daemon:启动 `<tree>` 的 daemon 跑到第一条 `quota_poll`。期望**修前修后一致**:两路径 `switched`,审计各恰一对 entry/exit,池内 `personal/.credentials.json` 含 `personal-rotated`。
- **true-drift**:`.active`=personal,keychain 放 business 的 token。**daemon 入口的前置条件(台架专用,不碰产品代码)**:runtime 的每 tick 机器见证会在 `pollOnce` 之前就把这个 drift 修掉(live≠池副本 → `reconcileMachine`),所以给 fake `security` 加一个一次性哨兵 `FAKE_SECURITY_FAIL_NEXT_READ_FILE`:存在时下一次 `find-generic-password` 删除哨兵并以非零退出——这恰好让见证阶段的 `readKeychain()` 返回 null(见证跳过),而随后 `pollOnce` 的 snapshot/usage/bash 读取全部正常。触发前断言:`.active` 仍为 personal 且 live token 经 identity endpoint 解析为 business;触发后断言日志里 `account_switch_reconcile` 的第一条是 `trigger:"drift_recovery"`(之前没有 `trigger:"witness"`)。修前:手动 0(审计多一对 `reconcile` + `stale_active_reconcile`),daemon `switch_failed` 且日志无 detail;修后:daemon 日志 `account_switch_reconcile trigger=drift_recovery outcome=repaired from=personal to=business` 后 `outcome=switched`,无 `account_switch_failed` 告警。
- **old-daemon**(Lead 要求的一幕):不经 wrapper,直接以 `<old-tree>/packages/teamlead/bin/flywheel-quota-monitor`(它 `exec node <old-dist>`)在 scratch env 下启动旧 daemon(与 1256 台架启动方式相同),`FLYWHEEL_CLAUDE_PROFILE_BIN` 指被测树的 bash 脚本。**前置屏障(触发前必须成立)**:起旧 daemon 前把 scratch `quota-monitor-state.json` 的 `nextUsageDueAt` 设为遥远未来,让它的启动 tick 只做 `local_scan`、不切号;等待 scratch pidfile 与 health marker 出现,断言 pidfile 的 pid 是旧 daemon 进程、marker 的 `runtimeTreeSha256` 等于对 `<old-tree>/packages/teamlead/dist/account-heal` 算出的哈希且 ≠ 当前树 dist 的哈希——证明真的在跑旧码;然后**改写(不删除)** state 为「立即到期」:`observedGeneration` = 当前 store `generation`、`nextUsageDueAt=0`、`lastSwitchAt=null`、其余字段保持合法默认(删除 state 会让 `loadQuotaMonitorState` 在 store generation>0 时以 `lastSwitchAt=now` 恢复,触发 cooldown 而不是切号),再向旧 daemon 发 `SIGUSR1`(pidfile `wakeProtocol:1` 的唤醒信号,见 `installWakeCapability`)触发切号 tick。台架用同一个 `reset_monitor_state_due_now` 函数做每一次 state 重置。修前(baseline 脚本):`switch_failed reason=active_marker_drift`、审计零行、告警 body 无 `exit=`;修后(当前树脚本):旧 daemon 仍报失败(它不认识 48,可观测的只有 `switch_failed` 与告警),**权威证据是审计 entry + exit(48, `atomic_apply_contract_mismatch`)与 daemon stderr/日志里可见的失败**;不断言「标记进了旧 daemon 的 reason」(旧 daemon 不外露 reason)。随后 source `scripts/lib/restart-quota-monitor.sh`,seams 指向 scratch(`_rqm_launchctl print` 查旧 daemon 存活、`kickstart -k` 实现为「TERM 旧 daemon、等其 graceful 退出、以当前树 `bin/flywheel-quota-monitor` 起新 daemon」,`_rqm_runtime_sha` 用当前树 `--runtime-tree-sha`,marker/pidfile/ps 指 scratch)→ 断言 `QUOTA_MONITOR_RESTART_STATE=restarted`;kickstart seam 在「旧进程已退出、新进程未启动」之间再调一次 `reset_monitor_state_due_now`(否则新 daemon 读到旧 `nextUsageDueAt` 只做 local_scan),新 daemon 第一条 `quota_poll` 为 `switched`。Task 4 被摘除时此幕止于「审计与 stderr 有证据」,脚本用 `[[ -r scripts/lib/restart-quota-monitor.sh ]]` 决定是否跑第二段并在对照表标注。
- 每场景写 `evidence/<scenario>-<revision>-<entry>.json`:`{rc, auditLines:[{cmd,phase,exitCode,probeSummary}], events:[…], alertBodies:[…]}`,末尾生成 `evidence/README.md` 对照表;任一期望不满足 `exit 1`。
- **secret 检查**:`grep -R -F -e <fake access token> -e <fake refresh token> -e personal-rotated engineering/doc/FLY-2271-daemon-switch-evidence/evidence/` **命中即 fail**(不是 `grep -L`)。
- 清理(与上文顺序一致):先 kill 并 `wait` 全部 daemon/server 进程 → `git worktree remove --force` × 2 → `rm -rf $ROOT`(`FLYWHEEL_QUOTA_E2E_KEEP=1` 保留 scratch,但 worktree 仍移除)。

- [ ] **Step 2: 运行并确认 RED(修前)**

```bash
bash scripts/qa-fly-2271-switch-evidence-e2e.sh all --baseline origin/main
```

Expected: 「修前」列显示 true-drift daemon 失败无 detail、old-daemon 审计零行;若 Task 1–4 尚未合入本分支,「修后」列失败 → exit 1。

- [ ] **Step 3: 跑修后并提交证据**

```bash
bash scripts/qa-fly-2271-switch-evidence-e2e.sh all --baseline origin/main
```

Expected: exit 0,`evidence/README.md` 三场景对照表齐全,secret 检查零命中。

- [ ] **Step 4: 提交**

```bash
git add scripts/qa-fly-2271-switch-evidence-e2e.sh engineering/doc/FLY-2271-daemon-switch-evidence/evidence
git commit -m "test(FLY-2271): isolated bench for switch evidence and stale daemon"
```

## Task 6: 里程碑(literal last commit)

**Files:**
- Create: `engineering/doc/milestones/FLY-2271.md`

- [ ] **Step 1**: 按 `engineering/doc/milestones/README.md` 格式写:Status/PR/Date;交付(A–E 各一句)、验证(每个 Task 的测试命令与结果、台架对照表摘录)、风险(旧 daemon 在本 PR 合入后到下一次部署波次之间仍跑旧码——需要一次波次或人工 `launchctl kickstart -k gui/$UID/com.flywheel.quota-monitor`;`account_switch_failed` 路由仍 `mention:false`)。不改 `CLAUDE.md`。
- [ ] **Step 2**: `bash scripts/__tests__/fly2045-milestone-layout.test.sh` GREEN。
- [ ] **Step 3**:
```bash
git add engineering/doc/milestones/FLY-2271.md
git commit -m "docs(FLY-2271): milestone"
```

---

## 验收清单(implement 完成前逐条勾)

- [ ] `pnpm --filter flywheel-claude-runner test` 与 `pnpm --filter flywheel-teamlead test` 全绿;`pnpm -r build` 与 `pnpm lint` 通过。
- [ ] `bash scripts/__tests__/restart-quota-monitor.test.sh`、`bash scripts/__tests__/ci-shell-suite-enumeration.test.sh`、`bash scripts/test-restart-services.sh` 全绿(Task 4 在范围内时)。
- [ ] 台架 `all --baseline origin/main` exit 0,`evidence/README.md` 三场景对照表:token-rotation 修前修后皆成功;true-drift 修前 daemon 失败/修后成功;old-daemon 修前零审计/修后审计 48 + restart lib `restarted` + 新 daemon `switched`。
- [ ] secret 检查(exact fixture tokens,命中即 fail)零命中。
- [ ] PR body 列出:本单**否定** issue 的 token 轮转假设及三条反证;老 daemon 仍需一次重启;Task 4 与 FLY-2280 的 rebase 约定。
