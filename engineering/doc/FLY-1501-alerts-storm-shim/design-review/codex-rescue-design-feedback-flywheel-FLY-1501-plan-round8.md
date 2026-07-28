# Design Review — plan.md (FLY-1501) (Round 8)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 8 correctly turns digest mismatch into a distinct nonterminal outcome and requires convergence inside the same reconciliation invocation; the shared canonical encoder/decoder also gives the lock classifier a concrete direction. The new contracts still do not fit the existing configuration boundary or the transaction-before-validation requirement, and two uniqueness keys remain too coarse for the newly introduced re-entry and same-second resume cases.

## What's Good (Keep)

- `quarantine` exit 6 is now unambiguously nonterminal, and the caller must re-read the replacement bytes in the same `reconcileRestartStormSpool` invocation.
- The three-re-entry bound prevents an adversarially changing file from spinning one reconciliation forever; exhaustion leaves the file live and retryable.
- A12 now forbids convergence by kernel restart or an ad-hoc second invocation and checks actual contention on the expected child lock.
- One Python encoder/decoder shared by ensure-spool and quarantine is the correct way to prevent the two Python paths from disagreeing about lock ownership.
- The compact delimiter-based filename is filesystem-safe and much easier to validate than the prior colon-bearing ISO spelling.

## Issues & Recommendations

1. **[HIGH] The frozen child-key grammar is narrower than the current authoritative config grammar, but the plan does not change or validate the upstream producer.** plan.md:51 accepts only lowercase, at most 64 characters and no `__`; plan.md:58 constructs Lead keys directly as `lead.<project>-<lead>` from the manifest. Today `ProjectConfig.ts:387/402/595` accepts uppercase identifiers, has no length bound and permits `__`. Therefore a project that is valid under the existing config contract can materialize a supervised wrapper whose gate exits 4 on every launch; because wrapper integration treats every nonzero as “do not exec,” this becomes a persistent service outage rather than an early config error. The current local fleet happens to fit the proposed grammar, but that does not close the code-level contract. Either widen the gate grammar to the existing `SAFE_ID` domain while retaining an unambiguous suffix decoder, or add the exact derived restart child-key invariant to `ProjectConfig`/manifest materialization, list those files in W3, and provide an explicit compatibility/migration check before deployment. Do not lowercase, truncate or replace characters at the wrapper because that can alias two authorities. Acceptance must cover uppercase, `__`, and over-64 inputs at the config boundary and prove no config accepted upstream can later be rejected by gate.

2. **[HIGH] “TS only passes strings” conflicts with the required pre-commit spool validation; the sole Python parser is not callable on the valid projection path.** plan.md:40 requires exact schema plus filename↔episode_key↔child_key↔window validation before opening the kernel transaction, so malformed canonical data must create zero obligations. plan.md:51 simultaneously forbids TS from implementing the grammar and only names Python encoder/decoder callers in ensure-spool and quarantine. A self-consistent JSON file with an invalid child/timestamp spelling can therefore pass TS’s type/equality checks and be inserted; `mark-applied` may reject it after commit, but the invalid obligation already exists, violating the frozen zero-obligation rule. Add a helper operation that validates/decodes the live spool and returns the canonical fields and digest before `kernel.write`, or allow a TS validator backed by one frozen shared conformance corpus. In either design, the same bytes/digest must flow into the subsequent transaction/quarantine decision. Add a case with valid JSON and mutually matching fields but a noncanonical episode filename, asserting zero obligations and quarantine before any DB commit.

3. **[MEDIUM] Re-entry promises a new diagnostic for a new invalid digest, but the unchanged event key makes that impossible.** plan.md:41 still freezes `event_uid=restorm-invalid:<basename>` with `INSERT OR IGNORE`, while the exit-6 branch says a still-invalid replacement records its new digest. Since events are append-only, the second insert for the same basename is ignored and the only row continues to describe the old bytes; the three-re-entry exhaustion row can likewise disappear behind the first event. Make the content version part of the idempotency key, e.g. `restorm-invalid:<basename>:<digest>`, so replay of the same bytes remains exactly once while distinct invalid bytes receive distinct audit rows. Update A12 to assert one row per distinct digest, no duplicate on replay of a digest, and an explicit exhaustion diagnostic.

4. **[MEDIUM] Second-resolution `window_start` can reuse the full-history episode key after resume.** plan.md:51 reduces the episode timestamp to `YYYYMMDDTHHMMSSZ`, while plan.md:39 uses the episode key as the permanent obligation primary-key suffix and as the spool/alert dedupe identity. If a resume and a newly qualifying storm occur within the same wall-clock second—especially with a low test/operator threshold—the new episode can collide with the prior applied spool and resolved obligation, suppressing the N43 “new episode after resume” behavior. v13 deliberately uses seq for ordering so same-tick behavior is not allowed to depend on clock precision. Preserve filesystem safety but include sufficient uniqueness, such as fixed-width fractional UTC precision or the first post-resume event seq in the canonical episode key. Add a frozen-clock acceptance case that resolves the first episode, resumes, triggers a second storm in the same second, and obtains a distinct spool, alert signature and obligation.

## Verdict

CHANGES REQUESTED — address items above
