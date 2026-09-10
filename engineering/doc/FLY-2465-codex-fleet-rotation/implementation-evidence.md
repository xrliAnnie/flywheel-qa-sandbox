# FLY-2465 Codex 舰队自动切号 — 实施证据
Issue: FLY-2465 (https://linear.app/geoforge3d/issue/FLY-2465/2371-根治-codex-舰队级自动切号限额信号-按最早重置挑号-切-codex-重起被收的体全池打满才发-founder)
日期: 2026-09-09
基于: plan.md

## 实施边界

Implement TURN epoch=2 已取得。重新查询 gate `baae6323-533c-4958-baae-833165d537de` 确认 R2 effective APPROVED；与受审 `ddb435a0d` 比较，plan.md 没有变化。用户任务新增三项硬判据（queued/running、安装中断保全候选刷新凭据、暂停老化告警）仍是本次必做项，不改受审计划文件。

## T0 守卫基础（未完成运行时接线）

新增 read-only readiness 模块。输入为每次重新获取的完整、已交叉核对的归属/活性清单；本模块不把目录或 lease 存在当作活体证明，也不自行迁移/切号。

TDD：初始缺少模块红侧；随后增加完整权威/未知归属、正确链接仍有 copy-pending、canonical 权限错误三个行为测试，各自观察 `expected true to be false` 后最小修复。最终命令：

`pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/codex-quota-readiness.test.ts`

5/5 通过，覆盖活跃副本拒绝、未知权威拒绝、每次回读磁盘、错误链接/迁移 marker 拒绝、canonical mode/missing、已排空历史与独立登录排除。尚未证明生产清单采集、Bridge 接线、目标身份/generation fence、排空迁移或六进程跨刷新边界，因此 T0 不标完成。

## QA5 客户端 queued/running

BridgeClient 原先将所有 2xx 判 ok，红侧夹具证明 202 `CODEX_QUOTA_QUEUED` 被误报 `ok=true`。修复仅针对 POST runs/start 的 202；保留 body 和标识，返回 ok=false，不作 transport 重试。同一 idempotencyKey 再回 running/200 才 ok=true。Lead 规则补充排队语义。

`pnpm --filter flywheel-gemini-agent exec vitest run src/__tests__/bridge-client.test.ts`

19/19 通过。服务端 waiter、coordinator recovery/liveness 尚待实现；此结果不是端到端恢复成功。

## 测试命令修正

本仓 `pnpm --filter flywheel-teamlead test:run -- <file>` 实测展开整包测试，已中断；当时未 build 的 comm dist 导致部分既有测试失败，不能作为完整包 gate 结果。定向执行使用 `pnpm --filter <package> exec vitest run <explicit-path>`。依赖以 frozen lockfile 安装完成，最终仍须运行任务要求的全部仓库 gates。

## 后续批次（仍未接完全部运行时入口）

- `5a02567ab`：严格 core quota schema、adapter usageLimited 信号、normalizer 和 worker 终态保护。行为红侧包括 failure 丢失、旧提交导致 DecisionLayer 覆盖限额失败、最大合法 binding 生成超长事件 ID、超长小数时间戳被接受；相应修复后定向 core 17、adapter/helpers 147、normalizer 2、worker propagation 30 通过。未将这些计数冒充整仓 gate。
- `be5bc32d5`：三号排序、隔离 reader/probe、候选 account lease、安装 helper 与 manual use/save 共锁。TeamLead 15、runner installer/ledger/shim 34 通过；全部 synthetic auth/temp homes，未读写真实账号池。独立复查随后发现真实 SIGKILL 残锁和网络错误误分类，正在修正，不能将该提交标成最终通过。
- Direct/HTTP intake 的 generalized 与 legacy 路径已加入同事务 quotaSignal/pause/outbox 接线；7 个新行为红绿与 174 项 intake 回归通过，尚待统一提交和最终 gate。
- 启动前 callback 必须位于每次物理 daemon spawn 之前。原 commitWorkflowLaunch 在 goal active 后才触发，不能证明认证前绑定；已新增 callback 传递路径，生产 callback 安装与全舰 readiness 仍待完成。
- run-recovery 8 项夹具覆盖无 probe 权限零 API、queued 不当 running、同键重放、terminate 后代数改变、人工停止/健康后继/存活旧体/无 quota provenance 禁止恢复、拒绝 terminate body 和响应丢失 cursor。此为编排单元测试，尚未证明六具隔离 Bridge 实体恢复。

Lead 指令 `[lead-instruction 1f68db7e-ca2b-4715-a525-b072ff4e7be4]` 已确认：真实 ~/.codex 和 profiles 写入禁令、QA5–7、FLY-2404 部署前置、一次普通 push、exact-head review 期间冻结均保留。报告 `607fefa9-3afe-4358-b9ee-9ebea2189aa9` 更正上一报告中无效 commits 字段；实际提交以本文件及 git 为准。

## 持久安装与投递补强（2026-09-09）

- Store 现在要求先持久化安装材料，才允许 generation commit；不能只传字符串 `probeResult=ok` 绕过安装日志。相关 StateStore/协调器/入口 26 个测试通过。
- 协调器重建先对账 installing；未知中断不重新刷新候选，也不遗失日志。未恢复目标（包括安装完成后的 queued/waiting）超过 10 分钟使用同一 founder alert latch。关闭开关停止协调器动作。
- 探针失败后，相同额度/凭据证据不会因 observedAt 更新而重复 exec；外部观察异常转为持久有界重试，错误正文不入告警。
- outbox 使用既有通知器 durable receipt 才结清，只有 sent 返回值不够；跨重建 ambiguous attempt 30 分钟 fence。2 个定向测试通过。founder 路由缺少目标 ID 时保持 pending。
- 原始审计行持久于同一 StateStore；巡检仅读取限长、原子生成的公开投影，不包含 auth、账号 key 或恢复文件路径。安装中断/失败/commit 投影测试通过。
- review 模型只接受安全 slug，按 review binding 不可变登记；重复同值允许，不同值或 runner binding 拒绝。1 个定向测试通过。
- AutoRepairBot Codex 专属 guard 的红→绿证明：Codex quota 不会调用 Claude accountSwitch；14 个测试通过。
- 仍未完成：完整六 run 隔离 Bridge 台架、全仓门禁、exact-head 外部 review、PR；没有生产凭据读写或发布验证。

## 真实路由台架与接线收尾（2026-09-09）

- `qa-evidence.md` 记录 6/6 合成协议、真实 HTTP/SQLite/子进程台架；不代表在线 Codex、生产迁移或 Discord 实际投递通过。
- 台架暴露并修复：observe 后必须重新读时钟；runs/start 的 canonical 响应字段为 workflowRunId；安装失败返回不能覆盖已持久化 installing；旧 casualty 在新 generation 提交后仍由专用 target fence 阻止普通换体。
- 合法同账号刷新只登记观察摘要，不修改原 probe proof 或 generation；手动身份变化按 CAS 进新代但不伪造 probe。旧代迟到目标只借用当前同一 root 的有效 committed proof，原信号归属不改。
- 恢复使用 server-owned frozen snapshot/node/模型/分支连续性；真实 liveness unknown 不算死，202 不算 running，路径/分支不一致不记恢复。按目标集合去重的 Lead 汇总经真实 durable inbox API 投递，不以告警频道消息替代。
- review 旧 binding 在手动换代无 proof 时保持 paused；重绑与 exec 之间重新检查原 binding 当前许可及 generation，随后核对实际 auth digest。14 个 client tests 通过，包括两个换代竞争路径零 retry。
- 首次完整 `pnpm -r build` 通过；`pnpm lint` 已通过（14 条既有 warning）。首次 `pnpm test:packages:run` 非绿：runner kill-path inventory 未登记新增 12 项，另有 vitest-worker onTaskUpdate timeout。清单已逐项检查：signal-0 两项、QA-only 八项、拥有的独立 probe/review 子进程两项；更新后该 gate 单测通过。完整包门禁须重跑，不能把定向绿记作全仓绿。
- 已 fetch main：新增 e79cdb2d5、24a64338b；本分支与 main 共同基线仍为 227058c73，尚未对已发布设计提交做历史重写。没有 push、PR、merge、部署或生产 auth 操作。


## 最终实现审计与全仓失败处理（2026-09-09）

- 历史启动补录先观察缺方法红侧，再证明不接受后续其他故障 hold（3 条误入、预期 2 条）；修复后 StateStore quota 14/14。只接受当前最新 activation 的精确 usageLimited + 最新 retry_limit_escalated 对；缺失/多重 binding 只生成 identity_uncertain pause 与一条 Lead 诊断，不归属当前账号、不触发切号或 kill。生产启动在任何 runtime 认证操作之前执行一次限量扫描。
- 第二次完整包门禁失败：TeamLead 11 文件/15 测试失败，另有 onTaskUpdate timeout；期间并行添加的 TDD 红侧也被 suite 收入，此轮不能作为最终固定源码验证。真实集成遗漏为新 quota 表保留登记、异步 probe 子进程清单、第四条终态 CommDB sink 清单，以及既有 route mock 未提供新增 waiter 方法；均按实际新路径补齐，未弱化生产防线。
- 无关旧失败文件单独复跑：terminal archive、Claude profile CLI 集成、bounded delivery maintenance、automated message inventory、reply guard，共 5 文件/75 测试通过。未改这些旧测试，也不将该结果记为完整包通过。
- 所有 15 张配额表（包括延迟创建的 canonical observation）登记 protectedCurrentOrReference；无新增清理/删除策略。保留策略与使用实际 runtime readiness 的六场景 bench 合计 31/31。
- 自动 admission waiter 恢复补齐：同一不可变 reservation/key 重入原入口，readiness 缺失拒绝，人工停止/终态 abandoned；实际 HTTP 202、200 但 liveness unknown 均保留 resuming，只有同代 binding + running session + 活体证明才 released。实际 route 原先提前 released 的红侧已修复；协调器将独立 waiter 纳入 settled 重开和十分钟单告警，31 项定向测试与 TypeScript 通过。


## 冻结源码门禁状态（5e2f9ac4f）

- `pnpm lint` 通过，14 条既有 warning；`pnpm -r build` 通过。
- 无并行源码编辑的默认 `pnpm test:packages:run` 仍非绿：runner 47 文件、1169 断言通过、2 skipped，但 Vitest `onTaskUpdate` RPC timeout 使命令 exit 1，未运行到所有后续包。不称为完整通过。
- 正在保持全部测试、原有超时和断言不变，以 `VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 pnpm test:packages:run` 复验全部包。结果将写入 PR 验证说明与 comm 报告；本文件在精确 HEAD 审查期间冻结，当前不预告通过。
- 所有新增 shell 门禁通过：codex-quota-client 14/14、codex-quota-readiness-receipt、codex-quota-summary。原 guard/converge/package-onboard/patrol/packaged seams，以及 CI shell enumeration/structure 的定向检查均已通过。
- 最终 fetch 的 origin/main 为 e79cdb2d5，共同基线 227058c73；批准 plan blob 与 ddb435a0d 相同。未改设计、未 rebase/force push、未 merge/main push、未操作生产账号。


## R1 审查与获准修复（2026-09-09）

- 首轮审查 request `90eaa506-a62c-400a-9d2a-133acbbd08e4`、HEAD `6b1bfea6f` 返回 CHANGES_REQUESTED。两项 HIGH 为 `wrapper-exec-id-gate-breaks-non-review-codex`、`null-incident-execution-pause-is-permanent`。
- Lead 裁决 `7433e079-d1af-4492-8322-a288cf6969ab` / `d5a0e675-4778-41fb-899b-f364f60673fc` 禁止已发布历史重写；隔离 rebase 工作树已移除、候选未推送。完整单 worker 包命令于原 HEAD exit 0 后，普通 merge main `e79cdb2d5` 得到 `1823b5653`。唯一冲突是两个测试组插入同处，完整保留双方；冲突文件 30/30 通过。没有 force push 或 main push。
- 原 HEAD 的完整单 worker gate：全部包完成，TeamLead 914 文件 / 12360 passed / 6 skipped，runner 47 文件 / 1169 passed / 2 skipped，零未处理 RPC error。默认并发命令此前 exit 1 的记录仍保留，不能改称默认环境全绿。
- Lead 裁决 `4ead389f-6f24-49cb-ba74-4c35b3efdae1` 只批准两项 HIGH 的 TDD 修复；其余八项 MEDIUM/LOW 在 PR body 列为后续工作，不在本批实现。最多再两轮审查；同区域再出 HIGH 时停止扩展并报告 Lead。
- `9a6601506`：无明确模型或完整控制上下文的真实 peer-review/codex-resume/缺 metadata CLI 形状，在红侧返回 75 且未执行；修复后原 argv 与本地 CLI 行为保留。只有可验证的完整 review enrollment 才进入配额协议。client 15/15、guard 46/46 通过。
- 同提交：新无绑定信号、历史补录和已有 NULL incident 残留三个红侧均已证明。现在无绑定记录仅去重诊断，历史扫描按 target / diagnostic receipt 去重；NULL 残留不再形成 execution fence。绑定后的真实 incident/target 仍暂停。store/generation 17、coordinator 9 通过。
- 合并后先补齐 comm snapshot-storage 的构建产物，随后真实 quota route 与六场景 bench 9/9 通过；这个过程未修改 main 的 snapshot 功能。`pnpm lint`（14 既有 warning）、`pnpm -r build`、全部新增 shell tests、converge/package-onboard/packaged seams 均通过。
- 最终普通 push 后将启动本次修复 HEAD 的完整单 worker 包复验、fresh exact-head review 和 CI；结果在 PR body 与 comm 完成报告中记录，审查期间不再为更新文档改变 HEAD。尚未完成 needs_review 交接，也未实施生产迁移、在线 provider 验证或发布。

## Lead ship-gate rework — 2026-09-09

Bounded implement attempt 2 follows the injected Lead rework and guard instruction
`[lead-instruction 73db84de-1844-405b-9bfd-07fc23ddfb59]`; the earlier QA attempt 1
PASS (claim 993) remains prior functional evidence. No production/529 deployment
or credential migration was performed.

- Launch enrollment is optional when the auto-switch flag is OFF, initialization
  fails, or binding fails. The Bridge returns an explicit null binding to select
  the legacy daemon path; rotation is logged disabled. Valid bindings retain
  their identity/generation validation. Existing durable quota pause guards remain.
- Initialization and binding failures retain structured code + cause in logs and
  use the existing infra alert inbox. One host shares an hourly rate limit across
  initialization and launches; stable host/hour event ids also deduplicate inbox
  delivery across Bridge reconstruction.
- RED: four runtime tests failed against the old fail-closed wiring; daemon null
  fallback failed with `codex_quota_pre_auth_rejected`. After implementation:
  runtime 15/15, daemon 35/35 passed.
- Integrated `src/codex-quota/__tests__/launch-fail-open.test.ts` drives constructor
  failure through real dispatcher wiring, CodexDaemonGoalRuntime, CodexDaemonClient
  and goal loop with hermetic process/RPC fixtures. It completes successfully,
  reports rotation disabled, emits no binding and has zero restarts. Replacing the
  unavailable-runtime fallback with a throw makes this test RED; restoration GREEN.
- Cheap advisory: `WorkflowEngineDispatcher.consume` bound-execution pause is
  tested even without root resolution. Removing its execution pause guard is RED
  (admission called once); restored targeted suite is GREEN 3/3.
- `pnpm lint` passes with 14 existing warnings. `pnpm -r build` passes.
  All three new shell tests (quota client, readiness receipt, quota summary) pass.
  Full `pnpm test:packages:run` is still pending at this checkpoint.
- The prescribed `codex:rescue` companion task could not create its review thread:
  nested `sandbox-exec: sandbox_apply: Operation not permitted` (exit 71).
  This limitation was reported to Lead; raw Codex exec was not substituted.
  Fresh request-driven cross-family exact-head review and CI remain required.

FLY-2404 relation for this rework: rotation is inert until the shared-credential
migration/readiness conditions hold; launches are unaffected. The integrated
constructor-failure test above is the executable launch-continuity receipt.
The pinned approved plan remains unchanged; this bounded Lead rework supersedes
its launch-fail-closed behavior only.

The first rework full package command exited 1 at claude-runner:
47 files passed, 1,170 assertions passed, 2 skipped, zero failed assertions,
one `[vitest-worker]: Timeout calling "onTaskUpdate"` error. Downstream
packages were not reached. Raw receipt: `/tmp/fly2465-rework-full-packages.log`.

Lead ruling on question `f92b54c8-8033-414e-8bd0-2752525ed196` accepts this known
local harness signature and directs that the current single-worker full rerun is
the LAST local full run. If it has zero failed assertions, disclose its actual
receipt, then use one milestone-last ordinary push, fresh exact-head review and
CI 14/14 as the ship-gate evidence. Do not chase the RPC timeout further.
The ruling does not turn a failed local exit code into a passing receipt.

Final single-worker full rerun **PASS, exit 0**:
`VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 pnpm test:packages:run`.
Runner: 47 files / 1,170 passed / 2 skipped. Teamlead: 917 files /
12,392 passed / 6 skipped, including the integrated launch-fail-open test.
All other packages completed successfully. Raw receipt:
`/tmp/fly2465-rework-full-single-worker.log`. No exclusions or timeout changes.
The earlier default-concurrency RPC failure remains a separate failed receipt.

Rework implementation is commit `015e3b352`. After this evidence/progress update,
the milestone file is the literal last commit, followed by ONE ordinary push.
Fresh exact-head review and CI results are recorded externally in PR #1143 and
comm reports while that HEAD stays frozen.


## Second ship-gate cycle: H1 + H2

First-cycle frozen head `cc8820926f266c4a994d89333d28d5cf99f6e818` passed
CI 14/14 ([run 34421511592](https://github.com/xrliAnnie/flywheel/actions/runs/34421511592))
but request `604cdfd1-878d-4f9a-9506-80729cca1c1c` requested two HIGH changes.
Lead `7cab4237-dddd-4a68-9eb8-824921684e6a` authorized exactly one further
H1/H2 cycle; the authoritative correction and quote are in design-correction.md.

Implementation `c39c0255f`:
- ON typed `CodexQuotaLaunchPausedError` survives infrastructure fallback, including
  a fresh unbound execution, unavailable runtime with known pause, and a pause
  racing asynchronous bind. Genuine infrastructure/bind failures still launch
  legacy with rotation disabled. OFF is checked before any quota binding calls.
- A live flag-backed launch policy bypasses engine, admission and commit fences
  under OFF while retaining incident/pause rows and dead-execution retry guards.
- The ordinary dispatcher pass resumes durable user admission reservations that
  were queued before any engine intent existed. It uses their original keys and
  authenticated start route only, never terminate or casualty recovery. 202 stays
  pending; running plus physical liveness is required to release. Existing sessions
  or launch ownership after a lost response only reconcile liveness; dead/unknown
  executions receive no new POST, including after Bridge reconstruction.
- Lead `f63ad162-39a7-44ea-964a-f12631b08d1f` approved the necessary scoped-origin
  dependency: authenticated master replay retains the stored freshStart actor only
  for matching authority/reason in a waiting/resuming legacy reservation. Changed
  reason/tier remain 409, and existing digest tests pass.

TDD: typed pause, OFF queued engine/root and pre-intent HTTP admissions, dispatcher
replay hook, and scoped replay each produced the expected RED before implementation.
Lost-response preflight added five expected RED cases, then 30 tests passed.
Mutations removing the ON typed-pause fences, OFF central policy bypass, and live
plugin flag wiring each turned their production-seam regressions RED; restored GREEN.
Constructor-failure integration remains GREEN. Bounded read-only audit found no
remaining same-origin HIGH before the final merge verification.

Main integration `326dac3ef` includes `5cbd540f1` (FLY-2460, FLY-2446, FLY-2454).
Conflicts preserve both daemon test groups, both flag imports and all retention
entries; combined registry has 199 tables (138 protected current/reference).
No 529 deployment was performed. Merged full build passes. Lint import ordering
failed once after merge, was corrected, and final lint passes with 14 warnings.
Three new quota shell gates, CI structure shell gate, and retention consumer gate
pass. Final merged focused test totals are recorded below.

Per Lead f92b54c8's LAST-local-full ruling, the earlier exit-0 single-worker full
receipt remains historical evidence for the first cycle. No full local suite was
rerun after H1/H2 or main integration; merged focused tests and a fresh exact-head
CI 14/14 plus review are the remaining gate receipts. No focused run is labeled a
full repository pass. If fresh review raises another same-origin HIGH, stop/report
instead of beginning a third cycle.

Final merged focused receipts: runner 2 files / 159 passed, exit 0. Teamlead
initial default-concurrency selection exited 1: 333 passed, 8 failed. The existing
probe serialization test used a 10ms sleep and asserted before its callback ran;
its unreleased lock then caused seven following timeouts. No test/timeout change
was made. The SAME 16-file selection with all Vitest worker bounds set to 1 passed
341/341, exit 0, including retention and flag merge-conflict coverage plus all six
bench scenarios. These remain focused receipts, not a full-package receipt.
Logs: `/tmp/fly2465-h1h2-merged-teamlead-final.log` (failed),
`/tmp/fly2465-h1h2-merged-teamlead-single.log` (passed),
`/tmp/fly2465-h1h2-merged-runner-final.log` (passed).


## Authorized merge-test cardinality correction

Review `db271869-134f-4cf7-8888-2104e3e61df7` at `3cc7fcc09` returned
CHANGES_REQUESTED solely for HIGH `feature-flag-count-merge-regression`.
H1/H2 had no blocking findings. The merged registry contains both new flags (27),
while both branches independently changed the shared expected literal 25 to 26.
CI Unit(light) failed exactly this assertion: config 785 passed / 1 failed.
Local one-file reproduction: 53 passed / 1 failed (RED).

Lead question `85886250-ebe4-4172-89df-6cc9c9411626` authorized this test-only
26→27 correction after the review settled, one milestone-last ordinary push,
fresh exact-head review and CI 14/14. No production behavior changes were made.
Review advisories were reported: replay backoff, root-key canonicalization,
unbound backfill alerts, quota-store allocation, probe post-reap signal, patrol
format. They remain follow-ups outside the bounded correction.

GREEN: entire config package `pnpm --filter flywheel-config test:run`: 49 files,
786 passed, exit 0. Raw receipt `/tmp/fly2465-config-cardinality-green.log`.

## Founder notification rework — implement attempt 3 (2026-09-10)

Rework `5456253c`, founder message `1547465762174930955`, and Lead instruction
`b91c6529-6741-4830-90eb-9d226db9adcc` supersede only the earlier success-notification
contract. A successful generation commit now atomically enqueues one durable
`switch_notification`, delivered by the existing Bridge alert notifier as
`quota_switch_confirmation`. Like the existing Claude notification kind, this is
visible in the notification channel without an additional founder mention or
incident ticket. The original pool-exhausted founder alert, mention, severity,
and deduplication key remain; its text now includes the same recovery details.

Both paths include `usageLimited`, source profile, observed source reset in UTC
(`unknown` when unavailable), destination (`none` if no switch), affected run
count and recovered run count. Queued targets are not counted as restarted.
The source reset is persisted in the original quota event before probing, so
installation recovery can still produce the notice after process reconstruction.
No new channel, account selection policy, quota window, migration, or Claude
behavior was introduced. The pinned plan was not edited.

Two appended tests exercise the coordinator, real in-memory SQLite store and
existing alert delivery callback with durable receipts; a repeated tick/flush
must deliver exactly once. Original tests are unchanged. Initial focused RED:
3 passed / 2 failed, because success had no notification and exhaustion lacked
`usageLimited` and account/run fields. Focused GREEN: 5/5. The first broader quota
run exposed three old bench assertions requiring zero founder mentions after
success; ordinary notification delivery now retains that invariant. No tests
were relaxed. Raw receipts are `/tmp/fly2465-notification-focused-red.log`,
`/tmp/fly2465-notification-green.log`, and the quota regression logs.

The first test invocation accidentally passed a literal `--` to Vitest and
started the whole TeamLead suite; it was interrupted (exit 1) after unrelated
parallel timeouts. It is not a passing gate. The required full package run uses
the established single-worker environment, after the dependency build completed,
with no exclusions or timeout changes. Final results are recorded below.

The current tool catalog exposes no `codex:rescue` companion task capability;
this was reported through comm. The formal request-driven cross-family review
remains mandatory on the final pushed HEAD. No raw `codex exec` review substitute
was used.

Validation checkpoint: lint exit 0 (14 existing warnings), recursive build exit 0,
TeamLead typecheck exit 0; all three new quota shell gates exit 0 (client 16,
readiness receipt, summary/packaged/converged closure). Six-scenario HTTP/SQLite/
process bench passes unchanged. Quota regression after the mention correction:
19 files passed, 1 failed; 147 assertions passed, 8 failed. The first failure was
the unchanged probe serialization test's fixed 10ms wait; its failed assertion
left the callback lock unreleased and seven later tests timed out. Isolated
unchanged-file rerun passed all 13 assertions, exit 0, in 5.44 seconds
(`/tmp/fly2465-notification-probe-rerun.log`). This does not relabel the failed
broader receipt as a pass. Complete package run remains in progress.

### Main integration before the single push

Fresh fetch found main `42869f935` (FLY-2453) ahead of the prior merged
`5cbd540f1`, with PR #1143 conflicting. The pre-merge full package process was
intentionally interrupted (exit 1, unfinished) before changing its source base;
it is not a completed passing receipt. Integration commit `027397100` is an
ordinary merge, preserving both existing GatePoller callback bodies verbatim:
quota recovery/outbox/audit in `onLandOperationTick`, and main's
`onAutoNarrowGateTick` alongside it.

The only merge-specific corrections reconcile counts for both retained sets:
feature flags 27 -> 28 (RED 67 passed/1 failed, GREEN 68/68); retention referenced
tables 138 -> 142 and total tables 199 -> 203 (RED 29 passed/1 failed, then GREEN).
The retained-schema count is 200 after excluding the three retired tables. Both
counts were checked against the actual merged registries. The first retention
attempt failed collection because newly merged dependency exports were not yet
built; it was rerun after the complete recursive build, not counted as RED.

Merged validation: `pnpm -r build` exit 0; `pnpm lint` exit 0 with 14 existing
warnings; TeamLead quota, auto-narrow, retention and GatePoller focused run
30 files / 271 assertions PASS, exit 0; config focused 68/68 PASS. All three new
quota shell gates and main's auto-narrow rollback precheck pass. Receipts use
`/tmp/fly2465-r3-merged-*` and `/tmp/fly2465-r3-merge-config-green.log`.

The exact full package command is rerun on this merged source after dependency
build. Its final result, fresh exact-head review, and CI14 will be recorded
externally in PR #1143 and comm after the milestone-last commit freezes HEAD.
No gate is claimed passed while its result is pending.

### Authorized sole-HIGH correction after notification review

Review `b66518da-d055-4d10-895e-294e6e4aabda` on `cbf8e08e3` returned
CHANGES_REQUESTED for `review-quota-usagelimited-evidence-rejected`. The actual
client classifier plus isolated HTTP/SQLite route reproduced `usageLimited` ->
400 `INVALID_QUOTA_SIGNAL`, zero incidents. Lead question
`367a8d7a-89f0-4ea7-8b08-92bd3d92ec05` authorizes only this fix and one real
client-text/HTTP acceptance/replay test, then one ordinary push and fresh
exact-head review/CI14. Any NEW HIGH in that review requires stop-and-report;
the six MEDIUM/LOW findings remain untouched and disclosed in PR #1143.

`13972c263` removes only the contradictory single-value evidence check. The
shared schema still restricts evidence to `usageLimited | usageLimitExceeded`;
review source, exact request shape, authentication, owner and binding guards
remain. The appended test runs actual `runReview` classification against the
HTTP route twice, confirms both 200 receipts, one incident/target, spool ACK,
no runner pause and no additional execution. RED: 3 existing tests pass, new
test fails with `observe rejected 400`; GREEN: 4/4 pass. Original tests were
not edited. Logs: `/tmp/fly2465-r3-high-red.log` and `...-green.log`.

The previous full local failed receipt and isolated CLI 57/57 pass remain
separate. Lead's `9a4c15ba` ruling, reaffirmed by the bounded authorization,
forbids another full local rerun or timeout edits. The new HEAD still requires
fresh exact-head APPROVED and CI14; old-head CI14 is historical evidence only.

Correction verification: full recursive build and lint pass (14 existing
warnings); all three quota shell gates pass. Broader quota receipt is exit 1,
19 files / 148 assertions passed and one probe file / 8 failures: unchanged
10ms serialization assertion failed before release(), then seven tests timed
out. Its isolated unchanged-file rerun passes 13/13, exit 0, in 4.73 seconds.
The route suite (4/4), six-scenario bench (6/6), and all other selected files
pass. Both receipts remain distinct (`/tmp/fly2465-r3-high-focused.log`,
`/tmp/fly2465-r3-high-probe-rerun.log`). No code, fixture or timeout was changed
to address this known harness race. The authorized final new-head gates remain
request-driven APPROVED and CI14; results will be reported externally after
milestone-last freeze.
