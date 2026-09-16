# FLY-2606 设计交付证据 — 调研
Issue: FLY-2606 (https://linear.app/geoforge3d/issue/FLY-2606/热生效-founder-2026-09-16-0038z改模板effort-要等重启才生效本来就有问题-工作流模板从仓库种子发布到)
日期: 2026-09-15
基于: plan.md

## 已完成的设计检查

- 基线源码 `6556b0751`；初版设计提交 `40fd8c2b1` 已推送 `origin/flywheel-FLY-2606`。
- 设计TURN：epoch=1，activation `activation:dd57b466-0a26-4d51-b32f-726ae6e3d311:4a585d8b-0454-4f51-8a83-c0a1b81cc2a4:eng_design:1`。
- FLY-2602边界答复：question `85b26eff-69c9-4986-966b-12148f4381dc`；Codex范围/legacy守卫答复：question `4fbfd625-1300-4984-aa4b-33911d0502e0`。两条均通过check消费，并向Lead报告已采纳。
- 显式设计R1：question `b8f9938a-cab5-46ad-baef-770b6d38e1ce`，request `1761aed1-5233-4844-aac8-373f3dade7b5`，accepted=true/skipped=false。有效结论为CHANGES_REQUESTED；原始回执见design-review-r1.json，逐项处置见design-review-r1-disposition.md。
- `codex-cli 0.153.2` 本机生成实验schema成功，确认settings update/updated、turn/start和thread/read字段；未启动生产模型会话。
- R1两项HIGH修订与全部11项处置提交 `bcd8cb4b0`；R2 question `143fa0c1-eff9-4b94-bbe8-d3eb0d47dd25`，request `637f806c-e620-45ab-aa84-2d910d47f227`，accepted=true/skipped=false；有效reviewVerdict=APPROVED，reviewerVerdict=APPROVED；原始回执design-review-r2.json与5项非阻断Follow-ups见review-receipt.md。
- R1修订后评论页DOM检查重新PASS。
- `git diff --check` 通过。

## HTML检查

运行：

```bash
FLY2606_HAPPY_DOM_MODULE=/Users/xiaorongli/Dev/flywheel/node_modules/.pnpm/happy-dom@20.10.6/node_modules/happy-dom/lib/index.js node engineering/doc/FLY-2606-live-config/verify-founder-html.mjs
```

结果：structural=PASS，controller=PASS，8节全部有评论框；长意见分成4块且每块≤1800字符、都有规定marker；clipboard promise拒绝和API缺失均回退execCommand；localStorage异常可继续；location.pathname隔离通过；输入HTML只作为文本。

唯一inline script使用精确nonce占位符，无自定义CSP、inline handlers、外部资源。此为DOM控制器验证，**不是浏览器视觉或真实CSP运行验证**。

## 本地绘图与浏览器限制

flow.mmd和data.mmd分别执行mmdc一次，失败后各按标准参数重试一次：

```text
mmdc -i <source> -o <svg> -w 1000 -b white --svgId FLY-2606-d1|FLY-2606-d2
```

四次均为Chromium启动失败：`bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer ... Permission denied (1100)`。按本任务明确允许的降级交付 `DIAGRAM PENDING LOCAL RENDER` 标记和Mermaid图源；没有CSS假图、远端渲染或外部图资产。

Chrome DevTools新隔离后台页调用返回：`MCP tool call requires approval, but approval policy is never`。因此visual_browser=NOT_RUN；没有通过其他路径规避审批限制。

## 尚未属于本设计的功能证据

没有实现代码、没有生产模板写入、没有Lead配置写入或服务重启；没有宣称模板发布、Lead热生效、实现CI或隔离运行验收PASS。plan中A1-B7由后继实现/QA提供。托管发布与fetch/CSP验证将在有效设计APPROVED之后补到本文件。

## 发布阻塞记录（2026-09-16 UTC）

最终HTML在提交1f01ed3e5后执行两次同一publish-only命令，两次均返回 `publish failed (502): report publishing failed`，url/reportId为null，delivered=false。原始结果见publish-attempt-1.json、publish-attempt-2.json；没有托管URL，因此HTTP/CSP/线上内容验证尚未执行，不能报托管已验。

源码 `bridge/reports-route.ts:396-415` 在upload/deploy catch执行staged.abort后映射该502；不能仅由通用错误确定具体存储商/网络/凭据原因，未读取凭据或更改发布服务。已按要求报告DESIGN-HTML publish-failed（receipt bed5592a-0448-40e0-b8be-61e3507fb866），并通过question `790a5784-0cdc-4dee-97a2-16c260ce53b2` 请求Lead协调托管恢复或明确失败交接处置。设计保持APPROVED；尚未执行phase_design_complete/park。

恢复轮次再次调用同一publish-only命令，原生CLI exitCode=1，仍HTTP502且url=null；结构化stdout/stderr见publish-attempt-3.json。当前TURN仍为design epoch=1；Lead question 790a5784-0cdc-4dee-97a2-16c260ce53b2尚未答复。没有重开设计或修改发布服务。

## Lead明确的失败交接处置

Question `790a5784-0cdc-4dee-97a2-16c260ce53b2` 已通过check消费。Lead独立核验托管存储暂停（blob PUT 403 store_suspended），并亲自发布本提交HTML也502；本节点不声称自行观察了403。Lead要求不再重试，并明确授权在报告publish-failed后完成design，由Lead于托管恢复后交付HTML。原始答复保存在lead-publish-disposition.txt。

故交接保留以下真实限制：托管URL不存在，HTTP/CSP线上验证未运行；两张Mermaid图本地渲染失败、图源保留；浏览器视觉QA未运行；只有评论层DOM检查PASS。热配置功能仍须后继实现与隔离验收。


## Implementation admission

- Acquired implement TURN epoch 2 for execution `e059729e-9960-4b78-80c1-70b28214852f`, activation `activation:e059729e-9960-4b78-80c1-70b28214852f:4a585d8b-0454-4f51-8a83-c0a1b81cc2a4:implement:1`.
- Rechecked question `143fa0c1-eff9-4b94-bbe8-d3eb0d47dd25`: effective R2 reviewVerdict APPROVED. Existing advisories remain nonblocking; no new design review opened.
- Plan §2.5 requires the final FLY-2602 dependency. PR #1217 is OPEN at `4f376f290fc87d173cab2c5a6ba20ecb1cf485e0`, not an ancestor of the initial implementation head. Question `06a541f9-16fa-45eb-9d51-df218c2ba46e` asks Lead whether to sync that feature head or wait for main. No dependency merge or implementation code changes yet.
- `pnpm install --frozen-lockfile`: exit 0; `/tmp/FLY-2606-install.log`. Initial missing workspace dist/bin warnings require build before behavioral tests.

## Source audit and test targets

- Existing `StateStore.createAndPublishWorkflowTemplateRevision` already wraps revision/publication/pointer/audits in a synchronous transaction and checks expected revision. It lacks publication operation receipts, expected digest, retired admission and active/held pin guards. Extend the common writer rather than introduce a second transaction path.
- `workflow-menu.ts` resolves aliases against ambient snapshots during compile; `loadWorkflowMenuSeeds` passes the compiler directly to `map`. Adding a snapshot parameter also requires replacing that callback with an explicit closure to avoid passing the array index as a snapshot.
- The upstream `packages/config/src/agent-registry.ts` parser also reads ambient model registry entries in `parseModel`, reached by `loadBundledRegistry`. A fixed publication snapshot must reach this validation boundary as well as manifest compilation; a compiler-only test would miss the generation mismatch.
- FLY-2602's dependency implementation retries source-profile matches without a published marker; `source_profile_preserved` is only a returned result, not a terminal persisted marker. The managed publication admission must account for that distinction so rollback to an old profile cannot be silently migrated on a later restart.
- First T1 tests should establish fixed-generation seed compilation, atomic publication/receipt failure rollback, replay/conflicting operation IDs, two-field CAS, active and held unpinned rejection, and seed/migration restart preservation.

## Pending evidence

All T1–T6 implementation, red/green tests, required aggregate gates, effective code review, PR and exact-head CI remain pending. No production template/config writes or service restarts performed. Host isolation acceptance remains distinct from unit tests and CI.

Lead dependency disposition: wait for PR #1217 to merge into main; do not merge its open head. Independent implementation/tests may proceed; ask again after 05:00Z if still blocked. Baseline `pnpm -r build` exited 0 (`/tmp/FLY-2606-baseline-build.log`).

## T1 partial: fixed model generation

- Added `workflow-menu-snapshot.test.ts`: three assertions failed before implementation (`/tmp/FLY-2606-snapshot-red.log`), proving all three public entrypoints ignored a supplied generation.
- Threaded one model snapshot through bundled registry policy parsing, menu loading, alias resolution and manifest validation. Existing callers capture a default snapshot once; explicit callers retain their captured generation.
- After the fix: snapshot + existing menu + menu registry suites 51/51 passed (`/tmp/FLY-2606-snapshot-green.log`); config agent-registry regression 20/20 passed (`/tmp/FLY-2606-registry-regression.log`). Config build passed. Scoped Biome check passed after formatting.
- This is only the seed compilation prerequisite. Publication transactions/CLI and Lead hot configuration are not implemented yet; T1 is not complete.

## T1 partial: durable publication primitive

- Added optional managed publication metadata to the existing atomic StateStore writer, including expected digest alongside expected revision, durable append-only operation receipt, source/reason/build/registry attribution and before/after audit digests. Existing callers remain compatible; management routing and migration admission are still pending.
- Receipt/CAS tests initially failed 4/4 (`/tmp/FLY-2606-publication-red.log`). Corrected test expectations for the existing revision getter's `undefined` absent result. Active/held malformed snapshot tests then failed 2/8 before adding the guard (`/tmp/FLY-2606-publication-guards-red.log`).
- Final focused result: 9 publication tests + 19 existing StateStore template tests passed (`/tmp/FLY-2606-publication-green.log`). Includes receipt replay/conflicting operation IDs, SQL append-only replacement rejection, retirement, digest CAS, receipt insertion failure rollback, disk reopen and preserved manual ownership on seed import. Valid pinned/unpinned snapshot variants and new-run dispatch integration still need coverage.
- Teamlead build passed (`/tmp/FLY-2606-publication-build.log`). Retention consumer gate passed (`/tmp/FLY-2606-retention-gate.json`); consumer and retention mutation regression 12/12 passed (`/tmp/FLY-2606-retention-tests.log`). The new receipt table has a protectedCurrentOrReference fragment.
- No API is enabled by this primitive alone. Publication service/stage/apply/CLI and FLY-2602 admission integration remain required before T1/T2 completion.

## T1/T2 partial: publication service and injectable HTTP routes

- Added a server-owned stage/apply service: strict stage fields, reason/ID/content bounds, seed/file/historical revision selection, immutable compiled candidate, captured registry generation, expected revision+digest and content-bound single-use token. Apply revalidates the generation and uses the shared transaction. Durable receipt replay bypasses a consumed token only for the same committed request digest.
- The initial service test run failed collection because the new module did not yet exist (`/tmp/FLY-2606-publication-service-red.log`); this is not an assertion-level red claim. Service tests now cover expiry, changed canonical content even with a recomputed digest, generation drift, committed replay after generation drift, concurrent CAS, forged actor/invalid fields, and immutable rollback publication.
- HTTP tests first failed 2/2 because mutation routes were absent (`/tmp/FLY-2606-publication-routes-red.log`). Added optional service-backed routes requiring a loopback peer/Host and matching Origin/Referer before stage/apply or receipt lookup. The apply URL must match the frozen template; internal errors return 500 without exposing database details.
- Final focused run: 25/25 across transaction, service, publication routes and existing read routes (`/tmp/FLY-2606-service-routes-green.log`). Scoped Biome check passed. Build initially found a route-param union type mismatch; status now validates unknown input at the boundary.
- Production plugin still constructs the read-only router. CLI, GET alias, management editor integration, token expiry presentation and migration admission remain pending. No production activation or full T1/T2 completion claimed.

## T2 partial: CLI and read alias

- Added registered `workflow-template publish|rollback|status` CLI. It validates options and loopback origin, reads bounded UTF-8 JSON file contents locally, prints operationId/requestDigest before apply, and does not re-stage/rebase or retry after a lost response. Status uses an authenticated same-origin GET. Tokens are not printed.
- Initial CLI test run failed collection because the command module was absent (`/tmp/FLY-2606-cli-red.log`), not an assertion-level red. Final CLI suite 9/9 passed (`/tmp/FLY-2606-cli-green.log`), including duplicate/unknown flags, wrong origin, file contents versus path, oversized file refusal, status, rollback and lost-response handling.
- Read-only alias `/api/workflow-templates/:id` and `/revisions` delegates internally to the same read router with no redirect. Alias test failed before implementation (`/tmp/FLY-2606-alias-red.log`); original/read-alias/publication HTTP tests 3/3 passed (`/tmp/FLY-2606-alias-green.log`). Plugin mounts this read-only alias; managed production publication remains disabled until migration admission is integrated.
- Comm build passed (`/tmp/FLY-2606-cli-build.log`); teamlead build passed (`/tmp/FLY-2606-alias-build.log`). No production writes or restart. FLY-2602 PR #1217 still OPEN at this checkpoint.

## T4 prerequisite: native transport and stale launcher tuning

- Rechecked generated local schema in `/tmp/fly2606-codex-schema/v2`: settings/update uses threadId/model/effort; settings/updated supplies threadId/threadSettings. ThreadReadResponse explicitly describes model/reasoningEffort as current or persisted settings, **not per-turn telemetry**.
- Added typed `CodexLeadProcess.updateThreadSettings` and `readThreadSettings`, and optional model/effort on startTurn. RPC errors propagate; read rejects missing fields/wrong thread. Update returns queue acknowledgement only; no applied/observed claim. New transport tests first failed 3 with 30 passing, then all 33 passed (`/tmp/FLY-2606-process-red.log`, `/tmp/FLY-2606-process-green.log`).
- Shared canonical Codex launcher now replaces inherited model/effort with validated registry fields, or unsets stale values when absent. Removed only those two equality assertions; identity/backend/context-window assertions remain strict. This does not itself change a running process.
- Launcher tests first failed the two stale tuning cases with 14 passing, then all 16 passed (`/tmp/FLY-2606-launch-tuning-red.log`, `/tmp/FLY-2606-launch-tuning-green.log`). Teamlead build passed (`/tmp/FLY-2606-process-build.log`).
- Still required: daemon plist generation changes, fresh registry bootstrap/reconnect, settings coordinator and notification receipt, capability/auth socket, managed registry write and persistent operations, router/TUI/goal next-turn observations. Experimental API capability has not been enabled in production runtimes by these transport methods.
- Existing `scripts/__tests__/flywheel-lead.test.sh` regression exited 0 (`/tmp/FLY-2606-launch-selector-regression.log`), exercising the standard launcher fixture and its registration/preflight/verification boundaries. This is not production launch or hot-config evidence.

## T4 partial: settings coordinator

- Added a raw-notification coordinator with project/lead/identity/carrier/owner epoch/runtime generation/thread/config-generation binding. Source identity is rechecked after async boundaries. A matching settings notification and successful RPC are both required before synchronously persisting and returning applied.
- Caller timeout returns pending while retaining the single-flight lock until the actual RPC settles. Wrong-thread/partial notifications cannot confirm application. Same-generation no-op retry requires both a prior receipt and fresh readback. External session drift prevents automatic re-application until an explicit new generation.
- Initial test collection failed on the missing module (`/tmp/FLY-2606-coordinator-red.log`). A later behavioral race test failed 1/9 (`/tmp/FLY-2606-coordinator-race-red.log`): match followed by another settings change before ACK incorrectly returned applied. Fixed by checking the latest complete notification before persisting; that race returns drifted.
- Coordinator remains a tested building block, not a wired runtime capability. Registry validation callback, durable receipt storage, socket authentication, bootstrap receipts, actual-turn telemetry and runtime admission are still pending. No current settings read is labeled actual-turn evidence.
- Final coordinator/process run passed 45/45 (`/tmp/FLY-2606-coordinator-green.log`); scoped Biome and teamlead build passed (`/tmp/FLY-2606-coordinator-build.log`).

## T4 partial: authenticated runtime configuration socket

- Added applyRuntimeConfig/readRuntimeConfig request types and clients. Canonical HMAC includes method plus every target identity/config field and socketOwnerId. Strict new-method field allowlist, 16KiB request bound and positive configGeneration validation precede hook invocation. Unknown methods cannot fall through to submitBatch.
- Server checks socket inode ownership, socketOwnerId/carrier, a runtime-provided compatibility gate and validated target identity before and after async work. Capability advertisement requires that gate; no existing runtime supplies it yet. Applied client receipts must match the complete requested target and contain a valid application timestamp.
- Initial socket tests failed 3/3 with the missing methods/capability (`/tmp/FLY-2606-socket-red.log`). Final socket suites passed 18/18 (`/tmp/FLY-2606-socket-green.log`), covering existing batch/subscription/proactive behavior plus wrong secret, stale target, every target-field mutation under an old HMAC, unknown field and method substitution. These use isolated Unix sockets and stub runtime hooks, not native Codex application evidence.
- Build initially identified two union-narrowing errors in old default branches; explicit unsupported-method guards fixed those paths. Runtime hook wiring, verified bootstrap-artifact capability, registry writer and persistent state remain pending.
- Final teamlead build passed (`/tmp/FLY-2606-socket-build.log`); scoped Biome and diff whitespace checks passed.

## T3 prerequisite: shared registry IO and explicit lock path

- Extracted the existing lead-registry no-follow read, durable/atomic write, directory fsync and error class into exported `flywheel-comm/lead-registry-file-io`. Command consumers use that single implementation; existing error codes and behavior are preserved. No second file writer or summary receipt writer introduced.
- Extended the existing Python-flock latch helper with optional absolute lockPath, preserving the old home-based default. An actual competing flock writer proved the isolated path was previously unlocked (1 failure, 4 passing); after the fix both default and isolated registry locks exclude competitors, 5/5 passing (`/tmp/FLY-2606-config-lock-red.log`, `/tmp/FLY-2606-config-lock-green.log`).
- All six existing lead-registry suites were included. Concurrent first run had 56 passing and one 5s test timeout, no assertion failure (`/tmp/FLY-2606-registry-io-regression.log`). After build, single-worker run passed 57/57 with original timeouts unchanged (`/tmp/FLY-2606-registry-io-regression-serial.log`).
- Comm build passed after removing two imports made unused by extraction (`/tmp/FLY-2606-registry-io-build.log`). The managed model/effort write planner, lock override conflict admission, operation ledger, crash recovery, runtime push and CLI remain pending; this prerequisite does not enable writes.
- Teamlead build passed (`/tmp/FLY-2606-lock-teamlead-build.log`); scoped Biome and diff checks passed.

## T3 partial: durable operation and audit ledger

- Added protected lead_config_operation and lead_config_audit tables. Operations store immutable identity, source/target SHA, field pre/postimage, actor/reason, model registry revision and config digest; generation allocation is per lead. Prepared same-target intents require recovery before another can be admitted.
- StateStore exposes prepare/replay, pending-intent listing, guarded status transition and ordered audit reads. Status transition and append audit share a synchronous transaction; audit failure rolls back the status. Operation input/replacement/deletion and audit mutation/replacement are guarded by SQL triggers.
- Four initial tests failed before the methods existed (`/tmp/FLY-2606-ledger-red.log`). Final five passed (`/tmp/FLY-2606-ledger-green.log`), including disk reopen of prepared intent and SQL immutability guards. Retention mutation tests 4/4 passed (`/tmp/FLY-2606-ledger-retention.log`).
- This ledger does not yet perform a projects.json write, validate the identity/summary projection, classify file crash seams, push runtime updates or claim applied/observed. Those integrations remain required for T3 completion.
- Teamlead build passed after correcting the pending-query helper argument (`/tmp/FLY-2606-ledger-build-confirm.log`, exit 0); scoped Biome and diff checks passed.

## FLY-2602 main integration and publication admission

- PR 1217 merged as 557d2b00e6ebf102c61c88368a4338b9777099f9. Synced origin/main without conflicts in merge a78ad1df8. Full recursive build passed (`/tmp/FLY-2606-sync-build.log`); ledger, publication, snapshot and effort-migration regression passed 30/30 (`/tmp/FLY-2606-sync-focused.log`). The mistakenly named service test argument did not select that suite; it is included in the subsequent run below.
- Actual 2602 migration has a durable successful-publication marker, while preserved source profiles have no terminal marker. Reproduced the unsafe seam: a managed historical-profile publication without a prior successful 2602 marker was overwritten on the next migration. After fixing the test's initial template field typo, both missing admission and actual overwrite failed (`/tmp/FLY-2606-migration-admission-red-corrected.log`).
- Added a durable managed-receipt preservation check to both migration orchestration and its StateStore transaction. Shared source-profile matching decides whether a pending migration can still change the target. Untouched profiles remain blocked; source profiles 2602 already preserves can be managed, and their committed receipt prevents later rollback to the historical profile from being overwritten. Existing 2602 success markers continue preventing reapplication.
- Stage/apply readiness regression initially failed because the service did not perform the check (`/tmp/FLY-2606-migration-service-red.log`). It now checks both boundaries. Five publication/migration suites passed 40/40 (`/tmp/FLY-2606-migration-integration-green.log`). Earlier four-suite run passed 37/37 before this additional service test (`/tmp/FLY-2606-migration-admission-green.log`).
- Mounted the managed service in createBridgeApp using its actual build identity and model snapshot; unknown build identity rejects new staging with 503. Read alias remains the same catalog. All verification uses isolated in-memory state; no service restart or production mutation occurred.
- Build caught strict indexed-access typing on the shared source matcher; an explicit undefined guard was added. Final build and mounted-Bridge verification are recorded below once complete. Management DAG writer integration and the remaining template/run matrix still remain before T1/T2 completion.
- Complete createBridgeApp HTTP verification passed 2/2: stage/apply reaches revision 2 and the alias returns it immediately; unknown build refuses with 503 and leaves revision 1 (`/tmp/FLY-2606-publication-bridge.log`). Final Teamlead build passed, exit 0 (`/tmp/FLY-2606-migration-integration-build-final.log`). Scoped Biome and diff checks passed. This proves isolated HTTP/catalog behavior, not real-host native Lead hot configuration or production acceptance.

## Management DAG publication integration

- Reproduced the management writer publishing despite a held run with an unverifiable snapshot (one failure, nine existing tests green; `/tmp/FLY-2606-management-guard-red.log`). It now supplies managed publication metadata to the common StateStore transaction, preserving its existing server actor and limited legacy-model repair behavior. The same transaction enforces digest/revision CAS, run pinning, durable audit and receipt creation. It also checks unresolved FLY-2602 source migration before editing.
- The test proves zero publication on the held-run rejection, then verifies the persisted management receipt after that run becomes terminal. Three management writer/coordinator suites passed 31/31 (`/tmp/FLY-2606-management-guard-green.log`); Teamlead build passed (`/tmp/FLY-2606-management-build.log`). A source-only unknown build is explicitly recorded as unknown for this pre-existing management surface; deployed builds use resolveBridgeBuildIdentity. The new CLI service retains its stricter unknown-build admission guard.

## T3 partial: registry candidate planner and Codex Lead model surface

- Added a pure planner that selects exactly projectName/leadId through the canonical identity compiler, changes only model/effort, preserves the rest of the parsed registry structure, and returns candidate bytes, pre/post SHA, identity, field images, resolved native pair and model-generation-bound config digest. Public patch rejects empty, null/reset, unknown fields, controls and invalid enums. Internal rollback can restore absence only when a validated explicit native default pair is supplied; otherwise it rejects runtime_defaults_unavailable.
- Cross-vendor changes fail backend_change_not_hot. Model changes preserve modelContextWindow and require a sufficient trusted candidate context window; effort-only changes retain the already configured model/window pair without inventing a capacity. Summary receipt/schema checks, cfglock/write/recovery and runtime preflight remain service responsibilities and are not yet wired.
- Initial test could not load the not-yet-created planner (`/tmp/FLY-2606-plan-red.log`). After implementation, three tests exposed the actual registry gap: builtin Sol/Astra had no Lead surface (`/tmp/FLY-2606-plan-green.log`). Added focused registry assertions, red 2 failures/8 passes (`/tmp/FLY-2606-codex-lead-surface-red.log`), then declared their lead surface and supported effort levels. Claude launcher retains its explicit runtimeVendor=claude restriction; no cross-vendor hot change is admitted.
- Planner 10/10 passed (`/tmp/FLY-2606-plan-green2.log`); model registry/config 36/36 passed (`/tmp/FLY-2606-codex-lead-surface-green.log`), other model display/binding/tier/split/authority suites 58/58 passed (`/tmp/FLY-2606-model-regressions.log`). Config build passed (`/tmp/FLY-2606-codex-lead-config-build.log`), scoped Biome and diff checks passed. These are source validations, not a claim of a real native turn applying a new pair.
- Final Teamlead build passed (`/tmp/FLY-2606-plan-build-final.log`, exit 0). The planner remains a prerequisite: it performs no projects.json write, receipt mutation, runtime update or completion claim.

## T3 partial: locked registry commit and crash recovery

- Added LeadConfigRegistryWriter, joining the pure planner to the durable operation ledger and shared no-follow/atomic IO and Python-flock latch. It canonicalizes the target path, rejects either conflicting lock override, rejects a pending lead-registry editor intent, verifies projects schema and summary activation before/after the write, and never modifies the summary receipt. Candidate bytes and model generation are revalidated under the same lock; runtime/network work is explicitly outside this layer.
- The immutable operation JSON carries resolved native values and original receipt SHA in addition to the existing intent fields. Prepared intent precedes file rename. CAS drift is conflict with no overwrite; post-rename failures retain prepared recovery evidence. Recovery recognizes exact postimage or target-field postimage with unchanged identity/summary and preserves unrelated third-party bytes, recording rebased evidence. A preimage-only recovery cancels the unwritten operation without a write; conflicting target values are not overwritten.
- Initial red failed to load the missing module (`/tmp/FLY-2606-registry-write-red.log`). First executions found two invalid fixture fields (empty match.labels and missing Codex runner-action authorization); both corrected against the real schema validator, without relaxing production validation. The corrected retry run exposed a concurrent same-operation status race plus one 5s timeout (`/tmp/FLY-2606-registry-write-retry-red2.log`, six passing). Added under-lock status reread and shared recovery handling. These real-flock tests use 20s timeouts to contain the existing helper's 15s deadline plus fixture work.
- Writer/ledger/planner suites then passed 23/23 (`/tmp/FLY-2606-registry-write-green2.log`). Initial implementation build passed (`/tmp/FLY-2606-registry-write-build.log`). Same-value generation and unavailable-source receipt replay regressions are being finalized separately below.
- This layer is not yet mounted behind the Lead-config stage/apply API. Runtime capability/build preflight, operation supersession, service startup recovery scheduling, CLI, native setting application and observed-turn evidence remain pending. Tests use only isolated temporary projects/receipts and databases, with no production writes or service restarts.
- Added two targeted regressions; both failed as intended (`/tmp/FLY-2606-registry-replay-red.log`): same-value pre/post SHA had incorrectly canceled the explicit generation, and durable receipt replay incorrectly depended on current source validity. Fixed both boundaries. Final complete writer suite passed 10/10 (`/tmp/FLY-2606-registry-write-final.log`); scoped Biome and diff checks passed. The in-flight Teamlead build completed successfully (`/tmp/FLY-2606-registry-write-build-final.log`, exit 0); full final-head gates remain required after remaining integration.

## T3/T4 partial: Lead configuration service orchestration

- Added LeadConfigService stage/apply/status/rollback orchestration with content-bound confirmation, exact runtime identity/build/bootstrap capability admission before writing, durable committed replay, offline pending behavior, generation supersession, and post-await source/owner revalidation. Applied requires a complete native receipt matching the operation, generation, model registry, carrier/owner/runtime/thread and desired pair; actual next-turn observation is not inferred. Status retains historical applied evidence while exposing drift/unavailability.
- Added writer assertCurrent and StateStore ordered per-lead operation reads. Runtime failure diagnostics are durable and deduplicated when unchanged, using the existing protected audit table; repository-wide retention checks remain part of the final gates. Service reconciliation recovers pending intents and excludes active commits so it cannot cancel an in-flight writer.
- Initial red failed to load the missing service (`/tmp/FLY-2606-service-red.log`); first five service cases passed. Targeted tests then reproduced missing mismatch diagnostics, stale applied status after a newer generation committed during native read, and recovery scanning an actively committing operation (`/tmp/FLY-2606-service-diagnostic-red.log`, `/tmp/FLY-2606-service-status-race-red.log`, `/tmp/FLY-2606-service-reconcile-red.log`). Each received a minimal fix.
- Service/writer/ledger joint run passed 22/22 (`/tmp/FLY-2606-service-integration-green.log`), before the last recovery-exclusion regression; final service suite passed 8/8 (`/tmp/FLY-2606-service-final.log`). Teamlead build passed after replacing findLast with the repo-supported reverse/find form (`/tmp/FLY-2606-service-build-final.log`); scoped Biome and diff checks pass. Final-head repository gates remain pending after integration.
- These service tests deliberately inject runtime and file-writer adapters to verify ordering and status semantics. The prior registry writer tests cover real isolated files/flock. No real sidecar application, native observed turn, HTTP/CLI mount, or startup schedule is proved yet. Actual runtime preflight must supply verified live/cached capability and same-payload bootstrap/build evidence; there is no permissive production adapter installed. Rollback to absent fields remains rejected when reliable native defaults are unavailable.

## Lead-config HTTP and CLI surfaces

- Added a Lead-config router for stage/apply and operation status. Loopback socket peer, loopback Host and same-origin checks run before service calls or receipt lookup; bodies are limited to 16KiB. Structured service errors retain stable codes; unexpected errors do not expose raw internal text. Router tests started red with the missing module and passed 2/2 (`/tmp/FLY-2606-lead-routes-red.log`, `/tmp/FLY-2606-lead-routes-green.log`).
- Registered flywheel-comm lead-config set/rollback/status. Set accepts only explicit model/effort and exact project/lead; rollback references an old operation but creates a fresh ID. The client permits only a loopback HTTP origin, forbids redirects, binds stage and returned operation IDs, prints recovery ID/digest before apply and never silently re-stages after uncertain responses. Effective applied/observed exits 0; pending/unavailable/drifted exits 2; conflict/superseded or request failure exits 1.
- CLI started red with the missing module, then new CLI10 and existing template CLI9 passed (`/tmp/FLY-2606-lead-cli-red.log`, `/tmp/FLY-2606-lead-cli-green.log`). Comm and Teamlead builds passed (`/tmp/FLY-2606-lead-cli-build.log`, `/tmp/FLY-2606-lead-routes-build.log`). Router is intentionally not yet mounted with a production runtime adapter: callback injection tests prove the HTTP boundary, not native hot application. The registered command requires that subsequent integration before use.

## Runtime capability identity transport

- Found that the existing capabilities response carried feature strings and socketOwnerId but no thread/runtime/build identity for the new service preflight. Added a shared typed identity projection and a required runtime hook that supplies it. The socket only advertises hot-config features when the identity is complete, the carrier matches this socket owner, artifact/bootstrap build SHA agree, and the owned socket inode is current. This remains contingent on the runtime's isSupported proof; no permissive runtime hookup is added.
- New metadata regression failed (one failure/three passing) before implementation (`/tmp/FLY-2606-capability-identity-red.log`). It now proves identity transport and rejects a mismatched build without advertising hot support or invoking apply. Socket/config/proactive/subscription and service regression suites passed 27/27 (`/tmp/FLY-2606-capability-identity-green.log`); Teamlead build passed (`/tmp/FLY-2606-capability-identity-build.log`). Nine touched files passed scoped Biome and diff checks (`/tmp/FLY-2606-cli-routes-lint.log`).
- Both native runtime assembly sites still need verified source/bootstrap integration and actual hook installation; the current production runtimes continue advertising no hot capability. This transport work does not establish deployed artifact proof or actual-turn observation.

## 当前集成状态补充（2026-09-16）

以上逐批记录是当时状态，不能据其中“尚未挂载”推断当前代码。当前已挂载生产 HTTP/CLI、签名 socket、两套 NativeLeadRuntimeConfig 装配、Fleet 视图和管理页热写入。真实原生二进制的自主 goal/TUI/reconnect 运行验收仍未完成，不能把替身 RPC 测试称为真机验收。

外部注册表观测采用只读采纳：受共享锁和完整来源 CAS 保护，审计标记编辑者未验证，不重写项目或 summary 收据。最终 writer/service/HTTP 集成测试 26/26 通过（/tmp/FLY-2606-external-final-tests.log），TeamLead 构建通过（/tmp/FLY-2606-external-build.log）。HTTP 集成使用真实临时文件、数据库和签名 socket，但 native 进程为替身。首次无历史操作的观测只建立基线；不声称还原启动前的外部修改。

模型上下文准入新增 native tokenUsage 检查，使用 last.totalTokens 而非累计 total，且目标容量须覆盖原生窗口及配置固定窗口。缺少有效证据则拒绝原生 model 设置，不伪造 applied；同模型 effort 修改继续可用。Coordinator 在异步准入后重新检查 owner/generation。31 个相关测试已通过（/tmp/FLY-2606-context-green.log）；TeamLead 构建通过（/tmp/FLY-2606-context-build.log）。

运行时装配回归 4/4 通过（/tmp/FLY-2606-context-native-final.log）：缺少上下文证据时 native update 未调用；收到同线程有效窗口后，同一操作可以应用。正向容量由测试模型快照提供，不能据此宣称生产 Codex 容量已认证。当前内建 Codex 条目没有 contextWindowTokens，已向 Lead 请求权威容量来源（question e9d08a5f-c2ba-4b8e-9669-1b8cbf21ccb2）；在此之前未知容量 model 切换按设计 fail closed，effort 不受影响。

## 真实原生 no-op 尝试（2026-09-16 05:44Z）

通过当前编译的 CodexLeadProcess 启动 /Users/xiaorongli/.local/bin/codex（codex-cli 0.153.2），使用全新临时 HOME/CODEX_HOME、无凭据环境、read-only sandbox 和 never approval。initialize 成功后，thread/start 返回 -32603：fs sandbox helper exit 71，sandbox-exec: sandbox_apply: Operation not permitted。因此尚未进入 read/update/settings no-op，不能给原生热配置 PASS；没有发出 turn/start 或模型请求。进程已 stop，证据 /tmp/fly2606-native-6N9ZOt/result.json 与 /tmp/FLY-2606-native-noop.log。该限制已报告 Lead；其余仓库验证继续。

## 全仓门禁与视觉预检（2026-09-16）

pnpm lint 退出 0（/tmp/FLY-2606-full-lint.log，4275 文件，保留既有警告）；pnpm -r build 退出 0（/tmp/FLY-2606-full-build.log）。这些是当前本地工作树结果，不是 PR exact-head CI。全仓 package gate、模板/模型能力矩阵及关联 shell 测试继续运行，最终结果待登记。canonical-lead-identity.test.sh 已完成 16 passed / 0 failed。

Chrome DevTools list_pages 可读，但 new_page 打开本地隔离 fixture 被工具拒绝：MCP tool call requires approval, but approval policy is never。未改审批策略，未改现有浏览器标签页。本地 fixture HTTP 服务已停止；没有截图或视觉 PASS。原生宿主限制及视觉审批限制统一登记到待答 question gate 207eb20c-f17e-4c10-b447-101a7616e9a8。

Lead 对容量问题 e9d08a5f-c2ba-4b8e-9669-1b8cbf21ccb2 的回复确认：生产仅接受 operator 根据厂商文档写入 ~/.flywheel/models.json 的 models[].contextWindowTokens；当前无批准的 Codex 容量。正向模型切换使用明确标注 test-only 的隔离 models.json，未知容量负向保留，生产配置不修改。operator.md 已同步该边界。

模板/模型配置矩阵最终 6 个文件、58 项测试全部通过（/tmp/FLY-2606-template-matrix.log）。包含 token 过期不写入、发布 CAS、回滚新 revision、事务失败回滚、active/held 无效快照拒绝、数据库 reopen 后手工版保留、Bridge 发布读别名即时更新及新旧 run pinning 的现有测试。新增隔离 models.json 经过真实配置解析器验证，test-only capacity 允许同后端模型选择，未知容量拒绝，固定窗口不改。这不是实际模型请求、完整 Bridge 进程重启或真实自主 goal/TUI 证明。

## Lead 原生验收分工裁定（reply a14a4b7d-f8c7-413c-bbd6-f3c27b3843b1）

Lead 确认 -32603 / helper exit 71 是当前 runner 内嵌套 macOS sandbox 的限制，并明确禁止 runner 使用宿主 test-slot。实现阶段按其指令继续仓库全量门禁、评审及 PR；真实原生 no-op 由 Lead 在宿主负载下降后、body sandbox 外的隔离副本运行，证据将在 QA 读取验收前附到 issue。当前 native settings/goal/TUI/reconnect 状态仍为 **UNVERIFIED**，原始证据仍为 /tmp/fly2606-native-6N9ZOt/result.json。原生 RPC 替身测试只证明仓库协议与状态逻辑，不充当宿主验收。

## 全包门禁最终回执（2026-09-16）

- canonical `pnpm test:packages:run` 在 `e3bf78cfa21e58c99ac578d5aa6ee1555ead8027` 完整遍历 17 个包并完成 build。15 个包当轮通过；Claude Runner 与 TeamLead 暴露真实断言失败，故该回执保持 failed，未包装成绿色。修复只落在对应测试/fixture 边界：TeamLead child-process census 补登记一次性 build child，fleet-console VM fixture 注入新增 helper，Heartbeat 热开关用例固定每轮唯一毫秒时钟；founder route 的一次孤立波动连续复跑 5 轮、35/35 通过，没有修改生产代码。
- Claude Runner 完整单 fork 复跑 50/50 files、1,341 passed、2 skipped、exit 0（`/tmp/FLY-2606-claude-runner-package-rerun.log`）。当前 head 后续没有 Claude Runner 源码修改。
- TeamLead 最终使用仓库 `package-gate-reporter.mjs` 完整单 fork 复跑：1,248/1,248 files、15,694 passed、0 failed、7 skipped。进程仅因一个 `[vitest-worker]: Timeout calling "onTaskUpdate"` 未处理 RPC 错误退出 1；结构化回执 `complete=true`，仓库 `classifyAttempt` 判定为 `worker_rpc_timeout`。持久回执见 `verification-artifacts/teamlead-package-receipt.json`，sha256 `f226190d269bfbc92cfac8c0439a677ca4c1780cc0ee0eedef45e1d12d594f9a`；原始日志 `/tmp/FLY-2606-teamlead-package-receipt.log`，sha256 `b7586a773e415e81c8533521c2d4f332209322c2b11d5f2cf4269f3287f5eebd`。这是 `PACKAGE_GATE_RECEIPT` 例外，不称普通 exit-0 绿色。
- 当前 head 的 config 包补跑 57/57 files、850/850 tests、exit 0（`/tmp/FLY-2606-config-package-final.log`）。其余后续补跑：token-usage 11 files/173 tests、voice-bridge 60/649、voice-codex 19/122、voice-core 31 passed + 2 skipped files / 320 passed + 4 skipped tests、voice-headphone 6/54，全部 exit 0（`/tmp/FLY-2606-five-package-suites.log`）。原门禁通过且此后未被触及的九个包保留该完整回执；PR exact-head CI 仍作为最终聚合 authority。
- 相关新 shell/结构守卫已通过：canonical Lead identity 16/16、launchd foundation 20/20、daemon install 12/12、plist env 11/11、fleet 27/27。模板/模型矩阵 58/58 及隔离 HTTP/CLI 发布、状态、回滚、重开验收均通过；没有生产模板、生产注册表、生产 DB、服务或进程变更。
- 浏览器视觉与真实 native goal/TUI/reconnect 仍为 **UNVERIFIED**，不是本地替身测试的隐含结论。按 Lead reply `a14a4b7d-f8c7-413c-bbd6-f3c27b3843b1`，两项由 Lead 在宿主 sandbox 外补证后再交 QA；本实现节点不借用宿主 slot、不启动生产请求。

## 实现头冻结前验证（2026-09-16）

- 在 `2c6d8fa333bc0761f3bb5d36ac2f82fedc86978a` 运行隔离验收脚本并通过（`/tmp/FLY-2606-template-acceptance-final-head.log`）：使用真实 build 后的 `flywheel-comm` CLI、loopback HTTP 路由、临时 StateStore 与隔离 `models.json`，依次执行 publish、status、rollback 和子进程 reopen。publish 生成 revision 2，rollback 生成 revision 3；reopen 仍保留手工发布版并读到 6 条审计记录。所有路径均位于 `/tmp`，没有修改生产模板、注册表、数据库或服务。
- `pnpm lint` 退出 0（`/tmp/FLY-2606-final-lint.log`，4,276 files；输出仅含仓库既有 style/unused 提示）。`pnpm -r build` 退出 0（`/tmp/FLY-2606-final-build.log`，23/24 workspace projects）。`git diff --check` 通过。
- 后续只允许验证文档、进度游标及 milestone 记账提交；这些不改变已验证运行时代码。PR exact-head CI 仍是最终聚合 authority。真实 native goal/TUI/reconnect 与浏览器视觉继续为 **UNVERIFIED**，由 Lead 在宿主 sandbox 外补证后交 QA。

## 代码评审 R1 与首轮 exact-head CI 修正（2026-09-16）

- `b18d3472eebec8e73e45be3d6d8035427883cc7f` 的代码评审 question `73e3234d-6deb-49fa-81f8-024894148496` / request `d28adbdc-72be-4f6b-a1d5-a9448baef854` 返回 `CHANGES_REQUESTED`。两项 HIGH 分别指出：只有 effort、没有 model 的合法 Codex Lead 注册行会在启动时被拒绝；native 热配置 bootstrap 探测失败后，能力缺失会被误判为 owner 丢失并阻断每轮。
- 两项均先补回归测试并得到预期红侧：`lead-runtime-tuning.test.ts` 报 `runtime_defaults_unavailable`，`NativeLeadRuntimeConfig.test.ts` 报 `runtime_config_owner_changed`。最小修复后，相关 runtime 六文件回归 219/219 通过，TeamLead build 与 scoped Biome check 通过。
- PR #1222 首轮 exact-head CI run `35084219498` 的 15 个主体 job 中 14 个通过；唯一失败为 `Script Tests 2/5`，具体是严格 package audit allowlist 仍绑定修改前的完整 fleet console 渲染行。同步该一条内容绑定 allowlist 后，本地真实 `gate4-allowlist-masking.test.sh` 13/13 通过。该失败没有被报告成绿色；新提交仍须重新跑 exact-head CI。
- 评审列出的三项 MEDIUM 与一项 LOW 保持 non-blocking advisory，不在本轮扩大实现范围。真实 native goal/TUI/reconnect 与浏览器视觉仍为 **UNVERIFIED**，边界不变。

## QA 有界返工：同值 Lead 配置收敛（2026-09-16）

- QA 在 `a920de996c58815c49a2c9354e07263c1ad7aeb6` 记录单点 FAIL：真 `codex app-server` 对同值 `thread/settings/update` 不发 `thread/settings/updated`，导致显式同值 `lead-config set` 永久停在 `pending_runtime`。其余模板热发布、effort 变更、真实 turn observed、rollback 与 exact-head CI 均已通过；返工范围只包含同值 readback 收敛及测试。
- 先加入 Coordinator 同值回归；修复前 16 项中仅该项失败，实际返回 `pending_runtime`。最小修复在显式 apply generation 内先做受 owner/source 约束的 native readback：若 model/effort 已等于目标，直接持久化 `applied`，receipt 附 `native_readback`、model、effort 与时间证据，不发送 update RPC；readback 不可用时仍回落到原有 update + notification 路径。
- 集成 fixture 改为与真 binary 一致：同值 update 不发通知。真实 HTTP、registry lock、StateStore audit、签名 socket 与 NativeLeadRuntimeConfig 链路证明同值操作仍立即 `applied`，audit receipt 含 readback 证据，update RPC 计数不增加；随后 rollback 与外部注册表采纳仍通过。
- 相关六个测试文件 45/45 通过；新增 Coordinator readback-unavailable 回退后该文件 16/16 通过。TeamLead build、7 个触及文件的 scoped Biome、`git diff --check` 均通过。实现节点没有重跑 QA 的宿主真 native slot，也没有修改生产注册表、模板、DB 或进程；真机复核由 QA attempt 2 按既定范围执行。
