# FLY-2280 跨版本 cutover takeover 改写 legacy reason — 调研
Issue: FLY-2280 (https://linear.app/geoforge3d/issue/FLY-2280/引擎部署-restart-services-跨版本-cutover-takeover-自己改写了随后要匹配的-legacy-reason-新)
日期: 2026-09-02
基于: exploration.md

## 1. 三方合同逐字核对

### 1.1 旧 Bridge（deployed-sha `4e77a39`，即 30bd50ec7 之前的 `StateStore.setAdmissionPause`）

```sql
INSERT INTO admission_pause (id, paused_until, set_by, reason, set_at)
VALUES (1, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  paused_until = excluded.paused_until, set_by = excluded.set_by,
  reason = excluded.reason, set_at = excluded.set_at,
  alert_state = 'pending', alert_attempt_at = NULL, alerted_at = NULL
```

- 无 `lease_id` 列；任何 pause 都无条件覆盖 `reason` 与 `paused_until`。
- 路由层只做 `reason.trim().slice(0, 200)`，忽略 body 里的 `leaseId` / `expectedLegacyReason`（不校验未知字段）。
- 响应：`{ok, admissionPause:{active, remainingSeconds}}`，**没有** `leaseId`，没有 `reacquiredAfterLapse`。
- 新 Bridge 打开同一个 DB 时 `ALTER TABLE admission_pause ADD COLUMN lease_id TEXT`（`StateStore.ts:4009-4015`），
  旧行成为 `lease_id IS NULL` 的 NULL-owner row。

### 1.2 新 Bridge（`63154c2`，`StateStore.ts:12820-12960`，`bridge/plugin.ts:1544-1640`）

三条互斥写路径，由 body 决定：

| body | SQL 谓词 | 0 行时 |
|------|----------|--------|
| `leaseId` | `WHERE id=1 AND lease_id = ?` | 409 |
| `expectedLegacyReason` | `WHERE id=1 AND lease_id IS NULL AND reason = ?` | 409 |
| 都没有 | `INSERT … ON CONFLICT … WHERE lease_id IS NULL OR paused_until <= now` | 409 |

- 三条都把 `paused_until` 改写为 `now + durationSeconds`，不保留旧 TTL（FLY-2264 research §121 明确“旧 expiry/reason 作废”）。
- `reacquiredAfterLapse` 只在 `previousPause.active == false` 且匹配成功时为 true——即使 legacy 行已过期，
  `expectedLegacyReason` 路径仍能接管并如实报告 lapse。
- 409 不泄漏 id：`{"ok":false,"error":"admission pause is owned by another lease"}`。curl `-f` 把它变成 rc=22。

### 1.3 脚本侧（`scripts/restart-services.sh`）

| 函数 | 行 | cutover 分支现状 |
|------|----|------------------|
| `cutover_legacy_pause_pending` | 246-252 | receipt 为 0600 regular file、`status=="paused"`、`pause.leaseId` 为空 |
| `pause_admission_best_effort` | 331-391 | `reason = restart-services:${RESTART_REASON}:pid=$$:started=<UTC>`，与是否 cutover **无关**；cutover 时只置 `NEEDS_CUTOVER_TAKEOVER=true`、`RELEASE_ON_EXIT=false` |
| `takeover_cutover_admission_pause_after_bridge_health` | 393-459 | cutover 分支 `expectedLegacyReason = receipt .pause.reason`（内联 jq：string、1..200）；失败 `return 1` |
| `deploy_and_verify` Step 0 | 2940-2945 | `pause_admission_best_effort` 返回非零 → `ERROR: admission cutover owner handoff failed before Bridge stop` → `return 1`（走 `restart_on_exit` 的通用「异常终止，状态未知」severe 告警） |
| `deploy_and_verify` health 后 | 3093-3101 | takeover 失败 → `alert_severe cutover-admission-takeover-failed` → `RESTART_TERMINAL_REPORTED=true` → `return 1` |
| `rollback_and_restart` | 2842-2844 | `if ! pause_admission_best_effort; then log WARNING …; fi` 继续回滚 |

普通（非 cutover）分支：phase-1 若成功但无 leaseId，把同一个 `pause_identifier` 写进 0600 run-local receipt；
takeover 从该 receipt 读回同一串做 `expectedLegacyReason`。**两端同源，所以自洽**——这正是 cutover 分支缺的东西。

### 1.4 host 工具与 receipt

- 旧工具（pre-FF，runbook §3.1 用它）`pause_admission` 把 `--reason` 原文同时写进 API body 与 receipt `.pause.reason`
  （`git show 30bd50ec7^:scripts/host-terminal-cutover.sh:161-193`）；默认 `tmux 3.7c host cutover`，runbook 示例
  `FLY-2264 arm64 tmux destructive window`。工具**不校验**长度或首尾空白。
- 新工具对 legacy receipt（无 leaseId）强制先从 0600 handoff 导入 id 才能 renew/resume；handoff 由 restart 的
  takeover 写出（`write_cutover_admission_lease_handoff`）。takeover 失败 ⇒ 没有 handoff ⇒ 新工具也动不了 brake。
  这就是 15:26 之后 fleet 被卡住的形状。

## 2. 生产时间线（`/tmp/flywheel-updater.log`）与 receipt 事件对齐

| 来源 | 时刻 | 事实 |
|------|------|------|
| receipt | 单调 576495（≈15:02 PT） | 旧工具 `pause` 3600s，无 `reacquiredAfterLapse` 字段（旧工具形态） |
| receipt | 579424-579625 | `bootout-supervisors` / `stop-old-servers` / `phase-b-link` / `services-bootstrap` 相继 completed（旧 Bridge 由 services-bootstrap 重新拉起） |
| updater | 15:24:55 | `Starting full restart: 4e77a39 → 63154c2 (reason=updater)` |
| updater | 15:25:04 | phase-1 pause **成功、无 leaseId**（旧 Bridge 应答）→ reason 被覆盖 |
| updater | 15:25:04 | 旧 Bridge 停止 |
| updater | 15:26:17 | 新 Bridge 健康 → takeover 409 → 拒绝 Lead 波 → `deploy did not converge` |
| updater | 15:26:18 | `restart-services.sh failed (deterministic)`；票 `…98528-1788387839-12062.urgent.json` 作废 |
| updater | 15:33:25 | 第二张票被 `host-tmux-selection-gate` 拒（PATH 仍选 Intel 3.5a）——与本单无关 |
| updater | 15:59:53 | 第三张票 phase-1 收 409（foreign owner）；receipt 已非 legacy 形态 ⇒ 普通部署 |
| updater | 16:04:07 | `deployed-sha updated to 63154c2` |
| receipt | 579961（≈16:05 PT） | 新工具 `pause`，`reacquiredAfterLapse:false`，携 leaseId |
| receipt | 588006（≈18:19 PT） | `resume`，`leaseLapsed:false`，事务收口 |

15:26-15:59 之间 lease 与 handoff 的取得没有进 updater 日志（推断为人工 curl + 手写 handoff）；
`~/.flywheel/bridge-state.db` 里没有 `admission_pause` 表（StateStore 在别的 DB），本单没有去翻生产 DB。

## 3. 候选修法的判别性验证（scratchpad 原型，不进仓库）

原型文件：`scratchpad/proto/cross-version-proto.sh`（有状态 fake Bridge）+ `rs-63154c.sh`（`git show 63154c214:scripts/restart-services.sh`）
+ `restart-services.sh`（套用修法 A 的副本，diff 见 §4）。fake Bridge 把唯一的 `admission_pause` 行放在
`FAKE_BRIDGE_ROW` JSON 文件里，`FAKE_BRIDGE_VERSION=legacy` 复刻 §1.1（覆盖 reason、不返 leaseId），
`FAKE_BRIDGE_VERSION=lease` 复刻 §1.2 三条谓词（不匹配 → 输出 409 JSON 并 `exit 22`）。

### 3.1 尺子有效：旧 RED

```
$ RESTART_SERVICES_UNDER_TEST=proto/rs-63154c.sh bash proto/cross-version-proto.sh
rc=20
[restart] WARNING: Bridge admission paused without an owner lease id; preserving the cutover brake for post-deploy takeover
[restart] ERROR: new Bridge could not take ownership of the legacy cutover pause
row after: {"lease_id": null, "reason": "restart-services:updater:pid=58856:started=2026-09-03T02:37:51Z"}
wire: pause reason=restart-services:updater:pid=88736:… expected=-
      pause reason=restart-services:updater:cutover-takeover expected=FLY-2264 arm64 tmux destructive window
handoff: (none)
```

两行日志与 updater 15:25:04 / 15:26:17 逐字相同；row 上的 reason 就是被 phase-1 改写后的值。

### 3.2 修法 A：新 GREEN

```
$ RESTART_SERVICES_UNDER_TEST=proto/restart-services.sh bash proto/cross-version-proto.sh
rc=0
[restart] WARNING: Bridge admission paused without an owner lease id; preserving the cutover brake for post-deploy takeover
[restart] Bridge admission legacy pause atomically adopted; owner handoff is durable and restart will not resume it
[restart] Bridge admission cutover lease belongs to the host transaction; preserving the brake
row after: {"lease_id": "123e4567-e89b-42d3-a456-426614174000", "reason": "restart-services:updater:cutover-takeover"}
wire: pause reason=FLY-2264 arm64 tmux destructive window expected=-
      pause reason=restart-services:updater:cutover-takeover expected=FLY-2264 arm64 tmux destructive window
handoff: -rw------- host-terminal-cutover.admission-lease-id (37 bytes)
```

phase-1 在 wire 上写的 reason 等于 receipt reason（旧 Bridge 覆盖成同一串）；takeover 精确匹配；没有 resume 调用。

### 3.3 负向守卫：receipt reason 尾随空格

| 脚本 | 结果 |
|------|------|
| 修法 A 副本 | `rc=10`（phase-1 返回 1），日志 `ERROR: cutover receipt has no valid legacy pause identifier; refusing to touch the brake before Bridge stop`，**零次 curl**，row 未动 |
| 63154c 副本 | phase-1 照常 pause（改写 reason），新 Bridge 起来后才 409（`rc=20`）——失败发生在旧 Bridge 已停、Lead 全被拒之后 |

### 3.4 既有套件无回归

`scripts/__tests__/restart-services-admission-pause.test.sh` 复制到 scratchpad、`RS` 指向修法 A 副本：
第一次跑 33/34（`legacy cutover lapse/handoff evidence missing`）——原因是套件的 awk 抽取列表没有新 helper，
`pause_admission_best_effort` 调到未定义函数；把 `cutover_legacy_pause_reason` 加进 awk 列表后 **34/34**。
⇒ 实施必须同步更新套件的函数抽取列表（`test-restart-services.sh` 的 FLY-2264 块只做 grep，不受影响）。

### 3.5 jq 谓词可行性（jq 1.7.1）

```
'.pause.reason | select(type == "string" and length > 0 and length <= 200
                        and test("^\\S") and test("\\S$") and (test("[\\r\\n]") | not))'
```

对 `"FLY-2264 arm64 tmux destructive window"`、`"x"` → 通过；`" leading"`、`"trailing "`、`"two\nlines"`、`""`、201 字符 → 拒绝。
Bridge 归一化是 JS `trim().slice(0,200)`；jq `length` 按 Unicode 码点、JS 按 UTF-16 单元，只在含非 BMP 字符且接近
200 的极端 reason 上分歧（记入 runbook 约束，不建机制）。

### 3.6 Codex R1 之后的 v2 矩阵（T1–T8，`scratchpad/proto/matrix-v2.sh`）

Codex Round 1 指出：(1) 修法 A 的 phase-1 对 lease-aware Bridge 仍走无限定分支
（`WHERE lease_id IS NULL OR paused_until <= now`），会接管 reason 不匹配的无主行；(2)「未动」型 Step-0 告警在
「owner 已铸出但 handoff 写失败」路径上为假；(3) 重试 / 二票 / 回滚三种状态没有可执行矩阵。
v2 修法：cutover 分支 payload 同时带 `reason` 与 `expectedLegacyReason`（都等于 receipt reason），
cutover 事务下 phase-1 收到 HTTP 错误（curl rc=22）即 fail-closed；删除 Step-0 告警。fake Bridge 升级：
`lease` 模式按 §1.2 三条谓词精确判定，`resume` 删除行文件（两版真 Bridge 都是 DELETE 行），每个用例前重种。

| 用例 | 63154c214 | v2 |
|------|-----------|----|
| T1 phase-1 reason == receipt reason、不含 `pid=` | ✗（`restart-services:updater:pid=…`） | ✓ |
| T2 legacy → lease takeover、handoff == lease、不 resume | ✗（rc=20，`could not take ownership`） | ✓ |
| T3 三个非法 reason 在零次 curl 前拒绝 | ✗ ×3（照常 pause，4 次调用） | ✓ ×3 |
| T4 lease-aware phase-1 精确匹配 adopt + handoff | ✗（wire 无 `expected=`） | ✓ |
| T5 lease-aware phase-1 对不匹配无主行 | ✗（**无限定 adopt 成功**——Codex #1 的漏洞实证） | ✓（409 → Step 0 拒绝，row 不变） |
| T6 legacy receipt + 已有主行（有 / 无 handoff） | ✗ ×2（best-effort 继续，晚失败） | ✓ ×2（Step 0 拒绝，row/handoff 不变） |
| T7 owned receipt 走普通路径、row/receipt 不变、不 resume | ✓ | ✓ |
| T8 adopt 后 rollback 只以 leaseId 续期、不 resume | ✗（第 2 次 pause 的 reason 是 `pid=` 形态） | ✓ |
| 合计 | 1 / 11 | 11 / 11 |

既有 34 条套件对 v2：34/34（out5 的 phase-1 `CURL_RC=22` 语义上应改为 7=connection refused 以模拟 bootout；
v2 下 22 在 cutover 事务里会 fail-closed，但 out5 的 helper 忽略 phase-1 rc，故当前仍绿）。

### 3.7 Codex R2 之后的 v3 矩阵（T1–T11，`scratchpad/proto/matrix-v3.sh`）

Codex Round 2 指出：(1) T1 断言 `expected=-` 与 payload 合同矛盾（expectedLegacyReason 对旧 Bridge 也在线上）；
(2) curl rc=22 只证明 HTTP ≥400，不能推断 409/行状态；rc=28/52/56 可能是「服务端已提交但无回包」，继续停 Bridge
会重演两态一痕；(3) 代码回滚把旧 Bridge 拉回后，row 的 `lease_id` 仍在而旧 Bridge 不返回 `leaseId`，新工具无法
导入 handoff，「导入后再发票」不可执行。v3：首次获取只对 rc=7（连接被拒）放行，其余非零全部 fail-closed，
日志不断言 409；恢复表改按操作者可观测状态；回滚后的前向转换 = 一张预期在 takeover 处失败的过渡票 → 新 Bridge
在位 → 导入 handoff → owned-receipt 票。fake 增加 `FAKE_BRIDGE_FAIL=<rc>[:mutate]` 注入。

| 用例 | 63154c214 | v3 |
|------|-----------|----|
| T1 wire == `reason=R expected=R leaseId=-` | ✗ | ✓ |
| T2–T6（同 §3.6，T5/T6 改为断言通用拒绝串） | ✗ ×7 | ✓ ×7 |
| T7 active owned receipt 走普通路径 | ✓ | ✓ |
| T8 adopt 后 rollback 只以 leaseId 续期 | ✗ | ✓ |
| T8b 回滚回旧 Bridge 后的过渡票：phase-1 幂等继续，takeover 409 拒绝 Lead 波，owner/handoff 不变 | ✗（phase-1 把 reason 改成 `pid=` 形态） | ✓ |
| T8c 导入 handoff 后的 owned-receipt 票走普通路径 | ✓ | ✓ |
| T9 rc=7 best-effort 继续 | ✓ | ✓ |
| T10 rc=22 拒绝（不断言 409） | ✗（best-effort 继续） | ✓ |
| T11 rc=28 且服务端已提交：拒绝、不伪造 handoff | ✗（best-effort 继续） | ✓ |
| 合计 | 3 / 16 | 16 / 16 |

既有 34 条套件对 v3：34/34。

## 4. 修法 A 的最小 diff（原型，实施以 plan 为准；v2/v3 增补见 plan §1.2）

```diff
+cutover_legacy_pause_reason() {
+    local receipt="${FLYWHEEL_HOST_CUTOVER_RECEIPT:-${HOME}/.flywheel/state/host-terminal-cutover.json}"
+    jq -er '.pause.reason
+            | select(type == "string" and length > 0 and length <= 200
+                     and test("^\\S") and test("\\S$") and (test("[\\r\\n]") | not))' \
+        "$receipt" 2>/dev/null
+}
@@ pause_admission_best_effort
     if cutover_legacy_pause_pending; then
         cutover_pending=true
+        pause_identifier=$(cutover_legacy_pause_reason) || {
+            log "ERROR: cutover receipt has no valid legacy pause identifier; refusing to touch the brake before Bridge stop"
+            return 1
+        }
         ADMISSION_PAUSE_NEEDS_CUTOVER_TAKEOVER=true
@@ takeover_cutover_admission_pause_after_bridge_health
-        local receipt="${FLYWHEEL_HOST_CUTOVER_RECEIPT:-…}"
-        expected_legacy_reason=$(jq -er '.pause.reason | select(type == "string" and length > 0 and length <= 200)' "$receipt" 2>/dev/null) || {
+        expected_legacy_reason=$(cutover_legacy_pause_reason) || {
```

净 +11/-2 行；Bridge、host 工具、receipt/handoff schema 零改动。

## 5. 被否决的替代方案（补充 exploration 表格的证据）

- **B 跳过 phase-1 pause**：原型里把 phase-1 改成直接 `return 0` 同样能让 takeover 匹配，但 (i) 15 分钟健康窗
  + 构建时间可能吃光 receipt 剩余预算而没有任何刷新；(ii) 第二张票撞上 lease-aware Bridge 上的 stale reason 时
  没有自愈路径（修法 A 下 phase-1 对 lease-aware Bridge 走既有 adopt+handoff 分支，§3.2 的 `lease` 模式已覆盖）。
- **C takeover 双候选**：需要 phase-1 记录“我写了什么、写成了没有”。curl 超时但服务端已提交时无法区分
  （[[feedback_two_states_one_trace]]）；修法 A 让这一区分不再必要。
- **D Bridge 放宽匹配**：改的是新 Bridge，但事故发生在旧 Bridge 的写入；且破坏 FLY-2264 ruling
  `16a390ab` “identifier 不匹配即 409，绝不接管外部 brake”。

## 6. 测试落点与 CI 可见性

- `scripts/__tests__/restart-services-admission-pause.test.sh` 是这些函数的合同套件（34 条，本机 34/34），
  但在 `scripts/__tests__/ci-shell-suite-manual-only.txt:35` 被 FLY-1764 归入「macOS / launchd / Keychain /
  host-network integration suites」而**不在 CI 跑**。它本身是 hermetic 的（fake HOME/PATH/curl、GNU/BSD stat 双路径）。
- `scripts/test-restart-services.sh` 在 CI（`ci.yml:839`），其 FLY-2264 块对同一批函数只做 grep/fence 断言。
- 结论：跨版本引导段用例放进合同套件（复用既有 harness，只把 fake curl 变成有状态），并把该套件**提升进 CI 的
  FLY-1434 步**（从 manual-only 清单移除、`ci.yml` 注册）。清单文件头写明「deleting, adding, or registering a suite
  without updating its classification fails CI」，两处必须同改。若 Linux lane 因 harness 原因失败，修 harness
  而不是退回 manual-only——这条回归花掉了一张部署票，值得一个 CI 门。
