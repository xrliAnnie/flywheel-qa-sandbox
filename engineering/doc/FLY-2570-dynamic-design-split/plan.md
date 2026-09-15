# FLY-2570 动态设计分流 — 实施计划
Issue: FLY-2570 (https://linear.app/geoforge3d/issue/FLY-2570)
日期: 2026-09-14
基于: research.md

## Status

Revision 3 after round-2 CHANGES_REQUESTED (request 7f7fd0de-2af1-49a6-bf5f-b83d604f14b8); implementation requires effective APPROVED review_design. Execute inline under implement TURN. No successor dispatch, merge, deployment or production configuration mutation.

## Goal / Architecture

Extend existing hot-read models.json policy, retaining v1 parity. One shared pure policy parser/allocator backs config validation, operator command and receipt replay. Human set/show operates atomically on the same runtime config location. New workflows use the new policy; admitted workflows retain the immutable assignment. Scope gate is exactly menu.shape === 'code' && node.id === 'eng_design'.

## Contract

New JSON policy:
```json
{"enabled":true,"rule":"issue_number_percentage","codexPercent":75,"codex":{"arm":"A","model":"astra"},"fable":{"arm":"B","model":"fable"}}
```
Canonical input uses fixed field order: rule, codexPercent, codex {arm,model}, fable {arm,model}; ruleVersion is derived at parse time and stored only in the immutable assignment receipt. A legacy/manual version property on percentage input is ignored; editing codexPercent alone remains valid and produces a new computed version. Receipt replay still validates the saved computed version using the frozen fly2570-v1 algorithm. v1 schema stays byte-compatible. Percent accepts finite number 0..100 including decimals; unknown fields (except optional ignored version), malformed arms and non-Astra/Fable pairing reject. enabled must be true for the new rule; rejection explicitly directs operators to set --codex-percent 0 for Fable-only design routing. CLI cannot bypass split via disabled percentage config.

Algorithm:
```ts
const bucket = Number.parseInt(createHash('sha256')
  .update(`fly2570-v1:${issueNumber}`).digest('hex').slice(0, 13), 16)
  / 2 ** 52 * 100;
const arm = bucket < policy.codexPercent ? policy.codex : policy.fable;
```
Issue suffix must remain positive safe integer. Configuration does not enter bucket hash. Receipt basis extends the existing discriminated rule union with bucket, codexPercent and full codex/fable mapping; ruleVersion is canonical digest. Replay recomputes bucket/version/arm from saved basis and verifies selected model against receipt/pinned runtime, without reading current config. Legacy parity receipt remains accepted with existing semantics.

## Task 1 — shared policy parser and allocator (TDD)

Files: new packages/config/src/model-split.ts; exports in packages/config/src/index.ts; packages/config/src/agent-registry.ts and model-config.ts; new packages/config/src/__tests__/model-split.test.ts and existing model-config tests.

- [ ] Add failing tests for percent 0, 100, 75, 37.125; repeated same issue returns identical bucket/arm; integer suffix failures; NaN/Infinity/string/negative/>100; unknown field/invalid model; manual ratio edit with absent/stale version is accepted and generates the new version.
- [ ] Assert representative large deterministic issue population approximates 75% and all 0%/100% endpoints. Golden independent SHA256 vector anchors algorithm.
- [ ] Run focused config Vitest and preserve red receipt.
- [ ] Implement discriminated v1/percentage types, common strict parse/build/resolve helpers and version derivation. Keep legacy parser acceptance unchanged.
- [ ] Run green tests; commit implementation + tests, update progress.

## Task 2 — hot dispatch and frozen replay (TDD)

Files: packages/teamlead/src/workflow-menu.ts, workflow-dispatch-resolution.ts; tests workflow-model-split.test.ts and workflow-dispatch-resolution.test.ts.

- [ ] Same process, same loaded menu: resolve issue at 0%, atomic replace temp config at 100%, resolve again => Fable then Astra without resetting model cache. Assert config changes preserve implement/qa vendor constraints.
- [ ] Malformed policy/JSON throws MODEL_SPLIT_CONFIG_INVALID for code.eng_design before model selection; other shapes/nodes remain unaffected. Absent file retains legacy parity.
- [ ] Explicit wrong override throws MODEL_SPLIT_OVERRIDE_CONFLICT including issue, rule/version, bucket, percent, expected arm/model. Matching override works; 0% odd issue Fable works.
- [ ] Real StateStore fixture: pin percentage assignment, change current policy, close/reopen store, replay original arm. Verify v1, missing audit legacy path, duplicate/tampered receipt rejection.
- [ ] Run tests red; implement exact scope check and shared resolution, preserve snapshot pinning and runtime immutability; run tests green and commit.

## Task 3 — operator set/show (TDD)

Files: scripts/design-model-split.mjs, scripts/__tests__/design-model-split.test.sh; thin shared packages/config/src/model-authority-lock.ts path wrapper around existing exported withMkdirLock in mkdir-lock.ts; packages/teamlead/src/account-heal/fable-model-sync.ts and its existing tests. Shared pure helpers from flywheel-config dist. No new service or credential.

- [ ] Child-process shell test uses temp config. set 75 then show exposes matching percentage and digest, set 0 enables Fable-only, set 100 Codex-only, set 37.125 accepted, resetting 75 recovers same version.
- [ ] Negative command tests: empty/non-number/Infinity/-1/101, corrupt existing JSON, symlink, busy lock; each exits nonzero and leaves file unchanged. Preserve unrelated config fields. Both first-create and replacement target must have mode exactly 0600 and current uid, matching fable-model-sync authorityIsSafe; reject unsafe existing owners/modes and symlinks. Assert both create/replace modes in tests. Show corrupt config exits nonzero.
- [ ] Implement set --codex-percent NUMBER and show with --config override (default env/path matches runtime), using strict candidate validation, shared exclusive lock at canonical authority path + .lock, same-directory 0600 temporary write then atomic rename and finally cleanup owned lock/temp. Resolve parent path aliases consistently and reject symlink authority targets. Use existing withMkdirLock (bare:false, timeoutMs:2000, retryMs:50, staleMs:120000), with its PID/start-time/unique marker ownership and exact-marker release. Dead PID is reclaimed immediately; provable PID reuse is reclaimed; live or uninspectable owner is never age-stolen. Empty lock from death before marker creation uses existing 120-second fallback and explicit retry guidance. No new lock protocol. Fable credential read and API probe happen OUTSIDE the lock; then acquire, re-read and validate the latest authority, compute the update against those latest bytes, write, verify and roll back only that locked preimage. No awaited network/keychain operation in the critical section. set holds the same lock across its read/validate/write/verification only. fable sync returns retained/authority_busy on contention; set exits nonzero with busy/retry guidance. Existing withMkdirLock owns stale recovery and release; callers never unlink lock paths themselves.
- [ ] Add deterministic two-writer tests: pause Fable sync inside injected API probe, set 0 must succeed immediately; release sync, its locked re-read must preserve 0 while updating Fable metadata. Pause set inside critical section, sync returns authority_busy without changes. Cover Fable verification failure rollback while holding lock and prove no successful percentage update can be overwritten. Inject test probes/credentials only, no live API/keychain.
- [ ] Orphan recovery test: kill a child process after its holder marker is published; a subsequent set 0 automatically reclaims and succeeds. Test live old owner and EPERM/uninspectable owner remain protected, PID-start mismatch recovery via existing lock seam, empty orphan after 120s, and replacement-owner release protection using existing lock suite. Alias test must hold through symlinked parent path and contend through real parent spelling (including first-create absent authority); use join(realpathSync(dirname(resolve(path))), basename(path)) in BOTH writers. Never realpath a missing target file.
- [ ] Reject options/duplicates that could silently redirect paths or values. No eval/shell interpolation. Report absolute sourcePath and effective version; absent config show reports v1 50/50 fallback explicitly.
- [ ] Run shell test green; same-process hot-read test consumes actual command output file, proving writer-reader contract; commit.

## Task 4 — historical four-metric report (TDD)

Files: scripts/fly2403-design-model-comparison.sql, scripts/__tests__/fly2403-design-model-comparison.test.sh.

- [ ] Add non-balanced fixture (three Astra vs one Fable with known review/QA/founder/duration data), percentage and v1 receipt cohorts. Assert each metric's own N, never assume equal counts.
- [ ] Add optional rule_version report parameter. Filtering uses saved design_model_arm_assigned basis.ruleVersion, never current config or current issue hash. Exact version filter excludes absent/ambiguous receipt evidence; unfiltered report retains legacy behavior and exclusions.
- [ ] Require all design assignment receipts in an included run match chosen cohort version, preserving multi-execution contamination rules. Old fly2403-v1 remains queryable where saved version exists; missing version is unknown, not fabricated v1.
- [ ] Red then minimal SQL change then green; retain existing attribution and denominator tests. Update report header/operator documentation; commit.

## Task 5 — verification, review, handoff

- [ ] pnpm install --frozen-lockfile if needed; pnpm lint; pnpm -r build; pnpm test:packages:run; new shell test plus existing comparison shell test. Register the new shell test explicitly in .github/workflows/ci.yml beside the comparison test and run ci-shell-suite-enumeration.test.sh. Save logs outside tracked source and summarize exact outcomes in verification.md.
- [ ] Aggregate green OR complete PACKAGE_GATE_RECEIPT (zero assertions, only onTaskUpdate RPC errors); cover unreached packages with VITEST_MAX_FORKS=1 pnpm --filter <pkg> exec vitest run. Never mislabel an aggregate failure green.
- [ ] No DB migration: configuration file and existing event payload only. Reopen StateStore fixtures establish restart/replay; operator restore demonstrates rollback. No new retention consumer/table, only existing comparison consumer and durable assignment data; verify existing retention treatment covers assignment event.
- [ ] Update operator.md with set/show/rollback and 0% emergency command, exact file scope, production activation limitation and SQL version filter. Tests exercise each command on scratch files.
- [ ] Commit progress before final milestone; create engineering/doc/milestones/FLY-2570.md as literal last commit. Push branch, open PR with artifacts and exact-head CI. Never touch CLAUDE.md.
- [ ] Register effective code review using gate review_code + request-review --type code. Poll structured reviewVerdict; fix blockers with new head/new review. Report advisories separately. Exact reviewed head must match final PR head and CI evidence.
- [ ] Send ask --report with PR, head, verification/gate receipts and scope limits. Complete --route needs_review --pr NUMBER, then obey controller TURN/park. No QA dispatch or ship approval.

## Acceptance mapping

| Requirement | Proof |
|---|---|
| Human arbitrary hot ratio and visible effective value | Task 3 CLI + Task 2 same-process writer/read test |
| Same issue same policy deterministic, historic versions | Tasks 1, 2 restart/replay, 4 version cohorts |
| Wrong override fail-closed and understandable | Task 2 error assertions |
| Invalid ratio/config rejected without fallback | Tasks 1–3 negative tests |
| Non-50/50 metrics retain individual N | Task 4 imbalanced fixture |
| Scope and invariants | Task 2 unrelated shapes and implement/QA tests |

## Risks and limits

Host model file remains host-scoped; no new per-project precedence. Initial rollout retains registry v1 until operator sets percentage; 75 is documented command, not forced production mutation. Updating a ratio does not reassign already-admitted workflows. The initial software capability deployment is separate from future ratio changes, which need no deployment/restart. 0% affects only eng_design; implement still has its existing Codex default and may stall in a fleet-wide Codex outage. A concurrent ratio change during the two existing admission reads can cause a retryable admission conflict; document retry after set completes, without claiming all in-flight admissions finish atomically. Freeze canonical serialization by fly2570-v1 tag; future policy formats require a new tag and must retain old replay code and golden fixtures. Existing model aliases can change concrete model versions: receipts freeze concrete model and arm policy at admission, as before.
