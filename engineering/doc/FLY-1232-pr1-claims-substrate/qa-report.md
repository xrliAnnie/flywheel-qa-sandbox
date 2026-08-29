# FLY-1232 子单 A：claims substrate + 影子并行写 — QA 验收报告

Issue: FLY-1232 (https://linear.app/geoforge3d/issue/FLY-1232)
日期: 2026-07-13
基于: plan.md（验收矩阵 A1–A13 / B1–B11）+ 本分支已提交实现（PR #578, head 71a1e60bf）

> 三段式 pipeline QA 阶段：独立复验 implement 阶段在本分支的提交，不重跑其自报即当通过。
> 终验在 R9-APPROVED head **9e37006f7** 之上进行（QA 收口 commit @ **4c1568cf7**；CI 绿）。
> 结论：**PASS（A1–A13 / B1–B11）**。B11 的 fresh-spawn 以 RunDispatcher.start seam + 真证据链验证；
> 全真 tmux spawn 是启用前置 gate（Lead 裁定 A，2b3a46ed，§4.2 三段边界；推迟非豁免）。substrate 全部
> default-off、字节兼容；无生产读路径接线；全套单测绿；tsc/lint 干净；全仓 teamlead vitest 无 FLY-1232
> 引入的新增失败（27 例预存失败逐一核实均为环境性/预存红，与本 PR 无关）。新增两支独立 QA 验收测试
> （probe 7 测 + B11 fresh-spawn 2 测，全绿）补最强安全断言 + B11 生产 seam 证据链（见 §4.2）。

## 1. 验证方法

- **代码审计**：逐读 substrate（workflow-claims.ts / StateStore.ts 6 表 DDL + 触发器 + submit/
  resolve/system-claim + 影子 batch + ②b 状态机）与全部生产接线 diff（run-dispatcher pre-launch
  seam / phase-orchestrator T3–T6 / plugin.ts 单一开关点 / run-infra / post-ship T9 /
  DirectEventSink / TmuxAdapter 注释）。逐点核对转移表合同与 flag-OFF 字节兼容 guard。
- **单测复跑**：workflow-claims(43) + doc-sentinel(3) + StateStore.workflow-shadow(27) +
  shadow-writer(32) + shadow-wiring(9) + post-ship-finalization(30 内含) → 全绿。
- **全仓复跑**：`vitest run`（teamlead 全套）→ 6657 passed / 27 failed / 16 skipped。
  27 例失败逐一定位（见 §3）。
- **静态检查**：`tsc --noEmit`（teamlead + claude-runner）零错；`biome check` 触碰的 11 个源文件
  + 新 QA 测试文件干净。
- **B11 fresh-spawn 终验**：新增 `bridge/__tests__/workflow-b11-freshspawn.test.ts`（2 测），驱真
  `RunDispatcher.start()` 生产 seam + 真 marker 文件 + 真 CommDB 收口 fresh-spawn 证据链（§4.2）。
- **独立行为 probe**：新增 `StateStore.workflow-qa-fly1232.test.ts`（7 测），以 QA 视角、不同数据、
  更强角度独立复验关键不变量（不是复制 implement 断言）。

## 2. 验收矩阵结论

### 段①（A1–A13）— claims substrate

| # | 项 | 结论 | 证据 |
|---|----|------|------|
| A1 | 6 表 DDL 符合 §2.1/§2.2/§3.1b | PASS | StateStore.ts:7936-8067 逐列核对；typed enrollment 列在 workflow_run |
| A2 | 三账本表 UPDATE/DELETE 被 DB 层 RAISE(ABORT) 拒 | PASS | 触发器 8052-8067；QA probe 独立复验（reopen 真库，6 条 UPDATE/DELETE 全 throw /append-only/）|
| A3 | capability 无明文 token 列，只存 sha256 | PASS（**加强**）| 列层 implement 已测；QA probe 新增**整库文件字节扫描**：明文 token 全库不存在、仅 sha256 存在 |
| A4 | E3(a) 幂等重放 / E3(b) 异 payload·过期·stale 拒 / E3(c) 无凭证拒 | PASS | submit 单事务 8492-8667；shadow/claims 单测覆盖 |
| A5 | 拒绝路径零残留 | PASS | 全部 fail-closed 分支在 db.transaction 内提前 return，无写入 |
| A6 | 解析绝不回落旧 attempt | PASS | resolve 8835-8889 取最高 attempt/seq；QA probe：attempt1 PASS→attempt2 FAIL→gate invalid(not_pass) |
| A7 | E6 同 family review 拒 / 缺 producer 拒 | PASS | submit 8595-8606 same_vendor_review / missing_subject_producer |
| A8 | 系统 claim allowlist 双向锁 + subject_kind 强制 | PASS | appendWorkflowSystemClaim 8690-8706 |
| A9 | 续期 ≤ absolute_deadline；过期/consumed/revoked 不可续 | PASS | renew 8423-8473 |
| A10 | 3 flag 默认 OFF 且独立；enrollment 只认显式入参 | PASS | workflow-claims.ts 139-151；QA probe：仅字面 "1" 生效 |
| A11 | doc sentinel 3 测绿（含突变自检）+ 伞单文档钉 9ed7ea69e 先于代码 commit | PASS | plan.md 与 9ed7ea69e 逐字一致；docs commit c3be33d3e 先于 code commit 6670450a6；sentinel 有 mutation 自检且直读文件（缺目录会抛非 skip）|
| A12 | 字节兼容反向哨兵 | PASS | 见 B1 |
| A13 | 硬化四项（非有限时间戳拒 / 签发 cap / system claim issue 身份从 run 派生 / 各配负测）| PASS | workflowFiniteTimestamp 8093 + issue cap 8314 + system claim 8734 |

### 段②（B1–B11）— 影子并行写

| # | 项 | 结论 | 证据 |
|---|----|------|------|
| B1 | flag OFF：接缝 undefined、零 workflow 写、fresh 路径 launchCommitPath 仍 undefined | PASS | run-dispatcher seam 全被 `this.workflowShadow` 门控；shadow-wiring B1 哨兵测试；QA probe：writer 工厂无 flag 返 undefined |
| B2 | flag ON：转移表 T1–T9（含 T3b）逐行；spawn/wake 两交接都含 edge | PASS | shadow-writer.test(32) + wiring(9) |
| B3 | attempt/ordinal 五案例 + uid 命名空间双撞车 + crash 换 execId | PASS | shadow-writer/shadow 单测；ordinal 仅 writer 事务内分配 9420-9442 |
| B4 | 重放幂等 + reconcileOnStartup 按持久源逐行回填 + 声明缺口不误报 | PASS | reconcileOnStartup 491-617；listWorkflowRunAttributedFixRounds 执行归属 |
| B5 | 影子事务失败 ⇒ 回滚 + loud warn + 生产零影响 | PASS | safe() 148-163 never-throw |
| B6 | 逐语句故障注入 ⇒ 全量回滚零撕裂，随后重放成功；无绕过 batch 的写面 | PASS | applyWorkflowShadowBatch 单事务；QA probe（真文件端到端）：合法 batch 在事务**中途**抛（op#1 已写后 op#2 throw）→ 基线 1/1 保持、op#1 全回滚、raw reopen 证回滚**耐久**；随后**重开同一文件**经 StateStore 重放干净 batch → 成功（同 run、writer 分配 ordinal、uid 合式）且再重放幂等去重 |
| B7 | ②b 真值表：indeterminate/lookup_error 保持；started=marker∧非pending 双证据；Codex 行在 marker 缺⇒停 intent_recorded；execution_id 不可改写 | PASS | transitionWorkflowSideEffectTx 9455-9509 + identity_immutable 触发器 8973 + onDispatchFailed 355-411 三态 |
| B8 | 对账零副作用 | PASS | reconcileSideEffects 无 spawn/wake/Blueprint 调用面 |
| B9 | 事件 kind 全在 §3.1b 词汇，无自造 kind | PASS | finalize 为 projection-only（无 event）；side-effect 转移不追加 run_event |
| B10 | 活影子 run 唯一（部分唯一索引）；T9 双路径都推出 active | PASS | idx_workflow_run_active 8982；T9 hook + claim 兜底 reconcile |
| B11 | flag ON 真机演练：6 表落行 + append-only 拒改 + ②b 证据推进(达 started) + 一次性凭证 + flag=0 对照 + **fresh-spawn seam** | **PASS（default-off 合并范围;Lead 裁定 A，§4.2 三段边界）** | (a) truth-table 演练 qa-fly1232-flagon-drill.mjs 真 dist 25/25(§4.1);(b) **fresh-spawn seam** workflow-b11-freshspawn.test.ts 2 测绿(§4.2)——真驱 **RunDispatcher.start()** + 真 fresh-path `launchCommitPath` 传递 + 真 marker 文件 + 真 CommDB + 真 reconcileSideEffects → started;start 成功不伪造 started;无 writer→launchCommitPath undefined。**真 Blueprint.run/TmuxAdapter 不在本测试内跑**——marker-write 由 callback 代演(该步=FLY-245 已审 commit-gate,retry 生产在用;FLY-1232 新增=fresh 路径走它,已验)；全真 tmux spawn = 启用前置 gate（Lead 钉入 Linear 收尾+子单 B，推迟非豁免） |

## 3. 全仓 27 例失败定位（均非 FLY-1232 引入）

FLY-1232 触碰文件：StateStore / workflow-claims / workflow-shadow-* / phase-orchestrator /
run-dispatcher / retry-dispatcher / run-infra / post-ship-finalization / plugin / DirectEventSink /
TmuxAdapter + 新测试。**27 例失败无一落在上述文件或其被测源**。

| 失败文件 | 例数 | 根因 | 复核 |
|----------|------|------|------|
| codex-lead-runtime.test.ts | 22 | runner TMPDIR/browser-tmp 落在 `~/.flywheel` 下，触发 FLY-245 confinement「workspace 不得 overlap ~/.flywheel」正当拒绝 | **换干净 TMPDIR 复跑 → 全绿**（已验）；记忆库 reference_qa_codex_lead_runtime_tmpdir_overlap 记载的环境性假失败 |
| lead-rules-bundle.test.ts | 2 | 同上（CODEX_HOME 在 browser-tmp 下）| 换 TMPDIR → 全绿 |
| createLeadRuntime-preflight.test.ts | 2 | 23-worker 并行下 STACK_TRACE 超时 flake（单测 1870ms）| 单文件隔离跑 → 4/4 绿 |
| stuck-candidate.test.ts | 1 | FLY-1048 stuck 检测 env-gated 断言（output_changing）预存红 | 该测试 + 其源 stuck-candidate.ts **与 main 逐字一致**，只 import 未改动代码 → 结构上不可能由 FLY-1232 引入 |

24/27 由「runner 会话 TMPDIR 在 ~/.flywheel 下」触发（我作为 Flywheel runner 运行，TMPDIR 即在该目录），
换 TMPDIR 后消失；余 3 例为并行超时 flake（2）+ 预存红（1）。**无新增失败。**

## 4. B11 — flag-ON 真机演练（module-driven，Lead 硬标准）

Lead（Tadashi）硬标准：default-off 影子基建的 QA 必须含**一次 flag-on 真机演练**（Annie 两次
在 gate 上打回过纯代码级 QA）。据此在**隔离环境**用 **#578 真 dist**（`packages/teamlead/dist`，
非 vitest 转译 src）跑 `qa-fly1232-flagon-drill.mjs`：隔离 StateStore 文件 + 隔离 TMPDIR，
`FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1` 经 `createWorkflowShadowWriterFromEnv` 构真 WorkflowShadowWriter，
驱一条真实派发链（T1 design → T4 → T2 implement → T4 → T2 qa → T5 QA PASS → T9 finalize）过影子写入器。

**结果:25/25 checks green**（终端全量证据在 §4.1）：

- **① claims 账本 6 表真落行**:真派发链落 `workflow_run`(active) + `workflow_run_node`×3
  (design/implement/qa) + `workflow_run_event`×9(node_dispatched/edge_traversed/node_completed)
  + `workflow_side_effect_ledger`×3(dispatch intent, writer 分配 ordinal 均=1);capability 流又落
  `workflow_decision_capability` + `workflow_claims` + `workflow_claim_revocation`。**append-only 触发器
  真拒改写**:真库 reopen 后 6 条 UPDATE/DELETE 全被 RAISE(ABORT) 拒(`/append-only/`)。
- **①b ②b 证据真值表真推进(Codex R5 加固)**:在真机上写**真实的 on-disk marker 文件** + 真
  reconcileSideEffects 驱动 research §F.3 真值表——**双证据(marker ∧ 已证非 pending 行)→ started(终态)**、
  **仅 marker / row=unknown → launch_committed(绝不 started)**、**无 marker → 停 intent_recorded(缺席绝不伪造历史)**。
  不再用恒 false 的 stub,真机上真的走到 started。
- **② decision capability 一次性消费真只认一次**:首 submit 消费(ok);同 payload 重放=幂等
  (同一 claimId 无新行);**异 payload 在已消费 token 上=fail-closed**(`replay_payload_mismatch`);
  全程恰 1 条 claim 行。凭证只存 sha256(无明文列)。
- **③ flag=0 路径字节不变(对照)**:同一 dist、`FLYWHEEL_WORKFLOW_CLAIMS_WRITE=0` →
  `createWorkflowShadowWriterFromEnv` 返回 **undefined**(单一开关点),生产 seam 全 inert →
  对照 store 零 workflow 行。这是启用/不启用之间**唯一**的分叉点。
- **T9 双态**:finalize 后 run.status active→completed,同 issue 无活 run 残留。

演练脚本随 PR 携带(`packages/teamlead/qa-fly1232-flagon-drill.mjs`),可复跑:
`node packages/teamlead/qa-fly1232-flagon-drill.mjs`(exit 0 = 全过)。

> 注(范围):本演练(§4.1)验证的是**编译 dist 上的能力真实性 + append-only + 一次性 + 字节兼容 +
> ②b 真值表**——它**直调 WorkflowShadowWriter hooks**,marker 文件为脚本手写、CommDB 行事实来自内存
> Map。它**不单独构成** plan Step 8/B11 要求的隔离真 fresh spawn(RunDispatcher.start→Blueprint.run→
> adapter→launchCommitPath 传递→真 CommDB 注册)。**该 fresh-spawn 生产证据链由 §4.2 的终验收口**
> (Lead 67225a60 ③;Codex R6 HIGH 指出原 drill 以合成证据背书 fresh-spawn,故拆成两段独立证据:
> §4.1 能力真实性 + §4.2 真 fresh-spawn 链)。

### 4.1 演练终端证据（原样）

```
[drill] node dist = ./dist (compiled #578)
PASS  ③a flag=0 → shadow writer factory returns undefined (inert seam)
PASS  ③b flag=0 control store has ZERO active workflow runs
PASS  flag=1 → shadow writer is constructed
PASS  ① T1 created an ACTIVE workflow_run row
PASS  ① workflow_run_node landed 3 nodes (design/implement/qa)
PASS  ① workflow_run_event landed dispatch+edge+complete rows — 9 events
PASS  ① workflow_side_effect_ledger landed 3 dispatch intent rows (writer-allocated ordinals) — 3 rows
PASS  ②b all three launch rows begin at intent_recorded (no evidence yet)
PASS  ②b dual evidence (marker ∧ proven row) advances exec-design → started — started
PASS  ②b marker-only / unknown row advances exec-impl → launch_committed (never started) — launch_committed
PASS  ②b no marker keeps exec-qa at intent_recorded (absence never fabricates history) — intent_recorded
PASS  ② capability issued (plaintext returned once)
PASS  ② first submit consumes the capability (ok)
PASS  ② same-payload replay is IDEMPOTENT (same claim, no new row)
PASS  ② different-payload replay on a consumed token is FAIL-CLOSED (one-shot honored) — replay_payload_mismatch
PASS  ② exactly ONE claim row exists for the run — 1 claims
PASS  ① T9 finalize pushed the run out of ACTIVE
PASS  ① no ACTIVE run remains for the issue after finalize
PASS  ① append-only rejects: UPDATE workflow_claims SET predicate = 'qa_failed'
PASS  ① append-only rejects: DELETE FROM workflow_claims
PASS  ① append-only rejects: UPDATE workflow_run_event SET kind = 'tampered'
PASS  ① append-only rejects: DELETE FROM workflow_run_event
PASS  ① append-only rejects: UPDATE workflow_claim_revocation SET reason = 'x'
PASS  ① append-only rejects: DELETE FROM workflow_claim_revocation
PASS  ① capability persisted only the sha256 (no plaintext token column)
[drill] ALL CHECKS PASSED
```

> Codex code review R5 (QA-delta) raised three issues on the QA artifacts (not the
> substrate): the drill originally stubbed evidence probes so it never reached `started`
> (HIGH), the probe's B6 failed at pre-validation before the transaction (MEDIUM), and a
> count/status mismatch (LOW). All folded: the drill now advances the ②b truth table with
> real on-disk marker files (reaches `started`), the probe now injects a genuine
> mid-transaction failure (a valid op that throws inside the tx after an earlier op wrote)
> and asserts full rollback, and the counts are reconciled (25 drill checks / 7 probe tests).
>
> Codex code review R6 (post-rebase, folded by the implement phase) then held the line on
> evidence honesty: the drill still does not run the production fresh-spawn chain, so B11's
> fresh-spawn clause is now marked **UNVERIFIED** here instead of PASS (HIGH); the B6 probe
> now reopens the SAME on-disk file through StateStore after the mid-transaction rollback and
> replays a clean batch with identity assertions, real-file end to end (MEDIUM); and this
> report's counts/evidence rows were reconciled to the revised tests (LOW). The fresh-spawn
> clause closes in §4.2 below (QA phase's final real-machine verification on the final head).

### 4.2 B11 fresh-spawn — RunDispatcher.start seam + 真证据链（终验,测试 @ 4c1568cf7,基于 R9-APPROVED 9e37006f7）

Lead 67225a60 ③ 要求把 §4.1 的 fresh-spawn 段用真 fresh-spawn 链收口。新增
`packages/teamlead/src/bridge/__tests__/workflow-b11-freshspawn.test.ts`(**2 测绿**),在隔离环境
(独立 file-backed StateStore + 独立 better-sqlite3 CommDB + 真 marker 文件系统)驱动**生产
`RunDispatcher.start()` seam**:

- **flag ON**:`start()` 在 fresh 路径**真设** `ctx.launchCommitPath`(== 生产 per-exec 路径
  `launchCommitPath(execId)` = `~/.flywheel/state/launch-commits/<execId>`)——这正是 FLY-1232 的
  **新行为**(fresh 路径此前不设,flag ON 才设);影子 intent 行在 `Blueprint.run` **之前**落库
  (pre-launch seam);随后 `reconcileSideEffects()` 读**真 marker 文件 ∧ 真非 :pending CommDB 行**
  (双证据,均为真 on-disk 事实)→ 行推进到 **started**。关键诚实断言:**`start()` 成功本身不伪造
  started**——推进前行状态为 `intent_recorded`,只有真证据齐了才 started。
- **byte-compat 对照**:无 writer 时 `start()` 保持 `ctx.launchCommitPath` undefined,字节不变。
- 真 marker 落生产路径(per-execId),`afterEach` 逐一清除,`~/.flywheel` 零残留(已核)。

**证据边界(三段,Lead 裁定 A — 2b3a46ed;Codex R(B11) HIGH 如实采纳)**——本 PR default-off、
合并后生产行为**零字节变化**,故按证据边界分三层收口:

1. **已证(本测证到)**:FLY-1232 的**新增量** = fresh 路径**设** `launchCommitPath` 并传递到底
   (fresh 路径此前不设,flag ON 才设)。本测试用**真部件**证到:真 `RunDispatcher.start()` +
   真 `launchCommitPath` 计算/传递 + 真 marker 文件 + 真 better-sqlite3 CommDB + 真
   `reconcileSideEffects` → started;start 成功不伪造 started。
2. **继承已证(旧机器,已 ship 已审)**:adapter 把 marker 亲写到 `launchCommitPath` 这一步 =
   FLY-245 的 two-phase commit-gate,**retry 路径自 FLY-245 起生产在用、已审已 ship**。本测试由
   blueprint 回调代演这一步(非真 tmux/Claude spawn)——为一个 default-off 零读接线的 PR 重验这台
   旧机器是仪式不是证据。
3. **留待启用门(推迟,非豁免)**:一次**全真 tmux/runner fresh spawn**(真 `Blueprint`+`TmuxAdapter`
   亲写 marker)按 plan §5 风险 7/§8.2 定位为**启用前置 gate**——`FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1`
   真启用前必须跑一次。Lead 已将此钉入 FLY-1232 Linear 收尾评论 + 1135 子单 B 直令(机制化)。**这是
   推迟不是豁免。**

据此边界,**B11 在本单(default-off 合并)范围内收口为 PASS**;全真 spawn 是启用节奏的事,不是本次
合并门槛。

## 5. 结论

**PASS（A1–A13 / B1–B11，default-off 合并范围）** —— 实现忠实于 plan 与验收矩阵；default-off 字节
兼容成立；无生产读接线；append-only / one-shot token 不落盘 / 单事务原子性(真文件端到端含回滚后重放)
/ 解析不回落 等关键不变量经独立 probe 复验；全套单测绿；静态检查干净；全仓无 FLY-1232 引入的新增失败。
**B11 两段真机证据**:(a) flag-ON truth-table 演练(真 dist、隔离)25/25 green;(b) **fresh-spawn seam**
(§4.2,workflow-b11-freshspawn.test.ts 2 测绿)——真驱 `RunDispatcher.start()` + 真 fresh-path
`launchCommitPath` 传递 + 真 marker 文件 + 真 CommDB + 真 `reconcileSideEffects` → started,start 成功
不伪造历史。**证据边界(Lead 裁定 A,§4.2 三段)**:已证=fresh-path 传递新行为;继承已证=FLY-245
adapter 写 marker(已 ship 已审);留待启用门=全真 tmux spawn(启用前置 gate,Lead 钉入 Linear 收尾+
子单 B,推迟非豁免)。合并后生产行为零字节变化,flag-ON 演练即其真机证据。QA 收口 commit @
**4c1568cf7**(基于 R9-APPROVED 9e37006f7)。Codex R5/R6/R(B11) 全部折入,B11 范围按 Lead 裁定 A 收口。
