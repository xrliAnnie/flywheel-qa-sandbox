# QA Report — FLY-904 scratch turn-reducer (FLY-887 R2 TURN protocol mirror)

**Issue**: FLY-904 (QA E2E scratch — FLY-887 R2 real-machine 529 Room verification, FLY-902 disposable)
**Date**: 2026-07-06
**Branch**: `project-slot-2-FLY-904` (shared three-stage branch; PR #52)
**Verdict**: **PASS**
**QA phase**: independent verification of the implement-phase deliverable (`qa-fly904/turn-reducer.mts` + test suite) against the authoritative oracle.

## 1. Oracle

Per plan §5, the acceptance oracle is the FLY-887 R2 authoritative state table
(transcribed in `research.md` §1) plus `plan.md` §2.4 (T1–T8), §2.5 (X1–X6b),
§2.6 (I1–I4). QA verified the reducer behavior row-by-row — no planted bug is
expected (plan §6); the harness drives the fix-loop / design-redo / ship-cleanup
scenarios, not an embedded defect.

## 2. Test execution

Independent re-run (clean, no cache):

```
$ npx vitest@3.2.4 run qa-fly904/
 ✓ qa-fly904/turn-reducer.test.mts (17 tests)
 Test Files  1 passed (1)
      Tests  17 passed (17)
```

16 implement-phase cases + 1 QA-added chain (§4) = **17 green**.

## 3. Oracle cross-check (row-by-row)

### Transitions (plan §2.4) — all present & behavior-correct

| Row | Guard → post-state verified | Test | Reducer site |
|---|---|---|---|
| T1 | design=running; `phase_design_complete` → design parked, implement running (spawn), turn→implement, epoch+1 | ✓ | `turn-reducer.mts:97` |
| T2 | implement=running ∧ qa=absent; `needs_review` → implement parked, qa running, turn→qa, +1 | ✓ | `:109` |
| T3 | qa=running ∧ verdict=none ∧ fixRounds<3; `qa_fail` → fixRounds+1, qa parked, implement running, turn→implement, +1 | ✓ | `:121` |
| T4 | implement=running ∧ qa=parked; `needs_review` (RE-TEST) → qa running (wake), turn→qa, +1 | ✓ | `:109` (shared T2/T4 guard admits qa∈{absent,parked}) |
| T5 | qa=running; `qa_pass` → verdict=pass; TURN/statuses/epoch **unchanged** | ✓ | `:134` |
| T6 | verdict=pass; `merged` → non-absent phases→closed, turn→null, worktreePresent→false | ✓ | `:152` |
| T7 | design=parked ∧ qa≠running; `design_redo` → design running, running-implement→parked, turn→design, +1 | ✓ | `:140` |
| T8 | turn=design ∧ design=running ∧ implement≠absent; `phase_design_complete` → implement running (wake), +1 | ✓ | `:97` (shared T1/T8; wake vs spawn = prior implement status) |

### Illegal / out-of-order (plan §2.5) — all present, correct reason + precedence

| Row | Case | Expected reason | Verified |
|---|---|---|---|
| X1 | handback from non-TURN holder (4 variants: qa_fail@implement, needs_review@design, phase_design_complete@qa, qa_pass@implement) | `not_your_turn` | ✓ |
| X2 | TURN holder / ownerless event with unmet guard (design_redo while running; design_redo while qa running; qa_pass while qa parked) | `bad_state` | ✓ |
| X3 | `qa_fail` at fixRounds=cap | `fix_cap_exceeded` | ✓ |
| X4 | `merged` before approve gate (verdict=none) | `bad_state` | ✓ |
| X5 | any of the 6 events after finalize (turn=null) | `bad_state` | ✓ |
| X6a | `design_redo` after qa_pass (ship pending) | `bad_state` | ✓ |
| X6b | `qa_fail` after qa_pass — **precedence 0.5 beats T3 and the cap** (incl. verdict=pass ∧ fixRounds=cap ⇒ bad_state, not fix_cap_exceeded) | `bad_state` | ✓ |

Refusal-precedence audit against reducer (`:65`–`:93`): rule 0 (turn=null) →
rule 0.5 (verdict=pass no-rollback) → rule 1 (fix cap) → rule 2 (not_your_turn)
→ rule 3 (bad_state) matches plan §2.5 ordering exactly. X6b's "0.5 beats the
cap" is the sharpest ordering claim and is covered by an explicit
verdict=pass ∧ fixRounds=cap case (`turn-reducer.test.mts:255`).

### Invariants (plan §2.6) — enforced on every call

- **I1** (≤1 running, = TURN holder pre-finalize; none after): folded into the
  `call()` helper (`turn-reducer.test.mts:31`) and asserted on every produced state.
- **I2** (epoch monotonic, only grants bump): epoch sequences `[1,2,3,4,5,5,5]`
  asserted on both chain tests; T5/T6 confirmed flat.
- **I3** (worktreePresent true until `merged`, false after): asserted each step of
  both chains via `worktreePresent === (turn !== null)`.
- **I4** (no input mutation on ANY path; ok:false returns same ref): `call()`
  takes a `structuredClone` snapshot pre-call and `toEqual`s post-call on every
  invocation (grant + refuse), plus `toBe(state)` ref-identity on refuse. This
  closes Codex R1 #2 (ref-equality alone only guards the ok:false half); the frozen
  `initialState` (`turn-reducer.mts:24`) additionally hard-fails any mutation
  attempt under module strict mode.

## 4. QA-added coverage

The implement suite covered the design-redo round trip (scenario 2 — the specific
FLY-887 keep-alive behavior FLY-904 exists to exercise) only as **disconnected**
T7/T8 unit rows against hand-built fixtures. QA added one connected-chain test:

- `design-redo round-trip chain T1→T7→T8→T2→T5→T6` — drives the reducer through a
  real redo round trip from `initialState`, asserting epoch stays strictly
  increasing across the redo grants (`[1,2,3,4,5,5,5]`), flat on qa_pass/merged, and
  that the redo leaves no residue (final `fixRounds=0`, all phases closed). This
  proves the round trip composes, not just that its individual rows pass in
  isolation.

Result: 16 → **17 tests, all green**.

## 5. Verdict

**PASS.** The reducer is a faithful semantic mirror of the FLY-887 R2 TURN
protocol: every authoritative transition (T1–T8), every illegal/out-of-order row
(X1–X6b) with the correct reason and precedence, and all four invariants (I1–I4)
are verified. No behavior diverges from the oracle. Scratch deliverable — never
merged to a real branch; disposition driven by the FLY-902 harness.
