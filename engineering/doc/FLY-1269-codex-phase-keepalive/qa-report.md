# FLY-1269 Codex Resident Phase 529 E2E — Implement Evidence

Issue: [FLY-1286](https://linear.app/geoforge3d/issue/FLY-1286/qa-fly-1269-codex-常驻三段式-529-room-真机-e2edesigncodex-implementcodex)
日期: 2026-07-15
基于: FLY-1269 PR #604 candidate `cad61a07894a98d808aea5b948830f12cfdcff83`

## Verdict

**IN PROGRESS — IMPLEMENT EVIDENCE PASS；QA RESIDENCY 与 TERMINAL CLOSEOUT PENDING。**

fresh successful chain 已完成 Implement 负责的三项核心真机证明：

1. Design phase 在 handoff 后以同一 execution/thread/goal 进入 paused hold，63.258 秒内
   goal budget 与 phaseHold remainder 完全冻结，StateStore heartbeat 持续前进；
2. 在 execution-private socket、shim process group、paused goal 与 Implement TURN 全部
   fail-close 前置成立后，只对 Design detached daemon group 注入一次 SIGKILL；controller
   在 3.736 秒内以新 shim/PGID 恢复，同一 thread/goal/hold/TURN 未变，并再次冻结
   63.185 秒；
3. Lead 只发送一条真实 Design mailbox instruction；durable wake row 唯一绑定该 instruction，
   Design 真实执行 TURN 得到 `not-yours ... phase=implement epoch=4`，未触碰 worktree，
   re-park 后建立新的 paused hold，并再次冻结 63.284 秒。

Implement 不能自证 A5，也不能在 terminal cleanup 后观察 A7。因此当前不写
`PHASE PASS — TERMINAL CLOSEOUT PENDING`：该 pre-terminal verdict 只能由 QA Opus 在完成
A1–A6/A8 独立复核后写入；FINAL PASS 仍只能由 issue 外 FLY-1269 closing session 在 A7
request/ack/delete observer 闭环成立后写入。

## Runtime Attestation

| Evidence | Value | Result |
|---|---|---|
| Production PR #604 head | `cad61a07894a98d808aea5b948830f12cfdcff83` | pinned |
| Candidate worktree head | `cad61a07894a98d808aea5b948830f12cfdcff83` | pinned |
| Parked-boundary fix | `7d20e4a76d718efd6d6fbb440dec2dd8bdf66c6d` | ancestor |
| Bridge listener | PID `96935`, cwd FLY-1269 QA worktree | current listener |
| Estimated Bridge start | epoch `1784110600` | after source/dist mtimes |
| Source/dist mtimes | `1784110558` / `1784110560` | loaded fixed artifacts |
| Dist semantic check | `observeBoundary()` → parked branch → `enterPhaseHold()` | present |

旧 `bridge.log` boot line 没有用作当前进程证明。observer 的 real `--once` 运行前后，
StateStore/CommDB 及 WAL/SHM 的 mutation oracle 完全一致，证明读取使用
`sqlite3 -readonly` + `PRAGMA query_only=1`。

## Successful Chain Identity

| Plane | Design | Implement |
|---|---|---|
| Execution | `464064c0-a711-4aa7-9426-5633dcef590d` | `1ba0f0f1-928c-4aaa-aa5f-5782a54a37ad` |
| Role/backend | `design / codex-tmux` | `implement / codex-tmux` |
| Model | `gpt-5.6-sol` | `gpt-5.6-sol` |
| Thread | `019f654c-e651-71c2-9ab9-c4e68bcdcfd5` | `019f6579-9da9-7882-8ef2-29bfc50e692c` |
| Goal | `d05c8f51-0db3-4029-982d-d293e4347044` | `4ffe8b18-dcb8-4b6a-9155-46031750276e` |
| TURN epoch | `3` | `4` |

首次 A2 FAIL 的 Design `c552669e-…` / Implement `e854cc74-…` 只保留在
`priorAttempts`，其 immutable evidence anchor 为 `ec78d79239f3cb61916f876f58855dcfccb89679`；
它们未混入本次 successful chain。

## Design Residency

handoff 后的联合证据：

- StateStore: `design_done`、`codex-tmux`、role `design`、heartbeat advancing；
- CommDB: declared `parked`；
- session latch: `phaseHold.state=paused`；
- native goal: same goal id、`status=paused`；
- tmux: live pane，redacted capture status anchor 为 `gpt-5.6-sol xhigh — Goal paused`；
- socket: `/Users/xiaorongli/.flywheel/cdx-sock/d159c5c4c11eff43.sock` connectable，
  holder PGID 与 persisted shim 一致；
- TURN: Implement exec / phase implement / epoch 4，三个冻结窗口内均未漂移。

### Freeze windows

| Window | Duration | PID/PGID | Tokens | Goal time | Goal updated_at | phaseHold |
|---|---:|---:|---:|---:|---:|---|
| pre-crash | 63.258s | `26476` | `562219 → 562219` | `3126 → 3126` | `1784114094257` stable | `11:14:54.236Z` stable |
| post-recovery | 63.185s | `88885` | `562219 → 562219` | `3126 → 3126` | `1784114559736` stable | `11:14:54.236Z` stable |
| post-wake re-hold | 63.284s | `88885` | `565978 → 565978` | `3156 → 3156` | `1784114820643` stable | `11:27:00.624Z` stable |

每个窗口 heartbeat 都前进；execution/thread/goal、socket holder group 与 TURN 都保持不变。

## Crash Recovery

`2026-07-15T11:22:36.000Z` signal 前重新验证：execution/issue/thread 正确、phaseHold 与
native goal 都 paused、socket connectable、`lsof -Fpg` holder group 为 `26476`、Implement
仍持有 epoch 4 TURN、wake count 为 11、fresh live Design count 为 1。全部成立后只执行：

```text
SIGKILL process group 26476
```

native goal `updated_at_ms=1784114559736` 对应
`2026-07-15T11:22:39.736Z`，给出正确 UTC bounded recovery latency `3736ms`。恢复结果：

- new shim/PGID/socket holder = `88885`；old group 无进程、无 socket holder；
- execution/thread/goal/phaseHold 均未换；
- TURN 仍为 Implement epoch 4；
- wake count 仍为 11；fresh live Design count 仍为 1；
- tokens/time 不重置、不增长；随后 63.185 秒 freeze 再次成立。

## Mailbox Wake

- Lead ask question: `4bc1ae9b-a137-4ca5-8adf-5e1ce97c9e15`；
- CommDB instruction: `c18f4e2b-f7c4-4ea7-a51d-a12ed4eb4716`；
- transport message: `2219c21e-4d3f-4357-b999-b18a0b4397ed`；
- wake queue seq: `12`；
- queued/started/finished: `1784114790554 / 1784114790554 / 1784114790573`；
- exact instruction count = 1；exact source-bound wake row count = 1；
- TUI ground truth: `not-yours holder=1ba0f0f1-... phase=implement epoch=4`；
- declared state 更新为 `FLY-1286 WAKE_PROBE handled; three-stage design parked until ship`；
- same goal 在 bounded wake 中 tokens `562219 → 565978`、time `3126 → 3156`，然后
  以新 `phaseHold.enteredAt=2026-07-15T11:27:00.624Z` 返回 paused；
- 新 hold 的 63.284 秒 freeze 完整通过。

## Acceptance Matrix

| ID | Verdict | Evidence |
|---|---|---|
| A1 locked dispatch | IN PROGRESS | Design/Implement 均为 Codex `gpt-5.6-sol`；Implement xhigh 由 QA 从 argv/TUI 独立复核；QA Opus 尚未 spawn。 |
| A2 Design resident | **PASS** | same exec/thread/goal、five-plane paused hold、pre-crash 63.258s freeze。 |
| A3 crash recovery | **PASS** | PGID `26476 → 88885`，3.736s bounded recovery，同 identity/hold/TURN，post-recovery 63.185s freeze。 |
| A4 mailbox wake | **PASS** | one instruction → one finished wake；TURN `not-yours`；same goal re-hold；63.284s freeze。 |
| A5 Implement resident | PENDING | 必须在 Implement complete+park 后由 QA 反向观察 ≥60s。 |
| A6 TURN chain | IN PROGRESS | fresh Design epoch 3 → Implement epoch 4；QA 必须捕获更大的稳定 epoch。 |
| A7 terminal shutdown | PENDING | 外部 observer 必须在 terminal 前捕获两个 Codex phase 的 request/ack/delete 与无 orphan。 |
| A8 isolation | PASS TO IMPLEMENT BOUNDARY | mutation 只在 per-exec runtime、test-slot-2、gate marker 与 qa-sandbox evidence allowlist；无 production source/config 改动。 |

缺失项不计 PASS；当前 overall 仍为 `IN_PROGRESS`。

## Observer Regression

terminal observer syntax 通过，17/17 fixture tests 通过，覆盖 request→ack、首次采到 ack 的
durable same-id corroboration、missing ack fail-close、direct_proven rerun、真实 exit-1
indeterminate liveness、initial tmux binding fail-fast、live→server-gone、dead tmux pane、
raw/canonical socket alias、benign lsof warning、evidence-change-only `lsof` cache、stable
snapshot dedupe、旧 attempt 过滤、TURN/QA cleanup、socket orphan 与 read-only WAL 行为。
real `--once` 也在 `0.26s` 内通过，并解析出 Design holder PID `88885` 与 Implement
holder PID `54044`。

Implement head 的 fresh narrow regression：

- terminal observer: 17/17 passed，duration `28.494s`；
- `codex-phase-lifecycle` + daemon client/runtime: 89/89 passed，duration `1.890s`；
- three-stage routing/config table: 22/22 passed，duration `1.230s`；
- production PR #604 head 与 candidate worktree 均重新核对为 pinned `cad61a078`；
- evidence JSON parse、scope guard 与 `git diff --check` 通过。

## Safety / Scope

- 没有修改 `packages/**`、workflow、runtime config 或 production script；
- fault injection 只 signal 已证明属于 Design execution 的 detached process group；
- mailbox wake 由 Lead 发送，Implement 没有冒用 Lead 身份；
- 没有操作 production PR #604；
- structured raw evidence 在 `qa/529-e2e-chain.json`；
- 下一步由 QA Opus 独立复核 A1–A6/A8、观察 Implement resident hold，再 arm external
  terminal observer。Issue terminal 前不得写 FINAL PASS。

## QA Opus Independent Verdict — FAIL (round-3 findings unresolved)

QA exec `aad2f2a7-ad02-4e34-b933-7ae539af1dfa`（phase=qa, TURN epoch 5）复核 head
`1afa999a0cfedb3bbbb1c753130b366db7e7e098`。Lead 把 review round-3 的三条 findings 设为
terminal approval 前的硬性 QA 验收标准（comm inbox `577c9cd7-...`）。对
`qa/529-terminal-observer.mjs` 与 `qa/529-terminal-observer.test.mjs` 做确定性结构核查后，
**三条全部未满足 → QA FAIL**。TURN 交回 Implement 修复 + 新一轮 code review。在解决前
**不 arm terminal observer、不开 founder approve gate、不进入 A7 terminal closeout**。

| Finding | Criterion | Status | 关键位置 | Severity |
|---|---|---|---|---|
| C1 indeterminate-liveness 测试 clobber lsof marker + 依赖 lastPresent 时序 | 1 | **FAIL** | test `:655-689`（`clearSockets` `:679`/`:414-421`）；observer `classifyExecution` lastPresent `:384-395` | High |
| C2 startup arming one-poll abort（无 bounded retry window） | 2 | **FAIL** | observer arming `:587-616`（`return 1` `:613`）；test `:737-753` 锁定 fail-fast `:748` | High |
| C3 holder evidence 无 observedAt freshness | 3 | **FAIL** | observer `probeHolders` `:233-243`、holder 缓存复用 `:529-546`、赋值 `:545`（对照 shutdown `observedAt` `:317`） | Medium |

次要 reproducibility 备注：本机 `node --test` observer 回归 = **11/17 pass, 6 fail**
（duration 45.4s，日志 `qa/qa-round3-test-run.txt`），未复现本报告上文宣称的 "17/17"。
6 个失败多为高负载下假探针（fake `tmux`/`lsof` 皆 node 脚本）令 observer 迭代过慢的
`observer did not exit` 超时伪影，非 FAIL 主依据，但 qa-report 的 17/17 声称在本 QA 机器上
不成立，Implement 修复时宜一并降低每帧探针开销 / 放宽 fixture 时序假设。

详见 `qa/qa-round3-verdict.md`（逐条 expected-vs-actual 与 required actions）。

## QA Opus RE-TEST Verdict — PHASE PASS — TERMINAL CLOSEOUT PENDING (round 4)

QA exec `aad2f2a7-...`（phase=qa, TURN epoch 7）在 Implement 推修复 head
`1f12c3fb8f255e6795b58d57a9ee40b61cf925c8` 后复验。**三条 round-3 findings 全部修复，
full 529 observer 回归功能性全绿，Design+Implement resident liveness 重新确认 → PHASE PASS。**
A7 terminal request/ack/delete + FINAL PASS 仍留给 issue 外 FLY-1269 closing session。

### Round-3 findings — all RESOLVED（结构核查 + 测试实证）

| Finding | Fix at `1f12c3fb` | 验证 |
|---|---|---|
| C1 indeterminate-liveness clobber + lastPresent 依赖 | 测试改为只 `closeSocket`（不 rewrite lsof.json，保留 `indeterminate` marker），断言精确 `liveness_indeterminate:design-success:lsof`（cleanup-phase 守卫，非 lastPresent 派生） | `fails closed when direct-path liveness is indeterminate` 通过 |
| C2 one-poll abort | observer 新增 `armingAttempts`/`armingDeadlineAt`（默认 5 次 / 10s，可 `--arming-attempts`/`--arming-timeout-ms`）；`initialFailure` 仅在超过 bound 才 fail，否则 `sleep+continue`；fail verdict 带 `arming{attempts,maxAttempts,timeoutMs,deadlineAt}` | `retries transient startup liveness before arming`（瞬时抖动后 arm，verdict undefined）+ `fails closed after bounded startup retries`（arming.attempts===3）均通过 |
| C3 holder 无 observedAt | `probeHolders` 给 present/absent/indeterminate 全部盖 `observedAt` ISO 时间戳；缓存复用保留原采样时刻 | `timestamps holder evidence and preserves its sample time while cached` 通过 |

### Observer regression（full committed 529 harness）

- RED：旧 committed short-deadline harness 在 loaded 529 host 为 **13/19**；六个失败均为
  `cleanup_not_observed` / `observer did not exit` timeout。
- GREEN：`3b183e70` + `864303e2c959a3cdaf364f414524ae6ae5ac714f` 仅放宽 fixture
  observer/wait/exit/test deadlines（含 round-6 指出的 lifecycle-cleanup explicit literals），
  不改 production observer defaults、probe 逻辑或任何 assertion。
- 在该 exact commit 运行 committed command
  `node --test engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.test.mjs`：
  final exact-source run `2026-07-15T13:54:28Z` → `13:55:28Z`，`60139.824833ms`，
  **19 pass / 0 fail**。

### Locked three-stage chain (runtime-attested)

| Plane | Design `464064c0` | Implement `1ba0f0f1` | QA `aad2f2a7` |
|---|---|---|---|
| StateStore | `design_done` / codex-tmux / role design / `gpt-5.6-sol` | `awaiting_review` / codex-tmux / role implement / `gpt-5.6-sol` | `running` / **claude-tmux / qa / claude-opus-4-8** |
| declared | `parked` | `parked` | — |
| phaseHold | `paused` (enteredAt 11:27:00.624Z) | `paused` (enteredAt 13:05:23.365Z) | — |
| native goal | `paused` goal `d05c8f51` tokens 565978 / time 3156 | `paused` goal `4ffe8b18` tokens 949749 / time 5843 | — |
| daemon/socket | pid/pgid `88885`，socket `d159c5c4…` connectable，holder 88885 | pid/pgid `54044`，socket `6d3a98f0…` connectable，holder 54044 | — |
| xhigh | — | argv `model_reasoning_effort="xhigh"` + TUI `gpt-5.6-sol xhigh … Goal paused` | — |
| tmux | live (pane_dead=0) | live (pane_dead=0) | — |

**73-second authoritative two-sample freeze**（13:44:19 → 13:45:32）：两次实际 evidence query
均为 live `goals_1.sqlite` 上的 `sqlite3 -readonly` + `PRAGMA query_only=1`，没有使用
`immutable=1`。Design goal 保持 `paused / 565978 / 3156 / 1784114820643`，Implement
保持 `paused / 949749 / 5843 / 1784122323318`；heartbeat 分别前进到 `13:45:30` / `13:45:29`，
socket holder pid `88885` / `54044` 稳定。完整命令、模式、时间戳见
`qa/qa-round4-evidence.md`。

### Acceptance matrix (QA re-audit)

| ID | Verdict | Evidence |
|---|---|---|
| A1 locked dispatch | **PASS** | Design/Implement `gpt-5.6-sol`（codex-tmux）；Implement xhigh（argv+TUI）；QA `claude-opus-4-8`（claude-tmux, role qa）。 |
| A2 Design resident | **PASS** | same exec/thread/goal、five-plane paused hold、60s freeze、heartbeat advancing。 |
| A3 crash recovery | **PASS (Implement evidence + re-confirmed)** | qa-report PGID `26476→88885`；recovered daemon 88885 现仍 resident/paused。 |
| A4 mailbox wake | **PASS (Implement evidence + re-confirmed)** | one instruction→one finished wake；declared `FLY-1286 WAKE_PROBE handled…`；re-hold frozen。 |
| A5 Implement resident | **PASS** | paused hold、goal paused、live tmux/socket/pid+holder、60s freeze。 |
| A6 TURN chain | **PASS** | design epoch 3 → implement 4 → **qa 7**，严格递增，QA 稳定持有。 |
| A7 terminal shutdown | PENDING（external） | issue 外 FLY-1269 closing session 用 armed observer 捕获 request/ack/delete + no-orphan。 |
| A8 isolation | **PASS** | `1f12c3fb` 仅改 `qa/529-terminal-observer.{mjs,test.mjs}`，无 `packages/**`/config/workflow 改动；全部写落 FLY-1269 qa/evidence + FLY-1286 docs。 |

**verdict = PHASE PASS — TERMINAL CLOSEOUT PENDING**（唯一 pending = A7 external）。据此
emit `qa-result --status pass`，随后 arm external terminal observer 并按 approve gate 流程
请求 founder 审批 sandbox PR #58。FINAL PASS 仍只由 issue 外 FLY-1269 closing session 在
A7 闭环后写入。
