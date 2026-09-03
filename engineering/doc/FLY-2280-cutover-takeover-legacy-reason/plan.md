# FLY-2280 跨版本 cutover takeover 改写 legacy reason — 实施计划
Issue: FLY-2280 (https://linear.app/geoforge3d/issue/FLY-2280/引擎部署-restart-services-跨版本-cutover-takeover-自己改写了随后要匹配的-legacy-reason-新)
日期: 2026-09-02
基于: research.md

> **For agentic workers:** 使用 `superpowers:executing-plans` 与 `superpowers:test-driven-development`；
> 在 TURN 持有的共享 worktree 内按批次 RED→GREEN 执行，每批一次 commit/push/progress。

**Goal:** 跨版本 cutover 部署票（旧 pause-aware、lease-unaware Bridge → 新 lease-aware Bridge）的 legacy
admission pause 接管确定性成功：phase-1 不再改写随后要匹配的 legacy reason，并且对 lease-aware Bridge 也以
同一标识做**限定**获取；receipt reason 的合法性检查与「获取被拒或结果不明」的判定都提前到 Bridge 停止之前；
这一引导段（含重试、二票、回滚三种状态与三类传输失败）由有状态 fake Bridge 的测试在 CI 里锁住。

**Architecture:** 单一事实来源 = cutover receipt 的 `.pause.reason`。新 helper `cutover_legacy_pause_reason`
是 phase-1 与 takeover 共用的唯一读取+校验入口。cutover 事务下 phase-1 的 pause 请求同时带
`reason` 与 `expectedLegacyReason`（都等于 receipt reason）：旧 Bridge 忽略后者、以同一串覆盖（幂等）；
lease-aware Bridge 走精确匹配分支（匹配则分配 owner 并写 handoff，不匹配则 409）。cutover 事务下的首次获取，
只有 curl rc=7（连接被拒 = 请求根本没到达 Bridge，即 runbook 的 bootout 状态）才允许 best-effort 继续；
其余任何非零结果（HTTP 拒绝、超时、连接中断——后两者可能是「服务端已提交但无回包」）都在 Bridge 停止前
拒绝该票，因为 post-health takeover 用的是同一谓词。Bridge、host 工具、receipt/handoff schema、普通部署路径、
`deploy_and_verify`、`rollback_and_restart` 一字不动。测试侧把无状态 fake curl 升级为有状态 fake Bridge，
`legacy` / `lease` 两种版本分别复刻 research §1.1 / §1.2 的写语义，并可注入传输失败。

**Tech stack:** Bash 3.2 兼容 shell、jq 1.7、既有 `restart-services-admission-pause.test.sh` harness、
CI Linux shell lane（`ci.yml` FLY-1434 步）。

---

## 0. 不变量与文件地图

### 0.1 修改的文件

| 文件 | 改动 | 量级 |
|------|------|------|
| `scripts/restart-services.sh` | 新 helper `cutover_legacy_pause_reason`；`pause_admission_best_effort` cutover 分支：reason 取 helper、fail-closed、payload 带 `expectedLegacyReason`、非 rc=7 的失败 fail-closed；`takeover_cutover_admission_pause_after_bridge_health` 改用同一 helper | ≈ +30 / −5（research §4 v3 diff） |
| `scripts/__tests__/restart-services-admission-pause.test.sh` | `RESTART_SERVICES_UNDER_TEST` seam；awk 抽取列表加新 helper；fake curl 增加有状态模式 + 传输失败注入 + wire ledger；`run_fn` 透传 `RESTART_REASON`；既有 out5 用例的 phase-1 失败码 22→7；新增 T1–T11 | ≈ +190 |
| `scripts/__tests__/ci-shell-suite-manual-only.txt` | 移除 `scripts/__tests__/restart-services-admission-pause.test.sh` 一行 | −1 |
| `.github/workflows/ci.yml` | FLY-1434 步末尾追加 `bash scripts/__tests__/restart-services-admission-pause.test.sh`；该步注释「Both suites」改成中性复数措辞 | +2 / −1 |
| `engineering/doc/FLY-2264-arm64-tmux-gate/cutover-runbook.md` | §3.1 补 reason 约束；§6 步骤 1 改成事实；§8 新增「8.3 部署票在 Step 0 被拒后的恢复」与「8.4 代码回滚回旧 Bridge 之后的前向转换」 | ≈ +24 / −2 |
| `engineering/doc/milestones/FLY-2280.md` | ship 时新建，作为 literal last commit | 新文件 |

### 0.2 明确不改

- `packages/teamlead/**`：`expectedLegacyReason` 精确匹配、409 不泄漏 id、三条写路径全部保持。
  完成审计以 `git diff --stat origin/main...HEAD -- packages/` **为空**为证。
- `scripts/host-terminal-cutover.sh`、receipt/handoff schema、`request-restart.sh`。
- `deploy_and_verify`、`rollback_and_restart`：调用点与失败处理一字不动。Step 0 失败仍 `return 1`，由
  `restart_on_exit` 的通用 finalizer 报告，精确原因在紧邻其前的 ERROR 日志行（Codex R1 #2：不加「未动」型告警）。
  rollback 对 `pause_admission_best_effort` 的非零返回仍是 WARNING 继续（可用性优先的既有例外）。
- `bridge_admission_request`：不加 `-w %{http_code}`；本单不区分 HTTP 状态码（Codex R2 #2：rc=22 只证明「≥400」）。
- `scripts/test-restart-services.sh`：其 FLY-2264 块只做 grep/fence，继续原样通过；不为本单加 grep 断言。
- 普通部署路径（无 legacy receipt）：`pause_identifier = restart-services:<reason>:pid=…:started=…`、
  run-local receipt、takeover、resume 行为不变；既有 34 条用例（out5 仅改失败码）必须原样通过。
- 不做 `max(remaining, 1800)` 之类 TTL 保守化；不改 `FLYWHEEL_RESTART_DISABLE_CODE_ROLLBACK` 的语义或默认值。
- **与 FLY-2271 的共存边界（Lead 2026-09-03 02:38Z 裁定）**：FLY-2271 会并行在 `scripts/restart-services.sh` 加一处最小
  hook（部署波次按 runtimeTreeSha256 重启运行中的 quota-monitor daemon，逻辑放独立新 lib）。本单对该脚本的改动
  只限 admission/cutover 段：`cutover_legacy_pause_pending` 之后的新 helper、`pause_admission_best_effort`、
  `takeover_cutover_admission_pause_after_bridge_health`；不重构任何无关段。先合入的一方不动，后合入的一方 rebase。

### 0.3 稳定标识（identifier contract）

| 场景 | phase-1 pause payload | takeover payload | 说明 |
|------|-----------------------|------------------|------|
| cutover 事务，尚无本进程 owner（`ADMISSION_PAUSE_LEASE_ID` 空） | `{durationSeconds, reason: R, expectedLegacyReason: R}`，R = receipt `.pause.reason` 逐字（**新**；对旧 Bridge 也发，它忽略 `expectedLegacyReason`） | `{durationSeconds, reason: restart-services:${RESTART_REASON}:cutover-takeover, expectedLegacyReason: R}`（不变） | API 拒绝 `leaseId` 与 `expectedLegacyReason` 同时出现，故二者互斥 |
| cutover 事务，本进程已有 owner（adopt 后的 rollback 续期） | `{durationSeconds, reason: R, leaseId}`（不变） | 不触发（`NEEDS_CUTOVER_TAKEOVER=false`） | 只带 `leaseId` |
| 普通部署 | `{durationSeconds, reason: restart-services:${RESTART_REASON}:pid=$$:started=<UTC>}`（不变） | run-local receipt 的 `pauseIdentifier`（不变） | 一字不动 |

helper 的接受谓词（jq，research §3.5 已验证）：string、非空、≤200 码点、首字符与末字符非空白、不含 CR/LF。
它与 Bridge 的 `trim().slice(0,200)` 归一化在 ASCII/BMP 范围内等价。

### 0.4 显示标签（日志，逐字；测试 grep 这些串）

| 位置 | 串 | 状态 |
|------|----|------|
| phase-1 receipt 校验失败 | `ERROR: cutover receipt has no valid legacy pause identifier; refusing to touch the brake before Bridge stop` | 新增 |
| phase-1 cutover 首次获取，curl rc≠0 且 ≠7 | `ERROR: legacy cutover admission acquisition was rejected or its outcome is unknown (curl rc=<N>); refusing to stop the Bridge. Establish the brake state (receipt, 0600 handoff, host-terminal-cutover.sh inspect-admission/pause-admission) and follow runbook §8.3 before re-ticketing` | 新增；不断言 409，不断言行状态 |
| phase-1 curl rc=7 / 普通路径任何失败 / 续期失败 | `WARNING: admission pause unavailable (pre-feature Bridge, foreign owner, or control API failure); no owned admission lease acquired; preserving any existing brake` | 既有，不变 |
| takeover receipt 校验失败 | `ERROR: cutover receipt has no valid legacy pause identifier` | 既有，不变 |
| 既有 `atomically adopted` / `cutover lease adopted and handed off` / `preserving the brake` / `could not take ownership` 各行 | 不变 | — |

不新增告警 id；`deploy_and_verify` Step 0 的 `ERROR: admission cutover owner handoff failed before Bridge stop` 保留原文。

### 0.5 迁移与回滚边界

- 无数据迁移、无 schema 变更、无新 env/flag。行为变化只在 `cutover_legacy_pause_pending` 为真时出现。
- 本修复自身的部署走普通路径（届时没有 legacy receipt），部署过程不触发新分支。
- 回滚 = revert 脚本 commit；receipt、handoff、DB 行都不需要修补。
- CI 分类变更可独立回滚（把套件放回 manual-only 并从 ci.yml 删除一行）。

### 0.6 负向守卫

1. receipt reason 非法 → phase-1 在**任何 curl 与 Bridge 停止之前** rc=1；row/receipt/handoff 全部未动。
2. cutover 首次获取遇到任何非 rc=7 的失败（HTTP ≥400、超时、连接中断）→ phase-1 rc=1；日志不推断行状态，
   只指向 §0.7 的观测式恢复。**「Bridge 不停止」这一保证只属于 `deploy_and_verify` Step 0**；`rollback_and_restart`
   保留可用性优先的既有例外（WARNING 后继续 `stop_bridge`）。
3. takeover 409 → 仍拒绝 Lead 波（既有，不变）。
4. 旧 Bridge 不可达（bootout，curl rc=7）→ 既有 best-effort 路径不变（out5、T9）。
5. adopt 之后的 rollback 只以 `leaseId` 续期，永不发无主 resume（T8）。
6. 普通部署不得因本改动碰任何 receipt：既有 `plain_*` 用例 + T7 锁住。
7. 传输失败后**不伪造** handoff：拿不到 `admissionPause.leaseId` 就没有 handoff（T11）。

### 0.7 恢复转换（Codex R1 #3 / R2 #2 #3；写进 runbook §8.3 / §8.4）

Step 0 被拒（日志 `rejected or its outcome is unknown`）只说明 **restart 没有收到权威的成功租约回包**；
请求是否送达、行是否已被改写、是否已经有 owner，全部未知（T11 就是「服务端已提交、回包丢失」）。
行的真实状态要由操作者**另行建立**，恢复按建立到的状态走：

| 操作者能建立的状态 | 恢复 | 谁做 |
|------|------|------|
| 0600 handoff 存在，且**当前是 lease-aware Bridge** | 用新工具 `pause-admission` 导入。**导入成功的判据 = 退出码 0，且 0600 receipt 被改写成 owned 形态（`.pause.leaseId` 等于 handoff 内容）**；工具的 stdout 刻意不暴露 owner capability（回归测试 `pause output does not expose the owner capability`），不要在 stdout 里找 `leaseId`。退出码 3 = 工具已把 continuity breach 写进 receipt/event，按既有规则先保全证据、不得宣告成功。导入成功后立即再发票（走普通路径，T7/T8c） | 操作者 |
| 0600 handoff 存在，但**当前是旧 Bridge**（代码回滚把旧 Bridge 拉了回来，row 的 `lease_id` 仍在） | 旧 Bridge 不返回 `leaseId`，新工具无法导入。前向转换 = 发**一张**过渡票：phase-1 对旧 Bridge 幂等续期并继续，新 Bridge 起来后 takeover 对已有主的行 409、**按设计拒绝 Lead 波**（T8b，Bridge 保持新版）；随后按上一行导入 handoff（receipt → owned），再发 owned-receipt 票完成 Lead 波（T8c） | 操作者 |
| 没有可用 handoff（不存在，或导入返回 409），当前是 lease-aware Bridge | 不做固定等待。founder 授权后以裸 curl 发一次**无限定** `pause`（body 只有 `durationSeconds` 与 `reason: R`，不带 `leaseId`/`expectedLegacyReason`）作为**原子探测兼获取**：(a) 返回 200 且带 `admissionPause.leaseId` ⇒ 行原本无主（如 T5 的 reason 不匹配行）或 owner 已过期，服务端已原子接管；把返回的 `leaseId` 写成 0600 handoff（目录 0700），再按第一行用新工具导入。(b) 返回 409 ⇒ 仍有**活跃** owner（foreign，或 T11 那种丢了 capability 的自有 owner；其时长可达 API 上限 3600s 且可能被续期）；用 `inspect-admission` 权威观测直到 `active == false`（不是固定 sleep），把这段 admission 重新开放记为 continuity breach，然后重复 (a) | 操作者（founder 级） |
| row reason 与 receipt 不匹配且无主（例如旧脚本的票先跑过），当前是旧 Bridge | 用保存的 pre-FF 旧工具对旧 Bridge 重新 `pause-admission --reason <同一 reason>`（覆盖回 receipt reason）后再发票 | 操作者 |

两条附加规则（Codex R2 #4）：owned receipt 再发票之前必须先用新工具**成功续期一次**（判据同第一行；lease 处于 active
状态，普通路径的 `paused_until <= now` 分支才不会接管它）；代码回滚回旧 Bridge 后的过渡票预期在 Lead 波前失败，
不得当作事故重试。不为这些状态新增自动接管机制；`FLYWHEEL_RESTART_DISABLE_CODE_ROLLBACK=1`（既有 env）
可让窗口票不做代码回滚，作为窗口策略选项写进 runbook §8.4 供 founder 裁定，本单不改默认值。

---

## 1. 第一批：harness 升级 + 跨版本 RED → 修复 GREEN

### 1.1 RED：让测试先复现生产失败与 Codex R1/R2 指出的状态

编辑 `scripts/__tests__/restart-services-admission-pause.test.sh`：

1. 测试 seam：`RS="${RESTART_SERVICES_UNDER_TEST:-${SCRIPT_DIR}/../restart-services.sh}"`（只此一处）。
2. awk 抽取列表在 `cutover_legacy_pause_pending` 后加一行 `/^cutover_legacy_pause_reason\(\)/,/^}/ { print; next }`
   （research §3.4：漏掉它会让 phase-1 调到未定义函数，用例假绿/假红）。
3. `run_fn` 的 `RESTART_REASON=deploy` 改为 `RESTART_REASON="${RESTART_REASON:-deploy}"`，并像 `${CURL_RC:+…}` 一样
   透传 `FAKE_BRIDGE_ROW`、`FAKE_BRIDGE_VERSION`、`FAKE_BRIDGE_FAIL`。
4. 既有 helper `legacy_pause_takeover_then_resume` 的 phase-1 `CURL_RC=22` 改为 `CURL_RC=7`（connection refused =
   旧 Bridge 已 bootout；22 是 HTTP 错误，在 cutover 事务下现在会 fail-closed）。out5 的断言不变。
5. fake curl 增加**有状态模式**：当 env `FAKE_BRIDGE_ROW` 非空时，把该 JSON 文件当唯一的 `admission_pause` 行
   （`{"lease_id":null|"<uuid>","reason":"…"}`；**文件不存在 = 行不存在**），按 `FAKE_BRIDGE_VERSION` 分支；否则保持现有
   固定回包行为（既有 34 条不改断言）。payload 取 argv 里 `-d` 的下一个参数；`-K -` 的 stdin 照旧写进 `CURL_STDIN`。
   归一化 `reason = payload.reason // "operator maintenance" | sub("^\\s+";"") | sub("\\s+$";"") | .[:200]`。

   | 请求 | `FAKE_BRIDGE_VERSION=legacy`（复刻 research §1.1） | `FAKE_BRIDGE_VERSION=lease`（复刻 §1.2 active-row 分支） |
   |------|------|------|
   | pause，无 `leaseId`/`expectedLegacyReason` | 行不存在则创建；`row.reason = 归一化 reason`（**`lease_id` 原样保留**——旧代码不知道这一列）；回 `{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800}}`；exit 0 | 行不存在或 `row.lease_id == null` 才写入（reason 同上，`lease_id = 123e4567-e89b-42d3-a456-426614174000`）并回带 `leaseId` 与 `reacquiredAfterLapse:false`；否则回 `{"ok":false,"error":"admission pause is owned by another lease"}` exit 22 |
   | pause，带 `expectedLegacyReason` | 同上（旧 Bridge 忽略未知字段） | 行存在且 `row.lease_id == null and row.reason == expected` 才写入并回带 `leaseId`；否则 409/exit 22 |
   | pause，带 `leaseId` | 同上 | `row.lease_id == leaseId` 才续期；否则 exit 22 |
   | pause，同时带 `leaseId` 与 `expectedLegacyReason` | 同上 | exit 22（API 400） |
   | resume | **删除行文件**，回 `{"ok":true,"admissionPause":{"active":false,"remainingSeconds":0}}` | `row.lease_id == leaseId` 才**删除行文件**并回 `wasActive:true,leaseLapsed:false`；否则 exit 22 |

   传输失败注入：env `FAKE_BRIDGE_FAIL=<rc>[:mutate]` 非空时，pause 请求不走上表，直接 `exit <rc>`；带 `:mutate`
   时先把行写成 `{reason: payload.reason, lease_id: ffffffff-ffff-4fff-8fff-ffffffffffff}`（模拟服务端已提交、回包丢失）。
   fake 的范围声明（写进测试文件注释）：只复刻 **active row** 上的 pause/resume 语义；不建模 `paused_until <= now`
   的过期无限定接管（cutover 事务下 phase-1 已不再使用无限定分支；T7 因此只对 active owned lease 成立）。
   每次 pause 追加一行 wire ledger 到 `${CURL_ARGV}.wire`：
   `pause reason=<归一化 reason> expected=<expectedLegacyReason|-> leaseId=<leaseId|->`（注入失败时写 `pause FAIL rc=<rc>`）；
   resume 追加 `resume leaseId=<…>`。
6. 新 helper 函数（追加进 `HELPERS` heredoc）：

   ```bash
   cross_version_legacy_bootstrap() {   # T1/T2
   	export FAKE_BRIDGE_VERSION=legacy
   	pause_admission_best_effort || return 10
   	export FAKE_BRIDGE_VERSION=lease
   	takeover_cutover_admission_pause_after_bridge_health || return 20
   	resume_admission_best_effort
   }
   cross_version_lease_phase1() {       # T4/T7/T8c
   	export FAKE_BRIDGE_VERSION=lease
   	pause_admission_best_effort || return 10
   	takeover_cutover_admission_pause_after_bridge_health || return 20
   	resume_admission_best_effort
   }
   cross_version_phase1_only() {        # T3/T5/T6/T9/T10/T11
   	export FAKE_BRIDGE_VERSION=lease
   	pause_admission_best_effort
   }
   cross_version_rollback_after_adopt() {   # T8
   	export FAKE_BRIDGE_VERSION=lease
   	pause_admission_best_effort || return 10
   	pause_admission_best_effort || return 11
   	resume_admission_best_effort
   }
   cross_version_ticket_after_legacy_rollback() {   # T8b
   	export FAKE_BRIDGE_VERSION=legacy
   	pause_admission_best_effort || return 10
   	export FAKE_BRIDGE_VERSION=lease
   	takeover_cutover_admission_pause_after_bridge_health && return 0
   	echo "TAKEOVER_REFUSED"
   	return 20
   }
   ```

7. 固定 fixture 与 `seed` 函数：**每个用例前**删除并重建 receipt（0600）、row 文件、handoff、`curl.argv`、
   `curl.argv.wire`（单例状态必须重种；T8→T8b→T8c 是唯一有意串联状态的三段，中间只清 argv/wire）。
   `LEGACY = {"status":"paused","pause":{"remainingSeconds":3600,"leaseId":null,"reason":"FLY-2264 arm64 tmux destructive window"}}`；
   `NULLROW = {"lease_id":null,"reason":"FLY-2264 arm64 tmux destructive window"}`；`RESTART_REASON=updater`。
8. 新用例（测试名逐字锁定，pass/fail 各一句；fail 信息带 stdout 尾行）：

   | # | 名称 | fixture → 调用 | 断言 |
   |---|------|----------------|------|
   | T1 | `cross-version cutover bootstrap: phase-1 sends the receipt reason as both reason and expectedLegacyReason` | LEGACY + NULLROW → `cross_version_legacy_bootstrap` | wire 第 1 行 == `pause reason=R expected=R leaseId=-`（旧 Bridge 忽略 expected 但它在线上） |
   | T2 | `cross-version cutover bootstrap: new Bridge adopts the legacy row after health and never resumes it` | 同 T1 同一次运行 | rc=0；row `lease_id` 为 UUID；handoff 存在、mode 600、内容 == row `lease_id`；pause 恰 2 次、resume 0 次；stdout 含 `legacy pause atomically adopted; owner handoff is durable` |
   | T3 | `cross-version cutover bootstrap: invalid receipt reason fails closed before any Bridge call` | 三个 fixture 逐个（reason 尾随空格 / 201 个 `a` / 缺 `.pause.reason`）+ NULLROW → `cross_version_phase1_only` | rc≠0、`curl.argv` 为空、stdout 含 §0.4 第一行 ERROR、row 文件字节不变 |
   | T4 | `cross-version cutover bootstrap: lease-aware Bridge adopts only the identifier-qualified legacy row` | LEGACY + NULLROW → `cross_version_lease_phase1` | rc=0；wire 第 1 行 == `pause reason=R expected=R leaseId=-`；handoff == row `lease_id`；pause 恰 1 次（takeover 为 no-op）、resume 0 次；stdout 含 `cutover lease adopted and handed off` |
   | T5 | `cross-version cutover bootstrap: mismatched NULL-owner row is refused before Bridge stop` | LEGACY + row reason `restart-services:updater:pid=1:started=x` → `cross_version_phase1_only` | rc≠0；pause 恰 1 次；row 字节不变；无 handoff；stdout 含 `rejected or its outcome is unknown (curl rc=22)` |
   | T6 | `cross-version cutover bootstrap: already-owned legacy row is refused before Bridge stop (with and without handoff)` | LEGACY + row `lease_id=aaaaaaaa-…`，两臂：预置 0600 handoff / 无 handoff → `cross_version_phase1_only` | 两臂都 rc≠0；pause 恰 1 次；row 与 handoff（存在时）字节不变；stdout 含 `rejected or its outcome is unknown` |
   | T7 | `active owned cutover receipt takes the ordinary path: row and receipt untouched, never resumed` | receipt 含 `leaseId=aaaaaaaa-…` + row 同 lease → `cross_version_lease_phase1` | rc=0；row 与 receipt 字节不变；pause 恰 1 次（普通 pause 得 409）、resume 0 次；stdout 含 `preserving any existing brake` |
   | T8 | `rollback after cutover adoption renews by leaseId only and never resumes` | LEGACY + NULLROW → `cross_version_rollback_after_adopt` | rc=0；wire 第 2 行 == `pause reason=R expected=- leaseId=<row lease_id>`；handoff == row `lease_id`；resume 0 次 |
   | T8b | `ticket after code rollback to the legacy Bridge: phase-1 continues, takeover refuses, owner and handoff preserved` | 承接 T8 状态（row 有主 L、handoff = L、receipt 仍 legacy），只清 argv/wire → `cross_version_ticket_after_legacy_rollback` | rc=20；stdout 含 `TAKEOVER_REFUSED` 与 `could not take ownership of the legacy cutover pause`；row `lease_id` == L、`reason` == R；handoff == L |
   | T8c | `owned receipt after handoff import completes on the ordinary path` | 承接 T8b，把 receipt 改写为 owned 形态（`leaseId = L`）→ `cross_version_lease_phase1` | rc=0；row 字节不变；resume 0 次；stdout 含 `preserving any existing brake` |
   | T9 | `fresh cutover acquisition against an unreachable Bridge keeps the best-effort path` | LEGACY + NULLROW，`FAKE_BRIDGE_FAIL=7` → `cross_version_phase1_only` | rc=0；stdout 含 `preserving any existing brake`；row 字节不变 |
   | T10 | `fresh cutover acquisition rejected with an HTTP error refuses before Bridge stop without claiming 409` | LEGACY + NULLROW，`FAKE_BRIDGE_FAIL=22` → `cross_version_phase1_only` | rc≠0；stdout 含 `rejected or its outcome is unknown (curl rc=22)`；无 handoff |
   | T11 | `ambiguous transport failure after a server-side commit refuses and fabricates no handoff` | LEGACY + NULLROW，`FAKE_BRIDGE_FAIL=28:mutate` → `cross_version_phase1_only` | rc≠0；stdout 含 `outcome is unknown (curl rc=28)`；无 handoff（row 已被 fake 改写，脚本不得据此写 handoff） |

9. 运行并确认 RED（research §3.7 已在原型上证明该矩阵对 63154c214 为 3/16：只有 T7、T8c、T9 这三条既有行为守卫绿）：

   ```bash
   bash scripts/__tests__/restart-services-admission-pause.test.sh
   ```

   把 RED 输出摘要写进 progress `--next`。

### 1.2 GREEN：`scripts/restart-services.sh`

按 research §4（v3）实施，逐字如下。

新 helper（位置：`cutover_legacy_pause_pending()` 之后、`restart_admission_receipt_path()` 之前）：

```bash
cutover_legacy_pause_reason() {
    local receipt="${FLYWHEEL_HOST_CUTOVER_RECEIPT:-${HOME}/.flywheel/state/host-terminal-cutover.json}"
    jq -er '.pause.reason
            | select(type == "string" and length > 0 and length <= 200
                     and test("^\\S") and test("\\S$") and (test("[\\r\\n]") | not))' \
        "$receipt" 2>/dev/null
}
```

`pause_admission_best_effort` 的 cutover 分支：

```bash
    if cutover_legacy_pause_pending; then
        cutover_pending=true
        pause_identifier=$(cutover_legacy_pause_reason) || {
            log "ERROR: cutover receipt has no valid legacy pause identifier; refusing to touch the brake before Bridge stop"
            return 1
        }
        ADMISSION_PAUSE_NEEDS_CUTOVER_TAKEOVER=true
        ADMISSION_PAUSE_RELEASE_ON_EXIT=false
```

payload 构造与请求（替换现有 `payload=$(jq -n …)` 与 `if response=$(bridge_admission_request pause "$payload"); then`）：

```bash
    payload=$(jq -n \
        --argjson durationSeconds "$ADMISSION_PAUSE_SECONDS" \
        --arg reason "$pause_identifier" \
        --arg leaseId "$owned_lease_id" \
        --argjson cutoverPending "$cutover_pending" \
        '{durationSeconds: $durationSeconds, reason: $reason}
         + (if $leaseId != "" then {leaseId: $leaseId}
            elif $cutoverPending then {expectedLegacyReason: $reason}
            else {} end)')
    local request_rc=0
    response=$(bridge_admission_request pause "$payload") || request_rc=$?
    if (( request_rc == 0 )); then
```

函数末尾的 `else` 分支（替换现有 `else … WARNING … fi`）：

```bash
    elif [[ "$cutover_pending" == "true" && "$owned_lease_id" == "" ]] && (( request_rc != 7 )); then
        # Fresh cutover acquisition: only a connection refusal (curl rc=7)
        # proves no request reached the Bridge (the booted-out legacy case).
        # Any HTTP rejection or an ambiguous transport failure may mean the
        # legacy row is owned, mismatched, or already mutated; the post-health
        # takeover would then fail deterministically, so refuse before stop.
        log "ERROR: legacy cutover admission acquisition was rejected or its outcome is unknown (curl rc=${request_rc}); refusing to stop the Bridge. Establish the brake state (receipt, 0600 handoff, host-terminal-cutover.sh inspect-admission/pause-admission) and follow runbook §8.3 before re-ticketing"
        return 1
    else
        # A fresh cutover acquisition reaches this fallback only for rc=7 (the
        # booted-out legacy Bridge). Ordinary deployments and owned-lease
        # renewals keep the best-effort contract for every other failure
        # (pre-feature 404, foreign owner, transport error); TTL protects
        # pause-aware versions.
        log "WARNING: admission pause unavailable (pre-feature Bridge, foreign owner, or control API failure); no owned admission lease acquired; preserving any existing brake"
    fi
    return 0
}
```

`takeover_cutover_admission_pause_after_bridge_health` 的 cutover 分支：删除局部 `receipt` 与内联 jq，改为
`expected_legacy_reason=$(cutover_legacy_pause_reason) || {`，其后的 ERROR 日志与 `return 1` 不变。

`deploy_and_verify`、`rollback_and_restart`、`bridge_admission_request` **不改**。

运行：

```bash
bash -n scripts/restart-services.sh
bash scripts/__tests__/restart-services-admission-pause.test.sh   # 期望 34 + 16 = 50 passed, 0 failed
bash scripts/test-restart-services.sh                               # FLY-2264 fence 块继续绿
```

尺子（必须做一次并把输出贴进 PR test plan）：

```bash
git show 63154c214:scripts/restart-services.sh > /tmp/fly2280-rs-before.sh
RESTART_SERVICES_UNDER_TEST=/tmp/fly2280-rs-before.sh \
  bash scripts/__tests__/restart-services-admission-pause.test.sh | grep -E '✗|could not take ownership'
```

预期 T1–T6、T8、T8b、T10、T11 红（T7、T8c、T9 与既有 34 条绿）且出现 `could not take ownership of the legacy cutover pause`；
`rm /tmp/fly2280-rs-before.sh`。

先查 inbox，再提交并 push：

```bash
git add scripts/restart-services.sh scripts/__tests__/restart-services-admission-pause.test.sh
git commit -m 'fix(FLY-2280): qualify the legacy cutover admission acquisition by the receipt reason'
git push -u origin flywheel-FLY-2280
```

`progress --phase implement --cursor 1/3 --set-chunk fix=done`。

## 2. 第二批：CI 提升 + runbook 事实修正

### 2.1 RED

1. 从 `scripts/__tests__/ci-shell-suite-manual-only.txt` 删除
   `scripts/__tests__/restart-services-admission-pause.test.sh` 一行；运行
   `bash scripts/__tests__/ci-shell-suite-enumeration.test.sh` ——预期 RED：套件既不在 manual-only 也未在 ci.yml 注册。

### 2.2 GREEN

1. `.github/workflows/ci.yml` FLY-1434 步（`bash scripts/test-restart-services.sh` 之后）追加一行
   `bash scripts/__tests__/restart-services-admission-pause.test.sh`；该步注释里的「Both suites use throwaway HOMEs…」
   改为「These suites use throwaway HOMEs…」并追加一句
   `FLY-2280: the admission-pause contract suite (hermetic fake HOME/curl) guards the cross-version cutover bootstrap.`
   不新增 step：`ci-structure.test.sh` 锁的是各 job 的 step 名单（`script-tests-3` 列表）与
   `bash scripts/test-restart-services.sh` 恰出现一次，在既有 step 内追加一行命令两把锁都不动；
   新增 step 反而要改 `ci-structure.test.sh` 的名单。
2. 重跑 enumeration 与 `bash scripts/__tests__/ci-structure.test.sh`，两者 GREEN。
3. Linux 兼容性：套件已同时走 GNU `stat -c` / BSD `stat -f`，fake curl/jq/mktemp 无 Darwin 依赖；
   PR 的 CI 运行本身就是验证。若 Linux lane 因 harness 原因红，修 harness（例如 `sed -i ''`、`date -r` 之类 BSD 语法），
   **不**退回 manual-only。
4. runbook `engineering/doc/FLY-2264-arm64-tmux-gate/cutover-runbook.md`：
   - §3.1 通过条件后追加一句：「`--reason` 会被部署票逐字当作接管匹配键：≤200 字符、首尾无空白、无换行，
     建议只用 ASCII；不满足时新脚本会在停止旧 Bridge 之前拒绝该票。」
   - §6「新 `restart-services.sh` 的强制时序」步骤 1 改为：「发现 0600 legacy transaction receipt，记为待接管；
     phase-1 以 receipt 中的 exact pause reason 同时作为 `reason` 与 `expectedLegacyReason` 向当前 Bridge 续 1800s 的
     pause（旧 Bridge 会以同一 reason 覆盖该行；lease-aware Bridge 精确匹配后直接分配 owner 并写 handoff）；
     只有连接被拒（旧 Bridge 已 bootout）才保持待接管状态继续，任何 HTTP 拒绝或结果不明的传输失败都在停止
     Bridge 之前拒绝该票。」
   - §8 新增「8.3 部署票在 Step 0 被拒（`rejected or its outcome is unknown`）后的恢复」，内容逐字取本 plan §0.7 表格
     与两条附加规则；新增「8.4 代码回滚回旧 Bridge 之后的前向转换」：过渡票 → takeover 按设计拒绝 Lead 波 →
     新工具导入 handoff → owned-receipt 票；并列出 `FLYWHEEL_RESTART_DISABLE_CODE_ROLLBACK=1` 作为窗口策略选项
     （founder 裁定，默认不启用）。
5. 提交并 push：

   ```bash
   git add scripts/__tests__/ci-shell-suite-manual-only.txt .github/workflows/ci.yml \
     engineering/doc/FLY-2264-arm64-tmux-gate/cutover-runbook.md
   git commit -m 'ci(FLY-2280): run the admission-pause contract suite in CI and correct the cutover runbook'
   git push
   ```

`progress --phase implement --cursor 2/3 --set-chunk ci_runbook=done`。

## 3. 聚焦与全仓 verification

先查 inbox，然后运行：

```bash
bash -n scripts/restart-services.sh scripts/__tests__/restart-services-admission-pause.test.sh
bash scripts/__tests__/restart-services-admission-pause.test.sh
bash scripts/test-restart-services.sh
bash scripts/__tests__/ci-shell-suite-enumeration.test.sh
bash scripts/__tests__/ci-structure.test.sh
git diff --stat origin/main...HEAD -- packages/        # 必须为空
git diff origin/main...HEAD -- scripts/restart-services.sh | grep -E '^@@' # 每个 hunk 都落在 246-470 行段内（admission/cutover 段）
command -v shellcheck && shellcheck -S warning scripts/__tests__/restart-services-admission-pause.test.sh || echo "shellcheck absent"
```

`pnpm lint` / `pnpm -r build` / `pnpm test:packages:run` 不因本单改动而变化，但 PR CI 会全跑；PR 判定以
**该头**的 CI 结论为准（[[feedback_local_green_is_not_that_head_ci_green]]）。

完成审计还要 grep 证明：

- `scripts/restart-services.sh` 里 `pid=$$` 只出现在 `pause_admission_best_effort` 顶部的 `case` 两行（普通分支的
  identifier 拼接）；`cutover_legacy_pause_pending` 分支内不出现 `pid=`。
- 内联 `'.pause.reason | select(` 在脚本中出现 0 次（只剩 helper 一处谓词）。
- `expectedLegacyReason` 在脚本中恰出现两处 payload 构造（phase-1 cutover 分支、takeover）。
- 脚本中不出现 `%{http_code}`（本单不区分 HTTP 状态码）。
- 测试文件里 `FAKE_BRIDGE_ROW` 未设时 fake curl 行为与改动前逐字一致（既有 34 条只改 out5 的失败码）。

## 4. Code review、milestone 与 PR

1. `stage set code_review`。
2. 按 runner contract 用 `codex:rescue` 支持的仓库入口跑本头 review；同时注册
   `gate review_code --no-block` + `request-review --type code`，poll `reviewVerdict`。
3. CHANGES_REQUESTED：对每个 blocking finding 先写/确认 RED，修复、跑 §3、commit/push，新开 questionId 新一轮；
   APPROVED advisories 用 `ask --report` 转 Lead。
4. review 通过后再次 inbox；若 FLY-2271 已先合入，先 rebase 到最新 `origin/main` 并重跑 §3。新增
   `engineering/doc/milestones/FLY-2280.md`（一 issue 一文件，格式见 `engineering/doc/milestones/README.md`），
   把它作为 literal last commit；不再 progress commit 或改代码。
5. push，`gh pr create`（body 含 `## Linear Issue` + 变更摘要 + test plan，test plan 贴 §1.2 尺子的 RED 输出与
   本地 50/50 GREEN 输出）；不 merge、不 deploy、不 dispatch QA。
6. 对本节点收到的每条 Lead instruction 发含完整 `[lead-instruction <id>]` 的 DONE report。
7. 用 implement 节点注入的 completion route `complete --pr NUMBER`；**complete 之后**再补 progress
   （[[feedback_no_ledger_commit_in_the_round_your_verdict_binds_the_head]]）。

## 5. 逐项完成审计

- [ ] cutover 分支 phase-1 wire 上 `reason == expectedLegacyReason == receipt .pause.reason`，对旧/新 Bridge 都如此（T1、T4）。
- [ ] 旧 Bridge 覆盖 + 新 Bridge 精确匹配接管 + handoff 0600 + 不 resume（T2）。
- [ ] 非法 reason 在零次 curl 前拒绝，row 未动（T3，三个 fixture）。
- [ ] lease-aware Bridge 只接管标识匹配的无主行；不匹配 / 已有主 → Step 0 拒绝，row/handoff 字节不变（T4、T5、T6 两臂）。
- [ ] 首次获取只对 rc=7 放行；rc=22 与 rc=28（已提交无回包）都拒绝且不伪造 handoff（T9、T10、T11）。
- [ ] active owned receipt 走普通路径：row/receipt 字节不变、不 resume（T7）。
- [ ] adopt 后 rollback 只以 leaseId 续期、不 resume、handoff 不变（T8）；回滚回旧 Bridge 后的过渡票在 takeover 处拒绝、
      owner/handoff 保持（T8b）；导入后的 owned-receipt 票走普通路径完成（T8c）。
- [ ] 既有 out5 以 rc=7 模拟 bootout 后原样通过；其余 33 条不改。
- [ ] 尺子：63154c214 脚本上 T1–T6、T8、T8b、T10、T11 红且出现 `could not take ownership`，输出贴进 PR。
- [ ] `test-restart-services.sh` FLY-2264 fence 原样绿。
- [ ] 套件进 CI：manual-only 移除、ci.yml 注册、注释措辞中性、enumeration/ci-structure 绿、PR 头 CI 绿。
- [ ] `git diff --stat origin/main...HEAD -- packages/` 为空；脚本 diff 的 hunk 全在 admission/cutover 段（FLY-2271 边界）。
- [ ] runbook §3.1/§6/§8.3/§8.4 与代码一致，无「旧 Bridge 已 bootout 时 pause 不可达」这一唯一路径的旧措辞。
- [ ] milestone 文件为 last commit；PR body 含 Linear 链接与 test plan。

## 6. 实现节点 RED 清单（本设计明确不做、留待观察）

- 旧 Bridge 没有所有权语义：同 reason 只让覆盖幂等，**不能**检测第三方在窗口内另发 pause；靠 runbook 窗口纪律。
- phase-1 与 takeover 都把 TTL 改写为 1800s；legacy 剩余 >1800s 会被缩短，receipt 的 expiry 在 host §7 续期前偏乐观。
  这是 FLY-2264 已接受的语义，本单不消除。
- phase-1 adopt 路径收到 `reacquiredAfterLapse:true` 只记日志，不像 takeover 那样把 lapse 写进 receipt
  （既有不一致，本单不动）。
- 「owner 已铸出但 handoff 写失败 / 回包丢失」只能按 §0.7 手工恢复；若希望自动化，另开 issue 给 host 工具加
  `adopt-expired` 之类命令或让 restart 消费 handoff，不在本单。
- 代码回滚回旧 Bridge 后需要一张预期失败的过渡票（§0.7 / runbook §8.4）；若 founder 认为不可接受，选项是窗口票
  设 `FLYWHEEL_RESTART_DISABLE_CODE_ROLLBACK=1`（既有 env，policy 决定），不在本单改默认。
- jq `length`（码点）与 JS `slice`（UTF-16 单元）在含非 BMP 字符、接近 200 的 reason 上可能分歧；runbook 约束 ASCII。
- 15:26–15:59 之间生产 lease/handoff 的人工取得过程未进 updater 日志，本单不补记。
- 15:33 第二张票被 `host-tmux-selection-gate` 拒（PATH 仍选 Intel 3.5a）与本单无关，不处理。
