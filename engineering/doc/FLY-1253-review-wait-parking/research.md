# FLY-1253 审查等待 park 重试 — 调研
Issue: FLY-1253 (https://linear.app/geoforge3d/issue/FLY-1253/fix-flywheel-land-30min-硬杀-改-park定期重试审查等待不该被切)
日期: 2026-07-14
基于: exploration.md

## 1. Authority Map

| 层 | 当前权威 | FLY-1253 职责 |
|---|---|---|
| landing policy | `xrliAnnie/flywheel-skills/skills/flywheel/flywheel-land/SKILL.md` v0.3.0 | PR-B：bound review/gate 30m terminal stop → park/retry；CI 不动 |
| production Claude runner | `packages/claude-runner/src/TmuxAdapter.ts` | 兼容性/回归验证；本单不改 timeout semantics |
| production Codex runner | `packages/claude-runner/src/CodexTmuxAdapter.ts` + goal runtime | 兼容性/回归验证；本单不改 gate-marker protocol |
| dormant direct Claude runner | `packages/claude-runner/src/ClaudeCodeAdapter.ts` | PR-A：future DAG/standalone hardening；不注册、不接线 |
| bound wait fact | CommDB question + checkpoint + question id | skill 必须持有当前 gate 的 `QUESTION_ID` |
| direct adapter wait probe | `CommDB.hasPendingBlockingGateFrom(execId)` | 仅用于新增 dormant supervisor；probe error fail-closed |
| lifecycle visibility | `flywheel-comm park/unpark` + `runner_declared_states` | 10m bounded lease、5m retry；不作为 authority |

canonical skill 仓库本地 checkout 是 `~/Dev/flyview-skills`（remote repo
`xrliAnnie/flywheel-skills`）；`~/.agents/skills/flywheel-land/SKILL.md` 只是安装副本，
实现阶段不得编辑它。

## 2. FLY-1225 Incident Reconstruction

### 2.1 First Execution

StateStore session `1515a3d5-53de-40bf-b616-0f897d59d64e`：

| 时间 (UTC) | 事件 |
|---|---|
| 15:49:54 | implement started；`adapter_type=codex-tmux` |
| 16:04:53 | PR #587 created |
| 16:05:07 | stage=`pr_created` |
| 16:05:18 | stage=`code_review` |
| 16:38:17 | `session_completed` route=`blocked` |
| 16:38:30 | reason=`Landing failed: unknown` |

branch 已有 commit `c71a8cbde`，PR/CI 资产没有消失。损失是等待中的 execution/context
被结束，后续只能重新派发再读已有资产。

### 2.2 Review Evidence

第一 execution 的 cross-family review jobs 分别止于 `gate_answered_externally` 与
`no_verdict`，没有可交付 verdict。随后 runner 按 landing/review wait policy 停止。
后续 execution 重新注册 review 后才拿到 APPROVED，证明 review infrastructure 最终
可恢复，也证明“另起 execution 恢复文件”不是 context-preserving continuation。

### 2.3 Machine-readable Gap

v0.3.0 同时要求：

- review 30m → 写 `failed/review_timeout` 并 stop；
- 任意退出都写 terminal `land-status.json`。

实际 session 落成 `Landing failed: unknown`，说明终止边界没有形成可靠 terminal
reason。v0.4.0 在合法 park 期间必须保持 `{"status":"pending"}`，只有真实
ready/failure 才 terminal。

## 3. Reachability Audit

### 3.1 Production Registry

`packages/teamlead/src/bridge/run-infra.ts` 只注册四个 factory：

- `claude-tmux` → `TmuxAdapter`；
- `codex-tmux` → `CodexTmuxAdapter`；
- `antigravity-tmux`；
- `kimi-tmux`；

default 是 `claude-tmux`。`packages/config/src/types.ts::ExecutorBackend` 也是相同四值
union；`role-adapter-resolver.ts` 把 vendor `claude` 映射为 `claude-tmux`，不是 bare
`claude`。

`packages/claude-runner/src/ClaudeCodeAdapter.ts` 的 `type="claude"` 没有 production
registry entry，也没有 production instantiation；repo 内只在 scripts/dev protocol
path 使用。不要与 `packages/agent-team-transport/src/claude/ClaudeCodeAdapter.ts`
这个同名 mailbox adapter 混淆。

### 3.2 Timeout Value

即使 future registry 接入 direct adapter，当前 Blueprint production path 也会显式
传 `ctx.timeoutMs`：默认 `sessionTimeoutMs=86_400_000`（24h）。因此 direct class 的
`DEFAULT_TIMEOUT_MS=30m` fallback 不是 FLY-1225 的 30m source。

`ClaudeCodeAdapter` 的 direct `execFile({timeout})` 仍是一个真实 future defect：一旦
standalone/dev/future DAG 以 30m fallback 或较短显式 timeout 运行，它无法识别 gate
wait，且 child 被 kill 后拿不到最终 JSON `session_id`。但这只能叫 dormant
hardening，不能叫 current incident root cause。

### 3.3 Corrected Causal Chain

1. FLY-1225 在 `codex-tmux` 上运行；
2. live Codex goal runtime 已能对 open gate marker 延长 deadline；
3. canonical flywheel-land v0.3.0 明写 review wait 30m terminal stop；
4. 所以 PR-B 是当前事故真修；
5. PR-A 是 founder 指定、为 FLY-1135/future direct path 提前补的正交 contract；
   task#139 缺陷⑦作为同类缺陷关联保留。

Lead 已依据这份 reachability 证据撤销旧的 A→B dependency。

## 4. Production Adapter Compatibility

### 4.1 `TmuxAdapter`

`checkDynamicTimeout()`：

- lazy-open CommDB；
- 当前用 `hasPendingQuestionsFrom(executionId)` 判断 waiting；
- `totalWaitingMs` 从 elapsed 中扣除，因此 active budget 是 session 累计值；
- 每段连续 waiting 由 `waitingTimeoutMs`（默认 49h）单独限制；
- poll loop 独立发 heartbeat。

这意味着 runner 在 pane 内执行 5m sleep/check 不会让 adapter 停止 heartbeat；open
question 也会保护 wait。`flywheel-comm park` 本身不驱动 adapter timeout，只给
watchdog/Lead 表示 intentional quiet。

注意：live TmuxAdapter 使用 broad `hasPendingQuestionsFrom`，会包含 checkpoint-less
ask；本单不改变它，因为：

- 用户 scope 是 flywheel-land + direct ClaudeCodeAdapter；
- 收窄 live production semantics 会改变既有 behavior，需单独 issue/risk review；
- v0.4.0 skill 自身仍只允许 bound checkpoint question 进入长期 park。

因此“`hasPendingBlockingGateFrom` 是唯一 wait 证据”只适用于 PR-A 新增 direct
supervisor，不宣称是所有现存 adapters 的统一不变量。

### 4.2 `CodexTmuxAdapter`

Codex path 在 `gate --no-block` 时写 question-bound marker。goal runtime 的
`isWaiting()` 只看当前 execution 的 unanswered marker，open gate 时延长 deadline；
独立 heartbeat timer 每个 poll interval 上报。gate watcher 在配置 deadline 到点时
写 synthetic timeout response，runner 的下一次 `check` 能看到 fail-open/fail-close
结果。

v0.4.0 的 bounded sleep/check loop 与这一机制兼容，前提是使用原 gate 返回的
question id；park marker不替代 gate marker。

这里有一个必须显式处理的 Claude/Codex asymmetry：`flywheel-comm check` 只查
response。Codex watcher会在 gate timeout时写 synthetic response；claude-tmux 没有
gate-marker watcher，bare question expiry 不会让 `check` 从 pending变成 timeout。
所以 skill 每轮必须在 pending response后再查 expiry-aware `pending --lead --json`；
同 qid消失时先 race-safe 再 `check` 一次（response可能刚好落在两次查询之间）；第二
次仍 pending才 unpark并写 terminal `review_gate_expired`。Claude bare expiry拿不到
原 gate timeout behavior metadata，因此安全边界是 fail-closed，不能假装 fail-open。

### 4.3 Liveness/Watchdog

bounded park lease 写 `runner_declared_states(kind='parked', expires_at='ISO timestamp')`：

- 5m retry < 10m lease，正常 loop 会在过期前续租；
- runner crash 后最多 10m marker 自然失效；
- tmux/codex adapter heartbeat 独立继续；
- verdict/timeout 后 skill 必须显式 `unpark`，避免继续显示 intentional quiet。

implementation/QA 必须实际跑一次 claude-tmux 和一次 codex-tmux，确认 5m 可用缩放
为短 interval 后：heartbeat/runner 存活、land status pending、response 后同 pane/thread
继续。

## 5. Bound Wait Semantics

### 5.1 In Scope

- `review_design` / `review_code` cross-family verdict；
- `brainstorm` / `question` / `approve_to_ship` 等 checkpointed gate response；
- future DAG 中复用同一 question/checkpoint contract 的 review node。

共同条件：

1. question 的 `from_agent` 是当前 execution；
2. `checkpoint IS NOT NULL`；
3. question 未答、未过期；
4. runner 已保存 gate 创建时返回的 exact `questionId`，或能从 Lead pending JSON 中
   唯一恢复当前 execution 的 checkpoint row。

### 5.2 Out of Scope

- checkpoint-less `ask` / `ask --report`；
- 只有 GitHub `reviewDecision` pending、没有 Flywheel gate 的 native review；
- model/tool 正常执行；
- CI no-progress；
- 单靠 `park`/`busy` marker；
- DB/probe error。

out-of-scope wait 不可无限续命；30m 到点按既有/明确的新 unbound terminal reason
`review_wait_unbound` fail-closed。

### 5.3 `QUESTION_ID` Binding

`flywheel-land` 不负责创建 review gate。v0.4.0 必须用醒目文字写
**MUST NOT open another gate**；上游 caller 已创建 gate并把返回的 question id 作为
`QUESTION_ID` 交给 landing flow。

如果变量没有跨 tool/shell call 保留，用现有 CLI 做 machine-authoritative recovery：

```bash
PENDING_JSON=$(node "$FLYWHEEL_COMM_CLI" pending \
  --lead "$FLYWHEEL_LEAD_ID" --json)
MATCHES=$(jq -c --arg exec "$FLYWHEEL_EXEC_ID" \
  '[.[] | select(.from_agent == $exec and .checkpoint != null)]' \
  <<<"$PENDING_JSON")
test "$(jq 'length' <<<"$MATCHES")" -eq 1
QUESTION_ID=$(jq -r '.[0].id' <<<"$MATCHES")
```

`pending` 已返回 id/from_agent/checkpoint，且只列 unanswered/unexpired rows。只接受
唯一 match；零个是 unbound，多个是 ambiguous，二者都写
`review_wait_unbound`；命令非零/JSON不可解析则写 `review_wait_poll_error`，不能当作
零 match。这不依赖 Codex-only gate marker，也不要求 PR-A 先上线。

进入 park loop 前必须已经有 caller-provided 或上述 recovery 验证的值。skill 不：

- 猜“最近一个问题”；
- 从 broad pending list 中猜最近一条；
- 把 GitHub review number 当 question id；
- 只靠模型记忆却不在当前 shell/step 明确重建变量。

如果调用 flow 没有创建/bind gate，本单明确不救；写
`review_wait_unbound`，而不是制造虚假的 long-lived wait。

当前 three-stage runner contract 已要求在 code/design review gate 创建时 capture
questionId；现有 `pending --lead --json` recovery 让 Claude/Codex 都能重新绑定唯一
open checkpoint。没有 gate 的 native GitHub review仍不适用。

## 6. Dormant Direct Adapter Supervisor

### 6.1 Budget Model

PR-A 不使用“每次 gate 关闭就发一整份新 active timeout”，而是模仿 TmuxAdapter：

```text
activeElapsed = now - startedAt - totalCompletedWaitMs - currentWaitMs
```

- active budget 在整个 child lifetime 内累计；
- 每段连续 wait 有独立 `waitingTimeoutMs`（默认 49h）；
- 全局 outer cap 为有限值，例如
  `min(setTimeoutMax, max(activeTimeoutMs, waitingTimeoutMs * 7))`；
- 多次 gate open/close 不能无限续 active lifetime；
- gate close 后恢复**剩余** active budget，不重新发 full budget。

`* 7` 沿用 TmuxAdapter 为多 gate worst case 设计的 ultra-safety cap，implementation 应
复用/共享 helper 或至少用同样公式与测试，不另造冲突常量。

### 6.2 Process Control

Node built-in `execFile.options.timeout` 必须移除，否则外层 state machine 仍会被内层
timer 绕过。supervisor 自己持有：

- one child；
- active/wait/outer timers；
- `settled`/`timedOut` single-settle guard；
- injectable clock/exec seam；
- timeout 后 `SIGTERM`（必要时 follow existing process semantics）。

不 respawn、不依赖 kill 后 `--resume`；fake test 的 `execFile` call count 必须为 1。

### 6.3 Wait Probe

direct adapter 只用：

```ts
CommDB.openReadonly(ctx.commDbPath)
  .hasPendingBlockingGateFrom(ctx.executionId)
```

无 DB、missing schema、busy/probe exception 都返回 false 并 warning，继续普通 timeout。
park marker不是 lifetime authorization。

### 6.4 Environment

future direct child 为运行 flywheel-comm/skill 至少需要：

- `FLYWHEEL_COMM_DB`；
- `FLYWHEEL_EXEC_ID`；
- `FLYWHEEL_PROJECT_NAME`；
- `FLYWHEEL_ISSUE_ID`；
- `FLYWHEEL_COMM_CLI`（可解析时）；
- `FLYWHEEL_LAND_STATUS_PATH`；
- `BASH_MAX_TIMEOUT_MS` ≥ waiting cap。

仍删除 inherited `CLAUDECODE`。这只补 future direct env parity；不新增
`FLYWHEEL_GATE_MARKER_DIR`，因为 PR-A 不把 direct Claude runner改造成 Codex
gate-marker transport。

## 7. Canonical `flywheel-land` v0.4.0

### Keep

- pending marker first；
- 30s CI poll；
- CI 30m no-progress → `ci_timeout`；
- max 2 CI fix attempts、conflict handling、never self-merge；
- terminal ready/failure 必写 signal。

### Change

当 review wait 达 30m：

1. 验证 `QUESTION_ID` 已绑定且 `check` 仍为 pending；
2. 无绑定 → `review_wait_unbound` terminal failure；
3. 有绑定 → signal 保持 pending；
4. `park --until 10m --reason "flywheel-land awaiting review gate"`；
5. 用五个**独立** Bash tool calls执行 `sleep 60`；每个 call明确使用 90s tool
   timeout，不用单个未声明 timeout 的 `sleep 300`；
6. `check "$QUESTION_ID"`：answered → `unpark` 并处理 verdict/response；非零或
   不可解析 → `unpark` + terminal `review_wait_poll_error`；
7. 如果仍 pending，再查
   `pending --lead "$FLYWHEEL_LEAD_ID" --json`：非零或不可解析同样是
   `review_wait_poll_error`；成功且同 qid仍 open时，重新执行 Step 4 的完整 park命令，
   然后明确回到 Step 5；
   qid消失时再 `check` 一次消除 response race；第二次仍 pending才认定
   expired/resolved-without-response，`unpark` 后写 terminal `review_gate_expired`；
8. 任一 sleep/CommDB poll error不得 tight-spin；`unpark` 并写 terminal
   `review_wait_poll_error`；
9. 任意 shell exit path用 trap/best-effort cleanup 避免留下未清 marker（bounded lease
   仍是 crash backstop）。

旧 Do NOT 列表的真实文本是：

```text
- Keep retrying indefinitely — max 2 CI fix attempts, 30min wait timeouts
```

v0.4.0 应改成：不允许 unbound retry；bound gate wait 由 gate TTL、adapter wait cap 和
bounded park lease 管理。不要搜索一个不存在的 `Do NOT keep retrying indefinitely`
句子。

## 8. Test Design

### 8.1 PR-B Guard

`scripts/skill-guard.sh` 用 byte-exact anchors 检查：

- full command
  `park --until 10m --reason "flywheel-land awaiting review gate"`；
- full cadence text
  `five sequential sleep 60 Bash tool calls` +
  `Give each call a 90s tool timeout`；
- explicit `rerun park and repeat from step 5`；
- post-check exact-qid pending revalidation；
- `pending --lead "$FLYWHEEL_LEAD_ID" --json` unique recovery；
- `unpark`；
- `review_wait_unbound`；
- `review_gate_expired` 与 `review_wait_poll_error`；
- `ci_timeout` 仍存在；
- bound branch 保持 `status":"pending`；
- 旧 `Review wait timeout (30min).*review_timeout` 不再存在。

不要用 bare `5m` token；会误匹配 `45m` 或无关 prose。

### 8.2 Production Compatibility

自动化：

- 保持/扩展 TmuxAdapter CommDB waiting tests，证明 open question 时 active elapsed
  不增长、close 后继续、heartbeat poll 不停；
- 保持 Codex goal runtime `isWaiting` open→close 的 monotonic deadline tests；
- park CLI test 证明 10m lease + 5m renewal，不改变 question response；
- skill guard 证明 unbound path fail-closed。

QA smoke（缩短 30m/5m 常量或用 test fixture，不真实等待 30m）：

1. claude-tmux：bound gate → park → deadline 跨越 → response → same pane继续；
2. codex-tmux：bound gate marker → park → deadline 跨越 → response → same thread继续；
3. 两者都确认 land signal 在 wait 中 pending、最终 unpark；
4. claude-tmux abandoned gate：expiry后 `check` 即使仍显示 pending，pending JSON已
   不含 qid，必须 unpark并 terminal `review_gate_expired`；
5. GitHub-only/unbound review 到点 terminal `review_wait_unbound`；
6. 任一 bounded sleep或 `check/pending` 非零/不可解析不 tight-spin、不误报 expiry，
   terminal `review_wait_poll_error`；
7. CI no-progress 仍 `ci_timeout`。

### 8.3 Dormant Direct Contract

fake clock + fake child + hermetic CommDB：

| 场景 | 预期 |
|---|---|
| no DB / no gate | active timeout kill |
| checkpoint-less ask | kill |
| pending review/generic gate | active time pauses；kill=0 |
| gate response | same child继续；remaining active budget resumes |
| probe exception | warning + normal timeout |
| one wait >49h | kill |
| repeated open/close | cumulative active budget不刷新 |
| wall clock > outer cap | kill |
| child success | timers clear；single settle |

这些 tests 是 future contract，不是 production incident acceptance。

## 9. Compatibility and Rollout

| Direct adapter A | Skill B | 当前 production | Future direct path |
|---|---|---|---|
| A0 | B0 | baseline；bound review 30m stop | future path无 wait supervisor |
| A1 | B0 | 无变化 | supervisor ready，旧 skill仍可自停 |
| A0 | B1 | **事故已修**；live tmux承接 park/retry | 未注册，暂无 runtime |
| A1 | B1 | 事故已修 | future activation具备两层 contract |

结论：

- PR-B 是 current priority，可独立 deploy/rollback；
- PR-A 是正交 dormant hardening，不是 PR-B prerequisite；
- FLY-1253 不新增 direct registry/backend selector；
- 未来若正式激活 direct adapter，再单独做 rollout gate 与 rollback；
- 当前 skill rollout 后用 claude-tmux/codex-tmux canary 验证，不用 dormant fake
  evidence代替。

## 10. Risks

| 风险 | 控制 |
|---|---|
| 把 dormant adapter 当事故根因 | reachability section + PR-B independent acceptance |
| unbound GitHub review 无限 park | exact `QUESTION_ID` precondition；否则 `review_wait_unbound` |
| 任意 ask 获得 direct lifetime | direct supervisor只用 blocking-gate predicate |
| live Tmux broad predicate被误改 | 明列 out-of-scope，保留现状 |
| repeated gates无限刷新 active | cumulative active budget + absolute outer cap test |
| child crash留下 park | 10m lease + cleanup/unpark |
| park期间被 watchdog判死 | adapter heartbeat + declared park，双重 smoke |
| CI timeout被误删 | byte-exact guard + negative control |
| reviewer active cap被误改 | diff audit `claude-review-runner.ts` unchanged |
| 两仓路径编辑错 | flywheel repo当前 worktree；skill repo使用独立临时 worktree |

## 11. Lead Decisions

Lead 第一轮批准的行为边界仍有效：普通 execution/CI timeout 不动；有 bound gate 才
park；response 后同 runner继续；fake-clock回归；design phase只交文档。

reachability 审计后 Lead 又明确更正：

- FLY-1225 是 codex-tmux + skill policy stop；
- PR-B 为真修；
- PR-A 保留为 dormant future hardening，不注册、不接线；
- 撤销旧 A→B 顺序；两项正交，PR-B 独立优先/回滚。

本 research 以更正后的证据和指令为准。

模型分配同样锁定：Design/Implement 使用 Codex `gpt-5.6-sol` xhigh，Design 由
`FLYWHEEL_THREE_STAGE_CODEX_DESIGN` 开关选择，QA 使用 Claude Opus；本单不产生
model/config/effort delta。
