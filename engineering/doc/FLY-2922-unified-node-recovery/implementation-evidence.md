# FLY-2922 实现证据与剩余合同 — 调研
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-26
基于: plan.md

当前仍在 implement；以下是第一块实现证据，不是整单验收、QA、CI 或 handoff 证明。批准计划正文保持 SHA-256 `7de9bef9d44818fa2a689a98dc517087154cafbe568126e6cb2aeb4edf11a1c5`，有效设计门 `d9ab4f85-f464-4fee-9c09-7af6295b0c9a` 已重新查询为 APPROVED。

## 第一块：FLY-2191 的恢复证据保留

根因在 `StateStore.pruneWorkflowDeadExecutionWatches`：原 SQL 把 TTL 到期、孤儿、run 非 active 三项用 OR 连接，因此 held 的新 watch 当即被删，active 的旧 watch 到 TTL 被删。dispatcher 在探测前调用此清理，所以旧体跨 TTL 再活动时没有证据可探。

按计划 §3.4 改为：只有 run completed/terminated 或确为孤儿，且达到 TTL 才可清理；active/held 的 active/tripped watch 保留，未知 run 状态保守保留。每批 200 条上限维持。未增加新 watch 状态或迁移。

- 红：StateStore 五个保留/终态 TTL 用例、dispatcher 两个重启后探测用例、孤儿批量边界用例共八个都在旧 SQL 上按预期失败。
- 绿：`vitest run` 按 `FLY-2191|retention TTL` 筛选，2 文件 / 8 用例通过。
- 定点完整文件：`StateStore.fly1385-dead-exec.test.ts` + `workflow-engine-dispatcher.test.ts`，151 passed / 1 原有 skip。skip 是原 #705 的非终态 session 管理拒绝，用例本来停用，不能算通过。
- `pnpm --filter "flywheel-teamlead..." build` exit 0，13 个受影响包及依赖。
- `pnpm lint` exit 0，25 warnings（仓库已有未改部分）；没有自动改动无关文件。
- FLY-1560 lexical guard 和 FLY-2567 compatibility guard：2 文件 / 24 tests passed。
- 受限 `vitest related`：同 2 文件 / 151 passed / 1 原有 skip，exit 0。配置只限制文件范围，保留原 setup/serial/超时。
- FLY-2211 kill-path inventory：1 文件 / 5 tests passed，exit 0。
- `git diff --check` exit 0。

日志（本机、非公开产物）：`/tmp/fly2922-watch-red.log`、`/tmp/fly2922-watch-orphan-red.log`、`/tmp/fly2922-watch-dispatcher-red.log`、`/tmp/fly2922-watch-green.log`、`/tmp/fly2922-watch-related.log`、`/tmp/fly2922-watch-vitest-related.log`、`/tmp/fly2922-watch-guards.log`、`/tmp/fly2922-watch-process-guard.log`、`/tmp/fly2922-build-preflight.log`、`/tmp/fly2922-lint.log`。

## 剩余批准合同（未实现或未验收）

1. 九张原单与新增 2901/2914 独立真实夹具，公共 stage/apply 到 dispatch 消费的证据；FLY-2191 的整个恢复链仍依赖统一入口。
2. canonical v2、receipt nullable 列、统一 hold 投影/历史 superseded 分类/active orphan、同事务真实 mint/CAS/权限与 replay。
3. 非根 lineage、根 startAuthority、rework/land/gate/state-only/recorded decision 消费、准入前失败 producer；保留设计 advisories 中的根连续性语义、排除 land/gate、pending 无 binding/owner 的事务内未启动证明。
4. enrolled complete 顺序/blocked failure 入口、删除 reconstruct_completion 例外，legacy 路由隔离。
5. carrier-close 不终结 run、done-close/显式 terminate、额度 target CAS 与旧请求 fence；watch 部分仅完成上面的独立 slice。
6. 完整消费者 sweep、其余守卫与定点验证、literal-last milestone、commit/push/PR、effective code review、正式 report + needs_review receipt + park。

最初通信 health 超时导致三个 stage 排队，progress CLI 以旧 onboard 阶段拒绝。已通过 ask --report `b47da4e1-7d60-4abf-8869-b6ef7783bcdc` 报 Lead；恢复后 progress CLI 成功提交 `bc80001e1`（implement 0/6）。未改通信库或伪造回执。


## 2026-09-26 implement 重开：准入前 producer WIP 审计

基线 `7e52c8dba` 含保留 WIP `d35da9cde`。TURN 为 implement / epoch 8，execution `76dcb547-4e56-43b6-8700-b04975fce7e0`。本块没有完成统一恢复事务，六组剩余合同不减少。

- MEDIUM `preadmission-producer-rework-carveout`：StateStore 在读取最新 dispatch 且证明 pending / 无 binding、activation、owner、completion 后，按持久 reason 的 `rework_replacement:` 前缀或同 tuple 的 open rework target 明确返回 `rework_delivery_owned`。不写 run hold、诊断 episode 或改变投递，由 FLY-2921 coordinator 计数。直接调用 producer 的两个反例（正常 reason、错误 reason 但有持久目标）在修改前均错误返回 held；修改后同时验证 run/node/delivery/events/ledger 未变。普通节点的结构性拒绝、跨重启暂时错误计数和 admission 竞争保护继续通过。
- WIP 构建失败根因：准入失败错误调用只接受死体复活 disposition 的 `workflowDeadExecutionAlertPayload`，还会发送 FALSE-POSITIVE 标题。先加断言复现错误标题，再改为准确的准入失败告警，并在 StateStore/LeadAlertNotifier 两端既有 metadata union 中声明 `pre_admission_failed`。没有放宽原死体复活 helper。
- WIP dispatcher 的一处长行格式已按 biome 修正。
- 原 WIP producer 的红测试历史未经此轮重新证明；本轮为上述 carveout / alert 补有明确红绿证据，不将继承测试的现状称作新增 TDD。

当前已核验本机证据（不等于整单完成/QA/CI）：

| 范围 | 结果 | 日志 |
|---|---|---|
| carveout 红 | 2 failed，实际错误返回 held | `/tmp/fly2922-rework-carveout-red.log` |
| 告警红 | 1 failed，实际错误标题 FALSE-POSITIVE | `/tmp/fly2922-producer-alert-red.log` |
| producer/FLY-2504 子集 | 21 passed | `/tmp/fly2922-producer-green.log` |
| dispatcher + dead-exec 两个完整定点文件 | 165 passed / 1 原有 skip | `/tmp/fly2922-producer-focused.log` |
| owning-package vitest related，配置仅限上述两个相关文件 | 165 passed / 1 原有 skip | `/tmp/fly2922-producer-related.log` |
| FLY-1560 / FLY-2567 / dispatch seam / FLY-2248 守卫 | 4 files / 41 passed | `/tmp/fly2922-producer-guards.log` |
| FLY-2211 kill-path inventory | 1 file / 5 passed | `/tmp/fly2922-producer-kill-guard.log` |
| pnpm lint | exit 0，25 warnings，未自动改无关代码 | `/tmp/fly2922-producer-lint-green.log` |

消费者 sweep：按四个变更 TS 文件的完整路径、文件名、父目录执行 `git grep -lF`，1872 个去重匹配保存于 `/tmp/fly2922-producer-consumers.json`，每条处置在 `/tmp/fly2922-producer-consumer-disposition.tsv`。精确符号 sweep 证明 producer 的唯一生产调用在 dispatcher catch；诊断事件无其他当前消费者。保留上述结构/兼容/进程守卫，文档、证据和其他 StateStore 子系统的路径引用按本 slice 排除。后续恢复/complete/close/receipt schema 变更必须重新选测，不能沿用本块排除结论。未执行本地全包或全仓测试。

Lead 对 question `d0680b7b-9362-4d25-8126-f43dbea7ddf5` 的当前答复：FLY-2921 仍在实现，无 PR/可同步实现 SHA，合入顺序未定；本单不等待，后合者同步全部 pending 消费路径、不 force-push。已通过 report `489b839e-18a0-4624-9e20-6ec0661cb1ef` 确认。PR 仍未创建，该 merge-order 约束必须写进最终 PR body。

本块追加验证：
- `pnpm --filter "flywheel-teamlead..." build` exit 0（`/tmp/fly2922-producer-build-final.log`）。
- LeadAlertNotifier 的受限 related：1 file / 69 passed（`/tmp/fly2922-producer-alert-related.log`）。
- 公共 dispatcher 真实替身的无效/超长 context 两个负控追加断言 run active、零 recovery episode：2 passed（`/tmp/fly2922-producer-rework-consumer.log`）。
- 全仓 lint 最后一次 exit 0（`/tmp/fly2922-producer-lint-final.log`）；测试追加断言后 3 文件 biome 检查通过。
- dependent typecheck 首次因缺少 voice-bridge dist 失败；`pnpm --filter "flywheel-voice-bridge..." build` 补齐后，`pnpm --filter "...flywheel-teamlead" typecheck` exit 0，teamlead/voice-codex 均通过（`/tmp/fly2922-producer-dependent-types-verified.log`）。

## 2026-09-26：恢复合同与替换事务基础

本块基于 `27fdc0fe6`，尚未接通 held 的正式恢复入口，六组批准合同仍未完成。`resumeWorkflowHold` 的版本 2 请求暂时明确拒绝为 `recovery_preflight_required`，不会进入旧 shape switch；下块用真实故障夹具接入可信预检及统一事务，随后删除旧故障分支。

- `workflow-recovery-contract.ts` 严格解析版本 2 canonical、RecoveryTarget 和 dispatch/state-only 两类 receipt。摘要绑定旧 tuple、snapshot、head、源 hold UID 集合；UID 排序而不丢弃重复，额外字段、不安全整数、错误 episode 摘要均拒绝。旧 canonical 的字段与摘要不变。
- `workflow_delivery_operation.recovery_receipt_json` 是 nullable 增量列，在旧 kind 表重建后升级。旧行不回填、不铸派发，读取标记 `legacy_result`。新 receipt 严格验证 operation/digest/run，并以真实 ledger ID 加完整 tuple 查账本，返回当前 dispatchState；无账本或损坏新证据标记 `invalid_receipt`，不降级成旧成功。迁移/重启测试只证明存储合同，不冒充 dispatcher 验收。
- 自动死体替换的账本、writer/resume/attachment/watch 逻辑抽入 `materializeWorkflowNodeReplacementTx`。它显式检查处于事务、当前 run/node/最新 attempt、自动预算、新执行身份及最终派发/writer 证据。当前仍只接受 active 自动恢复，held CAS/操作员预检授权由下块接入，不能把这一步称为已满足全部 shared-materializer advisory。
- mandatory `writer_replacement` 证据移出可选附件的 best-effort 包装，冲突使外层整笔回滚。原测试曾明确允许冲突后提交，现按批准计划反转该断言；可选附件缺失仍保留准确诊断，不伪造 ready checkpoint。
- 自动替换补 run.current_node_id/最新 attempt 检查，并拒绝用死体自己的 ID 作为替身。两个红测在旧行为下都返回成功，修改后拒绝且 ledger/node 不变。

红测日志：`/tmp/fly2922-canonical-red.log`（版本 2 不被识别）、`/tmp/fly2922-receipt-red.log`（缺 nullable 列）、`/tmp/fly2922-materializer-red.log`（writer 冲突仍提交）、`/tmp/fly2922-materializer-cas-red.log`（历史 cursor 与同 ID 替换）、`/tmp/fly2922-receipt-ledger-red.log`（缺实际账本状态）。回执夹具中的两次设置错误已修正：先创建关联 run 满足 attribution trigger；篡改 receipt JSON 而不越过账本身份不可变触发器。

本块消费者范围：六个 TS 文件按完整路径、文件名、父目录执行 `git grep -lF`，完整路径与新旧 literal 共 24 个 term / 1887 个去重路径；`/tmp/fly2922-foundation-consumers.json` 保存结果，`/tmp/fly2922-foundation-consumer-disposition.tsv` 逐条记录保留/排除理由，28 文件清单在 `/tmp/fly2922-foundation-retained-tests.json`。只跑受限 related 与明确守卫，不跑本地全包/全仓 suite。新增 `workflow-node-recovery.test.ts` 属于下一块公共入口红测，不包含于本块提交或通过声明。

后续接入点的只读核对（未实施）：
- enrolled blocked 需在 event-route 的 declared-PR/head/founder 成功校验前分流，保留 ingest bearer + exact activation/TURN 的现有身份合同，复用 drain 挑战/验证/事务消费。没有现有 submission-token 传输，不能凭审阅文字另造凭据协议。新 failure receipt 必须支持恢复后的幂等回放；失败登记不得进入 success audit 或 legacy fallback。
- 三处 carrier-close cascade 调用及级联实现待删。committed close intent 会长期 suppress dead recovery，因此恢复 episode 必须与 close settlement 同事务，不能放在成功后的 best-effort 回调。
- enrolled `done` 必须在旧 FSM completed 投影前按持久 enrollment 分流；held、旧体和历史 activation 不能因 current lookup 失败而被当成 legacy。响应字段需穿过 close-runner、ActionResult、plugin endpoint 和 actions router 四层。显式 run terminate 的 collection 权限仍保留。

基础块验证收据：affected-package/dependencies build、dependent typecheck、最终 lint 均 exit 0（lint 25 条既有 warning）。定点 schema/contract/migration 10 passed；自动替换文件 30 passed / 1 既有 skip。受限 related 为 23 files passed / 1 failed，604 passed / 2 skipped / 1 quota-bench timeout；该 quota 文件随后单文件通过。FLY-1560 lexical 扫描曾 timeout，原文件未改的独立重跑 7/7 passed；其余相关 guard 通过，FLY-2211 5/5 passed。保留原失败日志，不称本批全绿。

按新版 local-test-policy/v1 逐文件补验时，quota-bench、codex-quota、workflow-holds 通过；workflow-rework 93 passed / 3 timeout（此前 related 同文件 96 passed），伴随 onTaskUpdate RPC 超时。其余逐文件检查和新增 fly2302 consumer 尚待执行。主机负载很高；未放宽既有测试超时、杀进程或删除锁。日志为 `/tmp/fly2922-foundation-related.log`、`/tmp/fly2922-foundation-explicit-01.log` 至 `-04.log` 及 `/tmp/fly2922-foundation-teardown-guard-retry.log`。

下一块公共 FLY-2329 原现象已有效复现（`/tmp/fly2922-node-recovery-public-red.log`）：真实 dispatcher 准入后未启动回滚成功，但 stage 仍返回旧 unlaunched shape、缺 version 2。失败在预期的 canonical 断言，非夹具 setup；单独保留为待实现验收。仍是 implement 0/6，无 PR、review、CI、QA 或完成交付。

## 2026-09-26：共享前序关系解析（接入恢复前的依赖）

从 dispatcher 抽出只读 `resolveWorkflowDispatchLineage`，保留连续 replacement → 原 edge 的 outcome、loopIteration、founderFeedback。stage/apply 尚未调用，当前仍没有正式 held 恢复。旧查找算法遇重复证据取最近一条、遇环静默结束；新定点红测为 3 failed / 2 passed（`/tmp/fly2922-lineage-behavior-red.log`），严格拒绝歧义、循环、跨 run/node/attempt 证据后为 6 passed（`/tmp/fly2922-lineage-green-final.log`）。更早一次缺新模块的 collection failure 不作为行为红测。

接入 dispatcher 首轮 10 个失败指出现有返工 actor 可跨 attempt 复用；精确历史 activation binding 修正后余 2 个 QA 夹具失败，原因是它们有原始派发账本但尚未 activation。最终只在已验证的 replacementContext 下允许较早 attempt，且必须有同 run/node/execution/attempt 的 immutable binding 或 dispatch ledger；普通故障恢复仍严格当前 tuple。剩余用例定点 3 passed（`/tmp/fly2922-lineage-rework-origin.log`）。没有修改既有回归测试来绕过这些失败。

消费者检索含完整路径、文件名、父目录、新旧 literal 和扩展名省略的 import 名；`/tmp/fly2922-lineage-consumers.json`、`/tmp/fly2922-lineage-consumer-disposition.tsv` 记录逐项处置，`/tmp/fly2922-lineage-retained.json` 保留 10 文件。其中公共 FLY-2329 文件仍是明确待实现红测；其余 9 文件进入受限 related。额外 7 个直接 dispatcher consumer 已逐文件通过：rework-stall 7、divergence 5、predeploy replay 2、land alert 1、ship probe 11、FLY-2302 CommDB 2、rework E2E 9，共 37 passed；日志 `/tmp/fly2922-lineage-consumer-1.log` 至 `-7.log`。构建（含 dependencies）与 lint 通过，最终修改后的 owning build / related 仍在执行，不能据中间结果宣称本块全绿。

本块最终检查：`/tmp/fly2922-lineage-related.log` 为 9 files / 180 passed（含完整 dispatcher 137 条）；`/tmp/fly2922-lineage-build-final.log` owning build exit 0。公共恢复红测未包含在这些通过数字中。下一步应直接接通它所约束的 trusted preflight + held CAS/mint/receipt，不能把共享解析完成当成统一恢复完成。

## Public held recovery implementation batch

Implemented server-owned stage/apply preflight for the existing non-root fault aliases, strict held CAS, shared materializer validation, fresh ledger/execution mint, durable full receipt, and frozen dispatcher authority. The real FLY-2329 public rollback/stage/apply/dispatch fixture now passes. Removed the legacy unlaunched/retry empty-execution mutations and completion reconstruction branch. Unsupported root/rework/land/decision/quota cases still fail closed and remain required work.

Additional actual RED→GREEN controls cover changed owner generation after stage and diagnostic ledger reason mutation: the canonical token now binds the full observed state, and dispatch proof comes from immutable replacement lineage plus the stored receipt. Alive/unknown liveness, changed git HEAD, injected late transaction failure, replay, stale requests, and corrupt receipt controls also pass in the same public fixture. These are one original-case fixture plus negative assertions, not nine completed acceptance cases.

Verification receipts: public final `/tmp/fly2922-dispatch-proof-green.log` 1 passed; workflow-holds `/tmp/fly2922-legacy-door-green-final.log` 33 passed; rework receipt guard `/tmp/fly2922-reconstruction-removal-guard.log` 33 passed; automatic replacement `/tmp/fly2922-held-materializer-automatic.log` 30 passed, 1 existing skip. Restricted related config selected 42 concrete consumers; related resolved 37 files, 831 passed, 2 skipped (`/tmp/fly2922-held-related.log`, exit 0). Consumer discovery/exclusions: `/tmp/fly2922-held-recovery-consumers.json`, `/tmp/fly2922-held-consumer-disposition.tsv`. This related result does not replace pending per-file checks. Build plus dependencies, dependent typechecks and lint passed before the final immutable-proof edit (lint 25 existing warnings); final narrow checks follow. No full-suite/CI/review/handoff claim.

Independent next-path RED fixtures: carrier close 3 semantic failures/2 passes (run incorrectly terminated; done synthesizes session completed); completion failure 5 semantic failures/1 bearer-control pass (blocked report reaches success-only founder/PR validation first). Both use real stores/routes/FSM with only physical/control boundaries substituted. They are intentionally failing until their respective implementation batches. All six approved groups remain incomplete.

## Carrier close implementation batch

Removed implicit run-termination cascade method and all close/actions callers. Current incomplete carrier close now atomically commits its close intent with one `run_recovery_required` episode; failed close has no episode, late database failure rolls back the entire close settlement, and replay publishes no duplicate. Durable activation history determines enrollment, including reused actors. Enrolled done cleanup bypasses legacy success projection; current incomplete closed sessions use the existing terminalization helper to revoke writer credentials. Old-body and genuine-completion closures preserve replacement/successor. Public close/actions responses expose execution-only outcome; explicit run termination remains separate. Lead rules and terminal tool descriptions now state that scope and preserve R2 authorization.

An additional actual RED exposed close-triggered thread archive from a bare completed session. The close path now requires enrolled run completion before archive. `/tmp/fly2922-close-archive-red.log` failed that assertion; `/tmp/fly2922-close-archive-green.log` passes all 6 carrier cases. Explicit checks: StateStore close settlement 6 passed (`/tmp/fly2922-close-settlement-second.log`); close-runner legacy 80 passed (`/tmp/fly2922-close-legacy-final.log`); actions terminate 14 passed (`/tmp/fly2922-close-actions.log`); edge action result 5 passed; terminal lifecycle 16 passed. Restricted related selected 19 concrete files and resolved 10 files: 323 passed, 1 skipped (`/tmp/fly2922-close-related.log`). The archive fix landed during that related run; its own current-source fixture is green, final archive-consumer rerun remains required. The existing actions fixture attempted its usual external inbox write and received sandbox EPERM warnings; assertions passed. No production inbox was modified.

Affected builds (teamlead+deps, terminal-mcp+deps) and dependent edge-worker/teamlead/voice-codex types passed before final archive guard. Formatting errors in two touched files were corrected; final lint/build remains required. New discovery and per-test disposition records: `/tmp/fly2922-close-consumers.json`, `/tmp/fly2922-close-consumer-disposition.tsv`. Remaining explicit selected checks, CLI/HTTP response proof, terminal collection coverage, and unified recovery consumption of this new episode are still required. This closes no complete approved group by itself; cursor remains 0/6.
