# Design Review — FLY-1244 plan.md (Round 4)
Date: 2026-07-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

The governance blocker is closed. Tadashi's Option B ruling is internally legitimate: the plan may narrow the same-user threat model, ship a per-execution bearer as defense-in-depth, record the TTL-window forgery residual, and defer restoration of the stronger isolation invariant to a peer-credential/separate-principal follow-up. Making that follow-up a hard prerequisite for production `READ=1` is a conservative and acceptable rollout boundary.

Round 4 also resolves most of the bounded Round 3 architecture findings. Founder claims now have a USE-time challenge-generation contract, the head-authority problem is acknowledged across the Bridge finalization surfaces, execution binding has a selected append-only table, re-QA recovery preserves phase order, TURN has a stable source id and unique history row, the family comparator consumes resolved identities, and the file matrix is much closer to the actual blast radius.

I cannot approve the plan as written, however, because several finalized contracts still contradict those decisions. The redline says the bootstrap credential never persists while §4.1 deliberately persists it through shell snapshots; §4.1 claims protection from passive snapshot harvest while §11b accepts exactly that harvest; and the deployment option that enables production READ omits the mandatory peer-credential prerequisite. The selected credential/binding DDL also does not enforce that its duplicated `(run,node,execution,attempt)` tuple matches the immutable binding, and the plan never defines the executable predicate that makes an execution current rather than merely historical. Those are security/correctness issues, not editorial polish.

The remaining changes are bounded and do not require reopening governance. They require making the selected Option B schema and rollout checklist internally executable, completing the CLI side of the head-authority switch, and removing stale alternatives/claims from the projector, template, acceptance, and upstream documents.

## What's Good (Keep)

- Keep the signed Option B decision and the three-part §2.2 amendment. It separates an owner-approved scope change from an accidental weakening.
- Keep the explicit known limitation that a same-user sibling can forge PASS during the credential lifetime. This is the honest property of spawn-env delivery on the measured machine.
- Keep peer-credential hardening or a separate OS principal as a production-READ prerequisite rather than merely a backlog aspiration.
- Keep decision-capability and submission credential as separate objects. The capability token remains Bridge-internal while the submission bearer owns delivery/replay concerns.
- Keep one transaction for credential authentication, claim creation, capability consumption/linkage, and replay result. Exact replay after response loss and Bridge restart is the correct recovery contract.
- Keep the dedicated append-only `workflow_execution_binding`; it is safer than mutating `workflow_run_node.execution_id` into an identity authority.
- Keep founder claim authority bound to both head and the current challenge generation at USE time. That closes the same-head rebind race identified in Round 3.
- Keep the exported head-authority concept and the explicit integration matrix for all Bridge completion/reconciliation surfaces.
- Keep phase-safe rollout recovery: design/implement continue normally, while only an already-running uncredentialed QA attempt is superseded.
- Keep the lower-package canonical-digest direction, TURN source-id uniqueness, A/B decoupling intent, resolved-family comparator, generic deferral, Codex marker-only boundary, and read-only template routes.

## Issues & Recommendations

1. **[HIGH] The Option B security and production-rollout contract contradicts itself.**

   **Issue:** Section 0 still states that the “bootstrap credential” never lands on any persistent surface, while §4.1 calls the submission bearer a per-execution bootstrap credential and explicitly accepts that spawn-env delivery writes it into shell snapshots. Section 4.1 then says the mechanism protects against passive harvest through snapshot/env enumeration, while §2.1a and §11b correctly say a same-user sibling can read that snapshot and steal it. Finally, §6 declares peer-credential hardening a hard prerequisite for production `READ=1`, but deployment option (a) permits `READ=1` after only fresh-spawn E2E plus enrollment.

   **Why it matters:** These are the security guarantee and the operator enable gate. An implementation can pass a test named “passive harvest prevented” even though the accepted design does not prevent it, and an operator following the checklist can enable the claims reader before the owner-mandated hardening prerequisite exists.

   **Suggested fix:** Reserve “never persists” for the **decision-capability token**. State that the submission credential's server copy is hash-only but its runner plaintext may persist in shell snapshots under the accepted Option B residual. Replace “defends passive harvest” with “retires the fleet-wide bearer and bounds passive-harvest blast radius to one execution and a short TTL; it does not prevent same-user snapshot harvest.” Add “peer-cred/separate-principal follow-up complete” explicitly to deployment option (a), or remove option (a) from this PR's production rollout. Because this sub-issue ships with READ off, say whether production restart must use FORCE or intentionally accepts branch-(e) blocking.

2. **[HIGH] The credential and execution-binding schema does not enforce the identity tuple or stale-execution rule.**

   **Issue:** Governance selected Option B, but §4.1b still describes both options and permits `authority_kind='peer'`. `credential_hash` is nullable and enforced only by application convention. More importantly, `FOREIGN KEY (execution_id)` proves only that an execution exists; it does not prove the credential's duplicated `run_id`, `node_id`, and `attempt` match that binding. The promised exact capability relationship has no `decision_capability_id` column/FK, and `claim_id` has no FK. The “current-attempt predicate” says a binding must equal the current authorized QA attempt but does not identify that authority or give its query. Because bindings are append-only, an old execution remains resolvable after a replacement/new attempt; the current resolver also selects max attempt and has no required attempt/issuer-execution parameter.

   **Why it matters:** A malformed or stale row can authenticate against one execution while reading or writing another run/node/attempt. An old execution can resolve a newer execution's claim for the same node, defeating the production lookup contract even though `execution_id` itself is unique.

   **Suggested fix:** Finalize the Option B-only DDL now. Make `credential_hash NOT NULL UNIQUE` (or add a DB CHECK keyed by `authority_kind`), add a composite unique key on the binding and a composite FK from credential to `(execution_id,run_id,node_id,attempt)`, and add explicit capability/claim linkage constraints. Define the exact current-execution query—for example, join the immutable binding to the current `workflow_run_node` projection on the full tuple, require its `execution_id` to match, require the attempt to be the current admitted QA attempt, and require the candidate claim's `issuer_execution_id`/attempt to match. Extend the StateStore and flywheel-comm resolvers or add an enrolled-gate wrapper so both implementations test that exact predicate. Cover same-attempt replacement as well as a later logical attempt.

3. **[HIGH] The shared head authority still omits the runner CLI that the current code calls the final ship authority.**

   **Issue:** Section 4.3b correctly identifies CLI `--pr-head` as caller supplied, but the delivery/file matrix wires the new resolver only through Bridge/plugin/finalization surfaces. Current `flywheel-comm verify-approval` requires `--pr-head $(git rev-parse HEAD)`, its usage text calls it the mandatory pre-ship authority, and runner/Lead contracts call the runner's check the final authority. A teamlead-only resolver cannot be imported by flywheel-comm, and the plan does not define how that CLI obtains a server-owned head.

   **Why it matters:** The plan's subject-integrity fix is incomplete if the party being gated can still choose the head at the final merge check. Independent Bridge completion checks help, but they do not make a self-reported pre-merge authority server-owned.

   **Suggested fix:** Put the resolver/API at a legal dependency boundary and specify the CLI path. Prefer making `verify-approval` call a Bridge endpoint that resolves the persisted worktree head and treats the CLI head only as a comparison value; alternatively make the Bridge-issued preflight result the sole ship authority and demote the local CLI explicitly. Add the CLI/index/runner-wake/contract files to §9 and a test where CLI supplies H1 while the authoritative worktree is H2. Retain the per-sink Bridge integration tests and missing-worktree fail-closed behavior.

4. **[MED] The template contract is still not the executable/normative artifact claimed by §5.**

   **Issue:** Section 5.1 still uses comments such as `-- BEFORE UPDATE/DELETE ... RAISE(ABORT)` instead of executable `CREATE TRIGGER` statements. `project_scope`, `seed_owner`, and audit action domains are comments rather than CHECK constraints, and the audit table has no append-only triggers. The three “exact” YAML manifests do not exist as reviewed design inputs yet, and the per-run override schema/allowed fields are still unspecified.

   **Why it matters:** Immutable publication, founder-modification detection, seed compatibility, and override revalidation are material behavior in commit C. Different implementations can satisfy the prose while accepting different manifests or override powers.

   **Suggested fix:** Put the actual trigger/CHECK/index SQL in §5.1, define the precise override object and which node/edge fields it may change, and include the three canonical YAML manifests now or inline their full content in the plan. The already-correct generic deferral and resolved-family comparator should remain.

5. **[MED] The source/projector section retains mutually inconsistent old and new contracts.**

   **Issue:** Section 3.3 first says commit A's TURN destination does not depend on §4.2b and uses project/issue-level receipt when `target_run_id` is null. A later retained bullet again says the target run must be resolved from §4.2b, followed by a duplicate `grantTurn` instruction. The canonical digest decision also remains “move to flywheel-config/new util, or duplicate it,” despite the stated goal of a single dependency direction. The null-run project/issue destination has no explicit result beyond the generic receipt.

   **Why it matters:** Commit A is advertised as independently implementable, but these alternatives let it accidentally acquire a B dependency or implement two digest byte contracts. A retry can then become a poison event rather than an exact replay.

   **Suggested fix:** Delete the stale §4.2b/duplicate bullets, select `flywheel-config` (already depended on by both packages) as the single canonicalization home, and state that a null-run TURN event commits a receipt/project-history disposition without creating `workflow_run_event`. Reflect that result in `applyWorkflowSourceEvent`'s return type and tests.

6. **[MED] The acceptance and authoritative-document matrices have not been synchronized to the closed decision.**

   **Issue:** Decision table #2 still says verdict authentication is an open governance item. Sections 4.1b, 7, and L1 retain Option A branches after Option B was selected. The RQ matrix still says design/implement/QA all converge to a new QA attempt, contradicting the phase-safe §4.5c. The checked-in umbrella §2.2 still contains the old isolation invariant, while research §D still claims spawn-env delivery makes sibling forgery fail. Section 2.1a says to amend the umbrella during implementation, but neither the umbrella nor research update appears in §9.

   **Why it matters:** These are the files and tests the implementer and independent QA were explicitly told to read first. They currently prescribe incompatible negative-test outcomes and rollout behavior despite the governance decision being closed.

   **Suggested fix:** Make the authorized umbrella amendment a named doc-first change, mark research §D as superseded by the shell-snapshot finding/Option B ruling, remove Option A branches from this issue's E2E, and update RQ to “design/implement continue then admit QA; only uncredentialed QA is superseded.” Add a head-authority acceptance row covering the CLI plus every Bridge sink. Then regenerate §9/§12 so “no open items” matches the actual documents.

## Verdict

CHANGES REQUESTED.

I concur with the authoritative Option B governance decision; no governance escalation remains. Approval is blocked only on making that decision executable and internally consistent: fix the credential persistence/harvest language and READ gate, constrain the credential/binding tuple and current-execution query, include the final CLI in the head-authority path, and synchronize the template/projector/upstream artifacts. These are bounded Round 4 edits, not another design rethink.
