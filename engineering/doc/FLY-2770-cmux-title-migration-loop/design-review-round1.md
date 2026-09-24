# Design Review — FLY-2770 plan.md (Round 1)

Date: 2026-09-22
Author: Independent Claude reviewer (Codex/Gemini lanes unavailable)
Status: CHANGES REQUESTED

## Summary

The diagnosis in `exploration.md` §2 is correct and I verified it end to end: the
`"$title")` branch of `reconcile_prepared_ledger`
(`scripts/flywheel-cmux-sync.sh:9037-9046`) passes `$provisional` — which never contains
the cmux placeholder — into `complete_title_migration`, whose surface gate at
`scripts/flywheel-cmux-sync.sh:8193` therefore always fails while the surface reads
`Terminal 65`. The `__DEFAULT__` branch at `:8951-8958` already solves the *workspace*
face by appending the observed placeholder to `canonical_raw`, and
`scripts/test-cmux-sync.sh:6619` (`test_fly1884_prepared_default_title_recovers_with_uuid_receipt`)
proves that path already performs `rename-tab`. So the asymmetry the plan attacks is real
and the authority boundary it reuses (UUID ⇒ may rename a cmux placeholder; legacy ⇒ may
not) is genuinely pre-existing.

But the plan is not ready to implement, for four independent reasons:

1. **C1 does not close the loop on the failure path, and the plan mis-identifies the
   recycler.** The thing that destroys these workspaces is not a prepared-stall counter —
   it is the W1p restored-adoption path (`_restored_recovery_decision` row 13 →
   `advance` → `recovery-close`, `:7522-7533` / `:7645-7660`). Its eligibility predicate
   is *literally* "surface ≠ title" (`_restored_candidate_probe`, `:7411-7413`). Worse,
   once a W1p marker exists, `complete_title_migration` is **hard-blocked** at its first
   check (`:8145-8150`) and `reconcile_prepared_ledger` `continue`s the row (`:8905-8910`).
   So a single failed `rename-tab` pass is enough to guarantee close + recreate, which is
   exactly the issue's negative acceptance criterion (c). C1 fixes the happy path only.
2. **C2 as specified is wrong twice**: it names one `kind` allowlist but there are two
   (`:9469` and `:9509`), and omitting `:9469` corrupts the episode state file and
   disables suppression for *every* existing kind; and it reuses one `kind`+`title` key
   for two different messages with different evidence, which makes the two messages reset
   each other's hash and print every pass — the opposite of "alert once".
3. **C3's safety argument rests on a false statement.** `--refresh` is not "纯 tmux 修复,
   无 cmux IPC": `refresh_linked_sessions` → `refresh_linked_sessions_tail` (`:10485-10494`)
   calls `recover_restored_transactions`, which **closes cmux workspaces**, and
   `prepare_linked_view_state post` → `reconcile_prepared_ledger`, which renames and
   commits. `--refresh` is also not operator-only: `scripts/restart-services.sh:2698`
   fires it automatically 5 s after every Lead restart.
4. **The new `scripts/__tests__/*.test.sh` is not registered anywhere**, which the
   FLY-1764 guard (`scripts/__tests__/ci-shell-suite-enumeration.test.sh`) and the exact
   step inventory (`scripts/__tests__/ci-structure.test.sh:1481-1500`) both fail on.

## What's Good (Keep)

* **The FLY-1884 precedent reading is accurate and checkable.** `_workspace_title_is_default`
  (`:6790`, `^Terminal [0-9]+$`), `_workspace_uuid_valid` (`:6786`), and the paired tests
  at `scripts/test-cmux-sync.sh:6619` / `:6654` / `:6673` are exactly what the plan says
  they are. Reusing that boundary rather than inventing a new one is the right instinct.
* **`_GUARD_TITLE_UUID` claim is correct.** It is assigned at `:8202`, one line before the
  only invocation of `_title_tab_rename_guard` at `:8203`. `grep -n _title_tab_rename_guard`
  returns exactly two hits (`:8116` definition, `:8203` call). No stale-global hazard.
* **C1's authority class is not new.** `adopt_birth_candidate` at `:8378-8382` *already*
  issues `rename-tab` against a non-matching surface with no command-face proof at all —
  only a birth record. The plan should cite this; it is stronger support than the FLY-1884
  workspace-face argument.
* **C4's line numbers are exact** (`scripts/flywheel-cmux-sync.sh:116`,
  `scripts/test-teardown.sh:50`) and the derived default genuinely preserves production
  behaviour.
* **Scope discipline on the forbidden list is honoured**: nothing in C1–C4 touches the
  FLY-913 guardrails, `CMUX_MAINTENANCE_MARKER` itself, or launchctl.
* **The "验收与本 PR 的边界" disclosure section is the right call** — explicitly handing the
  30-minute / full-fleet-restart acceptance to Lead+QA instead of pretending the PR proves
  it is honest and correct.

## Issues & Recommendations

### 1. C1 alone does not break the create loop; the W1p restored-adoption path is the actual recycler and stays armed — BLOCKER

**Issue.** The plan's mermaid diagram labels the recycler "prepared-stall / restored-adoption".
I traced every destroy/recycle path and only one can fire here:

| path | can it destroy workspace:451 today? | does C1 remove the trigger? |
|---|---|---|
| prepared-stall `absent` counter (`:8969-8988`) | No — ref is present, and `_prepared_stall_clear absent` runs at `:8946` | n/a |
| prepared-stall `drift` counter (`:9048-9068`) | No — reached only from the `*)` default arm; a workspace already titled correctly takes the `"$title")` arm at `:9037`, which *clears* drift and never observes it | n/a |
| prepared-stall `authority` counter (`:9007-9021`) | No — only from the `__NULL__/__PROVISIONAL__/__DEFAULT__` arm's `GUARD_BLOCK_RC == 3` | n/a |
| `close_prepared_loser_ref` (`:7990`) | No — requires exactly one *other* `committed` ref for the same title (`:8917-8926`) | n/a |
| `rollback_unreceipted_workspace` (`:7943`) | No — create-time only, before a receipt exists (`:10242`, `:10253`) | n/a |
| `cleanup_stale_workspaces` (`:10329`) / `cleanup_stale_conservative` | No — anchored on the tmux source window vanishing, not on receipt state | n/a |
| **W1p restored adoption** | **Yes** | **Only in the happy path** |

The W1p chain is: `adopt_restored_workspaces live` sees `state=prepared` → `kind=W1p`
(`:7759`) → `_restored_candidate_probe` passes **because** `[[ "$surface" != "$title" && "$surface" != "$raw_title" ]]`
(`:7411-7413`) → `_restored_marker_upsert` mints the marker (`:7767`). Next pass,
`recover_restored_transactions` gets `W1p:prepared:present` + flag on + stable + ready →
row `13|advance` (`:7530`) → `_ledger_upsert committed "$generation" "$ref" "$title"`
(`:7649`, note: **the UUID is dropped**) → `action=recovery-close` → `close_ledger_workspace_ref`
(`:7673`). That is the `restored adoption minted synthetic committed receipt` →
`guarded close workspace=workspace:251` pair in the field log, verbatim.

Per-pass ordering (`sync_additive`, `:11565-11605`) is:
`refresh_linked_sessions_tail` → **`recover_restored_transactions` (acts on markers)** →
`reconcile_prepared_ledger` (where C1 lives) → … → `adopt_restored_workspaces live`
(mints markers) → `create_workspace_for_window`.

So:
* **Happy path**: C1 commits at create (`:10292`) or at the next reconcile, `adopt` then
  sees `live:committed` → `*) continue` (`:7761`), no marker, loop broken. Good.
* **Failure path**: if `rename-tab` or its readback fails even once
  (`:8203-8214`), the receipt stays `prepared`, `adopt` mints a W1p marker in the *same*
  pass, and from then on `complete_title_migration` returns 1 at `:8145-8150` before
  reaching C1's new predicate at all. The close is then unavoidable, followed by a
  recreate. **C1 has zero effect on this path.** This is precisely acceptance criterion (c)
  ("force a rename failure → no re-create, alert once"), which the plan claims as goal #3
  ("rename 真失败时保持不再造") without a single line of code or test behind it.

**Why it matters.** The whole point of the issue is the空壳圈. The plan ships a fix that
works only while nothing else goes wrong, and the issue's own negative criterion is the
case it does not cover. It also means the PR cannot honestly claim "why these readings
should turn green".

**Suggested fix.** Add a C1b that disarms W1p minting for a migration-pending row. Smallest
version: in `adopt_restored_workspaces` (`:7755-7767`), before `kind=W1p`, skip the
candidate when the prepared receipt is UUID-bound *and* the observed surface is a cmux
placeholder — that state is "migration pending", not "restored transaction". Alternative:
make `_restored_recovery_decision` return `quarantine` (not `advance`) for
`W1p:prepared:present` when the title has a live source window and a UUID receipt, and
route that through the C2 episode so it alerts once and never closes. Either way, add a
test that drives a full `sync_additive`-shaped sequence with a forced `rename-tab` failure
and asserts **zero** `new-workspace` and **zero** `close` ops.

### 2. C2 names one `kind` allowlist; there are two, and missing the second breaks suppression globally — BLOCKER

**Issue.** The plan says "`log_cmux_episode` 的 kind allowlist（9507）加 `title-surface-drift`".
The allowlist appears twice with identical contents:
* `scripts/flywheel-cmux-sync.sh:9469` — inside `_cmux_log_episode_state_valid`, the
  **state-file validator**;
* `scripts/flywheel-cmux-sync.sh:9509` — inside `log_cmux_episode`, the dispatch gate.

(Plan's "9507" is off by two; the validator copy is not mentioned at all.)

If only `:9509` is updated, the first `title-surface-drift` row written by
`_cmux_log_episode_commit` (`:9478-9495`) makes `_cmux_log_episode_state_valid` return 1
forever. `log_cmux_episode` then takes the `:9518-9522` branch — **"cmux log episode state
malformed; suppression disabled"** — for `view-invariant-mismatch`,
`cleanup-pending-ttl-reaped`, `watcher-started` and every other existing kind. One
under-specified edit turns a de-noising change into a fleet-wide log amplifier plus a
permanent `WARN: ... malformed` line every pass.

**Suggested fix.** State explicitly that both `:9469` and `:9509` must gain the new kind(s),
and add a regression test that writes the new kind and asserts
`_cmux_log_episode_state_valid` still returns 0.

**Severity.** BLOCKER.

### 3. C2 collides two different messages on one `(kind, title)` episode key, so suppression never engages — HIGH

**Issue.** The plan routes both the `complete_title_migration` drift WARN (`:8194`) and
`reconcile_prepared_ledger`'s `prepared title migration deferred` (`:9030`, `:9042`) through
the *same* kind `title-surface-drift`, keyed on `"$title"`. `_cmux_log_episode_commit`
(`:9484`) keeps exactly one row per `(kind, title)`. `log_cmux_episode` compares the stored
hash against the incoming evidence (`:9532-9537`): a mismatch **logs and resets**.

In a single pass both fire, with different evidence (`ref|surface` vs whatever the deferred
site passes). Each resets the other's hash. Net effect: both lines print on **every** pass,
`suppressed` never increments, and the 4231-line log keeps growing. C2 becomes a no-op at
best and a state-churn at worst.

**Suggested fix.** Use two distinct kinds (`title-surface-drift` and
`prepared-migration-deferred`), registered in both allowlists; or collapse to a single
call site by deleting the redundant outer `deferred` WARN (the inner one already carries
strictly more information). Add a test asserting N passes ⇒ exactly one WARN line.

### 4. C3's premise "`--refresh` 是纯 tmux 修复（无 cmux IPC）" is false — BLOCKER for the C3 rationale

**Issue.** The entire safety argument for letting `--refresh` through the marker is that it
is tmux-only. It is not:

```
--refresh  →  run_mutator_once refresh refresh_linked_sessions        (:14141-14143)
refresh_linked_sessions → prepare_linked_view_state pre               (:10479)
                        → refresh_linked_sessions_tail                (:10483)
refresh_linked_sessions_tail:
    recover_restored_transactions   (:10486)  ← closes cmux workspaces via close_ledger_workspace_ref (:7673)
    prepare_linked_view_state post  (:10490)  → reconcile_prepared_ledger (:9435)
                                              → rename-workspace / rename-tab / ledger commits
    repair_view_invariants          (:10493)
```

The in-file comment at `:10465` ("tmux-only repair — safe to call from outside cmux") and
the dispatch comment at `:14142` are both stale; the plan inherited them without checking.
`--refresh` under a maintenance marker will destroy and re-create cmux workspaces.

**Why it matters.** The marker is the Lead/founder's "freeze the fleet" signal. Relaxing it
for a path that performs guarded workspace *closes* is a materially different decision from
relaxing it for a tmux `select-window`. It may still be the right decision (the issue asks
for it), but it must be argued on the real behaviour, and the blast radius disclosure in
the PR must say "`--refresh` may close and re-create workspaces while the fleet is parked".

**Suggested fix.** Rewrite the C3 rationale with the real call graph. Either (a) accept the
mutation and justify it by the mutator lease being the actual exclusion, or (b) narrow the
relaxation to a genuinely read-mostly subset (e.g. allow `repair_view_invariants` +
`prepare_linked_view_state` but keep `recover_restored_transactions` behind the marker).
Also fix the two stale comments while you are in there.

### 5. `--refresh` is an automated caller, not "运维手动调用" — HIGH

**Issue.** The plan asserts `--refresh` and `--rebuild-views` are "运维手动调用，正是 marker
在时唯一的出路" (research.md §C). `scripts/restart-services.sh:2698`:

```bash
(sleep 5 && "$sync_script" --refresh >> "/tmp/flywheel-cmux-sync.log" 2>&1) &
```

`trigger_cmux_refresh` (`scripts/restart-services.sh:2692`) runs after every Lead restart.
After C3, any Lead restart during a parked window will fire a full mutating pass — including
the restored-adoption closes from issue #4 — against the fleet the marker was supposed to
freeze. That is a real, undisclosed production behaviour change, and it interacts badly with
acceptance criterion (b), which is *about* a full-fleet restart.

**Suggested fix.** Either keep the marker blocking for automated invocations and add an
explicit operator opt-in (e.g. `--refresh --force-parked`, or a distinct mode string that
`restart-services.sh` does not use), or change `trigger_cmux_refresh` to skip when the
marker is present. Whichever you choose, list `scripts/restart-services.sh:2698` and
`scripts/lib/cmux-mutator-process-census.sh:194` in the consumer sweep (the plan's sweep
list does not name either).

### 6. C3's `maintenance_entry_allowed ops_rebuild` restructure is under-specified and a literal reading of the plan produces broken code — HIGH

**Issue.** The plan says: "把 `marker 在 → return 1` 放宽为 `QA teardown claim 在 → return 1`;
marker 在 + 无 QA claim 时，沿用既有的「自有 ops claim 或无 ops claim」判据." There is no
such existing "自有 ops claim 或无 ops claim" predicate. The actual code
(`:13881-13895`) is:

```bash
elif [[ "$mode" == "ops_rebuild" ]]; then
  if [[ no MARKER && no QA && no OPS ]]; then return 0; fi      # :13882-13886
  [[ no MARKER && no QA ]] || return 1                          # :13887-13888
  _read_ops_rebuild_claim || claim_rc=$?
  [[ claim_rc==0 && -n "$OPS_REBUILD_CLAIM_LINE" && self-published && pid==$$ ]] || return 1
  _ops_claim_owner_matches; return $?
```

The "no ops claim ⇒ allow" case exists **only** inside the first early return, which also
requires no marker. Removing the marker term from the *first* conditional alone still hits
`[[ no MARKER && no QA ]] || return 1` at `:13887` and refuses. Removing it from both leaves
the self-claim requirement reachable only when an ops claim exists — which happens to be
correct, but the plan never says so, and `--rebuild-views --execute` **without**
`--handover` never publishes a claim (`run_rebuild_views:12537-12542`), so the ordering of
the two gates decides whether the common operator invocation works at all.

**Suggested fix.** Specify the target control flow literally:

```
qa_teardown claim present            -> return 1
ops claim absent                     -> return 0     (marker ignored)
ops claim present and self-owned+live-> return 0
otherwise                            -> return 1
```

and cover all four rows in T6, including `--execute` without `--handover` under a marker.
Same for the `refresh` branch: note explicitly that the plan also (silently) relaxes refresh
past a **foreign live ops-rebuild claim**, since `maintenance_requested` (`:13217-13221`)
covers all three files. That is probably fine — `run_mutator_once` acquires the lease first
(`:13975`) and the lease is the real exclusion — but it must be stated, not inferred.

### 7. The new `scripts/__tests__/*.test.sh` is not registered in CI; two guards will fail — HIGH

**Issue.** `scripts/__tests__/ci-shell-suite-enumeration.test.sh:15-40` (FLY-1764)
enumerates every `scripts/__tests__/*.test.sh` and fails any file that appears neither in
`.github/workflows/ci.yml`'s literal `bash scripts/__tests__/... .test.sh` list nor in
`scripts/__tests__/ci-shell-suite-manual-only.txt`. Separately,
`scripts/__tests__/ci-structure.test.sh:1481-1500` pins the FLY-1364 step's run block to an
**exact ordered list** (`expected_fly1364_commands`). The plan's T8 adds
`scripts/__tests__/fly2770-qa-teardown-claim-env.test.sh` and mentions neither file.

**Suggested fix.** Add explicit plan steps: register the suite in `.github/workflows/ci.yml`
(the FLY-1364 cmux step, next to `bash scripts/__tests__/fly2048-cmux-convergence.test.sh`)
**and** in `expected_fly1364_commands` at the matching position. Or fold T8's two static
assertions into `scripts/test-cmux-sync.sh` and add no new file at all — which is what I
would do, since T8 is two `grep`s.

### 8. T8's assertion "`test-teardown.sh` … 不读写 marker" is factually wrong — MEDIUM

**Issue.** `scripts/test-teardown.sh` reads `CMUX_MAINTENANCE_MARKER` at `:441-443`,
`:1261-1263` and `:1284` as a deliberate refusal gate ("refusing teardown" /
"refusing whole teardown"). A test asserting it does not touch the marker will fail, and
should fail — that gate is a safety feature.

Also worth noting: C4 therefore only decouples *half* the coupling. Repointing
`FLYWHEEL_CMUX_QA_TEARDOWN_CLAIM` alone still leaves `test-teardown.sh` refusing whenever
the production marker exists.

**Suggested fix.** Restate T8 as: "with `FLYWHEEL_CMUX_QA_TEARDOWN_CLAIM` set, both scripts
resolve the claim to the custom path; with it unset both resolve to
`${CMUX_MAINTENANCE_MARKER}.qa-teardown`; the marker refusal gate is unchanged."

### 9. C1's predicate is weaker than the FLY-1884 pattern it claims to mirror — MEDIUM

**Issue.** FLY-1884's `__DEFAULT__` branch pins the **exact observed byte string** into
`canonical_raw` (`:8955`) and the guard then re-checks membership in that pinned list. If
the surface flips from `Terminal 65` to `Terminal 66` between the pre-check and the
mutation, the guard refuses.

`_title_surface_migratable` as drafted calls `_workspace_title_is_default "$surface"` in
both the pre-check (`:8193`) and the guard (`:8133`). Any `^Terminal [0-9]+$` satisfies
both, so a surface that was **replaced** between read and mutation is still renamed. The
workspace UUID/ref/generation fences (`:8124-8127`) do not cover surface identity.

**Suggested fix.** Keep the FLY-1884 shape: when the observed surface is a placeholder and
the receipt carries a UUID, append that exact observed string to the variants and keep
`_managed_view_command_in_variants` as the sole matcher. This is also a strictly smaller
diff — for the `"$title")` arm it is a three-line change at `:9037-9046` that mirrors
`:8951-8958` exactly, with no new predicate and no change to the guard at all.

### 10. The plan names two call sites; `complete_title_migration` has four, and two more mutation paths already do what C1 does — MEDIUM

**Issue.** `grep -n complete_title_migration scripts/flywheel-cmux-sync.sh` gives call
sites at `:8722` (`reconcile_workspace_titles`), `:9029` and `:9041`
(`reconcile_prepared_ledger`), `:10292` (`create_workspace_for_window`). The plan discusses
`:8193`/`:8133` and mentions `create_workspace_for_window (10292)` in the exploration, but
never `reconcile_workspace_titles:8722` — which passes `managed_view_command_variants`
output, i.e. the same placeholder-free list, and therefore also changes behaviour.

Relatedly, the plan understates its own supporting precedent. `adopt_birth_candidate:8378`
already issues `rename-tab` against a mismatched surface with **no** command-face proof,
and `_v2_lead_prepare_and_name:5091-5100` does the same for v2 Lead rows. C1 is not a new
authority class; say so.

One field-evidence gap this exposes: `reconcile_workspace_titles` should already have
repaired workspace:451 via `adopt_birth_candidate` (state `prepared` + `birth_owned=1`,
`:8692-8697`). It did not — consistent with `--verify-agent-visible` reporting
`receipt-uuid-unattributable … birth:missing`, i.e. **no birth record exists** for these
workspaces. The plan should explain why (`_cmux_attach_birth_records_uncached:4323-4432`
depends on cmux's persisted `processTitle`), because if birth records are simply stale the
same staleness may affect other assumptions. `title_source_authorized:8240` also refuses
when the view session is absent — which is exactly the `title stock topology proof refused`
line in the issue title — so `reconcile_workspace_titles` is not even reaching these rows
today.

**Suggested fix.** Enumerate all four call sites and state the intended behaviour change at
each. Add one sentence on why birth-record adoption did not already fix this.

### 11. "UUID receipt ⇒ 只可能由本 watcher 的 create 或 birth 记录收编产生" is nearly, but not exactly, true — MEDIUM

**Issue.** Enumerating every 5-field mint:

| site | gate |
|---|---|
| `:10246` `create_workspace_for_window` | UUID from this create's ref diff — unambiguously ours |
| `:8331` `adopt_birth_candidate` | requires `cmux_workspace_birth_record` |
| `:5045` `_v2_lead_prepare_and_name` | requires `cmux_workspace_birth_record` |
| `:5270` / `:10671` (rebind paths) | UUID-fenced |
| `:8384`, `:8220`, `:8189`, `:5296`, `:10681` | commit of an already-UUID-bound prepared row |
| **`:6944` `_ledger_upgrade_legacy_uuid`** (called from `:5077`, `:5103`, `:8359`) | **promotes a 4-field legacy row to a 5-field UUID row** |

Two consequences the plan should acknowledge:

* A "birth record" is derived from cmux's own persisted `processTitle`
  (`:4390-4404`, `:4424-4431`), not from any watcher-side provenance. A workspace whose
  `processTitle` happens to be a managed attach command — e.g. one restored by cmux's own
  session restore, or duplicated in the UI — earns birth authority. In practice it *is*
  a managed view carrier, so the risk is low, but "只可能由本 watcher 产生" overstates it.
* `_ledger_upgrade_legacy_uuid` means the FLY-1884 legacy/UUID boundary is **not**
  permanent: a legacy row minted by `authorize_stock_candidate` (`:8688`, 4-field) over
  founder stock can later be upgraded to a UUID row and thereby gain the new tab-rename
  authority C1 grants. `authorize_stock_candidate:8286-8288` did prove the surface at
  adoption time, so this needs the surface to later regress to a placeholder — narrow, but
  it is a real hole in the "legacy receipts never gain this authority" framing.

Also note `:7649`: the `advance` action mints `committed` with the UUID **dropped**
(4 args). Under C1 that would strip tab-rename authority from the row. It is immediately
followed by a close so it is currently moot — but if you implement the fix for issue #1 by
diverting `advance`, watch this.

**Suggested fix.** Soften the code comment to "a UUID-bound receipt can only be produced by
this watcher's create, by birth-record adoption, or by a birth-proven legacy upgrade —
`authorize_stock_candidate` writes 4-field legacy rows and never gains this authority", and
add a regression asserting a stock-adopted legacy row stays zero-mutation.

### 12. Deploy-time migration churn from pre-existing W1p markers is not disclosed — MEDIUM

**Issue.** `~/.flywheel/state/` currently holds W1p markers (the field log's
`restored adoption minted synthetic committed receipt` lines prove it). On the first
unparked pass after C1 lands, `recover_restored_transactions` runs **before**
`reconcile_prepared_ledger` and will close those workspaces one more time. If C1 has already
committed a receipt when the marker is evaluated, the decision becomes
`W1p:committed:present` with `evidence=drift` → row `16|cas-restore-marker` (`:7534-7538`)
→ the committed row is **demoted back to `prepared`** (`:7245-7252`, UUID preserved) before
the marker is cleared. Convergent, but it means acceptance criterion (a)'s "30 分钟零空壳"
window must not start at t=0 after unparking.

**Suggested fix.** Add an operational note: after the marker is removed, expect one
close/recreate churn per currently-stuck workspace and one prepared→committed→prepared→
committed oscillation; start the 30-minute observation after the marker file
`~/.flywheel/state/cmux-restored*` reaches zero rows.

### 13. Acceptance criteria (b) and (d): no mechanism analysis, and (d) has a hard dependency the plan never mentions — MEDIUM

**Issue (d).** `_verify_sidebar_subject_evidence` fails a target outright when a restored
marker exists: `rule=restored-marker observed=$marker_count` at `:12212-12216`. So
`--verify-agent-visible status=pass` for the three Codex-carrier Leads **requires the W1p
markers to be gone**, which is issue #1's territory. It also requires `rule=render`
(`cmux read-screen` non-empty, `:12180-12196`), `rule=client-count >= 1` (`:12171-12178`),
`rule=a1-topology` (`_linked_view_matches`, `:12152-12158`) and `rule=receipt == committed`
with exactly one ledger row (`:12202-12206`). Only the last of those is addressed by C1.
`receipt-uuid-unattributable` is a WARN, not a failure (`:12207`), so `birth:missing` alone
will not block — worth saying explicitly, because the field table lists it as a reason.

**Issue (b).** Nothing in C1–C4 touches attach/client recovery. The mechanism that restores
`list-clients == 1` is `self_heal_sweep_all` (`:11623`) plus the create-time verify loop
(`:10310-10320`), both of which run in the normal additive pass — i.e. (b) follows from
"watcher is healthy again", which follows from C1. That chain is plausible but the plan
asserts it with no analysis, and issue #5 above means the post-restart `--refresh` now
behaves differently too.

**Suggested fix.** Add a short "how each acceptance criterion is reached" table mapping
(a)–(d) to the specific function that delivers it, and call out the `restored-marker` rule
as a hard prerequisite for (d).

### 14. Test plan does not exercise the actual loop — MEDIUM

**Issue.** T1–T3 drive `reconcile_prepared_ledger` in isolation — that is the right unit
shape and matches the FLY-1884 fixtures, so keep them. But T4 ("让 rename-tab 持续失败 →
多轮只落一条 WARN … 且不触发任何 `new-workspace`") cannot prove its second clause: nothing
in `reconcile_prepared_ledger` ever calls `new-workspace`. The recreate comes from
`adopt_restored_workspaces` → `recover_restored_transactions` → close, then
`create_workspace_for_window` on the following pass. T4 as written will pass vacuously
while the production loop continues.

**Suggested fix.** Add T4b: fixture with a UUID prepared row, placeholder surface, a live
source window, `restored_adoption_enabled` on, and a `rename-tab` mock that always fails;
run `adopt_restored_workspaces live` then `recover_restored_transactions` then
`reconcile_prepared_ledger` for ≥3 rounds; assert zero `close-workspace`, zero
`new-workspace`, and exactly one WARN. That test is the whole point of the issue.

### 15. Minor — LOW

* **Line-number drift** (harmless but check before quoting in the PR):
  `reconcile_prepared_ledger` is `:8881` not 8880; `log_cmux_episode` `:9497` not 9496;
  `maintenance_entry_allowed` `:13878` not 13877; `watcher_maintenance_checkpoint` `:13914`
  not 13913; `authorize_stock_candidate`'s legacy mint is `:8688` not 8695;
  `create_workspace_for_window`'s prepared mint is `:10246` not 10247.
  `research.md` §A cites `test_fly1884_uuid_default_title_recovers_both_faces`; the real
  name is `test_fly1884_prepared_default_title_recovers_with_uuid_receipt`
  (`scripts/test-cmux-sync.sh:6619`).
* **C3 park/lease race.** The plan says "park 的 watcher 已释放 lease，所以不冲突". True only
  *after* the watcher reaches `watcher_maintenance_checkpoint` (`:13914`). Between marker
  creation and the next checkpoint the watcher still holds the lease, so `--refresh` fails
  at `acquire_mutator_lease` and `run_mutator_once` logs "mutator already running; skipping"
  and returns 0 (`:13975-13986`). Fail-closed and safe — but say that the **lease**, not
  the marker, is the exclusion, because that is the actual invariant C3 relies on.
* **C4 footgun.** After C4 the QA claim path is only shared if **both** `test-teardown.sh`
  and `flywheel-cmux-sync.sh` see the same `FLYWHEEL_CMUX_QA_TEARDOWN_CLAIM`. Combined with
  C3 (where the QA claim becomes the *only* thing blocking refresh/ops_rebuild), a one-sided
  env means refresh/rebuild can run **during** a teardown. Document that the env must be
  exported to both, and keep the derived default.
* **C4 existing consumers** not listed in the sweep:
  `scripts/__tests__/fly2048-cmux-convergence.test.sh:13` (exports the internal name
  `CMUX_QA_TEARDOWN_CLAIM`, which is and remains ineffective) and
  `scripts/__tests__/test-teardown-lease-contract.test.sh:256`.

## Answers to the seven targeted questions

**Q1 — Does C1 alone break the loop?**
Partially. See issue #1 for the full path table. Only one path can recycle a healthy
workspace here: `adopt_restored_workspaces live` → W1p marker (`:7759`, `:7767`) →
`_restored_recovery_decision` row 13 `advance` (`:7530`) → `_ledger_upsert committed` with
the UUID dropped (`:7649`) → `close_ledger_workspace_ref` (`:7673`). Its probe predicate is
`[[ "$surface" != "$title" && "$surface" != "$raw_title" ]]` (`:7411-7413`) — i.e. it fires
*because* the tab is still `Terminal N`. Prepared-stall absent/drift/authority counters,
`close_prepared_loser_ref`, `rollback_unreceipted_workspace`, `cleanup_stale_workspaces` and
conservative cleanup are all inapplicable to this state (table in issue #1). C1 removes the
trigger **only when the rename succeeds**: the commit at `:10292` or `:9041` flips
`ledger_candidate_receipt_state` to `committed`, so `adopt` hits `live:committed → continue`
(`:7761`) and never mints a marker. If the rename fails once, a marker is minted in the same
pass, and thereafter `complete_title_migration` short-circuits at `:8145-8150` and
`reconcile_prepared_ledger` `continue`s at `:8905-8910` — C1 can never run again for that
row, and the close is guaranteed. Pass ordering (`:11565-11605`) is
recover → reconcile → adopt → create, which is what makes the happy path work and the
failure path fatal.

**Q2 — Is the UUID receipt a sound ownership proof for a `Terminal N` tab?**
Sound enough, but the plan's phrasing overstates it. Every 5-field mint is enumerated in
issue #11. The two non-create mints (`:8331` `adopt_birth_candidate`, `:5045`
`_v2_lead_prepare_and_name`) gate on `cmux_workspace_birth_record`, which is derived from
cmux's persisted `processTitle` parsing as a managed attach command
(`:4390-4404`) — that is evidence of *carrier shape*, not of watcher provenance, so a
hand-made or cmux-restored workspace carrying the managed attach command would qualify.
`authorize_stock_candidate` (founder stock) writes 4-field legacy rows (`:8688`) and never
qualifies — the plan is right about that. But `_ledger_upgrade_legacy_uuid` (`:6944`,
called from `:5077`, `:5103`, `:8359`) can promote a legacy row to UUID once a birth record
appears, so the legacy/UUID boundary is not one-way. Independently: the repo **already**
renames a mismatched surface on birth evidence alone (`adopt_birth_candidate:8378`), so C1
grants no authority class that does not already exist.

**Q3 — Is `_GUARD_TITLE_UUID` set before `_title_tab_rename_guard` runs? Other callers?**
Yes, and no. `_GUARD_TITLE_UUID="$workspace_uuid"` at `:8202`, immediately before
`cmux_call_guarded _title_tab_rename_guard rename-tab ...` at `:8203`. `grep -n
_title_tab_rename_guard` returns exactly `:8116` (definition) and `:8203` (sole call). The
plan's claim is correct. The globals are never reset on `complete_title_migration`'s early
returns, but since the only reader is the guard invoked one line after assignment, that is
not exploitable.

**Q4 — Does `mutator_lease_owned_by_self` / the closed allowlist make C2 a no-op?**
Not a no-op. `complete_title_migration`'s four call sites (`:8722`, `:9029`, `:9041`,
`:10292`) are all inside `reconcile_workspace_titles` / `reconcile_prepared_ledger` /
`create_workspace_for_window`, and `reconcile_prepared_ledger`'s two callers
(`:2581` `reap_ghost_workspaces`, `:9435` `prepare_linked_view_state post`) are reached only
from `sync_additive` / `sync_bootstrap` / `sync_once` / `refresh_linked_sessions`, all of
which hold the lease via `run_mutator_once` (`:13975`) or `acquire_watcher_lock`. The
read-only surfaces (`--verify-agent-visible`, `--verify-sidebar`, `--list-*`,
`--probe-lease`) never reach `complete_title_migration`. So the drift WARN is always on a
lease-holding path and `log_cmux_episode` will take the suppression branch.
**But** C2 is still broken for two other reasons: the missing `:9469` allowlist entry
(issue #2) and the `(kind, title)` key collision between the two messages (issue #3). Also
note the degraded case: if the lease is lost mid-pass (`WATCHER_AUTHORITY_LOST`),
`log_cmux_episode` falls through to plain `log` (`:9513-9516`) — acceptable, but it means
"exactly one WARN" is not an unconditional guarantee and T4 should not assert it as one.

**Q5 — Does C3 open a real safety hole?**
Three findings.
*(a) Lease release is not guaranteed at marker-creation time.* The watcher releases the
lease only when it reaches `watcher_maintenance_checkpoint` (`:13925-13932`). In the window
between the Lead touching the marker and that checkpoint, `--refresh` / `--rebuild-views`
lose the `acquire_mutator_lease` race and `run_mutator_once` logs "mutator already running
… skipping" and returns 0 (`:13975-13986`). Fail-closed — no concurrent-mutator hole. The
correct statement of the invariant is "the lease excludes", not "the parked watcher has
released the lease".
*(b) QA teardown exclusivity survives.* C3 keeps the QA claim blocking both modes, and
`test-teardown.sh` holds the same incarnation-bound lease for its whole run
(`scripts/test-teardown.sh:44-46`), plus refuses outright when the marker is present
(`:441`, `:1261`). `_reap_stale_qa_teardown_claim` / `_reap_stale_ops_rebuild_claim`
(`:13566`, `:13731`) are PID+incarnation+flock gated and need two observations, so a live
claim is not reapable. `maintenance_requested` (`:13217`) is unchanged, so the watcher's
own park loop still parks on marker **or** either claim — including the new ops claim
published while the marker is present. No invariant broken there.
*(c) The real hole is behavioural, not concurrency.* `--refresh` closes and re-creates cmux
workspaces (issue #4) and is fired automatically by `scripts/restart-services.sh:2698`
(issue #5). C3 therefore converts "marker = fleet frozen" into "marker = watcher paused,
but a Lead restart will still reshape the fleet". That needs an explicit decision and an
explicit disclosure, and the `maintenance_entry_allowed` restructure needs to be specified
literally (issue #6).

**Q6 — Anything missing that the issue requires?**
Yes.
* **(c) is not delivered at all** — see Q1/issue #1. "Rename fails → no re-create" is
  asserted, not implemented, and T4 cannot detect its absence (issue #14).
* **(d) has an undisclosed hard dependency**: `--verify-agent-visible` fails on
  `rule=restored-marker` whenever a W1p marker exists (`:12212-12216`), so (d) is gated on
  the same fix as (c). It also needs `rule=render` (non-empty `read-screen`, `:12180`),
  `rule=client-count >= 1` (`:12171`) and `rule=a1-topology` (`:12152`) — none of which
  C1–C4 touch. `receipt-uuid-unattributable` is only a WARN (`:12207`), so `birth:missing`
  will not block; say so, since the field table lists it as a reason.
* **(b)** plausibly follows from a healthy watcher via `self_heal_sweep_all` (`:11623`) and
  the create-time verify/retry loop (`:10310-10320`), but the plan never names the
  mechanism, and issue #5 changes what happens on restart.
* **(a)** needs the deploy-churn caveat from issue #12.
* **CI registration** for the new suite (issue #7) and the consumer sweep entries
  (issues #5, #15) are missing procedural steps.

**Q7 — Over-engineered or out of scope?**
Nothing violates the forbidden list: FLY-913 guardrails, `~/.flywheel/state/cmux-maintenance`
itself, and launchctl are all untouched. Scope concerns run the other way — the plan is
under-scoped for the issue's acceptance criteria (Q6). Two trims I would make:
* **C1 is bigger than it needs to be.** Putting the predicate inside
  `complete_title_migration` changes all four call sites at once. The minimal fix that
  covers the observed bug is three lines in the `"$title")` arm (`:9037-9046`) mirroring
  `:8951-8958` — append the observed placeholder to `canonical_raw` when
  `_workspace_uuid_valid "$workspace_uuid"`. That keeps the exact-string pinning (issue #9),
  needs no guard change, and reuses the FLY-1884 shape verbatim. If you also want the
  create path to commit immediately, do the same at `:10292` by passing
  `"$attach_cmd"$'\n'"$observed_surface"` — still no new predicate.
* **T8's standalone `.test.sh` is not worth its CI-registration cost.** Fold its two static
  assertions into `scripts/test-cmux-sync.sh` and drop the new file (issue #7).

## Verdict

**CHANGES REQUESTED.** The diagnosis is right and C1's authority boundary is the correct
one, but the plan cannot ship as written: it mis-identifies the recycler and therefore
leaves the issue's negative acceptance criterion unimplemented (issue #1), C2 will corrupt
the shared episode state and will not actually suppress anything (issues #2, #3), C3's
safety rationale rests on a factually wrong claim about `--refresh` and misses an automated
caller (issues #4, #5, #6), and the CI registration for the new suite is missing (issue #7).
Address issues #1–#7 and re-submit; #8–#15 should be folded in at the same time.
