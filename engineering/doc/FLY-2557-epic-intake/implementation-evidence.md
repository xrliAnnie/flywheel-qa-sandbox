# FLY-2557 Epic 自动入口 — 实施证据
Issue: FLY-2557 (https://linear.app/geoforge3d/issue/FLY-2557/epic-流程intake-epic-进-in-progress-自动触发拆解bridge-监听-linear-epic无)
日期: 2026-09-14
基于: plan.md

## Authorized dirty-refresh loop rework (2026-09-15 02:17Z)

Lead response to question `e6536835-af26-404e-8f2c-d867c9f65e9f` explicitly authorized bounded rework of HIGH `intake-dirty-row-never-cleared-refresh-loop`: terminal activation guard, clear published dirty revisions despite omitted intake cells, and bounded persistent-failure retries followed by not-refreshable state. It replaces the earlier last-round boundary. After this revision, any further HIGH must go to Lead governance; no additional push is authorized. The prior head `8fa0e01ddc67528b2a9f05ca8061e38061f931a2` independently completed CI successfully, while its effective review remained CHANGES_REQUESTED.

Implementation:
- `setEpicIntakeActive` permits deactivation but cannot reactivate `complete` or `superseded` rows.
- A successful hosted publication (including proven unchanged digest) clears all captured dirty row revisions, including intentional omissions. Existing project/owner/version/result compare-and-set protects concurrent newer updates. Unsuccessful or manual unpublished results do not clear dirty.
- Dirty-only `epic_intake` refresh attempts use per-project persisted failure count and retry time in two additive `epic_intake_scan` columns. After failures, retries are eligible after one minute, then five minutes; the third failure is terminal `structural: intake_not_refreshable`. Further dirty scans return before materialization and do not append repeated refresh receipts. Restart retains this state. Existing independent normal scans/event refreshes remain available; a successful hosted result resets the intake retry state. No new timer, background dispatch or production mutation is introduced.

Verification:
- RED: 7 failures / 1 pass after correcting a test accessor, reproducing terminal reactivation, dirty omission and 120 full attempts/hour (`/tmp/fly2557-refresh-red.log`).
- GREEN: 50/50 across refresh-loop, existing page-refresher, StateStore intake, intake scan and result suites (`/tmp/fly2557-refresh-focused.log`). Real temporary databases show 120 repeated triggers produce exactly three materializations and three receipts for persistent publish failure, unsupported/unconfigured hosting and materialization failure. Database reopen preserves terminal state; independent successful publish re-arms. Legacy schema upgrade is idempotent and preserves watermark. Concurrent newer dirty revision survives old publication.
- `pnpm lint`: exit 0 with 18 warnings (`/tmp/fly2557-refresh-lint.log`).
- `pnpm -r build`: exit 0 (`/tmp/fly2557-refresh-build.log`).
- Retention consumer gate: `ok:true`, no errors (`/tmp/fly2557-refresh-retention.log`). No new table or retention category.

This is synthetic/temporary database proof, not live Linear, process-kill or hosted/mobile QA acceptance. Prior aggregate stays interrupted/not relied on. Fresh exact-head review and CI remain required after the single milestone-last push.

## Second code-review HIGH fixes (2026-09-15 01:55Z)

Review `cffb020b-89ab-4fb1-ad25-8e29bb54f5d2`, request `116f40d5-eb71-440a-85d8-785409dc4a14`, reviewed head `4578952d0ee6f0e2c0b9b2ab3094a15a4f1a23c4`: effective **CHANGES_REQUESTED**, two HIGHs. That head independently passed CI **15/15** in run `34917213215`. Green CI does not settle the findings.

- `deleted-pending-epic-wedges-project-scan`: local commit `f9901bab7` applies the existing FLY-967 `entity not found|could not be found` classification. Single-root SDK lookup failures now prove missing only for those recognized errors; rate limits, unauthorized and timeout still fail retryably. RED 2 failures, then 27/27 focused green (`/tmp/fly2557-missing-red.log`, `/tmp/fly2557-missing-green.log`).
- `linear-rate-budget-exhausted-by-30s-pending-rescan`: pending current metadata is read in complete batches of at most 50 IDs, without project/label predicates so moved roots remain observable; archived roots are included. Incomplete/duplicate/unrequested batch identities fail closed. Validated histories are cached by credential/binding/root and current metadata revision (including updatedAt and state), capped at 512 roots, with a ten-minute maximum age. Shared page/dependency and observer paths use the same default cache. Failed histories are not cached. Resolved or inactive episodes leave the direct pending-read list; the existing updatedAt change window continues to find new started entries.

The 30-second rider, original patrol cadence, stable UID, frozen owner, project watermark-on-history-failure rule, auth and dispatch semantics are unchanged. This is process-local cache state, not a database migration; restart safely warms history again. The approved design remains unchanged. Scope question `3dc8dde1-e50f-42e5-94f6-4acea90497b6` was unanswered during implementation; proceeded under the injected fix-blockers/best-judgment workflow, without claiming a new Lead ruling. MEDIUM/LOW findings are not settled by this patch.

### Request budget and verification

Official limit: https://linear.app/developers/rate-limiting documents 2,500 requests per user/hour shared across API keys. This patch does not claim to measure the user's remaining shared quota or establish a global quota limiter.

For one test project with 17 unchanged active pending roots, one root/history page each and 120 scans/hour: initial root query + 17 history reads, then 119 × (one change-window query + one pending batch), plus five ten-minute history renewals × 17 = **341 requests/hour**, down from **4,183** before this fix. Unchanged resolved/inactive rows no longer add pending requests. Additional history pages, changed roots, more metadata pages, cache eviction/restart, other projects and non-intake consumers add requests; this fixture budget is not a worst-case account quota guarantee. Child traversal requests are unchanged. Existing API/deadline failures remain explicit and retryable.

- Budget RED: 2 failed / 2 passed after correcting the test cleanup callback; 4,183 requests exceeded the <=400 assertion (`/tmp/fly2557-budget-red.log`).
- Inactive/resolved RED: 2 failed / 7 passed (`/tmp/fly2557-active-red.log`).
- GREEN: 100/100 across seven focused files (`/tmp/fly2557-budget-focused.log`). Later added shared-default-cache coverage: budget suite 7/7 (`/tmp/fly2557-budget-shared.log`); overlaps the previous 100, not a second aggregate.
- `pnpm lint`: exit 0, 18 existing warnings (`/tmp/fly2557-budget-lint-final.log`); first formatting error corrected.
- `pnpm -r build`: exit 0 (`/tmp/fly2557-budget-build.log`).
- No host full package suite restarted. Fresh pushed-head CI and effective review remain required. All previously stated isolated live QA gaps remain open.

## Bounded HIGH review fix (2026-09-15 01:25Z)

Current execution `2d543988-6387-477b-b0d9-655e2cbaaf76`, implement TURN epoch 6. Lead instruction `[lead-instruction 056447ea-31be-44c9-8d68-2d2a8a91ebd3]` supersedes the incident freeze and authorizes only the shared-root history isolation fix, one push, then fresh exact-head review and CI. Approved R2 plan unchanged. Prior full package aggregate remains **interrupted — not relied on**; no host full suite restarted.

`collectEpicScope` now records per-root `{issueUuid, identifier, reason: intake_history_unavailable}` in `historyFailures` and continues collecting healthy roots after empty, malformed, inconsistent, truncated or unreadable history. Failed roots are distinct from confirmed missing roots, so their prior intake activity is not invalidated. Healthy episodes commit and replay with existing identities; the project watermark advances only after a scan without history failures. Shared page/dependency scope and healthy resolve observations continue. Root metadata/pagination failures retain their existing fail-closed behavior. No timer, dispatch, schema, auth or deployment changes.

Verification:
- RED: 6 failed / 11 passed, reproducing project-wide history throws and erroneous watermark advancement (`/tmp/fly2557-history-red.log`).
- First GREEN attempt exposed an incorrect child-query fixture shape; corrected fixture to the actual `issue.children` response. No production workaround.
- GREEN: 87/87 tests across collection, scan, observer, intake-route, full Linear scope and dependency-route (`/tmp/fly2557-history-focused.log`). Includes healthy scope surviving four history failure classes, repeated history pagination isolation, retaining prior watermark/activity, recovery without duplicate episodes, and resolving a healthy root with an unrelated failed root.
- `pnpm lint`: exit 0, 18 warnings (`/tmp/fly2557-history-lint-final.log`); initial formatting error corrected.
- `pnpm -r build`: exit 0 (`/tmp/fly2557-history-build.log`).

Fresh review and exact-head CI are still required after the single push. Live <=60s event/ACK, process-kill replay and hosted/mobile evidence remain isolated QA work per the handoff; no live acceptance is claimed here.

## Current gate authority (2026-09-14 23:41Z)

Lead instruction `eca3e5be-0a5f-4e71-b151-982e6e9945f3` supersedes the earlier plan to wait for/repeat local aggregates: four full suites were competing on this host. **Local full package aggregate: interrupted — not relied on.** Session `5805` was explicitly interrupted and returned terminal exit **130**. Do not restart it. Keep its logs for diagnosis only; neither its partial failures nor partial passes are handoff authority. Use focused suites only locally and **exact-head CI as the handoff authority**, per Lead. Acknowledgement receipt `802259ed-649d-43ba-8dea-12540c954a09`.

Effective code review remains pending on question `a2242c45-531e-44cc-a394-c4158f697b88`, accepted request `720090e9-5cb8-4903-a9ef-43c36930d6fd`. Creating the PR starts CI; it does not claim review, CI or QA acceptance.

Technical sync: merged `origin/main` at `1e6a419cb` without conflicts in merge `078276e51`; retained both current thread-archive changes and intake thread-receipt lookup. Adjacent post-sync focused validation is in `/tmp/fly2557-post-sync-focused.log`. The earlier review request predates this head movement; final handoff requires current-head review binding and CI evidence.

## Resident handoff continuation (2026-09-14)

Current execution `e70dc4e6-a421-4c2f-bc5b-37c80856a39d`, implement TURN epoch 5. The approved R2 plan remains unchanged. Lead handoff `04df8837-cb71-4ff8-9885-a92ed3697d5e` identified clean head `b97f1a3c7` and stash `037036cac74effb5cb1be5ed9f2e194964cbbbef`; restored all 20 tracked files and the fixture without conflicts. Handoff acknowledgement/report receipt: `29933314-f539-49c0-8070-a327f4607287` (doorbell timed out; durable report row retained).

Restored behavior connects manual/residual materialization to intake records and dispatch/department admission, and marks a recorded episode's page dirty when its root metadata changes. Remaining restored hunks are formatting of prior implementation. Shared snapshot consumer audit: dependency-route only uses descendant IDs; a zero-child root has no descendants and cannot add dependency members. Lead-note's fallback membership path is used only when the issue fails the configured binding; a same-binding zero-child root is already accepted by the direct binding check. Both legacy consumers continue to admit roots with children without a dispatch reader. No dependency semantics or Lead-note authorization changes were introduced.

Fresh verification of restored state:
- `pnpm lint`: exit 0, 18 warnings; `/tmp/fly2557-resume-lint.log`.
- `pnpm -r build`: exit 0; `/tmp/fly2557-resume-build.log`.
- Focused intake/page/residual/StateStore/query run: 133 passed, one failed, 16 files. Failure is a 5s timeout in `epic-residual-plugin-wiring.test.ts` during Bridge startup; `/tmp/fly2557-resume-focused.log`. This run is **not green**. Separate unchanged-assertion rerun is pending in `/tmp/fly2557-isolated-wiring.log`.
- New `epic-intake.e2e.test.ts`: 1 passed. Real temporary StateStore and MailboxQueue, producer enqueue interruption, journal/database reopen, canonical delivery ID replay, recipient ACK, pending card and scope invalidation; synthetic Linear collection. `/tmp/fly2557-e2e.log`. This is not a real process-kill or live Linear timing test.
- `render-intake-fixture.mts`: generated synthetic HTML/JSON under `/tmp/fly2557-intake-visual`, 31,846 HTML bytes. Chrome DevTools new-page call returned `MCP tool call requires approval, but approval policy is never`; no screenshot or visual acceptance claimed.

Added an executable resolver/materializer bundle regression and `qa-runbook.md`. Actual Claude/Codex launcher bundles, isolated live latency/kill receipts, hosted HTTP/CSP/mobile proof, FLY-2553 same-fixture budget comparison, full package gate, effective code review, PR and exact-head CI remain required.

### Isolation finding and follow-up verification

Additional current verification: Codex real-launcher/runtime-shim check passed **1/1** (25 other cases outside the name filter), reading the emitted prompt files and asserting §0.11/resolve; `/tmp/fly2557-codex-actual-bundle.log`. Together with Claude/CoS dry-run **54/0**, both launcher assembly paths are now exercised without starting real Leads. Latest isolated `pnpm lint` exited 0 with 18 warnings (`/tmp/fly2557-final-lint.log`). `node scripts/fly-2006-retention-consumer-gate.mjs` returned `ok:true`, no errors (`/tmp/fly2557-retention-final.log`). Lead response to isolation report `2750bf7e-69b1-4348-95c4-b9c9686a55bc` mandates hermetic full-suite runs and reserves the global startup-leak follow-up for Lead; acknowledgement receipt `180aff6a-9781-439a-909e-c2ff01356117` confirms no runtime restoration. Full gate receipt directory: `/var/folders/zl/nz5kfm5976q8p6kbt4d0cpgr0000gn/T/flywheel-package-gate-7IcHxB/`; final status remains pending.

Latest follow-up: Claude launcher shell rerun finished **54 passed/0 failed**. Review gate finally opened as `a2242c45-531e-44cc-a394-c4158f697b88`; `request-review` accepted request `720090e9-5cb8-4903-a9ef-43c36930d6fd`. Await effective verdict. The three TmuxAdapter golden failures were traced to the validation wrapper's redundant `FLYWHEEL_COMPLETE_MARKER_DIR` setting: TmuxAdapter forwards it as a new `-e` argument pair. Removed only that wrapper variable (completion markers still use the isolated HOME); unchanged `pre-change golden` tests then passed **3/3**, with the other 169 tests outside the name filter. Log `/tmp/fly2557-tmux-isolation-correction.log`. No adapter or golden assertion changes. The original full gate continues with its original environment and retains its failures; this focused correction does not make that aggregate green.

Follow-up validation now runs through `run-isolated-validation.py`: a new subprocess HOME, explicit Codex home/session, CommDB and completion-marker roots, and an environment allowlist without resident credentials. A probe confirmed the subprocess HOME is under `/tmp/fly2557-validation-*` and runner CLI/API token variables are absent; the resident environment remains intact. Isolated wiring run `/tmp/fly2557-hermetic-wiring.log` still failed its original 5s startup timeout (1 failed/1 passed), but showed no previous global-home scrub/quarantine output. This remains a failed test, not a contention waiver.

Full package gate is running with the same wrapper: session `5805`, log `/tmp/fly2557-hermetic-package-gate.log`, isolation receipt `/tmp/fly2557-validation-55oqauw7/receipt.json`. It has progressed beyond recursive build into package tests; three old TmuxAdapter surface snapshots have failed so far. Do not claim aggregate green or RPC-only acceptance before its final receipt.

Actual launcher assertions added: Claude dry-run resolves its emitted bundle path and reads §0.11/resolve content, CoS reads its emitted bundle and excludes §0.11, and Codex's existing runtime-shim test reads the rule files passed by its real launcher. The first complete Claude shell run had 49 pass/5 fail: all new assertions passed, but the old T8 department/CoS goldens omitted `DISCORD_OWN_CHAT_CHANNEL=set`. Verified `git show 720be415b:packages/teamlead/scripts/claude-lead.sh` already sets that key; corrected only those two exact expected manifests. Rerun session `37146`, log `/tmp/fly2557-launcher-bundle-final.log`; awaiting completion. Codex assertion will run in the full package gate.

Hardened synthetic HTML generated by the real `injectHeadMeta`: `/tmp/fly2557-intake-visual-hardened/intake.html`, 32,051 bytes, nonce matches and no external resource tags. This adds executable CSP validation but still is not screenshot/hosted/live acceptance.

Code-review registration is currently unavailable: queued `code_review` stage delivery times out, and every `gate review_code` attempt has returned `STAGE_PENDING` without a questionId. No reviewer has been registered. Lead status report receipt `253f2733-df93-49a2-b3c6-d81e60f298cd`. Do not bypass or mutate the stage queue; retry the exact gate once delivery recovers.

The separate wiring rerun passed both tests without timeout/expectation changes (startup test 3,988ms). However its existing startBridge fixture did not isolate all global home paths: `/tmp/fly2557-isolated-wiring.log` reported five orphaned keyed Codex home lease scrubs and a completion-reconciler 409 quarantine for receipt `9cb1f181-6216-4610-aea6-40f00750f8c5` under the global state directory. Therefore this rerun is **not valid isolated host acceptance**. Reported immediately to Lead via receipt `2750bf7e-69b1-4348-95c4-b9c9686a55bc`. No runtime-state restoration was attempted, and further Bridge-starting/full-suite runs are paused until the test subprocess home and runtime paths are isolated. No deliberate production service restart or Linear/channel mutation was performed; do not claim zero production filesystem effects.

The bundle fixture initially failed `INVALID_SUMMARY_DUTY:missing`, then passed after supplying the fixture's explicit `FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=0` environment value. Production rules unchanged. `/tmp/fly2557-bundle.log`: 1 test passed, real materialized department bundle includes §0.11 and CoS excludes patrol rules. This does not prove both complete launcher invocations.

Implementation is in progress under execution `32f3bfa0-9e48-4d08-9a41-1957688f69fc`, implement TURN epoch 2, activation `activation:32f3bfa0-9e48-4d08-9a41-1957688f69fc:f7b658b8-74cb-4566-952f-65ffea1e6563:implement:1`.

## Completed batches (not phase completion)

- `03c29ef89`: contiguous started episode identity and approved Epic admission predicate. Initial RED: missing `epic-intake.js`; GREEN: 11 tests. Started substate changes merge, quick reentries retain separate identities, contradictory histories reject, childless dispatched roots exclude.
- `090f5ea6c`: bounded root/history collection in `linear-epic-query.ts`, overlapping updatedAt discovery and pending UUID rereads. Initial RED: all six tests fail on missing `collectEpicScope`; GREEN: six new tests plus nine existing query tests and eleven identity tests, 26 total. Shared request transport rejects GraphQL errors and enforces deadline. `pnpm -r build` passed after this batch (log `/tmp/fly2557-build.log`).
- StateStore batch: additive `epic_intakes` and `epic_intake_scan`; transactionally records journal + episode, freezes owner/time, checks project sessions/workflow aliases before admission, persists bootstrap and monotonic successful scan cursor. Initial RED: missing methods/table (8 failures), then missing bootstrap method (1 failure); GREEN includes transaction failure injection and real disk close/reopen. Typecheck passed before adding the final reopen test. Retention registry classifies both tables as protected current/reference; expected schema fixture/counts updated. Consumer gate reports `ok:true`.

Environment: `pnpm install --frozen-lockfile` succeeded. Initial test attempt without dependencies was `vitest not found`, not behavioral RED. No production database copies or mutations, service restarts, Linear mutations, Discord messages, or deployments.

## Remaining requirements

T1 is still in progress: the original full-snapshot facade currently uses its legacy root collection. Switch it to `collectEpicScope` alongside scope.v3 model changes and dispatch-reader injection; avoid shipping two root collection paths. Existing full-snapshot children traversal must consume the same collected roots and deadline. Current collector throws for unreadable candidate history; no cursor can be advanced on that failure.

T2 is partial: strict cross-project DepartmentRegistry routing, active invalidation, bootstrap episode selection, and coordinated scan commit remain. The actual registry is `packages/teamlead/src/department-registry.ts` (the design's bridge path is inaccurate).

T3–T8 remain: canonical queue recovery/formatting/ACK tests; GatePoller scheduler and project serializer; scope.v3/page/pending/dirty handling; authenticated show/resolve with real thread receipts; patrol and Claude/Codex bundle rules; end-to-end fixture and QA runbook. No event producer is registered yet. No intake reaches a Lead or appears on a published page from these batches alone.

Still required before implement handoff: final lint, full recursive build, aggregate package gate or permitted complete RPC-only receipt, applicable shell tests, effective code review, milestone as literal last commit, push/PR and exact-head CI, structured report and exact completion route. Isolated live ≤60s event+ACK and rendered page proof remain unverified and must be explicitly tracked for QA. No PR or phase completion is claimed.

## Routing and scan coordinator batch

`ddc850c05` adds strict unique binding/department routing using DepartmentRegistry, plus `scanEpicIntakes`: persistent bootstrap, prior episode rereads, active invalidation, episode admission and retry through the same durable receipt. Root/terminal/missing cases do not create fallback ownership. Enqueue failure leaves the accepted episode and old scan cursor for retry. Initial RED was missing routing/scan exports (8 and 3 failures respectively); GREEN: 34 combined identity/routing/scan/StateStore tests, including two extra recovery/terminal regressions. `pnpm --filter flywheel-teamlead typecheck` passed (`/tmp/fly2557-typecheck-scan.log`). The coordinator is not yet registered in GatePoller; its enqueue callback still needs production wiring. T1 full-snapshot facade integration, T2 remaining edge matrix, and T3–T8 remain incomplete.

## Delivery and existing-clock wiring batch

`4a1b3bddc` adds epic_intake to active journal redrive, validates immutable payload/owner/UID/session identity before envelope construction, quarantines only typed invalid intake rows, and shares the intake formatter across CommDB/Mailbox runtimes. A real temporary CommDB test enqueues the canonical identity, reopens the database, rejects a wrong recipient's batch ACK, records exact ACKED/acked_at, accepts duplicate ACK idempotently, and proves the StateStore work_state remains pending. Initial RED: intake excluded from redrive; GREEN: 71 delivery/runtime/queue tests and 42 inbox-runtime/delivery tests (overlapping sets). Consumer retention gate passed.

The following scheduler commit registers `onEpicIntakeTick` before per-Lead suppression on every GatePoller poll. Its cheap callback starts due scans every 30s, one per project, concurrency 4, rotating projects after completion/failure; no new timer. Plugin wiring uses the existing Epic page project serializer, explicit configured bindings and canonical journal envelopes. A missing journal row requires actual archived terminal evidence; unexplained missing receipts fail for retry. Initial RED: missing scheduler export and GatePoller never calling intake; GREEN: 17 scan/delivery/scheduler/GatePoller tests plus teamlead typecheck (`/tmp/fly2557-intake-wiring-tests.log`, `/tmp/fly2557-intake-wiring-types.log`). The producer is now registered in source, not deployed or exercised against live Linear.

Still outstanding: shared full-snapshot facade and dispatch-reader integration, page dirty publishing, scope.v3 and intake Cell/receipt/founder card, residual pending readout and suppression exception, authenticated show/resolve with canonical thread evidence, patrol rules/bundles, expanded edge-case/e2e tests and QA runbook, final repo gates/review/PR/CI. These local database tests are not isolated live project evidence or proof of <=60s event+ACK.

## Shared snapshot and page projection batch

Full snapshot now delegates root/history collection to `collectEpicScope`; the old independent root query and 日常 prerequisite are removed. Root admission uses children-or-no-project-dispatch and supports a precollected scope to avoid querying the same root set twice. Missing dispatch evidence excludes zero-child roots. Main plugin materialization supplies strict department/project matching, StateStore dispatch reads and intake rows. Child traversal and descendant IDs remain separate; zero-child roots never enter dependency descendant scope.

New generator output is scope.v3 (`daily_title_contains:null`); old scope.v2 remains readable with its matching strict definition. Root `has_child_issues` and StateStore-sourced `intake` Cell are validated, included in source receipt traversal and freshness inputs, and only projected when root/current started segment/project match an active episode. Founder view admits the current intake root with true zero counts; HTML/Markdown show 待拆解 for confirmed no children, 待核依赖 for existing children pending verification, and founder-question state. Existing renderer structure remains unchanged beyond card text. Scope labels now describe the generated rule.

RED: scope.v3 rejected/empty root hidden, then generator still output scope.v2. GREEN: compatibility suite 128 tests before generator switch; integrated collection/model/materialization suite 62 tests after switch; final changed rendering/intake/full-query suite 42 tests and teamlead typecheck. Logs: `/tmp/fly2557-page-compat.log`, `/tmp/fly2557-scope-integration.log`, `/tmp/fly2557-page-final.log`, `/tmp/fly2557-page-final-types.log`. Sets overlap; these are not a full package gate. Explicit old scope.v2/mismatched-rule tests retained. FLY-2553 is not yet synchronized here; its <=80KB layout gate and visual/live proof are not claimed.

Next: connect persistent page_dirty refresh/retry and shared full-snapshot handoff without using an incremental candidate subset as a complete page; audit secondary snapshot consumers (dependency/lead-note/manual fallback) for dispatch-reader availability. Then residual pending and empty-scope suppression, authenticated resolve/thread evidence, Lead rules/bundle, full edge/e2e/visual/QA runbook and all final gates. No automatic hosted refresh or live acceptance is established yet.

## Persistent publication and pending patrol batch

The existing refresher now receives `epic_intake` requests when the 30s scan rider sees durable page_dirty rows, including after a failed scan (finally path). Publication captures dirty revisions before materialization, clears only rows actually covered by a successfully hosted page or verified unchanged hosted digest, and compares owner project/observed_at/active/work_state/result before clearing. Failed or unconfigured hosting retains dirty state. The source collector is shared; incremental intake candidates are not passed as a complete page. A fresh complete root scope is fetched for event refresh; materialization still executes once per attempt.

Residual facts now carry optional pending summaries (maximum 5) plus separate full total, validate IDs/times/uniqueness/counts, and filter by current root segment/project/Lead/active pending or needs_founder state. These facts do not change ready.v1 child counts. Empty-roster suppression admits a normal scope tick with pending intake even when remainingForLead=0. Renderer appends 待拆解/待核依赖 and omitted count under remaining-work facts, separate from ready children.

RED: absent clearPublishedEpicIntakes and missing pending projection. GREEN: 26 StateStore/publication tests, 39 residual/scan/intake tests, 89 patrol/render tests and teamlead typecheck (`/tmp/fly2557-dirty-tests.log`, `/tmp/fly2557-pending-tests.log`, `/tmp/fly2557-patrol-pending.log`, `/tmp/fly2557-pending-types.log`). These overlap prior tests and do not replace final full gates.

Outstanding: authenticated show/resolve and canonical thread/message verification; business-state dirty updates; Lead §0.11 and both bundles; full edge/e2e/visual fixture + isolated QA runbook; secondary snapshot dependency injection; root/metadata change publication behavior and integration audit; final full gates/review/milestone/PR/CI/completion. Live event+ACK <=60s and hosted page screenshot remain unverified.

## Business result and read-only thread evidence primitives

Added bounded strict result schema, StateStore transactional resolution with owner/active/observation/work-state fencing, idempotent identical results, needs_founder progression and dirty publication state. Evidence validation requires a current episode (or observed invalidation for superseded), direct-child membership, a ledger declaration within the patrol interval and not in the future, and canonical thread/message/Lead-author identity. This validates the Lead's declaration, not dependency semantics.

The existing bounded Discord REST helper now supports a read-only exact-message receipt lookup using around+limit=3, matching message ID and channel and requiring an author. Missing/malformed/wrong-channel/unreadable responses fail closed. No Linear write, Discord send, or Runner dispatch was added. Route/CLI production wiring remains outstanding.

RED: absent result module, absent evidence validator and absent thread reader. An additional fixture UUID format failure was corrected to a valid UUID without loosening production validation. GREEN: 48 tests across epic-intake-result (5), epic-intake-thread (2), and existing chat-thread-utils (41). This is focused evidence only, not the full package gate.

Typecheck initially found an unchecked array element in the new thread reader; added an explicit absence guard. Teamlead typecheck then passed, and both new suites passed again (7 tests, `/tmp/fly2557-result-tests.log`). Remaining T6 work: mount authenticated routes, fresh Linear scope/direct-child and canonical chat_threads checks, supply configured Lead bot identity, CLI with 16KB file limit and route/CLI tests. No endpoint is exposed by this batch.

## Authenticated resolution and Lead protocol wiring

Mounted GET `/api/epic-intake` and POST `/api/epic-intake/resolve` behind existing fail-closed master reports authentication (no ingest credential accepted). Routes require a configured spawning Lead in the claimed project, the frozen record owner, a bounded strict evidence body, fresh server observations and StateStore CAS. Shared master access remains the reviewed per-Lead authentication limitation; resolve binds the actual Discord message author to the configured Lead bot. Missing bot identity/token or unreadable Linear/thread/config data returns retryable failure with pending retained. No producer endpoint was added.

Observer reuses the root/history collector, children snapshot traversal, dispatch classification, canonical chat_threads mapping and bounded Discord reader. Direct-child evidence excludes nested descendants. Superseded requires fresh invalid scope plus the persisted scan's inactive state; if the scan has not caught up, resolve returns 409 and preserves pending. Successful resolution marks page dirty and requests the existing refresher; durable dirty remains the fallback when immediate refresh fails.

CLI show/resolve registered, defaults project/Lead from existing environment, accepts explicit Lead, reads at most 16385 bytes from a regular file (16KB admission limit), closes the file, rejects duplicate arguments and emits sanitized failure output. Transport ambiguity instructs checking show. Server remains the authoritative evidence validator.

RED absent route/observer/CLI modules. GREEN 12 route/observer/result/thread tests (`/tmp/fly2557-resolve-tests.log`), 2 CLI tests and both teamlead/flywheel-comm typechecks (`/tmp/fly2557-resolve-types.log` for teamlead). Covers master marker rejection, wrong owner/project, malformed and oversized evidence, idempotent resolution, unavailable observations, wrong author, inactive conflict, needs_founder progression, direct children, missing scope, canonical-thread mismatch and CLI transport/file bounds. Full package/CI/live gates remain outstanding.

Lead base rule §0.11 and README now carry normal intake/backfill/children/ledger/thread/result and retry discipline, preserving founder approval outside Epics. Existing bundle resolver/materializer suites passed 34 tests (`/tmp/fly2557-intake-bundle-tests.log`). Actual dept mailbox and commdb assembled texts contain §0.11 and resolve command (`/tmp/fly2557-intake-mailbox-rules.txt`, `/tmp/fly2557-intake-commdb-rules.txt`). Initial manual assembly correctly rejected omitted FLYWHEEL_LEAD_HAS_SUMMARY_DUTY; reran with explicit 0. No production Lead restarted or reinstalled. Claude append-order parity remains covered by the existing bundle suite.

Next: audit secondary snapshot consumers and root-change publication, remaining edge/restart/e2e evidence, rendered fixture/isolated live acceptance runbook and artifacts, required full-repo gates, effective code review, milestone-last PR and exact-head CI. No completion or QA dispatch yet.

## 2026-09-15 engine merge-conflict rework (attempt 2)

Request `rework:3629e03dfdf059265e3cdba02e6aa62ddfe064e028c647ab34aeb70fd5a50b67`; original approved head `35036f1c72220a968010f211c36eb79541f21847`. TURN verified yours, implement epoch 8. Technical sync targets `7f6e88d39a86e3e5e9feb4655adb4637282604aa`.

Eight conflicted paths resolved by preserving both implementations: additive StateStore imports and retention tables (233 classified tables); intake and child-thread generation inputs; shared attention snapshot plus intake dispatch/department filtering; intake poison-row quarantine relocated into main's reordered per-Lead inbox loop; main's current compact Epic renderer retained with pending intake status added. No product redesign or production mutation.

Fresh lint passed (21 warnings), retention consumer gate returned ok=true, and feature diff against the merge parent passed whitespace verification. Recursive build and isolated focused regressions are running; logs `/tmp/fly2557-rework-build.log` and `/tmp/fly2557-rework-focused.log`, isolation receipt `/tmp/fly2557-validation-eiyx730p/receipt.json`. New review, exact-head CI, milestone-last commit and needs_review receipt remain outstanding. Previous live QA evidence does not constitute retest of this merged revision.

Conflict validation follow-up: recursive build exposed an automatic-merge omission between `hasArchivedLeadEvent` and main's `isLeadEventAuditOnly`; restored the former method's closing brace. Teamlead typecheck then passed. Initial focused run: 34 suites passed, 11 could not load this syntax, and two materialize timeout failures. Second run: 17 suites passed, 190 tests passed, one materialize timeout plus one upstream audit-only archive assertion failed. Materialize alone then passed 7/7 unchanged. Retention consumer script tests passed 8/8.

The remaining audit-only archive test fails alone too (`/tmp/fly2557-rework-audit-r3.log`). Both that test and `terminal-row-archive.ts` are byte-identical to merge parent: bounded candidate SQL only filters event kind, omitting the audit-only eligibility that its later policy allows. Question `20c36632-1a39-4d38-9f09-e2b3f1c5ff32` requests Lead scope disposition. Do not label the local suite green or modify unrelated archive behavior without resolving this scope question. Recursive build rerun is live in `/tmp/fly2557-rework-build-r2.log`.

Final conflict-head verification: recursive `pnpm -r build` rerun passed (exit 0), teamlead typecheck passed, and final `pnpm lint` passed with 21 warnings. Logs: `/tmp/fly2557-rework-build-r2.log`, `/tmp/fly2557-rework-types.log`, `/tmp/fly2557-rework-lint-r2.log`. The audit-only archive assertion remains an acknowledged upstream failure, not an aggregate pass. Lead host-contention instruction `62225168-4176-46f4-b0d5-63f171b3c2ac` reconfirms focused local suites and exact-head CI as the aggregate authority; response receipt `d7d5a4d4-16ec-4e0b-8625-34cc8fb285a4` records none running.

### Lead-authorized upstream predicate repair and final main sync

Ruling `20c36632-1a39-4d38-9f09-e2b3f1c5ff32` authorizes the minimal candidate predicate alignment in this PR. Commit `79505b971` changes only that predicate: lead-events candidates include audit-only rows just as the existing later policy does; other archive tables retain their event-kind restriction. Existing unchanged regression failed alone before the change and passed 1/1 afterward (`/tmp/fly2557-audit-predicate-green.log`). Report receipt `93262d37-54fd-47bd-b7f5-fdc804fc39ef`.

New main `b9418b780` was then synced in `c2832c003`; the sole conflict was the StateStore import block, preserving both intake imports and model assignment assertion. Final related suites pass **78/78** across terminal archive, LeadInboxRuntime and StateStore intake (`/tmp/fly2557-final-archive-tests.log`). Final recursive build passes (`/tmp/fly2557-final-build-rework.log`) and lint passes with 21 warnings (`/tmp/fly2557-final-lint-rework.log`). No assertion or timeout changed. This supersedes the previously open audit-only defect; earlier failed runs remain recorded accurately.

New exact-head review and CI are required after the milestone-last push. Local aggregate is not relied on per Lead host-contention ruling. Controller-owned QA retest, isolated live timing/ACK and hosted/mobile acceptance remain separate from these implementation checks.

### Compatibility manifest addendum

Lead instruction `bff867bc-676b-4320-a94f-4c4f37b44545` arrived after head `4e98c7126` was pushed/review-registered. Follow-up ruling `15821a99-37cb-4657-8324-0d22fe0ad2ac` explicitly authorizes reviewed per-pair rationales and computed hashes, not a bare refresh. Read-only comparison found four changed members: current patrol rules, db.ts and both Lead runtimes. Original db.ts hash resolves to commit `4d266490b`; the actual diff adds SQL timing/openExistingWriter and shared attention selection, while leaving the bootstrap generator and getPendingQuestions paging implementation unchanged.

A bounded Python refresh computed SHA256 from the four source files and updated only their hash entries plus the three reviewed pair rationales. Rationale explicitly distinguishes ON section 0.11 from the unchanged historical OFF patrol text; both transports deliver the same new intake event instructions independently of the switch. No runtime, rule or test source changed in this addendum. Unchanged drift suite RED: 12 failed/5 passed; GREEN: drift, independent historical generator oracle, bootstrap, intake rule suites **23/23** (`/tmp/fly2557-compatibility-green.log`). Manifest Biome check passes.

Prior-head CI run `34998053331` has an observation-performance failure: max 51.827826ms versus strict <50ms (`src/ship-judgment/__tests__/observation-performance.test.ts:219`, job 104479327430). It is retained as a failed performance check, not waived or relabeled contention. New-head exact CI must pass.

### OFF-bundle review HIGH: exact additive rule and captured goldens

Review `5765ef74-9e1b-4888-b15e-f36188074448` at `14bad895f` returned effective CHANGES_REQUESTED for `intake-rules-missing-from-rollback-bundle`; exact CI run `34998866906` failed only teamlead 2/4 (plus aggregate CI OK). The existing real Codex launcher assertion also failed locally. Lead rulings `e1eff36e`, `f535c40e` and `dd6d00cc` authorize preserving approved section 0.11 in both modes and explicitly evolving the historical goldens without weakening assertions.

The exact section is copied to OFF; removing only the inserted bytes reconstructs the prior OFF source exactly. Overlay digest `24d7b1928661a4952de3e721b684d703452c86dd25037bd9f1f6ea2631f902a6`. OFF source digest changes from `a48cb411861c7b3edd234d49e42efb3b5fd114b0e4b70872cffe2db4734bae1c` to `f274a86e359454d6ed8a2b3b6fb5f1e941b39425df2028a8a3abe9c873888ffc`. No other rules or test assertions changed.

Capture command:
```sh
python3 engineering/doc/FLY-2567-lead-token-savings/capture-legacy-bundle.py --intake-overlay engineering/doc/FLY-2557-epic-intake/approved-intake-section.txt
```
The minimally extended existing capture script retains historical `f022a0a7` Git extraction and its selector/materializer. It verifies the pinned overlay digest and exact historical-byte preservation before generating both `rework-legacy-sources.json` and `legacy-bundle.json`. Two consecutive captures produce byte-identical files. A wrong overlay exits nonzero before touching either output. The independent historical body evolves from 231221 bytes / `5d5820dc793a2d66021da3e8f49658e1c2fd087365deb213e173a3b549b4835c` to 234489 bytes / `377c59fef2830389845c7cfe5b379123eaedac488e0b6678db4bdf4313b3da45`. Output JSON indentation was corrected in the generator, never by editing golden data.

Unchanged Codex bundle, OFF source/body oracle, compatibility drift and intake rule tests pass **50/50** (`/tmp/fly2557-off-bundle-green.log`). Real Claude/CoS launcher shell checks pass **54/54** (`/tmp/fly2557-off-claude-bundle.log`). Prior intermediate run retained the expected two stale-golden failures (48/50); final green supersedes them. New review and CI remain required after the authorized single push.

### Authorized FLY-2447 main sync

Lead ruling `ae563ea8-a5c5-4d22-a1ae-6fd191e07b2d` authorizes syncing `451812138` once, preserving both sides, with one push and automatic `head_moved` requeue of review `f19acfd9` (no second request). Prior head `154ade045` independently received effective APPROVED; six remaining MEDIUM/LOW advisories were relayed via receipt `6556e4c3-48b7-4cc9-bda9-a632adca4b1c` and are not expanded into this sync.

Only hook-payload.ts conflicted: retained both import groups, optional intake/business-wake payload fields and both formatter functions with separate method boundaries. Both runtime dispatchers retain their distinct intake and business-wake branches. Re-audit confirms db.ts is unchanged at SHA256 `27860a89041cb05e8a96bced3bf4eeb38c7ec16b0446de9b1d1bfa87f4e3f606`; only the two runtime compatibility digests/rationale change for the new business-wake branch.

Focused hook-payload/business-wake/bundle/OFF-oracle/drift/intake checks pass **58/58** (`/tmp/fly2557-sync4518-green.log`); initial two drift failures were reproduced before the reviewed manifest update. Teamlead typecheck and recursive build pass (`/tmp/fly2557-sync4518-types.log`, `/tmp/fly2557-sync4518-build.log`). Actual Claude launcher and final lint follow-up are running. New-head review/CI remain required; no merge to main or QA dispatch.

Final sync validation: Claude/CoS actual launcher checks **54/54** (`/tmp/fly2557-sync4518-claude.log`), final lint passes with 21 warnings (`/tmp/fly2557-sync4518-final-lint.log`). No tests changed for this sync.
