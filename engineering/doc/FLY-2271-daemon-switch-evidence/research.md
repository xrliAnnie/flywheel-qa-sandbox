# FLY-2271 daemon 自动切号失败零证据 — 调研
Issue: FLY-2271 (https://linear.app/geoforge3d/issue/FLY-2271/切号器daemon-自动切号在-token-轮转后必失败委托模式对-stale-active-marker不修复直接-46)
日期: 2026-09-02
基于: exploration.md

本篇把 exploration 里的五个方向(A 证据保全 / B 契约错配分类 / C daemon 一次性 reconcile+重试 / D 部署波次重启过期 daemon / E 隔离台架)落到具体文件、行号、现有合同与测试基础设施上,供 plan 直接引用。行号以分支头 `63154c214` 为准。

## 1. 代码地图与改动点现状

### 1.1 bash 切号原语 `packages/claude-runner/bin/flywheel-claude-profile`

| 位置 | 现状 | 与本单关系 |
|---|---|---|
| L52-80 | 顶层 trampoline:非委托且非 group leader 时用 Node 建进程组再 exec 自身 | 不动 |
| L486-553 `acquire_lock` | 委托三条件(env pid == holder pid == `$PPID` 且存活)→ `DELEGATED_LOCK_ACCEPTED=1`,否则正常取锁 | 不动 |
| L2249-2263 `begin_authenticated_switch_audit` | 非委托 → `trampoline_atomic_switch`(exec 走人);委托但 `FLYWHEEL_ATOMIC_SWITCH_APPLY != 1` → `fail_code 46`;**然后才** `begin_audit` | **A/B 的 bash 改动点**:先 `begin_audit`,再检查 APPLY;缺失时 `AUDIT_SUMMARY=atomic_apply_contract_mismatch`、stderr `FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH`、`exit 48` |
| L2265-2288 `use_profile` | `acquire_lock → begin_authenticated_switch_audit → active_marker_structural_gate → reconcile_after_acquire → … → reconcile_stale_active_locked` | 顺序不动;改动后 46/47 全部落在 `begin_audit` 之后 |
| L1711-1741 `fail_stale_active` | 46 → `FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE`;47 → `FLYWHEEL_STALE_ACTIVE_REPAIR_FAILED`(+uncertain 档) | 不动 |
| L1821-1895 `reconcile_stale_active_locked` | 委托 + 真 drift → 46「performs no repair」;委托 + 同身份 → strict capture + `emit_apply_freshened_report` | **不动**(FLY-1201 边界) |
| L2435-2465 `reconcile_profile` | 拒绝委托/bypass;`RECONCILE_MODE=1`;stdout JSON:`{"outcome":"already_consistent","freshened":true,"displaySynced":b}` / `{"outcome":"repaired","from":"x","to":"y","displaySynced":b}` / `{"outcome":"no_credential"}`(rc 10)/ `{"outcome":"unresolvable","reason":"…"}`(rc 20) | C 要把这个 JSON 原样带进 daemon 日志 |
| L145 `fail_code` | `set_failure_audit_details` 把 reason 写进 audit `details.reason` | 48 也走它,审计 exit 行自带 reason |
| exit code 集合 | `0 1 2 10 20 30 31 32 33 36 37 39 44 46 47 86 87 88 130 143` | **48 空闲** |

stderr 红线:bash 从不把 token 写 stderr(`identity_probe` 走 `curl --config -`,`kc_write` 走 stdin `-i`)。现有测试 `claude-profile.test.ts:1573` 已锁 argv;A 要新增「stderr 不含 token 字节」断言,让 Node 侧把 stderr 摘要写进日志/告警时有红线可依。

### 1.2 Node adapter `packages/teamlead/src/account-heal/claude-profile-cli.ts`

- L80-110 `applyFailureDiagnostic(error, stderr)`(FLY-2265):把未知 exit 的 stderr 归一(换行→` | `,控制字符→空格,尾部保留 2048)进 `Error.message`,透传 `profileChildStarted`。**不改**。
- L232-290 `reconcileClaudeProfile(deps): Promise<boolean>`:spawn `reconcile`(去掉委托/lease/bypass env),`outcome ∈ {already_consistent, repaired}` → true,其余与异常一律 false;**吞掉 outcome/from/to/exit/stderr**。C 需要它返回结构化结果。
- L370-425 catch 块分类顺序:`KEYCHAIN_PREIMAGE_CONFLICT` → `LIVE_IDENTITY_UNAVAILABLE` → **`code 46/47 || STALE_ACTIVE_*` → `ActiveMarkerDriftError(errText.trim())`** → 34/36/37/38/32/30/31/39 → `applyFailureDiagnostic`。B 在 46/47 之前插入 `code 48 || FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH → ApplyContractMismatchError`;A 让 `ActiveMarkerDriftError`/`ApplyContractMismatchError`/兜底错误都带 `applyExitCode`(`e.code` 为数字时)。
- L470-560 `runDetachedProfile`:reject 的 error 已带 `{code, stdout, stderr, profileChildStarted:true}`;spawn `error` 事件 → `profileChildStarted:false`(无 code)。

### 1.3 executor `packages/teamlead/src/account-heal/switch-executor.ts`

- L180-210 `SwitchOutcome.failed.reasonCode` 联合类型:B 新增 `"apply_contract_mismatch"`。
- L211-218 `SwitchResult = SwitchOutcome & { applyReports?, applyProfileChildStarted? }`:A 新增 `applyExitCode?: number`。
- L267-277 `ActiveMarkerDriftError(detail?)`:A 加 `exitCode?: number` 构造参数;B 新增 `ApplyContractMismatchError(detail?, exitCode?)`。
- L470-476 `profileChildStarted(error)`:A 仿此加 `applyExitCode(error)` 读取器。
- L930-960 candidate loop 的 `failed` 分支:`ActiveMarkerDriftError` → `active_marker_drift`(不轮候选);兜底 → `apply_failed` + `applyProfileChildStarted`。B 的 `ApplyContractMismatchError` 与 `FreshnessUnavailableError` 同姿态:环境类、立即 `failed`、不标记账号、不轮候选。A 在每个 `failed` 返回上附 `applyExitCode`。

### 1.4 daemon 主循环 `packages/teamlead/src/account-heal/quota-monitor.ts`

- L106-160 `QuotaMonitorDeps`:有 `readSnapshot`(锁内调用)、`withAccountsLock`、`switchAccount`、`log`、`alert`;**没有** bash `reconcile` 的注入点。C 新增 `reconcileMachine: () => Promise<ReconcileMachineResult>`。
- L826-866 `attemptSwitchFailureDelivery`:告警 `body = reason=${reasonCode}; degraded=${degraded}`,`signature` 含 reasonCode/degraded/startedAt/round/attempts。A 把 `detail` 追加进 body;signature 不变(避免 detail 抖动打破去重)。
- L868-905 `openSwitchFailureEpisode(deps,state,reasonCode,degraded,attemptedKinds)`:同 reasonCode+degraded 的进行中 episode 复用。A 增加 `detail` 参数,写入 episode(新 episode 或 detail 变化时更新)。
- L1531-1549:`switched.outcome ∈ {no_account, failed}` → 取 `reasonCode` 开 episode → `finish("switch_failed")`。**`switched.reason` 与 exit code 在此丢失**。A 在这里先 `deps.log(JSON.stringify({event:"account_switch_failed", trigger, reasonCode, exitCode, childStarted, detail}))`;C 在这之前插入 drift-recovery。
- L1089-1105 `finish()`:`quota_poll` 事件只带 outcome/panorama/delivery。不改。
- L1107-1120:tick 起点的 `deps.reconcileActive()` 是 **Node 侧 store 同步**(`syncActiveAccountInStore`),不是 bash `reconcile`;不要混淆。

### 1.5 状态文件 `packages/teamlead/src/account-heal/quota-monitor-state.ts`

- L116-123 `PendingSwitchFailure { reasonCode, degraded, startedAt, lastConfirmedAlertAt, alertCount, activeDelivery }`。
- L263-270 `SWITCH_FAILURE_KEYS` 白名单 + L480-510 `parsePendingSwitchFailure` 用 `hasOnlyKeys` 严格拒绝未知键 → A 加 `detail` 必须同时进白名单与 parser(可选,string,≤ 600 字节,不含控制字符;缺省 `undefined`)。state `version: 2` 不升。
- 测试:`quota-monitor-state.test.ts:69,306-354` 已有 pendingSwitchFailure 的 round-trip 与 legacy 用例可扩。

### 1.6 runtime `packages/teamlead/src/account-heal/quota-monitor-runtime.ts`

- L95 `RECONCILE_RETRY_MS = 20 * 60_000`;L189-200 `reconcileMachine` 默认实现 = `reconcileClaudeProfile({binPath, env:{POOL/STORE/LOCK/CLAUDE_JSON/JOURNAL}})`;L340-390 每 tick 机器见证:live keychain digest vs 池副本 digest,不等或 authority 未解析 → 调 `reconcileMachine()`,失败只 `log("quota monitor could not reconcile …")`,成功**不落日志**。
- L262-275 `switchAccount` 默认实现 = `defaultSwitchAccount(input, makeClaudeProfileSwitchDeps({... quotaPreverified: input.quotaPreverified === true ...}))`。
- L469-509 `reconcileActive`(Node store 同步)。
- C 的接线:把 `reconcileMachine` 传进 pollOnce deps;机器见证成功时也记一条 `{event:"machine_reconcile", trigger:"witness", ...}`(顺手补的日志缺口,不改行为)。
- 测试注入点:`quota-monitor-runtime.test.ts:119-196` 已经以 `reconcileMachine: vi.fn()` 注入。

### 1.7 手动 CLI `packages/teamlead/src/account-heal/account-switch-cli.ts`

- L128-215 `runAttempt(command, deps)`:`readSnapshot → (already active? 0) → selectCandidates → identity map → switchAccount`,返回 `{result, exitCode?}`。
- L217-300 `runAccountSwitchCli`:`for attempt in 0..1`:drift 且 attempt==1 → `FLYWHEEL_MANUAL_RECONCILE_RACE` rc 1;drift 且 attempt==0 → `deps.reconcile()` false → `FLYWHEEL_MANUAL_RECONCILE_FAILED` rc 1,true → `continue`(重新 `runAttempt`)。
- `AccountSwitchCliDeps.reconcile: () => Promise<boolean>`;生产实现 L590-600 直接包 `reconcileClaudeProfile`。
- 测试 `account-switch-cli.test.ts:193-235` 两条:一次 drift → reconcile 1 次、readSnapshot 2 次、selectCandidates 2 次;重复 drift → RACE。
- C 的共享 helper 抽取边界:CLI 的「重试 = 重跑整个 runAttempt(含候选重选)」与 daemon 的「重试 = 重读 snapshot 后用同一批已验证候选再调 executor」不同,**不强行共用重试体**;共用的是 (i) `ReconcileMachineResult` 类型与 `reconcileClaudeProfile` 的结构化返回,(ii) 「最多一次 reconcile、第二次 drift 即终止」的守卫函数 `driftRecoveryStep(attempt, result)` → `"retry" | "race" | "proceed"`。CLI 行为逐字节不变(stderr 标记/rc 保持)。

### 1.8 daemon 进程入口 `packages/teamlead/src/account-heal/quota-monitor-cli.ts`

- L243-248 `main()`:启动时 `ownRuntimeTreeSha256 = runtimeTreeSha256(dirname(import.meta.url))`(dist/account-heal 目录的 .js 树哈希);每 tick 后写 `~/.flywheel/quota-monitor.health.json`:`{version:1, pid, processStartTime, runtimeTreeSha256, completedAt, outcome}`(L283-291)。
- L317-326:入口不解析 argv(`bin/flywheel-quota-monitor` 传 `"$@"` 但被忽略)。D 新增 `--runtime-tree-sha`:在 `main()` 之前分支,只打印 `runtimeTreeSha256(dirname(import.meta.url))` 并 exit 0,不碰 pidfile/marker/wake。
- L270-276 SIGTERM/SIGINT:`stopping=true` + 唤醒计时器;当前 `runtime.tick()` 跑完才退出;`finally` 清 run marker(graceful)。`launchctl kickstart -k` 发 SIGTERM,plist `ExitTimeOut=30`。**一次切号 ~4-7s(审计 entry→exit 实测 3.8-7.1s)**,在 30s 内。

### 1.9 部署链路

- `~/Library/LaunchAgents/com.flywheel.quota-monitor.plist` → `/bin/bash ~/Dev/flywheel/scripts/flywheel-quota-monitor-wrapper.sh` → gates(host tmux / restart-storm `gate quota-monitor` / crash streak)→ `exec packages/teamlead/bin/flywheel-quota-monitor` → `node dist/account-heal/quota-monitor-cli.js`。KeepAlive=true。
- `scripts/restart-services.sh`:L73-76 source `restart-cmux-watcher.sh`、`converge-nonlead-daemons.sh`;L3161 `restart_cmux_watcher`;L3172-3174 deployed-sha 推进;L3193 `converge_nonlead_daemons`;之后 `census_launchd_fleet` + `restart_report_launchd_census`。
- `scripts/lib/converge-nonlead-daemons.sh`(1627 行):只处理「plist 在盘、override 未禁用、不在 domain」的 job,launchctl 动词只有 bootstrap/print/print-disabled,**无 kickstart**(grep 证实)。`units.manifest` 里 `com.flywheel.quota-monitor` policy=`setup`(由 setup-quota-monitor.sh 安装)。
- `scripts/lib/restart-cmux-watcher.sh`:source-only 状态机,输出 `CMUX_WATCHER_RESTART_STATE/DETAIL`,通过 `_crw_*` seam 让测试脚本化 launchctl;restart-services 把 degraded 只报告不阻断。D 新 lib `scripts/lib/restart-quota-monitor.sh` 照此合同。
- restart-services 的测试 `scripts/test-restart-services.sh` 用 `BO_FLYWHEEL` 假仓 + shim 的 node/pnpm/launchctl 跑真实脚本;lib 级单测放 `scripts/__tests__/<lib>.test.sh`(样板 `converge-nonlead-daemons.test.sh`:source lib,覆盖 `_cnd_launchctl` seam,pass/fail 计数)。

### 1.10 告警

- `quota-monitor-alert.ts:82` `account_switch_failed: {mention:false, severe:false}`;L193 仅 `transition_journal_conflict|identity_rollback_failed` 升 mention+severe。不改路由(范围外),但 HTML 诚实边界要写。
- `scripts/lead-alert.sh`:`--body` 原样进 Discord content,无截断;Discord 单条 2000 字符。detail 上限 600 字节 + reasonCode 等字段 < 200 字符,安全。

## 2. 拟定义的合同(plan 直接采用)

### 2.1 bash

```
# begin_authenticated_switch_audit (delegated branch)
begin_audit <cmd> <target> identity_check_pending        # 先落 entry
[[ FLYWHEEL_ATOMIC_SWITCH_APPLY == 1 ]] || {
  AUDIT_SUMMARY="atomic_apply_contract_mismatch"
  echo "FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH" >&2
  fail_code 48 "delegated profile mutation requires FLYWHEEL_ATOMIC_SWITCH_APPLY=1 (parent runtime predates the atomic-apply contract; restart the quota-monitor daemon)"
}
```
- 审计 entry:`cmd=use|next, profile=<target>, probeSummary=identity_check_pending`;exit:`exitCode=48, probeSummary=atomic_apply_contract_mismatch, details.reason=…`。
- `next` 且 `FLYWHEEL_ATOMIC_SWITCH_AUDIT_CMD=next` 的 `selectedBy:"atomic-cli"` details 逻辑保持在 `begin_audit` 之前算好。

### 2.2 TypeScript

```ts
// switch-executor.ts
export class ApplyContractMismatchError extends Error {
  constructor(detail?: string, public readonly exitCode?: number) { … name="ApplyContractMismatchError" }
}
export class ActiveMarkerDriftError extends Error {
  constructor(detail?: string, public readonly exitCode?: number) { … }
}
type FailedReasonCode = … | "apply_contract_mismatch";
export type SwitchResult = SwitchOutcome & {
  applyReports?: ApplyProfileReport[];
  applyProfileChildStarted?: boolean;
  /** Numeric exit of the last profile child, when the failure came from it. */
  applyExitCode?: number;
};

// claude-profile-cli.ts
export interface ReconcileMachineResult {
  ok: boolean;                                   // outcome ∈ {already_consistent, repaired}
  outcome: "already_consistent" | "repaired" | "no_credential" | "unresolvable" | "malformed" | "spawn_failed";
  from?: string; to?: string; reason?: string;   // 来自 reconcile 的 JSON
  exitCode: number | null;
  detail: string;                                // sanitized stderr 标记行摘要,≤ 600 字节
}
export async function reconcileClaudeProfile(deps): Promise<ReconcileMachineResult>;
// 兼容:account-switch-cli 的 deps.reconcile 改为返回 ReconcileMachineResult,CLI 只看 .ok

// 共享(新文件 account-heal/switch-drift-recovery.ts)
export function summarizeApplyFailure(stderr: string, max = 600): string;  // 只保留 FLYWHEEL_* 标记行 + 首个 "Error:" 行,去控制字符,截尾
export function driftRecoveryStep(attempt: number, result: SwitchResult): "retry" | "race" | "proceed";
```

### 2.3 daemon 日志与告警

```jsonc
{"event":"account_switch_reconcile","trigger":"drift_recovery"|"witness","outcome":"repaired","from":"business","to":"shopping","exitCode":0,"detail":"FLYWHEEL_STALE_ACTIVE_RECONCILED business shopping"}
{"event":"account_switch_failed","trigger":{"kind":"quota","scope":"5h"},"reasonCode":"apply_contract_mismatch","exitCode":48,"childStarted":true,"detail":"FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH | Error: delegated profile mutation requires FLYWHEEL_ATOMIC_SWITCH_APPLY=1 (…)"}
```
- 告警 body:`reason=<code>; degraded=<b>; exit=<n|none>; child=<started|not_started|unknown>; detail=<≤600B>`。signature 不变。
- `pendingSwitchFailure.detail?: string`(同一 episode 内 detail 变化即更新并允许再告警一次:把 `current.detail !== detail` 加入「新 episode」判定与 `reasonCode` 同级)。

### 2.4 daemon drift-recovery(C)

在 `quota-monitor.ts` 的 `switched` 判定之前:

```
switched = switchAccount(input)
if failed && reasonCode == active_marker_drift:
   r = deps.reconcileMachine()            # 锁外;bash reconcile 自己取锁
   log account_switch_reconcile(trigger=drift_recovery, …r)
   if r.ok:
       fresh = withAccountsLock(readSnapshot)          # 重读 activeName/generation
       input2 = {...input, observedAccount: fresh.activeName, observedGeneration: fresh.store.generation,
                 preferredOrder: preferredOrder.filter(n => n !== fresh.activeName)}
       switched = switchAccount(input2)               # 恰好一次
       if failed && reasonCode == active_marker_drift: detail = "drift persisted after reconcile: " + detail
   else: detail = "reconcile " + r.outcome + ": " + r.detail   # reasonCode 保持 active_marker_drift
```
- `preferredOrder` 过滤后为空(reconcile 后 active 就是唯一候选)→ 直接按 `noop_already_switched` 处理(executor 本身也会返回 noop)。
- 不循环:第二次结果无论如何都进既有 `failed/no_account/switched` 分支。

### 2.5 部署层(D)

```
# scripts/lib/restart-quota-monitor.sh (source-only)
restart_quota_monitor            # 设置 QUOTA_MONITOR_RESTART_STATE ∈ current|restarted|not_loaded|degraded|unverifiable, _DETAIL
  disk_sha  = "$FLYWHEEL_DIR/packages/teamlead/bin/flywheel-quota-monitor" --runtime-tree-sha   # 失败 → unverifiable
  marker    = ~/.flywheel/quota-monitor.health.json (owner 0600 regular; runtimeTreeSha256/pid/processStartTime)  # 缺失/不安全 → 视为过期
  running   = launchctl print gui/$UID/com.flywheel.quota-monitor 存在且 pid 匹配 marker.pid
  if !running → not_loaded(交给 converge,自己不 bootstrap)
  if marker.runtimeTreeSha256 == disk_sha → current(零动作)
  else kickstart -k;等待 ≤30s:新 pid ≠ 旧 pid 且 pidfile.processStartTime 变化 → restarted;否则 degraded
```
- 调用点:restart-services 在 `converge_nonlead_daemons` **之后**(converge 可能刚把它拉回域,新进程本身就是新码,marker 会在首 tick 后才出现 → 此时 `running` 但 marker 缺失 → 会 kickstart 一次;为避免这种无谓重启,`not marker && process age < 120s` 视为 current)。
- 只报告不阻断;写进 restart 报告的 launchd census 段。
- seams:`_rqm_launchctl`、`_rqm_runtime_sha`、`_rqm_now`、`_rqm_sleep` 供测试脚本化。

## 3. 测试基础设施盘点

| 层 | 现有 harness | 可直接复用 |
|---|---|---|
| bash 原语 | `packages/claude-runner/test/claude-profile.test.ts`:`spawnAuthenticatedPrimitiveSync(args, extra)`(建 holder marker、委托 env)、`seedShoppingMachine("business")`(真 drift 种子:marker→business,live token 属 shopping)、`seedCoherentActive`、fake `security`(stdin 写)、fake identity curl(`FLYWHEEL_PROFILE_CURL_BIN`)、`argvLog` | S2/S3 的 bash 层断言;新增「委托无 APPLY → 48 + 标记 + 审计 entry/exit」与「stderr 不含 token」 |
| Node adapter | `claude-profile-cli.test.ts:600-660`:`deps(execFile)` 注入 execFile 抛 `{code, stderr}` | 48/标记 → `ApplyContractMismatchError`;`exitCode` 透传 |
| executor | `switch-executor.test.ts:970-990`:applyProfile 抛 `ActiveMarkerDriftError` → `failed/active_marker_drift` | `applyExitCode` 透传、新错误类 |
| daemon poll | `quota-monitor.test.ts` `harness()`:`switchImpl` mock、`alerts[]`、`events[]`、`persisted[]`、`log` | C 的 reconcile-then-retry;A 的日志/告警 body;`reconcileMachine` 新 dep 需加进 harness |
| runtime | `quota-monitor-runtime.test.ts:119-196`:`reconcileMachine` 注入 | witness 成功日志;deps 接线 |
| state | `quota-monitor-state.test.ts` | `detail` round-trip / 超长拒绝 / legacy 缺键 |
| 手动 CLI | `account-switch-cli.test.ts:193-235` | `reconcile` 返回结构化后行为不变 |
| 部署 lib | `scripts/__tests__/converge-nonlead-daemons.test.sh` 样板(seam 覆盖 + pass/fail) | 新 `restart-quota-monitor.test.sh` |
| 隔离 E2E | `scripts/qa-fly-1256-quota-daemon-e2e.sh`:scratch HOME/pool/store、fake `security`(stdin)、mock usage/OAuth server、alert sink、真 daemon + 真 bash 脚本 + 隔离 tmux | E 台架的底座 |

## 4. 台架设计(要求 3)

新脚本 `scripts/qa-fly-2271-switch-evidence-e2e.sh <token-rotation|true-drift|contract-skew> [--baseline <git-ref>]`,复用 1256 的 scaffolding:

- 公共:scratch `HOME`、pool(personal/school/business 三槽 + anchors + identity-map)、store、fake `security`、mock usage server(active 95% 触发)、fake identity endpoint(按 token 返回 uuid/email)、alert sink、`FLYWHEEL_PROFILE_AUDIT_LOG` 指向 scratch。`--baseline` 时用 `git archive <ref> | tar -x` 到 scratch 造对照树并 `pnpm --filter flywheel-teamlead build`(不脏 worktree)。
- 每个场景各跑两路径:手动 = `<tree>/packages/claude-runner/bin/flywheel-claude-profile use school`(公开 trampoline → Node CLI);委托 = 启动 daemon 跑一个 tick(或直接用 `flywheel-quota-monitor` 的 tick),等 `quota_poll` 事件。
- S1 token-rotation:把 keychain state 里 personal 的 accessToken 改成同身份新字节(identity endpoint 映射不变)。**期望(修前修后同)**:两路径 rc 0 / `outcome=switched`,审计 entry/exit 各一对,池内 personal 副本被保鲜为新字节。
- S2 true-drift:`.active`=personal,keychain 里放 business 的 token。期望修前:手动 rc 0(审计里多一对 `reconcile` + `stale_active_reconcile`),daemon `switch_failed reason=active_marker_drift`,审计有 entry/exit(46);修后:daemon 日志 `account_switch_reconcile outcome=repaired from=personal to=business` 后 `outcome=switched`。
- S3 contract-skew:用一个只在 env 里删掉 `FLYWHEEL_ATOMIC_SWITCH_APPLY` 的 adapter 包装(测试 seam:`FLYWHEEL_QA_STRIP_APPLY_MARKER=1` 仅在台架 env 生效?——**否决**,不给生产代码加台架旗)。改为直接 spawn bash 原语模拟旧 daemon:建 holder marker、传 `FLYWHEEL_CLAUDE_LOCK_DELEGATED=$$`+lease proof、**不传** APPLY(与 `spawnAuthenticatedPrimitiveSync` 同构,只是在 shell 里做)。期望修前:rc 46、审计零行、stderr 无标记;修后:rc 48、审计 entry+exit(summary `atomic_apply_contract_mismatch`)、stderr 含 `FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH`。daemon 侧分类由 vitest 覆盖(注入 execFile 抛 48)。
- 每场景输出 `evidence/<scenario>-<before|after>.json`(rc、审计行数、日志事件、告警 body 摘要),脚本末尾打印对照表;任一断言失败 exit 1。

## 5. 风险与注意

1. **secret 红线**:`summarizeApplyFailure` 只保留 `FLYWHEEL_*` 标记行与首个 `Error:` 行;bash 测试锁「stderr 不含 keychain token 字节」;Node 测试锁「detail 不含注入 stderr 里的伪 token」。
2. **`hasOnlyKeys` 严格**:漏加白名单会让整份 state 解析失败回落默认 → 必须有 round-trip 测试。
3. **重试时 `quotaPreverified:true`**:候选是本 tick 几秒前 live 验证的,reconcile 本身 ≤ 10s;与首次尝试同一信任假设,不新增放松。
4. **reconcile 与 executor 锁**:reconcile 必须在 executor 释放锁之后调用(`switchAccount` 返回即已释放);bash `reconcile` 自己取同一把锁,不能在 `withAccountsLock` 内调用,否则自死锁(FLY-852 同型)。
5. **kickstart 时机**:放在 build 完成、deployed-sha 推进之后;SIGTERM 让当前 tick 跑完;30s 内未换 pid 记 degraded 不阻断。
6. **同-SHA 波次**:哈希一致零动作;converge 刚拉回的新进程无 marker → 以进程年龄 < 120s 判 current,避免双重启。
7. **FLY-2265 顺序**:两单都改 `claude-profile-cli.ts` catch 块与 `account-switch-cli.ts`;本单基于含 #1032 的 main,rebase 无重叠 hunk 风险低;若 2265 先 land,`reconcile` 返回类型变化只影响 CLI 的一处 `await deps.reconcile()`。
8. **机器见证成功日志**是行为无关的补日志,不进 A 的验收核心;避免与 C 混淆。
