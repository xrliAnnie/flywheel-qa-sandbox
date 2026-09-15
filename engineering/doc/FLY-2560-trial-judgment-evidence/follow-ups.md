# FLY-2560 机器试判 — 后续事项
Issue: FLY-2560
日期: 2026-09-15
基于: plan.md

Lead question `2626e70e-2af1-4c8d-aab3-2ccafe148104` 授权本轮仅修 HIGH `refresh-failure-discards-prior-file-cache`；以下新头评审 advisories 不在本轮处理，也不冒充已解决。评审头 `7d5b7ac7e87b033c52c293a3b865129a7530558f`。

## MEDIUM — qa-stale-claim-renders-as-hard-fail

A stale-attempt / wrong-issuer QA claim is reported to the founder as "③ QA 用例覆盖：不通过"

`qaAuthority` maps `qa_claim_stale_attempt`, `qa_claim_wrong_issuer`, `qa_claim_inconsistent` and `qa_claim_revoked` through `reject()`, which sets `verdict:"fail"` (l.190-212). buildEvidenceLedger then does `if (qa.verdict === "fail") fail(c, qa.reason)` (evidence-ledger.ts l.361), so coverage becomes `fail`, `aggregateJudgment` yields `recommend_reject`, and `evidencePointLabel` prints the bare string `不通过` — the reason code is never rendered.

Failure scenario: a rework opens QA attempt 2 while the founder-gate card is still `awaiting_review`. The only claim at that head is attempt 1's `qa_passed`. `node.attempt = 2 !== candidate.attempt = 1` → fail. The card renders `③ QA 用例覆盖：不通过 · qa_passed <claimId>` and the headline becomes `不可自动批：③` / overall `建议拒绝`, telling the founder QA failed when in fact no verdict exists yet for the current attempt. Same for `!node.execution_id` (a qa node row started but not yet bound to an execution) → `qa_claim_wrong_issuer` → `不通过`. This contradicts the stated goal ("缺什么就写什么") and the label contradicts the evidence id printed beside it. These states should be `undetermined` + `missing:[qa_claim]` with the reason code surfaced, keeping `fail` for `qa_failed` only.

## MEDIUM — evidence-digest-reintroduces-volatile-mechanical-digest

The ledger digest puts mechanical.digest back into presentation_digest, causing per-push card churn

`offer` deliberately strips `digest` and `checkedAt` from the mechanical payload before computing `presentationDigest` (l.161-165) so the card is not re-posted on every unrelated snapshot change. The new first key `evidence: evidenceLedgerDigest(evidence)` undoes that: `evidenceLedgerDigest` hashes `evidence.map(({observedAt, ...ref}) => ref)` including each ref's `id`, and the merge_probe ref's id IS `mechanical.digest` (evidence-ledger.ts l.377-396), which is `canonicalDigest({snapshot, merges, files})` over the full project snapshot — every open PR's head_sha and file list.

Failure scenario: a runner pushes one commit to any of the ~42 open flywheel PRs without changing its file set. `openPrCount` and `overlaps` (the parts kept in `displayMechanical`) are unchanged, but the snapshot hash changes, so `presentationDigest` changes, a new opinion row is inserted and the Discord card is patched. With pushes landing continuously this saturates the throttle (`next` = max(latest+10min, 6/hour)) for every open gate card and burns the `patch_reserved_times` budget (json_array_length<=6), delaying genuinely meaningful edits such as a QA verdict arriving. Derive the merge_probe ref id from stable inputs (e.g. verdict+reason+overlaps) or exclude it from `evidenceLedgerDigest`.

## MEDIUM — migration-concurrent-startup-throw

The evidence-ledger migration reads its guards outside the write transaction, so a concurrent StateStore open crashes

`applied` (l.6-8), `columns` (l.9-11) and `schema` (l.16-20) are all read before `db.transaction(...).immediate()` opens the write lock. Two connections to the same teamlead.db (Bridge startup plus any script that constructs StateStore) can both observe the un-migrated state.

Failure scenario: process A and process B both read `applied = undefined`, `columns` without `evidence_json`, and the legacy `schema.sql`. A takes BEGIN IMMEDIATE first, rebuilds the table and commits. B then acquires the lock and runs `CREATE TABLE ship_judgment_opinion_new` from its stale 15-column schema plus `evidence_json`, then `INSERT INTO ship_judgment_opinion_new SELECT *,NULL FROM ship_judgment_opinion` — the source table now has 16 columns, so the insert supplies 17 values for 16 columns, SQLite raises, the transaction rolls back and the error propagates out of `migrateEvidenceLedger` → `StateStore.create` throws and that process fails to start. evidence-migration.test.ts covers idempotency only on a single connection. Re-check `state_store_migration` and `PRAGMA table_info` inside the transaction (returning early if already applied) and read `sqlite_master.sql` there too.

## LOW — outcomes-prefers-older-input-opinion

frozenTargetContext silently falls back to a superseded input-bearing opinion instead of the newest evidence-only one

The query changed from `LEFT JOIN ship_judgment_input` to `JOIN`, so `ORDER BY o.created_at DESC ... LIMIT 1` no longer means "the latest opinion" but "the latest opinion that has an input". The evidence-only branch (l.281-320) only runs when that returns nothing.

Failure scenario: a question first gets an input/evaluation opinion, then later gets an evidence-only opinion (the one the founder actually saw on the card). At outcome time the context is frozen from the older, superseded opinion — its `input_id` is recorded on the outcome row and its mechanical binding drives the manifest/rebound checks. When the two opinions cover different target sets the newer evidence-only opinion is never considered and the outcome resolves as unresolved rather than pairing to what was shown. Prefer the newest opinion overall and dispatch on whether it has an input.

## LOW — preflight-masks-all-token-errors

preflight reports every exception as github_credentials_unavailable, including aborts

The `catch` around `Promise.race([deps.token(bound), aborted])` returns `unavailable("github_credentials_unavailable")` for any throw — including the deliberate `input_preflight_aborted` rejection raised when the caller's signal or the 20s timer fires.

Failure scenario: a card collection is cancelled (shutdown, or the outer 60s budget), the in-flight `checkInputs` rejects on abort, `deps.onError("input_unavailable:github_credentials_unavailable")` fires and the card renders `输入不可得：github_credentials_unavailable` even though `gh auth token` was healthy. Distinguish abort/timeout (`input_preflight_timeout` / propagate the abort) from a genuine credential failure.

## LOW — file-page-size-100-vs-2mb-body-budget

FILE_PAGE_SIZE=100 against an unchanged 2 MiB response budget leaves little headroom, and one oversized page blanks ② project-wide

`/pulls/{n}/files` responses embed a `patch` per file; raising per_page from 20 to 100 makes each response ~5x larger while `MAX_RESPONSE_BYTES` stays at 2 MiB (l.10, l.204-207). A `github_body_budget` failure is caught per-PR and only marks that PR `filesComplete:false`, but `checkFileConflicts` returns `incomplete_inventory` whenever ANY open PR in a target repo is incomplete (conflicts.ts l.37-44).

Failure scenario: a single unrelated in-flight PR with large patches exceeds 2 MiB on one 100-file page → ② becomes `缺 机械快照` for every card in the project until that PR closes. Real observation (rework-production-observation.json) shows 3-4 pages for the 200-370 file PRs with no budget error, so this is headroom rather than a present break; consider raising the budget for the files endpoint or falling back to per_page=20 on `github_body_budget` before giving up on the PR.

## LOW — teamlead-typecheck-red-at-this-head

pnpm --filter flywheel-teamlead exec tsc --noEmit fails at this head (pre-existing, not introduced by this PR)

Running the package typecheck at 7d5b7ac7e reports `src/bridge/codex-daemon-teardown.ts(64,4): error TS2559: Type '{ beforeSignal?...; gracefulOnly?...; }' has no properties in common with type 'CodexDaemonOwnershipDeps'` (exit 2). The file is untouched by this branch and its last change (ff33a3e22, PR #1193) is an ancestor of the merge base, so the breakage comes from main, not from this work.

Failure scenario: implementation.md records `tsc --noEmit 通过` as a receipt for this change; that receipt no longer reproduces at the reviewed head, so anyone re-verifying will hit a red typecheck and cannot tell it is unrelated. Either note the pre-existing failure in the PR body or land the one-line fix so the exact-head receipt is reproducible. All other checks I ran are green: 64 files / 292 tests in src/ship-judgment/__tests__, 3 files / 17 tests for the bridge ship-judgment suites, and 15/15 for scripts/__tests__/replay-ship-judgment-cards.test.mjs.

### typecheck 现场复核补充

上述typecheck LOW为reviewer原始观察。当前本地复现后发现claude-runner源码有beforeSignal/gracefulOnly，旧dist声明无；重建该依赖后teamlead build（含tsc）exit0。未修改其源码。原红日志保留于/tmp/fly-2560-warm-cache-build.log，恢复日志/tmp/fly-2560-warm-cache-build-r2.log。
