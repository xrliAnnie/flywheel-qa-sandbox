# Design Review — plan.md (Round 1)
Date: 2026-07-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

The target architecture is feasible on the current system. `StateStore` is already backed by `better-sqlite3`, enables WAL/foreign keys/busy timeout, and exposes transaction support, so an atomic teamlead.db claim/transition/event substrate is a sound fit. The head-bound, use-time claim model also addresses the actual FLY-1204 defect better than another `qa_required` repair.

The plan is not yet implementation-ready, however. The blocking gaps are at the boundaries: the unchanged red test is not selected by the proposed “claims run vs legacy run” branch; the edge token is bound to an edge before the result chooses an edge and has no proposed storage table; run pinning conflicts with “read latest revision at every dispatch”; founder approval and TURN currently cross teamlead.db and per-project CommDB without an atomicity/reconcile contract; and the shipped eng example violates the new cross-vendor admission rule. Those are correctness and rollout issues, not product-decision objections.

I verified the named implementation paths rather than relying on the plan text. In particular: `setQaRequiredSnapshot` is write-once; `qa-result` accepts caller-selected execution/head under the shared ingest bearer and persists failed-send markers; `/events` inserts the generic event before QA-specific processing; `evaluateQaShipGate` treats `qa_required=0` as an immediate pass; the three-stage PASS intent is headless today; `three_stage_turn` is authoritative in project CommDB and is read directly by the runner CLI; `approveExecution` and the founder-consent router write approvals directly; and the text/reaction/voice production wiring already injects the shared hold guard. I also verified the real FLY-1185 `codex_review_record` example and inspected the parked FLY-1204 commits and the original red test from `origin/fly-1204-split`.

## What's Good (Keep)

- Keep claims as append-only, head-bound evidence checked at use time. It directly encodes “the head that ships has a QA pass for that head” and naturally invalidates stale evidence without transitive graph pollution.
- Keep server-authoritative `rev-parse`, one-attempt capabilities, bounded replay protection, and claim-level cross-vendor enforcement. These address the two independent causes documented by the red test; the unchanged red test plus separate forgery tests is the right acceptance shape.
- Keep Gate A before Gate B: strict schema/loader, materialized snapshot, node-id lifecycle, output/completion contract, and Blueprint capability gating must exist before `generic` dispatch or graph interpretation.
- Keep immutable run snapshots, bounded first-class loop edges, explicit exit/limit/escalation behavior, and fail-closed human gates. They match the existing PhaseOrchestrator’s hard-won crash/retry guards while making the control flow declarative.
- Keep teamlead.db as the Dashboard/runtime SSOT and YAML as idempotent seed/import/export material. The existing StateStore engine can support this without introducing another database technology.
- Keep the default-off and reverse-compat sentinels, including a permanently available bare session. The plan correctly recognizes the ship gate’s blast radius and proposes parallel write before read cutover.
- Keep the intent to reuse the existing resolver rather than creating a second vendor-to-executor map, and keep capabilities outside all Lead/per-run overrides.
- Keep the staged PR approach and the two true E2Es. Eight reviewable increments are preferable to landing the edge contract, event engine, generic prompt rewrite, and template migration as one change.

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **[BLOCKER] Run pinning and hot deployment currently contradict each other.**

   **Issue:** Section 3.1b says a run pins an immutable revision/materialized snapshot and remains unaffected by later publishes, but also says the engine reads the currently published revision at every node dispatch and field edits take effect immediately “at dispatch.” Published revisions are also described as immutable, so a scalar edit cannot change an in-flight run without either mutating an immutable revision or bypassing its snapshot.

   **Why it matters:** Different implementation teams can reasonably choose opposite semantics. Reading live values mid-run breaks reproducibility, cross-vendor validation, token `manifest_revision` binding, crash replay, and the founder-decided run-pinning rule.

   **Suggested fix:** State one rule: select the current published revision once at **workflow-run admission**, apply and validate per-run overrides, materialize the complete effective snapshot, and have every later dispatch/retry/reconcile read that pinned snapshot from teamlead.db. Every template edit, including model/effort/cron/flag edits, creates and publishes a new revision; it affects the next admitted run, with zero process restart. Only separately named live safety kill-switches may block a future dispatch without rewriting the graph. Update the “三级矩阵” and hot-deploy explanation accordingly.

2. **[BLOCKER] The core eng seed is invalid under the plan’s own cross-vendor rule.**

   **Issue:** Current `three-stage-phases.ts` dispatches Implement on Fable and QA on Opus through the Claude lane. The v1 example likewise shows Implement as Claude/Fable and QA as Opus. Section 3.1 says a `qa_verdict_emitter`/review node with the same vendor as its upstream implement node must be rejected.

   **Why it matters:** The promised “today verbatim-equivalent” eng seed will fail admission. Changing QA to Codex (or Implement to Codex) satisfies the founder-decided independence invariant but is not vendor-byte-equivalent to today. The code also has multiple vendor vocabularies (`claude`, `claude-code`, executor backends, and model families), so an unnormalized comparison can accept or reject the wrong pair.

   **Suggested fix:** Put the exact valid vendor/model assignments for all three seed templates in the plan and define what “behavior equivalent” excludes. Define one canonical review-family enum (for example `claude | codex`) and a server-side mapping from the **resolved execution backend/model** to that family; never trust the manifest or runner payload for claim issuer identity. Add admission tests proving the shipped eng/product revisions pass, plus same-family negative tests. If current three-stage runs must change vendor at migration, call that out as an intentional acceptance delta rather than “逐字等价.”

3. **[BLOCKER] The proposed “edge token” cannot be bound to an edge before the node result selects an edge, and its durable model is absent.**

   **Issue:** A QA activation can produce PASS (forward edge) or FAIL (loop edge). At dispatch time the engine does not yet know which `edge_id` will be traversed, yet Section 2.2 binds the one token to one edge. The six listed tables contain no edge-token table, despite requiring expiry, attempt invalidation, consumption, manifest/schema binding, and audit. The token tuple also omits the authorized issuer node/execution and allowed predicate family.

   **Why it matters:** Implementations will either mint a reusable token, let the runner choose an edge/predicate, or issue an unusable token. None establishes the claimed authority boundary. Raw-token persistence or inclusion in shared event/session payloads would also recreate the bearer leak in a different place.

   **Suggested fix:** Model this as a **node-attempt/decision capability**, not a preselected traversed edge. Add a concrete `workflow_edge_token` (or `workflow_decision_capability`) table with at least: token hash (never plaintext), run/node/execution/attempt, allowed decision/predicate family, manifest and evidence-schema revisions, optional expected subject, issued/expires/consumed timestamps, consumed claim id, and revocation status. On submission, Bridge verifies the capability, captures the subject, writes the claim, chooses the legal outgoing edge from the snapshot, consumes the token, appends the event, increments any loop counter, and updates projections in one StateStore transaction. Define the private delivery mechanism and filesystem permissions for retry markers; no-transport backends must fail admission when they cannot receive the capability safely.

   Exact retry after a lost HTTP response must return the already-created claim (idempotent success), while reuse with a different payload must fail. Requiring every replay to fail would break the existing `qa-result-failed` recovery contract. Add expiry/heartbeat-renewal behavior for long-running sessions and explicitly redact tokens from logs, events, session params, and Dashboard APIs.

4. **[BLOCKER] Claim selection, exemption, and provenance semantics are not deterministic enough for a ship gate.**

   **Issue:** “Latest valid claim” is undefined across `qa_passed` and `qa_failed`, attempts, expiry, retries on the same head, and concurrent arrivals. The proposed claim columns do not include expiry even though expiry is a required claim element. `qa_exempt` is written by the engine at admission, not by a dispatched node holding an edge token, and may exist before a git head exists. Cross-vendor enforcement has reviewer provenance but no authoritative link to the author/producer execution.

   **Why it matters:** A prior PASS can accidentally survive a later FAIL, a same-head retest can be ambiguous, and an exemption cannot obey the same “current-head claim” rule. Comparing a reviewer only with a manifest-declared vendor is not an independent-author check.

   **Suggested fix:** Define a monotonic decision family and resolver, for example `(run_id, node_id, decision_kind, attempt)` with one outcome `pass|fail`, a unique server sequence, and one authorized claim per consumed capability. The gate evaluates the highest valid attempt/sequence for the current subject and rejects missing, expired, conflicting, or failed outcomes. Add `expires_at` (nullable only for explicitly permanent system claims), issuer kind, and subject-producer execution/provenance. Treat `qa_exempt` as a Bridge-issued, actor/reason-audited **run/snapshot policy claim**, not a runner edge claim; bind it to run id and snapshot digest rather than a nonexistent admission head. Define an equivalent server-owned challenge/claim path for human approval instead of pretending the founder carries a runner token.

5. **[BLOCKER] The unchanged red test does not enter the proposed claims branch.**

   **Issue:** The red fixture has a three-stage QA session, `qa_required=0`, a headless FAIL intent, and no `workflow_run`, snapshot, claim, or token. Section 2.4 says a no-claims legacy run follows the old path byte-for-byte. That path returns `qa_not_required`, so the required unchanged test remains red.

   **Why it matters:** This is the chapter-one acceptance line. It also exposes an undefined rollout category: pre-cutover three-stage runs cannot safely be treated like untouched single-session legacy runs, but they cannot manufacture trustworthy historical PASS claims either.

   **Suggested fix:** Define the cutover discriminator independently of claim presence. At minimum, existing durable three-stage identity (`session_role=qa` and `chat_thread_role=qa`) must stop honoring the headless `qa_required=0` exemption and require a valid head-bound claim; missing evidence fails closed and triggers an explicit re-QA/recovery path. Preserve byte compatibility for genuinely non-templated single-session runs. Specify how in-flight design/implement/QA phases are classified at deploy (grandfather, materialize a synthetic run then re-QA, or fail closed), and add tests for each. Do not use “table/claim exists” as a branch selector.

   Also move the minimal `workflow_run`/attempt identity substrate ahead of PR-1, or define non-null legacy run/snapshot/decision identities. PR-1 claims currently require `workflow_run_id`, `edge_id`, and `manifest_revision`, while those entities are not created until PR-4.

6. **[BLOCKER] The run event ledger needs an atomic transition and durable dispatch protocol.**

   **Issue:** The plan calls events authoritative and `workflow_run`/`workflow_run_node` projections, but does not define event idempotency, sequence allocation, projection rebuild, or transaction boundaries. Dispatch is an external side effect: Bridge can crash after recording intent but before launch, or after launch before recording execution id. Existing code already documents that `session_started` is fire-and-forget and may be lost while `worktree_ready` arrives first. `/events` currently inserts the generic session event before QA-specific authorization/processing, so an invalid/replayed claim submission could leave durable evidence-looking input.

   **Why it matters:** Without a durable intent/outbox state machine, startup reconcile can double-dispatch a writer or strand an open node. If claim, edge traversal, loop counter, current node, and display projection commit separately, the Dashboard and ship gate can disagree after a crash.

   **Suggested fix:** Add a unique client/event id and allocate `(run_id, seq)` inside the same transaction that validates the legal snapshot transition and updates run/node projections. For capability-bearing results, validate and consume before inserting any generic event, preferably on a dedicated endpoint/command. Define dispatch states such as `intent_recorded → launch_committed → started`, reserve the execution id before the side effect, and reconcile against the existing launch-claim/launch-commit and session/worktree evidence. Make projection rebuild/reconcile explicit. For loops, either key `workflow_run_node` by `(run_id,node_id,attempt)` or store the current attempt/execution plus retain every attempt in events; a single timeless `(run,node)` row is insufficient.

7. **[BLOCKER] TURN and founder approval cross two SQLite databases without a migration or recovery contract.**

   **Issue:** `three_stage_turn` is currently in each project CommDB, and `flywheel-comm turn` reads it directly before a phase touches the shared worktree. Writing only `workflow_run_event` in teamlead.db would not authorize existing runners. Founder approval is similarly authoritative across a bound response in project CommDB plus StateStore session/head/Codex evidence; adding a founder claim in teamlead.db creates a cross-database dual write that SQLite cannot commit atomically.

   **Why it matters:** A crash between databases can leave a writer with a TURN that the engine does not see, or a founder approval visible in one authority but absent in the other. “Byte-compatible verify-approval” does not say which record wins or how retry repairs a partial write.

   **Suggested fix:** Choose and document an authority/cutover for each domain. A safe migration is to keep CommDB TURN and bound founder response authoritative for legacy/in-flight sessions, then transactionally write a StateStore outbox/projection request and reconcile it idempotently from the authoritative record. Only switch runner TURN reads or `verify-approval` after a versioned protocol/dual-read period. Alternatively, move authority to Bridge claims, but then provide a new private TURN check and approval read path before removing CommDB writes. Add fault-injection tests at every before/after-write boundary.

8. **[HIGH] The founder guard scope and held behavior need to match the actual code, not the comments.**

   **Issue:** The plan is right that `approveExecution` and both founder-consent router write branches lack `founderApprovalHoldGuard`. However, the comments in `voice-routes.ts` and `founder-ship-approval-handler.ts` are not standing in for a nonexistent production guard: `plugin.ts` creates one closure and injects it into the text/reaction/voice paths. Existing FLY-1099 logic also already distinguishes deferrable `codex_pending`/`qa_not_green` holds from non-deferrable `merge_block`.

   **Why it matters:** Deleting accurate dependency-contract comments does not close a write boundary, and a new blanket reject/queue rule could regress the existing deferred-approval behavior. Mutating only the two named files may still miss the central response primitive, deferred replay, or emergency bypass policy.

   **Suggested fix:** Inventory every production approval writer and put the hold check at the narrowest shared pre-write boundary, while retaining explicit defense-in-depth in direct exceptional paths. Adopt the existing reason semantics: defer self-clearing Codex/QA holds; reject `merge_block`; preserve the one kill-switch. Cover actions, founder-consent off/audit/enforce, text, reaction, voice, deferred replay, same-decision retry, and the documented emergency bypass. Mutation tests should remove the real call/wiring at each authority path, not comments. Then define how the resulting bound response is projected into a founder claim per Issue 7.

9. **[HIGH] The template/revision/publish storage contract is incomplete and partly self-contradictory.**

   **Issue:** The review input references “six-table DDL,” but the plan contains only column sketches and no edge-token/output/binding/outbox DDL. A revision row is called append-only while its status moves from draft to published; at the same time `workflow_template.current_published_revision` is mutable. Boot seed import, concurrent editors, revision allocation, publish compare-and-swap, schema upgrades, foreign keys, indexes, and append-only enforcement are unspecified.

   **Why it matters:** Dashboard and boot can race, a restart can overwrite founder edits or create endless duplicate revisions, and “published immutable” is not guaranteed by prose. This is the SSOT boundary FLY-1038 will depend on.

   **Suggested fix:** Include executable DDL and StateStore APIs in the plan. Keep immutable manifest revisions, and either (a) allow one constrained draft→published transition while manifest bytes are immutable, or (b) record publication in a separate append-only publication row and atomically CAS the template pointer. Make seed import content-hash/version idempotent and never repoint a founder-modified template silently. Add DB triggers/permissions preventing UPDATE/DELETE of claim semantics and published manifest bytes, plus FK/index/JSON/schema checks. Specify founder auth, same-origin/loopback/confirm-token, audit actor, stale-edit 409, and atomic publish behavior as a named PR deliverable.

10. **[HIGH] The manifest language, template selection, and gate representation are not specified enough to implement.**

   **Issue:** There is no normative YAML/JSON schema showing node ids, stable edge ids, forward/loop conditions, `exit_when`, gate nodes, terminal states, escalation payloads, or overrides. The text alternates between `qa_fail`/`qa_pass` and claim predicates `qa_failed`/`qa_passed`. `project_scope` does not say how a task category selects one of the first three templates. The plan also promises movable terminal/founder gates and `gate_opened` events without defining a built-in gate node or terminal-gate manifest field.

   **Why it matters:** Loader, engine, Dashboard, and claims can each invent a different graph vocabulary. Ambiguous outgoing edges or undeclared cycles can cause multiple legal transitions. Without deterministic selection, default-off/bare fallback cannot be tested.

   **Suggested fix:** Add a complete schema and the three exact seed manifests, including the eng back-edge. Define one vocabulary and mapping from decision outcome to claim predicate and edge condition. Validate: schema version/unknown keys; unique/reachable nodes and edges; exactly one start; valid terminal/gate configuration; only declared cycles; disjoint deterministic outgoing conditions; mandatory `loop_when`, `exit_when`, `max_iterations`, and `on_limit`; capability/model/vendor compatibility; and no illegal skip. Add an explicit binding/selection precedence such as Lead per-run choice/override → project+task-category binding → project default → bare, with authorization and audit. Revalidate the fully resolved run snapshot after all Lead overrides, including skip/exemption and cross-vendor rules.

11. **[HIGH] Product v1 requires a write path that Gate A explicitly does not provide.**

   **Issue:** FLY-1020’s approved MVP contract makes `generic` read-only/`no_code`, with structured `workflow_node_outputs`; shared-branch generic is phase 2. The new product template says generic research/produce nodes write a docs branch and founder approval binds that branch head. Current shipped generic behavior is not a safe precedent: Blueprint’s default path includes branch/PR/approve behavior, which is precisely why Gate A requires capability-driven prompts. The proposed node fields also have no core-owned doc-writer profile.

   **Why it matters:** Product v1 either cannot produce its approval subject or must grant a user-parameterized generic node a write capability that the security model says it cannot self-grant. Shipping the template before resolving this would violate S11–S16.

   **Suggested fix:** Prefer keeping generic runners `no_code`: research/produce write structured outputs, then a trusted Bridge materializer creates/updates the docs branch from the validated artifact and server-captures its head for review/founder claims. If a runner must write the branch directly, add an explicit core-owned doc-writer profile/capability route (not agent.md or per-run controlled), its branch/TURN/completion contract, and corresponding Gate A and S11–S16 changes. Do not leave “doc-branch writer explicitly declared” as a template-controlled capability escape hatch.

12. **[HIGH] The parked-commit absorption plan is not mechanically safe.**

   **Issue:** Commit `4975ee0d` adds the retry-admission/worktree-occupancy solution. The later split commit `61593e8a` deletes those files/tests and reverses most of that patch while retaining the QA-head ownership work. The plan says to absorb both and later says to pick commits individually.

   **Why it matters:** A chronological cherry-pick silently discards the retry-admission fix; reversing order creates conflicts and an unreviewed hybrid. The listed hashes are not independent building blocks.

   **Suggested fix:** Replace the hash list with a path/hunk integration matrix and expected final-tree assertions. Transplant the QA-head ownership hunks from `61593e8a` while retaining the final retry-admission/worktree-occupancy implementation from `4975ee0d`; assign each net change and its tests to a specific PR. Record which parts `workflow_claims` supersedes rather than applying and deleting them. Run the original `58cecc1f` red test byte-for-byte and the parked branch’s worktree/retry tests against the final combined tree.

13. **[HIGH] PR sequencing and acceptance need an explicit migration/fault matrix.**

   **Issue:** PR-1–3 depend on run/attempt/manifest identities deferred to PR-4; PR-4–8 omit concrete deliverables for publication APIs, template bindings/selection, seed import, dispatch outbox, TURN/approval projections, and node outputs. FLY-1224 is described as “independent first,” but it is a hard dependency: today `dispatchModel` selects the Claude backend, effort comes from project role config, and current config documents/refuses meaningful effort on non-Claude backends. The sample Codex model+`xhigh` snapshot is not supported by the present resolver contract.

   **Why it matters:** The claims chapter cannot land with valid foreign identities as ordered, and PR-7 can silently resolve the wrong vendor/model/effort. A global claims-read switch cannot safely distinguish old single-session, in-flight three-stage, and new templated runs.

   **Suggested fix:** Recut the dependency chain as: (1) minimal workflow run/attempt + capability/claim/event transaction substrate and typed cutover marker; (2) parallel-write producers plus reconcile/outbox; (3) founder guard and cross-DB projection; (4) claims read for explicitly enrolled/migrated three-stage runs, with the unchanged red test; then Gate A schema/snapshot/lifecycle/output/capability work; only after FLY-1224’s explicit `{vendor,model,effort}` resolver API and tests land, enable template dispatch. Name separate write/read/emergency-revert flags and make enrollment per run, not inferred from table contents.

   Add an acceptance matrix covering: exact duplicate versus conflicting replay; expired/revoked/old-attempt tokens; marker replay after Bridge restart; server-head mismatch and head movement after PASS/approval; claim/edge/projection crash points; dispatch intent crash points; old workflow events; in-flight three-stage migration; legacy single-session byte compatibility; Auto-QA backfill; TURN dual-write/reconcile; founder response/claim partial writes; publish concurrency; seed idempotency; malformed/unknown schema; all loop exits/limits; and both event sinks/marker reconciler/finalizer/retry paths. Map revised claims assertions explicitly to S1–S16 instead of only saying they remain true.

## Verdict

CHANGES REQUESTED — address items above
