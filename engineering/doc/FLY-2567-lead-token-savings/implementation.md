# FLY-2567 Lead token 节省 — 实现记录
Issue: FLY-2567 (https://linear.app/geoforge3d/issue/FLY-2567)
日期: 2026-09-14
基于: plan.md

## T1 — Bootstrap（源码完成，未部署）

- CommDB 在现有 `getPendingQuestions` 上增加可选 kind/limit/cursor；复用原 response 与 terminal_disposed 判据，旧调用不变。分页按 `(created_at,id)` 排序，参数化 SQL。
- 生成器和只读问题页共用展示过滤；从原始候选推进游标，因此空过滤页不阻断后续义务。结构化 report 单列，并保留 kind/readAt/relayState；不自动消费。
- 两个 runtime 共用一个 formatter，整条正文最多 12,000 Unicode code points；gate/ask 各最多10条、report最多3条，正文160字符。超预算整条撤去预览，ID与DB路径不截断；所有区段有 omittedCount 与读取入口。
- 新增 master-token-only GET questions/sections 路由；未配置 token 为503，Gemini为403，其他凭据401。既有 POST Bootstrap 路由未改变。
- 恢复规则改用分页入口，避免旧 `pending` CLI 全量回灌。

### 已执行证据

- `pnpm install --frozen-lockfile` 成功；初始 `pnpm -r build` 成功。
- DB分页测试：原代码2项断言失败；改后 `db.test.ts` 85/85通过。首个代码提交 `4d266490b`。
- 生成器新增分页/报告回归先红；201份报告均可取回，50条全被过滤的gate页仍推进。生成器既有跨Lead、completed runner、ref/stop-report测试保留。
- 总正文回归：同一合成大快照原正文425,071字符，改后≤12,000；该数字是测试夹具，不冒充生产token收益。
- Bootstrap定向4文件73/73通过（generator、mailbox runtime、CommDB transport、read routes）。
- `pnpm --filter flywheel-teamlead typecheck` 通过；改动TS文件Biome通过。
- 本地详细日志：`/tmp/fly2567-t1-{red,db-green,generator-red,generator-green,render-red,render-green,route-red,route-green,focused,typecheck}.log`；初始构建 `/tmp/fly2567-build-initial.log`。

## 尚未完成

T1–T5 源码工作已完成；T6 全仓门检/有效 code review/PR/精确头 CI/needs_review 交接仍待完成。

未修改生产配置，未启用压缩灰度，未部署或重启服务。真实Discord路径、D1/D7同口径净节省仍须按批准计划由对应阶段/Lead取得；本记录不宣称QA B/C/D通过。

## T2 — 原生压缩窗口启用门（源码已验证，未灰度）

- 同一次注册表读取携带可选 `autoCompactWindowTokens` 与 `autoCompactBaseline`；absent保持absent，model authority receipt schema不变，last-good缺基线不优化。
- 无效或非Claude优化配置仅记录 `canary_not_applied` 并去掉优化字段，不把可选优化变成Lead启动失败。合法窗口400k–1M，另核对 `W >= max(2F,F+200k)`。
- launcher完成规则与工具组装后校验binary version/model/rules body hash/tools configuration hash/Bootstrap策略。tools hash只接受已理解的stdio结构及非秘密选择参数，env仅计名称；无法确认的工具结构不启用。
- 不用 `--version` 成功证明flag支持：限时执行空输入 `-p --autocompact W`，仅明确的无输入错误作为不发模型请求的参数解析成功证据。未知flag、超时、意外成功、版本/hash漂移、环境覆盖冲突都只省略窗口参数。
- config/model/probe定向182项通过；新增Codex排除用例另跑。launcher真实隔离dry-run先红（14 pass/1 fail，窗口未到argv），接线后15/15通过；包括匹配基线添加原生flag、冲突环境只取消优化且继续启动。初次shell测试夹具误判MCP路径已修正，不算产品红证据。
- 日志：`/tmp/fly2567-t2-{config-red,config-green,probe-red,probe-green,focused,final-focused,shell-red2,shell-green,build,build-final}.log`。
- **仍无生产基线配置、无窗口启用**。规则瘦身后≥3次底线测量、≥3次代表性压缩trace、founder延迟以及D1/D7账本均未取证，须后续按原计划取得，不能用上述stub/fixture测试代替。
- T2最终补充：新增Codex测试夹具先修正为合法受限配置后，model/probe 13/13通过；最终teamlead build通过；指定 `fly247-bash-suites.test.ts -t 'fly241 per-Lead model-override'` wrapper通过（46.35s，其他10项因定向选择未运行，内部launcher套件15/15且未SKIP）；Biome与diff-check通过。wrapper日志 `/tmp/fly2567-t2-wrapper.log`。

## T3 — 审计投递选择（底层与生产接线已完成）

- `EventFilter`新增窄allowlist，来源信任由调用者给出，默认外部/model；明确例行stage与监控恢复可audit-only，未知/失败/review/ship/需要动作/混合消息仍model。
- StateStore新增`delivery_disposition`（默认model、CHECK枚举）与pending部分索引；老行保持model，不迁移在途队列。未投递/guardrail/reconcile/inbox scans及统计排除audit-only，拒绝为audit-only伪写delivery失败或成功。
- runtime registry增加可配置的持久审计判断入口：dispatch/普通runtime wrapper可以无投递返回auditOnly；直接enqueue误用显式拒绝，不伪造queued收据。后续 wiring 提交已注册生产入口判断（见下文）。
- 归档发现旧allowlist/部分索引也排除了stage_changed；现仅让audit-only行另外进入候选，普通model事件条件不变。审计行不需要delivered_at，归档恢复后仍不参与投递。
- 已取得failing→green：分类、journal读写/统计、registry、归档。独立测试19/13/8/22项通过；typecheck通过。journal测试覆盖旧schema迁移、关闭重开、model行不被重新归类、审计行不伪交付；archive测试覆盖冷存与恢复。
- **剩余T3工作**：将已验证event-route stage与Heartbeat监控恢复接到持久选择；DirectEventSink默认保留非例行事件；给registry/LeadInboxRuntime接入权威判断，覆盖归档后按同seq重放防复活；补生产入口和队列重驱动集成测试、完成消费者/retention gate sweep。当前不宣称事件模型投递已降为0。
- 日志：`/tmp/fly2567-t3-{filter-red,filter-green,store-red,store-green,store-final,registry-red,registry-archive-green,archive-red,archive-green,typecheck,foundation-focused}.log`。`registry-archive-green`这次实际为1失败/29通过（发现stage归档索引缺口），后续`archive-green`22/22通过；保留原红证据，不按文件名判断结果。

### T3 production wiring completed

Trusted persisted stage transitions now classify only the six routine stages as audit-only; both authoritative session projection and raw input must pass the negative guards. Monitoring restoration retains title/domain effects and its audit payload but no longer invokes model transport. Unknown HTTP events and actionable/failed stages stay model-delivered. Registry and direct queue admission check authoritative hot or digest-verified archived rows, preventing cold audit rows from resurrecting into delivery.

Consumer sweep: pending-event, inbox, guardrail, reconcile and statistics readers exclude audit-only rows; delivery marking/failure recording cannot fake an audit delivery. Runtime admission guards cover direct and registry routes. Terminal archive admits audit rows without delivered_at; restore preserves disposition. The older destructive retention engine remains limited to its existing delivered narrative types; this change does not widen deletion. Rollback must retain disposition-aware readers and hot/cold admission guards while disabling only new classification.

Verification: producer/archived admission tests failed before wiring. Integration event-route, HeartbeatService, DirectEventSink and lead-inbox-runtime: 229/229 green (`/tmp/fly2567-t3-integration.log`). Expanded Heartbeat regressions initially failed 5 old mock/expectation cases; updated mocks reflect the new store dependency and routine restoration behavior, retaining lost-monitoring retry/throw assertions; final 130/130 green (`/tmp/fly2567-t3-heartbeat-final.log`). TypeScript check green; retention-consumer gate `ok:true, errors:[]`. These are local source receipts, not founder Discord or production savings proof.

### T4 ACK / expiry completed

Moved existing protocol consumption ahead of admission maintenance and lease expiry after owner acquisition. A protocol error is retained and reported after expiry runs, so an unrelated malformed/unavailable protocol effect cannot starve lease maintenance. Expiry now checks durable unconsumed bridge ACK rows within its existing immediate transaction. The parser moved to flywheel-comm and is shared by ProtocolIngress. Valid ACKs settle through the existing recipient-validated batch method and consume the ACK atomically; a foreign live claim holds the original batch without stealing the claim. Malformed, wrong-sender, wrong-batch, terminal and mixed-recipient candidates do not delay expiry. Late ACKs retain ack_late_noop and cannot settle a new batch.

No lease/retry changes, new tables, ref_id mirrors or transport-side automatic ACKs. The mailbox anti-join was added to the retention consumer registry as candidate_guarded: it only validates current hot batch membership for expiry, through the same hot-batch authority as ackBatchByRecipient; terminal history does not create new active members or replay authority.

Receipts: initial queue regression 3 failed/5 passed and loop regression 2 failed; final queue suites 78/78, loop + ingress 31/31, inbox MCP ACK semantics 4/4. Includes file-backed reopen, atomic rollback on injected ACK-consumption failure, late/new-batch isolation, duplicate ACK, live/expired foreign claims, malformed and wrong recipient. Comm build and teamlead typecheck green; retention gate initially detected the new unclassified anti-join, then green after registry entry. Logs `/tmp/fly2567-t4-{queue-final,loop-green,ack-semantics-final,comm-build,typecheck,retention-gate-final}.log`. The initial inbox filter matched no projects; only the corrected flywheel-inbox-mcp invocation is a test receipt. T4 expected production savings remain zero until repeated delivery identities are measured after deployment.

## T5 — 规则瘦身与按需操作

实际调用既有 rules_bundle_materialize，在同一临时路径、同一 18-source 顺序分别组装 `2c1143056` 与当前内容：215,552 → 155,143 Unicode 字符，减少 **28.03%**。另以设计阶段真实 bundle 的 215,011 字符及各来源 delta 计算为 27.89%。两者基准不同，均不是模型 usage 或上线节省量。逐来源 hash、字符数和 bundle hash 在 `evidence/rule-bundle-before-after.json`。

| 原常驻内容 | 新位置 / 保留约束 |
| --- | --- |
| department Reply Discipline 重复案例、表格、跨 issue 重复说明 | 常驻简明 N-token 算法；后部原 payload/status/remainingText/reverse-lookup 细则保留。400/403 不能盲目 fallback，失败仅影响对应 issue |
| inbox 重复的整份 Reply Discipline | 指向已常驻的 dept/cos 角色路由规范；保留按完整 batch 处理后确认 |
| patrol §0 准备、STEP 1–6/DWELL 详细操作、完成门、SQL 附录 A/B | 同版本 `lead-rules-base/runbooks/patrol-v1.md`；原 §0 到 §0.9 之前的字节内容逐段拼接验证完全一致，SHA256 `3ed52bf4ab84ab2ede3ef6265605aa843324d05785558cbf5c3ef88b1f4a6ce8`。常驻必须先读准备与相关 STEP、修复前读完整配方；MANIFEST 原源路径给出同版本相对入口 |
| patrol 核心义务/权限/完成条件 | 常驻约束保留 owner-only、真实性 guard 停手、不可写 authority/gate/approval/claim、不可终结 Runner、受管快照/低盘5×、A/B 双步骤、独立 evidence、六步+DWELL 与完成门；不可读手册为 UNAVAILABLE，不能猜或跳过 |
| founder-only-authority.md、其他治理包 | 未修改，仍完整常驻；按需配方不扩大授权 |
| batch ACK、FOLLOWUPS | 已完整处理批次同一响应并列 ACK；queued 仅协议受理；不等批次聚齐才处理 founder；不自动/提前 ACK；FOLLOWUPS 按事实变化局部更新，保留未完义务 |
| 定时/summary | 无覆盖证据的现有调度全部保留；summary_due 已是唯一 due 来源，禁止重复自建提醒；没有声称减少定时器 |

详细巡检步骤也随 SQL 配方迁入手册，常驻保留执行入口和核心合同，以满足整体 25% 目标。此举减少每个普通 Lead 请求的上下文，但 patrol 按需读取会重新引入相应成本；D1/D7 必须计入这部分，不能按 28.03% 直接宣称 token 下降。

验证：预算先红；改后预算/常驻安全 2/2。既有 patrol 合同测试读取其迁移后的完整操作内容，原断言、执行 SQL/awk 门验证保留；常驻安全另测，防止仅凭手册中存在约束宣称常驻安全。六个规则/装配测试文件 82/82；迁移后的 exact-path residue allowlist 测试77/77。Claude/Codex 原 shared resolver 加载来源不变，runbook 不作为 prompt source 自动追加。安装源 `package-onboard.sh` 的 PO_PACKAGE_ASSETS 已递归复制整个 lead-rules-base，既有 allowlist 覆盖其路径；无新增安装动作。日志 `/tmp/fly2567-t5-{budget-red,budget-green,rules,residue}.log`。

## T6 — 全仓验证进行中

`pnpm lint` 已通过（18 warnings，未修改无关告警）；独立 `pnpm -r build` 已通过。日志 `/tmp/fly2567-full-lint.log`、`/tmp/fly2567-full-build.log`。`pnpm test:packages:run` 正在运行（本次启动 head `896520df5`，执行工具 session 22752，输出 `/tmp/fly2567-full-package-gate.log`）；尚无 PACKAGE_GATE_RECEIPT 终态，不宣称聚合通过。后续进度文档提交不改变该源码测试覆盖，但 exact-head CI/有效评审仍须最终 PR 头重新取得。

### Resume: code-review instruction and audit read surface

Lead instruction `41ee3448-f8d1-472e-8f7d-5ef31cfd99eb` relayed effective APPROVED / raw APPROVED for request `270c43c6-5448-4664-ba39-8205aa31c71d`, reviewed head `863d4d2293e204b091be85ac941d772a54cbe019`; receipt preserved in code-review-receipt.json. Lead explicitly requested the audit read gap fixed in this round and no new review round for the seven nonblocking findings.

Added master-authenticated `GET /api/bootstrap/:leadId/audit-events?limit=1..50&cursor=<seq>`: descending seq keyset pagination, current Lead filter, hot plus retained cold rows, SHA256 validation before exposing archived payload. Bootstrap includes only its read pointer; audit rows remain excluded from model delivery/retry and are not automatically inserted into recovery text. New StateStore read is a historical/reporting consumer under the existing file/table registry entry: it explicitly includes retained cold history and creates no delivery or authorization state. Retention-consumer gate passes.

TDD: absent route/read method failed two regressions, then 91/91 related tests passed. Added corrupted cold-row digest coverage; initial fixture attempts hit the immutable-table and digest-length guards, corrected by inserting a separate valid-schema row with an invalid 64-character digest. Final test receipt recorded after completion below. This is test-fixture correction, not weakened production guards.

Follow-ups retained per Lead: (2) the older FLY-2006 retention engine still deletes only delivered narratives; extending this destructive policy is not the same semantic change as exposing archived audit history, so it remains unchanged. Audit rows use terminal-row-archive, and the new reader includes that archive. (3) section pages regenerate the bootstrap snapshot; (4) rule-budget test references doc evidence; (5) ACK scan is unbounded and runs on runner lane; (6) Heartbeat passes trustedBridge unconditionally; (7) duplicate disposition predicate. No fixes to 3–7 in this round.

Original aggregate session 22752 is no longer available after restart. Its claude-runner attempt ended with one 40-second profile timeout in Vitest (reporter failed=3); aggregate never produced a terminal summary. Do not accept it as RPC-only or green. The unchanged `classifies third_party destination replacement` test passed alone in 13.94s (`/tmp/fly2567-profile-repro.log`); this does not prove a host-contention waiver. Fresh full gate session6501 uses `/tmp/fly2567-full-package-gate-resume.log`; its starting head precedes this read-surface fix, so final source verification and exact-head CI remain required.

Final audit read focused receipt: 25/25 green including corrupt digest and cold retention (`/tmp/fly2567-audit-read-final.log`); preceding broader 91/91 (`/tmp/fly2567-audit-read-green.log`), TypeScript noEmit and lint (18 existing warnings) green. Build and aggregate are still pending; these focused receipts do not replace them.

### Technical sync before PR

Merged origin/main `f022a0a7e` (FLY-1945 / FLY-2559) in `012908b23`. The only textual conflict was the patrol section moved into the on-demand runbook. Kept the new activity/episode and mechanism-disposition constraints resident, and copied the complete upstream procedure section into the runbook without rewriting; section SHA256 `a05daf5e8e1dcd13e0c40ecbd752498eb22d25ef38f12b1fb2686b79fb53c3a0` matches upstream exactly. Rules/complete executable finding gate tests 35/35, residue 79/79 and retention-consumer gate pass. The earlier bundle before/after receipt predates this sync; current budget test still proves at least 25% character reduction, not production token savings. New full lint/build underway; full package gate remains live. Fresh review is for this technical sync head, not a re-review of the seven settled-as-nonblocking advisories.

### CI d9229e631 corrections

Run `34928911415` failed Quick Gate on FLY-1645 question-domain registration: Bootstrap paging forwards the authoritative question relay state but was absent from the exact consumer allowlist. Added its explicit path, with a regression that permits this question consumer while continuing to reject an unrelated relay/debt consumer (red, then 5/5 green; main-only scan green).

Script shard 3 failed the existing FLY-1716 retirement guard because the new optimization conflict check referenced a retired undocumented percentage variable. Removed that reference; retained supported native window, disable switch, and duplicate CLI argument guards. Retirement guard red then green; fly241 launcher wrapper passed (25.42s) and actual compaction probe test passed separately. The initial filtered wrapper command did not select the probe test; only the subsequent unfiltered one-test receipt proves it. No production config changed. Logs `/tmp/fly2567-{receipt-domain-red,receipt-domain-green,override-retirement-red,ci-fix-compact,ci-fix-compact-unit}.log`.

### CI 7efe6326e contract and fixture corrections

Run `34929586949` exposed remaining integration contracts: FLY-2144 expects the resident pure-clock anchor (restored its original bold markup); main's newly merged patrol-report test still extracted awk from the former file (now reads the versioned runbook and asserts nonempty mechanism logic before executing unchanged positive/negative cases); the bounded launcher-only auto-compaction CLI probes were absent from the child-process census (registered both 5s/16KiB probes, no Bridge import). Three contract suites failed locally before corrections.

The 253-row Bootstrap fixture exceeded CI's 5s test deadline because its helper reopened/migrated CommDB for every row. This one fixture now shares one seed connection and closes it before production paging; row counts, production query path, and every assertion/timeout are unchanged. The affected five suites pass 85/85 (`/tmp/fly2567-ci-contract-green.log`), and the paging case takes 380ms locally. This is a fixture efficiency fix, not a host-contention waiver or production behavior change. Original CI red remains recorded.

## Final verification closeout

Source head `042c89ad7afcfc67abf117414f488106d5339ff5` has effective review **APPROVED** (request `4877fda1-f731-4ca2-b80a-884a65c71dd4`, round 4) and exact-head CI **15/15 SUCCESS**. Both serial and parallel teamlead projects run across four shards; heavy/light shards cover all remaining package test scripts. This is full CI package coverage, not a focused-test substitution. Receipts are preserved in evidence/code-review-final.json and evidence/ci-source-head.json. Thirteen nonblocking advisories were reported to Lead; Lead explicitly deferred archive migration digest compatibility and audit retention/health observability to a follow-up, and directed this phase to finish handoff without scope expansion.

Local `pnpm test:packages:run` session6501 ended at 2026-09-15T05:18:13Z with **exit 1 / failed**, not RPC-only. It started on `863d4d229` before the subsequent CI fixes. All 17 packages were reached; 16 passed. Teamlead completed all 1124 files: Vitest reports 1 failed test / 14540 passed / 7 skipped, while the custom receipt reports failed=3, plus one `onTaskUpdate` RPC error. The sole failing test was the pre-fix 253-row Bootstrap fixture's 5000ms timeout; its later shared seed-connection correction was verified with unchanged assertions and timeout (380ms locally) and the complete exact-head CI suites. Keep this local red distinct from current-head CI green. `evidence/package-gate-local.json` is the unmodified wrapper receipt; full logs remain in the receipt's directory. No local-green or RPC-only exception is claimed.

PR #1204 is non-draft; milestone is kept as the final commit. Closeout adds documentation/receipts only, so no implementation changes follow the green source head. Final-head CI/review are revalidated before the structured needs_review handoff. Real Discord founder delivery/latency, measured context-floor canary, production D1/D7 usage and measurement-after.md remain the explicitly assigned QA/Lead rollout obligations; this implementation has not run or claimed them.

## Founder kill-switch rework (2026-09-15)

Implemented the approved single default-ON `lead_token_savings` project flag. Bootstrap and event paths read at call time; launchers freeze one read for rules and native compaction. Per Lead ruling `fd187a87-6c43-4ec5-adc2-4179ccba0433`, rules/window recovery takes effect on the next Lead launch. No live system-prompt replacement or service restart is implemented. ACK atomicity remains unconditional.

OFF reuses the historical unpaged Bootstrap collection and complete renderer, restores the old event payload/delivery, selects four historical rule sources, and omits the optional native compaction window. The launch reader uses readonly SQLite with the shared flag resolver; missing/malformed state chooses full behavior. Missing legacy rule assets abort launch. Both ON and OFF measured input floors must fit a configured canary window.

Compatibility is guarded by `src/__tests__/fixtures/fly2567/compatibility.json`: every paired source digest is checked independently, with per-pair rationale and independent mutation tests. The manifest includes rules, patrol runbook, generator/query dependency and both formatter consumers. Historical fixture imports are formatting-normalized only; the generator implementation bytes remain pinned. Full OFF governance body matches the original shared selector/materializer; host paths and generated timestamp are metadata and excluded from the body digest. `capture-legacy-bundle.py` reproduces that oracle directly from the historical Git source.

The registry records Lead-owned review by 2026-10-15; no automatic expiry/toggle or wall-clock CI failure. Lead must authorize removal after duty/savings evidence or explicitly extend with fresh compatibility evidence. Founder display states both effect times, symptoms, and the fact that past audit-only events are not replayed automatically.

Validation is still in progress: original QA remains historical evidence; controller-owned QA retest and founder gate must evaluate the final head.

### Verification-driven registry corrections

Full flag authoring guards found missing config identity metadata, an invalid retirement field shape, and a mismatch between the new strict codec and the existing boolean codec contract. Added the metadata, used the required issue ID `FLY-2567` for `retiring` with the review date/owner in the note, and kept standard boolean codec semantics. The shared runtime wrapper validates persisted override bytes before invoking the existing scoped resolver, so malformed storage still restores full behavior. Registry copy and exact delegated-read-site expectations were extended for the new flag; Heartbeat uses the scanner's class-qualified method identity.

The exact `three_stage_turn` compatibility declaration now covers the OFF patrol copy as well as the ON runbook; this is the same live read-only TURN recipe, not reactivation of the retired dispatcher. No broad rule-scan exclusion was added.

### Post-sync verification and CI fixture correction

Merged `origin/main` at `e43c4b567` in `78eaacb01`, preserving both flags and registry count30. All nine historical dependency blobs are unchanged at the new merge-base; see `evidence/rework-upstream-proof.json`. Postmerge config guards90, routing/launch40, full recursive build and lint passed. The first postmerge route run used stale config dist and rejected the newly merged rotation flag; rebuilding dependencies restored the unchanged test.

CI run34948207077 found two failures in `HeartbeatService.zombie-offpath-golden.test.ts`: its mock store had no `getFlagValueRow`, correctly causing full-behavior fallback while the fixture expected default-ON savings. Local reproduction failed the same two assertions. Added only the missing healthy-store read method (returns no override); existing assertions and production semantics are unchanged. Both that suite and main Heartbeat tests pass29/29. The suite's historical OFF label refers to independent zombie handling, not this new flag.

The local package gate also recorded an unchanged claude-profile SIGTERM fixture failure, teardown ENOTEMPTY and onTaskUpdate timeout. Its exact source and focused recovery receipt are preserved in `evidence/rework-local-profile-failure.json`; it is not RPC-only or aggregate green. Full collection continues. Current-head CI and effective review remain pending.
