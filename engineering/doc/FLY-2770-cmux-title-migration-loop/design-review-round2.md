# Design Review — FLY-2770 plan.md (Round 2)

Date: 2026-09-22
Author: Independent Claude reviewer (same reviewer identity as round 1; no memory carried over —
round 1 re-read from `/tmp/fly2770-design-review-round1.md`)
Reviewing: `engineering/doc/FLY-2770-cmux-title-migration-loop/plan.md` (v2)
Status: **CHANGES REQUESTED**

## Summary

v2 is a large, genuine improvement. I re-verified every round-1 finding against the source and
all fifteen were addressed in substance, not just in prose. Three things in particular are now
right and were not before:

* **The recycler is correctly identified.** The mermaid chain
  (`:7759` → `:7411` → `:7767` → `:8145` → `:7530` → `:7649` → `:7673`) matches the code
  line for line. I re-ran the round-1 destroy-path table against v2 (Q1 below) and found no
  additional closer.
* **C1's exact-byte pinning genuinely works.** I chased the fallback I was worried about:
  `_managed_view_command_in_variants` (`scripts/flywheel-cmux-sync.sh:4270`) falls through to
  `_cmux_carrier_classify equivalent` (`:4116`, `:4172-4181`), whose `identity()` returns
  `None` for `Terminal 66` (shlex → 2 words, no branch matches), so a swapped placeholder is
  refused. T4 is sound. Pinning inside `complete_title_migration` is also safe: `canonical_raw`
  is a positional local (`:8143`) so no caller sees the mutation, and `_GUARD_TITLE_RAW="$canonical_raw"`
  at `:8201` is unconditionally after the `:8193-8197` block on the single reachable path.
* **C3's rationale is now built on the real call graph** and the lease-vs-marker invariant is
  stated correctly.

But v2 is still not ready, for four independent reasons:

1. **C1b's insertion point changes four call sites the plan never mentions.**
   `_restored_candidate_probe` has **five** production callers, not one. The plan describes C1b
   as "不再铸 W1p marker", but `:7411` is shared by the close guard (`:7453`), the recovery
   evidence read (`:7599`), the minting site (`:7764`), and the ops-rebuild adoption path
   (`:12387`, `:12398`). One of those consequences is bad: `--rebuild-views --execute` — the
   operator exit the plan leans on for acceptance (d) — now **fails** on exactly the three
   Codex-carrier Leads it is meant to repair. (Issue 1.)
2. **C2 does not suppress the WARN that actually repeats on the negative-acceptance path**, so
   T5's "恰一条 WARN" assertion is unachievable as written. Under C1, `:8194`
   (`title-surface-drift`) becomes *unreachable* for the UUID+placeholder case; the line that
   repeats is `WARN: guarded rename-tab deferred` at `:8205`, which C2 does not touch.
   (Issue 2.)
3. **The post-deploy convergence section is factually wrong**, in the *opposite* direction from
   v1's errors: with C1b at the probe, pre-existing W1p markers take `14|marker-delete`
   (`:7522`), not `13|advance` → close. There is no churn. Shipping that paragraph in the PR
   body would send the operator looking for an event that cannot happen. (Issue 3.)
4. **C3a's literal control flow is not implementable as "只摘掉 marker 这一项" for the `refresh`
   branch** — `refresh` has no branch of its own; it falls into the shared `else` at `:13895`
   that also serves `once`, `reaper`, `qa_teardown` and every other mode. And C3b's relaxation
   of `publish_ops_rebuild_claim` silently un-gates **`--converge-runners`**, which is far more
   destructive than the two commands named in the disclosure. (Issues 4, 5.)

## What's Good (Keep)

* **Every round-1 line-number correction landed and I re-verified the new ones.**
  `:9469` + `:9509` are both real and identical (`_cmux_log_episode_state_valid` validator +
  `log_cmux_episode` dispatch gate); `:7411-7413` is exactly the `surface != title` W1p
  predicate; `:13878` is `maintenance_entry_allowed`; `scripts/flywheel-cmux-sync.sh:116` and
  `scripts/test-teardown.sh:50` are the two `CMUX_QA_TEARDOWN_CLAIM` derivations.
* **Choosing `return 1` (not 2) in C1b is correct** and the plan is right not to belabour it.
  rc=1 maps to `evidence=drift` at `:7599-7600`, which is a *conclusive* observation;
  rc=2 would map to `inconclusive` → `0|quarantine` (`:7477-7480`), i.e. a WARN every pass with
  the marker preserved forever. rc=1 is the only choice that converges.
* **`ledger_exact_receipt_uuid` is safe to call from the probe.** It is defined at `:8095`,
  *after* the probe at `:7356`, but Bash resolves at call time and the probe already calls
  peers from the same family (`ledger_candidate_receipt_state` is used by the probe's callers).
  It is a pure `awk` read with no lease requirement, returns rc=1 when there is no unique
  prepared/committed row, and the plan's `2>/dev/null || true` handles that.
* **C1b's variables are all in scope at `:7413`.** `kind`/`generation`/`ref`/`title` are
  positional params (`:7357`); `surface` is assigned at `:7383`; `raw_title` at `:7369-7375`.
  The probe has already proven `candidate_count == 1`, `candidate_ref == ref` and
  `current == generation` before that point, so the ledger read is against a proven tuple.
* **Two of the three "would the fix strand something" worries are answered by the code, in the
  fix's favour.** (a) `--refresh` does **not** call `adopt_restored_workspaces` — the mint sites
  are `sync_additive:11601` / `sync_bootstrap:11496` only — so the parked-fleet operator command
  runs recover→reconcile with no new markers. That is a *stronger* argument for C3 than the plan
  makes. (b) Pre-existing markers self-clear (issue 3).
* **The acceptance-criteria → mechanism table is the right artifact** and (d)'s `rule=restored-marker`
  hard prerequisite (`:12212-12216`) is correctly identified, as is the `receipt-uuid-unattributable`
  WARN-not-FAIL distinction (`:12207`).
* **Dropping the standalone `.test.sh`** removes the FLY-1764 / FLY-1364 registration cost, and
  there is precedent for static sibling-script assertions inside `scripts/test-cmux-sync.sh`
  (`:8764` sed-extracts `test-teardown.sh`).
* **The blast-radius / acceptance-boundary disclosure sections survive** and are honest.

## Issues & Recommendations

### 1. C1b is written as a change to one predicate, but `_restored_candidate_probe` has five production callers — and one of them breaks the operator exit for acceptance (d) — BLOCKER

**Issue.** The plan says "C1b —— 迁移待完成的行不再铸 W1p marker" and patches
`_restored_candidate_probe` at `:7411-7413`. But `grep -n _restored_candidate_probe
scripts/flywheel-cmux-sync.sh` returns five production call sites:

| site | function | effect of C1b's `return 1` | in plan? |
|---|---|---|---|
| `:7453` | `_restored_final_close_guard` | close guard refuses → `close_ledger_workspace_ref` aborts. Extra safety net. | no |
| `:7599` | `recover_restored_transactions` | `evidence=drift` → `W1p:prepared:present` takes `14|marker-delete` (`:7522`) instead of `13|advance`. **This is what actually retracts pre-existing markers** (see issue 3). | no |
| `:7764` | `adopt_restored_workspaces` | `probe_rc != 0` → `continue` at `:7765`, no marker minted. | **yes — the only one described** |
| `:12387` | `_ops_adopt_restored_candidate` (first probe) | `return 1` → the ops-rebuild target fails. | no |
| `:12398` | `_ops_adopt_restored_candidate` (second/stability probe) | same | no |

The `:12387` consequence is the damaging one. `resolve_rebuild_targets` classifies a row as
`W1p` purely from `receipt state == prepared` plus one live source window
(`scripts/flywheel-cmux-sync.sh:11937`: `prepared) [[ "$live_count" == 1 ]] || return 1; class=W1p ;;`)
— **the surface is not consulted**. So the three stuck Codex-carrier Leads classify as `W1p`,
`execute_ops_rebuild_targets` takes the `W1|W1p|W1dead)` arm at `:12460-12464`, calls
`_ops_adopt_restored_candidate W1p … prepared`, the probe returns 1, `rc=1`, the target is
recorded FAILED, and the `rc -eq 0` guard at `:12473` also suppresses the follow-up
`create_workspace_for_window`. Net: after C1b, **`--rebuild-views --execute` can no longer
repair exactly the rows this issue is about.**

That directly contradicts the plan's own acceptance table, which says for (d): "C3 让
`--rebuild-views` 在 park 时可用是操作出口". The operator exit becomes `--refresh` (which does
work — it runs `recover_restored_transactions` at `:10486` then `reconcile_prepared_ledger`
via `prepare_linked_view_state post` at `:10490`/`:9434`, and never mints a marker), but the
plan does not say that and C3's whole framing points at `--rebuild-views`.

**Why it matters.** This is the same class of error as round-1 issue #10 — a shared helper
edited as if it had one caller — and this time it silently removes a recovery capability while
the PR claims to add one.

**Suggested fix.** Keep the probe-level placement (it is the better design — it is what gives
you the free pre-existing-marker retraction in issue 3), but:
1. Enumerate all five call sites in the plan with the intended behaviour at each, as C1 now
   does for its four.
2. Decide explicitly what `--rebuild-views` should do for a `W1p` target whose receipt is
   UUID-bound and whose surface is a placeholder. My recommendation: teach
   `execute_ops_rebuild_targets`'s `W1p` arm to fall through to a title-migration completion
   (i.e. `reconcile_prepared_ledger` or a scoped `complete_title_migration`) instead of
   adoption, so the ops path converges the same way the watcher does. Minimum acceptable:
   state in the PR body that `--refresh`, not `--rebuild-views`, is the parked-fleet exit for
   these rows, and fix the acceptance table.
3. Add a test for the `--rebuild-views` W1p path (the harness already drives
   `_ops_adopt_restored_candidate` at `scripts/test-cmux-sync.sh:7949`).

### 2. C2 suppresses the wrong WARN; under C1 the `title-surface-drift` kind is nearly unreachable and T5's "exactly one WARN" cannot pass — HIGH

**Issue.** Trace the forced-failure scenario T5 describes (UUID prepared row, placeholder
surface, live source, `rename-tab` always fails):

1. `reconcile_prepared_ledger` `"$title")` arm (`:9036-9046`) → `complete_title_migration`.
2. Inside, **C1's new branch fires**: `workspace_uuid` is non-empty and `_workspace_title_is_default
   "$surface"` is true, so `canonical_raw` gets the placeholder appended and the
   `log_cmux_episode title-surface-drift` line at `:8194` is **not reached**.
3. `cmux_call_guarded _title_tab_rename_guard rename-tab …` (`:8203`) fails →
   `log "WARN: guarded rename-tab deferred ref=$ref title=$title"` at **`:8205`** — a plain
   `log`, which C2 does not touch. (If the mutation "succeeds" without effect instead, you get
   `:8211` `WARN: rename-tab readback mismatch …` — also plain `log`.)
4. Back in the caller, `log "WARN: prepared title migration deferred …"` at `:9042` — this one
   *is* routed through C2's `prepared-migration-deferred`.

So per pass the log gains **two** WARN lines, one of which is unsuppressed. T5 asserts "恰一条
WARN" over three rounds; it will see 1 (suppressed deferred) + 3 (`:8205`) = 4.

Worse, C2's `title-surface-drift` kind now only fires for the cases C1 *doesn't* cover
(legacy receipt, or genuinely foreign surface) — which are already rare and already
prepared-stall-counted. C2 as specified de-noises a line that C1 just made unreachable, and
leaves the line C1 creates un-de-noised.

**Suggested fix.** Route `:8205` (and `:8211`) through `log_cmux_episode` as well. Since both
already carry `ref`/`title`, a single kind — e.g. `title-rename-deferred`, evidence
`ref|surface` — covers them. Keep `title-surface-drift` for the legacy/foreign case (it is
still correct, just rarer). Register all three new kinds in **both** `:9469` and `:9509`.
Then T5's assertion becomes achievable and should be stated as "exactly one WARN **per kind**",
not "exactly one WARN".

Note also the plan already correctly caveats that `log_cmux_episode` degrades to plain `log`
when the lease is lost (`:9513-9516`); T5 holds the lease via `test_ensure_mutator_lease`, so
that is not a problem for the test.

### 3. The "部署后的收敛说明" is factually wrong — with C1b at the probe there is no close/recreate churn — MEDIUM (but it ships in the PR body)

**Issue.** The plan says:

> `recover_restored_transactions` 在每轮里跑在 `reconcile_prepared_ledger` **之前**,
> 所以摘标记后的第一轮,每个当前卡住的 workspace 仍会被关掉重建一次

That was true for a C1b that only stopped *minting*. It is not true for C1b at the probe. On
the first unparked pass:

* `refresh_linked_sessions_tail:10486` → `recover_restored_transactions`;
* `:7594-7600`: `relation=current`, `presence=present`, `flag=on` → probe called with the stored
  fingerprint → **C1b returns 1** → `evidence=drift`;
* `_restored_recovery_decision current W1p prepared present on drift ready` →
  `14|marker-delete` (`:7522`), **not** `13|advance` (`:7526`);
* marker removed, **no `advance`, no `close`**;
* the same `refresh_linked_sessions_tail` then runs `prepare_linked_view_state post` →
  `reconcile_prepared_ledger` (`:10490` → `:9434`), where `restored_inflight_state` (`:8903`)
  now passes because the marker is gone, and C1 renames + commits.

Convergence is **one pass, zero churn**. (Even if the stored fingerprint no longer matches, the
final `[[ -z "$expected" || … ]]` at `:7420` also yields rc=1 → same `marker-delete`.)

**Why it matters.** The PR body would instruct the operator to wait for
`~/.flywheel/state/cmux-restored*` to hit zero *through a close/recreate cycle* and to expect a
`prepared→committed→prepared` oscillation. Neither happens. An operator who sees markers vanish
with no close will reasonably conclude the fix did not run.

**Suggested fix.** Rewrite the section: "pre-existing W1p markers are retracted (not advanced)
on the first pass via decision row 14; expect zero closes and zero re-creates; the 30-minute
window can start immediately after the first pass completes." Add this as an explicit assertion
in a test (seed a W1p marker with a UUID prepared row, run `recover_restored_transactions`,
assert marker gone + zero `close-workspace` + ledger row untouched). That test is cheap and it
is the one that proves the deploy story.

### 4. C3a's `refresh` branch cannot be implemented by "只摘掉 marker 这一项"; `refresh` has no branch of its own — HIGH

**Issue.** `maintenance_entry_allowed` (`:13877-13911`) has exactly three arms:

```bash
if   [[ "$mode" == "watch" ]];        then  … marker only …           # :13880-13881
elif [[ "$mode" == "ops_rebuild" ]];  then  … three-file logic …      # :13882-13894
else  maintenance_requested || return 0                               # :13895
fi
```

`refresh` falls into the `else`. So does `once` (`:14152`), `reaper` (`:14170`), and any future
mode. `maintenance_requested` (`:13217-13221`) is marker **or** QA claim **or** ops claim.
"Removing the marker term" from that `else` would relax **every** non-watch, non-ops_rebuild
mode — including `--once`, which is a full `sync_once` pass. The plan explicitly promises
"`watch` / `once` / `reaper` / `qa_teardown` 等其余 mode **一律不变**", so the implementation
must introduce a dedicated `elif [[ "$mode" == "refresh" ]]` arm. The plan never says this, and
a literal reading of "只摘掉 marker 这一项" produces the forbidden behaviour — the same failure
mode as round-1 issue #6.

The `ops_rebuild` half **is** implementable exactly as written: deleting the two
`CMUX_MAINTENANCE_MARKER` terms from `:13883-13886` and `:13887-13888` produces precisely the
plan's four-row table, including the "`ops claim 不在` → 0" row that covers
`--rebuild-views --execute` without `--handover` (which never publishes a claim). Verified
against `_read_ops_rebuild_claim` / `_ops_claim_owner_matches` (`:13489-13505`). Good.

And yes — the plan's "refresh: ops claim 在 → 1" **is** faithful to today. Today
`maintenance_requested` is true whenever `CMUX_OPS_REBUILD_CLAIM` exists, so `refresh` returns
1; the new explicit rule reproduces that exactly.

**Suggested fix.** State the target as a new arm:

```bash
elif [[ "$mode" == "refresh" ]]; then
  [[ ! -e "$CMUX_QA_TEARDOWN_CLAIM" && ! -L "$CMUX_QA_TEARDOWN_CLAIM" \
     && ! -e "$CMUX_OPS_REBUILD_CLAIM" && ! -L "$CMUX_OPS_REBUILD_CLAIM" ]] || return 1
  return 0
```

and add a T8 row asserting that `once` / `reaper` / `watch` still refuse under a bare marker
(the regression that a shared-`else` edit would break).

### 5. C3b silently un-gates `--converge-runners`, which the blast-radius disclosure does not name — HIGH

**Issue.** The disclosure says "park 期间运维手动 `--refresh` / `--rebuild-views` **会**关闭并
重建 cmux workspace". But `publish_ops_rebuild_claim` (`:13500-13503`) is *also* the first gate
of `run_converge_runners` (`:12604`), which then calls `maintenance_entry_allowed ops_rebuild`
at `:12627`. Today, a marker makes `publish_ops_rebuild_claim` return 1 and convergence exits
with `ERROR: unable to publish runner-convergence handover claim`. After C3b + C3a it publishes,
passes `maintenance_entry_allowed`, and runs the full convergence — `advance_attach_reap_state`,
two rounds of runner reconciliation, helper reaping — against a fleet the founder deliberately
froze.

`--converge-runners --handover` is the most destructive entry point in this script (it is the
one the error messages elsewhere recommend as "full cleanup", `:14109`, `:13984`). Relaxing it
may still be the right call, but it must be a stated decision, not a side effect of C3b.

**Suggested fix.** Add `--converge-runners` to the C3 scope table and the PR-body disclosure,
or scope C3b narrowly (e.g. `publish_ops_rebuild_claim` gains a `--allow-parked` parameter that
only `run_rebuild_views` passes). Either way, add a truth-table row for it in T10.

### 6. C1's four-call-site table is wrong at `:9029` — the `__NULL__` sub-case does gain new authority — MEDIUM

**Issue.** The table says `:9029` is "不变（`__DEFAULT__` 已自带）". That is true for
`__DEFAULT__` and `__PROVISIONAL__`, both of which append `$observed` to `canonical_raw`
(`:8951-8958`). It is **not** true for `__NULL__`: that case leaves `canonical_raw="$provisional"`
(`:8945`) with nothing appended. `__NULL__` means the *workspace* title is empty/`~`; after the
guarded `rename-workspace` at `:8962-8963` the *tab* surface can perfectly well still read
`Terminal N`, and under C1 that tab rename now proceeds where today it is refused at `:8193`.

That is probably the behaviour you want (it is the same recovery), but the table as written
tells a reviewer no behaviour changes there, which is false.

**Suggested fix.** Split the `:9029` row into `__NULL__` (behaviour changes: placeholder tab now
migratable after the workspace rename) and `__PROVISIONAL__`/`__DEFAULT__` (unchanged). Add a
T-row for `__NULL__` + placeholder surface + UUID receipt.

### 7. C3c: `restart-services.sh` has no knowledge of the marker today, and step 2 of `trigger_cmux_refresh` is not covered — MEDIUM

**Issue.** `grep -n CMUX_MAINTENANCE_MARKER scripts/restart-services.sh` returns **nothing**.
C3c therefore introduces a *third* independent derivation of the marker path (after
`scripts/flywheel-cmux-sync.sh:114` and `scripts/test-teardown.sh:49`), and the plan does not
say how. It must be `${FLYWHEEL_CMUX_MAINTENANCE_MARKER:-$HOME/.flywheel/state/cmux-maintenance}`
to stay consistent with the override env both other scripts honour — otherwise every
marker-path test fixture in the repo will diverge from production for this one caller.

Separately, `trigger_cmux_refresh` has **two** steps. The plan gates only step 1 (`--refresh`,
`:2698`). Step 2 (`:2704-2728`) calls `"$sync_script" --list-lead-refs` and then
`cmux refresh-surfaces --workspace <ref>` per Lead — real cmux IPC against a parked fleet. It is
cache invalidation rather than mutation so the risk is low, but if the point of C3c is "a Lead
restart must not reshape a parked fleet", it should skip both.

**Suggested fix.** Specify the derivation literally, extract it once (or set it from the
existing env with the same default), and gate the whole `trigger_cmux_refresh` body, logging one
line. Consider factoring the marker path into `scripts/lib/` rather than adding a third copy.

### 8. T12 cannot live in `scripts/test-cmux-sync.sh` as a behavioural test — MEDIUM

**Issue.** The plan says "全部落在 `scripts/test-cmux-sync.sh`". `trigger_cmux_refresh` lives in
`scripts/restart-services.sh`, which has **no** `[[ "${BASH_SOURCE[0]}" != "${0}" ]] && return`
sourcing guard (its only `BASH_SOURCE` use is at `:3133`, unrelated), so
`test-cmux-sync.sh` cannot source it without executing the script.

Two workable options, both already in the repo:
* a **static** assertion in `test-cmux-sync.sh` using the `sed`-extract pattern at `:8764`
  (which is how `test-teardown.sh`'s owner-mode case is already pinned) — cheap, but only proves
  the text, not the behaviour; or
* a **behavioural** test in the already-CI-registered
  `scripts/__tests__/restart-services-admission-pause.test.sh`, which avoids the FLY-1764
  enumeration cost the plan is (correctly) trying to dodge.

The same question applies to T11's `test-teardown.sh` half.

**Suggested fix.** Name the host file and the assertion style for T11 and T12 explicitly. I'd
put T12 in `restart-services-admission-pause.test.sh` (behavioural) and keep T11's
`test-teardown.sh` half as the static `sed`-extract.

### 9. "只告警一次" lands in a log file; a permanently-stuck row now never recycles *and* never escalates — MEDIUM

**Issue.** C1b's stated cost — "一个 UUID 绑定的 prepared 行如果 `rename-tab` 永久失败,将永远
停在 prepared 而不再被回收" — is understated. Confirm the row really is immortal: in the
`"$title")` arm the drift counter is explicitly cleared (`:9037`), the absent counter is cleared
at `:8945` because the ref is present, and the authority counter is only observed from the
`__NULL__/__PROVISIONAL__/__DEFAULT__` arm. So none of the three prepared-stall GC paths
(`:8969-8988`, `:9048-9068`, `:9007-9021`) can ever reach it. The only signal is a WARN in
`/tmp/flywheel-cmux-sync.log`, suppressed to once an hour by C2.

This is a strictly better failure mode than close+recreate, and it satisfies acceptance (c) as
literally worded. But "the fleet silently carries a permanently broken Lead and the only
evidence is an hourly log line" is not an operable end state, and this script has a real alert
channel it uses for exactly this shape elsewhere (`_alert_cmux_cleanup` at `:9012`, `:9060`).

**Suggested fix.** After N consecutive deferrals (reuse `_prepared_stall_observe` with a new
`migration` counter, or the episode's own `suppressed` count), escalate once through
`_alert_cmux_cleanup` with a `cmux_cleanup|title-migration-stuck|…` signature. Keep the
never-close behaviour. One extra test row.

### 10. Minor — LOW

* **Line drift in the C3 call graph.** Real lines: `refresh_linked_sessions()` `:10464`
  (stale comment `:10465-10466`), `prepare_linked_view_state pre` `:10478`,
  `refresh_linked_sessions_tail` `:10482` / def `:10485`, `recover_restored_transactions`
  `:10486`, `prepare_linked_view_state post` `:10490`, `repair_view_invariants` `:10494`,
  `reconcile_prepared_ledger` inside `prepare_linked_view_state` `:9434`. The plan's `:10479`
  / `:10483` / `:10493` are each off by one. `publish_ops_rebuild_claim` is `:13500`, not 13501.
  `close_ledger_workspace_ref` in `recover_restored_transactions` is `:7674`.
* **C1b's `local pending_uuid` inside the `if`.** Legal, but every other local in
  `_restored_candidate_probe` is declared in the two `local` lines at `:7358-7360`. Match the
  house style — it also matters because this function is long and `local` inside a conditional
  reads like a scoping bug.
* **The C3d comment fix should include `:14146`'s sibling.** The `--wait-for-watcher-exit`
  comment at `:14146-14148` says it is "same tier as `--refresh`" — which is now wrong in the
  same way. Fix all three while you are in there.
* **T6 is correct but worth one sentence of justification.** A legacy (4-field) prepared row
  keeps the full mint→advance→close→recreate loop. That is deliberate (the recreate mints a
  UUID row, so it converges after one cycle), but say so — otherwise T6 reads like "we
  preserved the bug for legacy rows".
* **`_restored_final_close_guard` (`:7453`) becomes a second, independent refusal** for C1b's
  class. Worth one line in the plan: it means even if some future path reaches
  `recovery-close` for a migration-pending UUID row, the close still fails closed.

## Answers to the six targeted questions

**Q1 — Is C1b's insertion point correct and sufficient? Other callers? Does it strand anything?
Any other closer?**

*Correct, but under-scoped and under-disclosed.* Mechanically the insertion is sound:
`_restored_candidate_probe`'s signature is `kind generation ref title [expected]` (`:7357`);
at `:7413` `$surface` holds `workspace_single_surface_title "$ref"` (`:7383`, the **tab** face)
and `$raw_title` holds the workspace face (`:7369-7375`); `ledger_exact_receipt_uuid` (`:8095`)
is safe there (runtime resolution, pure `awk`, no lease); and `return 1` is the right code
(rc=1 ⇒ `evidence=drift` at `:7600`; rc=2 would become `inconclusive` ⇒ `0|quarantine` at
`:7477` ⇒ noise forever).

*Other callers:* five, listed in issue 1. Three of the four undisclosed ones are benign or
beneficial (`:7453` extra fail-closed; `:7599` gives free retraction of pre-existing markers via
`14|marker-delete`). **`:12387`/`:12398` is not** — it breaks `--rebuild-views --execute` for
precisely the rows in scope, because `resolve_rebuild_targets:11937` classifies them `W1p` from
receipt state + live source alone.

*Does it strand real restored-transaction recovery?* No. The skip is narrow: `kind == W1p` (so
only `live:prepared`, `:7759`) **and** `_workspace_title_is_default "$surface"` **and** a
UUID-bound receipt. A genuine restored half-transaction with that exact shape is a title
migration that did not finish, and `reconcile_prepared_ledger` + C1 completes it in the same
pass. Duplicates cannot reach the probe (`candidate_count == 1`, `:7367`). Legacy rows are
untouched.

*Round-1 destroy-path table re-run against v2:*

| path | can it close a UUID-bound prepared migration-pending workspace after v2? |
|---|---|
| W1p restored adoption (`:7759` → `:7530` → `:7674`) | **No** — C1b diverts to `14|marker-delete`; `_restored_final_close_guard:7453` is a second fence |
| prepared-stall `absent` (`:8969-8988`) | No — ref present, counter cleared at `:8945` |
| prepared-stall `drift` (`:9048-9068`) | No — the `"$title")` arm clears it at `:9037` |
| prepared-stall `authority` (`:9007-9021`) | No — only from the `__NULL__/__PROVISIONAL__/__DEFAULT__` arm's `GUARD_BLOCK_RC == 3` |
| `close_prepared_loser_ref` (`:8921`) | No — needs exactly one *other* committed ref for the title |
| `rollback_unreceipted_workspace` | No — create-time only |
| `cleanup_stale_workspaces` / `cleanup_stale_conservative` | No — anchored on the source window vanishing |
| `reap_unledgered_stock_workspaces` (`:2756`) | No — `awk '$3 == r'` finds the ledger row → `existing-ledger-authority` refusal (`:2829`) |
| `reap_ghost_workspaces` (`:2580`) | No — ledgered + live |
| `dismantle_view_display` (W2) | No — ops-rebuild class only, not W1p |
| **`_ops_adopt_restored_candidate` (`:12384`)** | Does not *close*, but now **fails** the target — issue 1 |

So the loop is genuinely broken by v2. The residual problem is the ops path and the disclosure,
not the core mechanism.

**Q2 — Does C1's exact-byte pinning behave at all four call sites? Side effects? `_GUARD_TITLE_RAW`?**

Yes on the mechanics, with one table error.

* `canonical_raw` is a positional **local** (`:8143`), so mutating it is invisible to
  `reconcile_workspace_titles:8722`, `reconcile_prepared_ledger:9029`/`:9041` and
  `create_workspace_for_window:10292`. No caller-side side effect. I checked `:8722`'s own
  `canonical_raw` is reused afterwards (`rename_stock_workspace`, `:8717`) — it is passed
  *before* the `complete_title_migration` call, so ordering is fine either way.
* `_GUARD_TITLE_RAW="$canonical_raw"` (`:8201`) is on the single fall-through path after the
  `:8193-8197` block; there is no early `return` between them and no alternative route to
  `:8203`. Assigned after the mutation on every path. ✓
* The pinning is genuinely exact: `_managed_view_command_in_variants` (`:4270`) first does an
  exact line compare, then falls back to `_cmux_carrier_classify equivalent` (`:4172-4181`),
  whose `identity()` returns `None` for anything that is not a recognised attach command — so
  `Terminal 66` cannot match a variant list containing `Terminal 65`. **T4 will pass.** The
  author's reasoning for pinning inside `complete_title_migration` (avoiding an extra
  `list-pane-surfaces` read that `scripts/test-cmux-sync.sh` counts) also holds: the surface is
  already in hand at `:8181`, and the `"$title")` arm has no `observed` surface value —
  obtaining one there would need a new read. **The author's choice is better than my round-1
  suggestion; accept it.**
* The one error is the `:9029` row of the table — the `__NULL__` sub-case *does* change
  behaviour (issue 6).

**Q3 — Is the literal `maintenance_entry_allowed` control flow implementable, and does the
`refresh` "ops claim present → 1" reproduce today?**

Half yes.

* **`ops_rebuild`: yes, exactly.** Deleting the `CMUX_MAINTENANCE_MARKER` terms from `:13883-13886`
  and `:13887-13888` yields precisely the plan's four rows, preserving every non-marker term
  (QA claim, self-published claim line equality, `OPS_CLAIM_PID == $$`, and
  `_ops_claim_owner_matches`' `kill -0` + incarnation check at `:13499-13504`). The
  "ops claim 不在 → 0" row correctly covers `--rebuild-views --execute` without `--handover`.
* **`refresh`: no.** There is no `refresh` branch; it falls into the shared `else` at `:13895`
  alongside `once`, `reaper`, `qa_teardown` and anything else. Implementing "只摘掉 marker 这一项"
  there relaxes all of them, violating the plan's own promise. A dedicated `elif` is required —
  issue 4.
* **"refresh: ops claim 在 → 1" is faithful.** Today it arrives via `maintenance_requested`
  (`:13217-13221`), which is `marker || QA || ops`, so any ops claim already refuses refresh.
  The explicit rule is behaviour-preserving for that row.

**Q4 — Is C3c correct and complete? Other automated callers?**

Correct in direction, incomplete in three ways.

1. **`--converge-runners` is newly un-gated** by C3b + C3a (`:12604` publish, `:12627`
   `maintenance_entry_allowed ops_rebuild`) and is not in the disclosure — issue 5.
2. **Step 2 of `trigger_cmux_refresh`** (`:2704-2728`, `--list-lead-refs` + per-ref
   `cmux refresh-surfaces`) is not gated — issue 7.
3. **The marker path derivation in `restart-services.sh` is unspecified** and would be its third
   copy — issue 7.

Everything else checks out. I swept the repo (`scripts/`, `packages/`, `.github/`) for automated
invocations: the only non-test callers are `scripts/restart-services.sh:2698` (`--refresh`) and
`scripts/lib/cmux-mutator-process-census.sh:194` (a mode *allowlist*, read-only, correctly
listed in the plan's sweep). `--once` has no automated caller outside launchd `--watch`, and
`--watch`'s own gate is untouched (`:14130`). `sync_additive` self-parks at `:11534`
(`maintenance_requested && return 0`), so the resident watcher is unaffected by C3.

Two facts that **help** C3 and the plan should state: `--refresh` never calls
`adopt_restored_workspaces` (mint sites are `sync_additive:11601` and `sync_bootstrap:11496`
only), so running it while parked cannot create new W1p markers; and it *does* reach
`reconcile_prepared_ledger` (`:10490` → `:9434`), so it is a complete repair path for this bug.

**Q5 — Are T1–T12 writable against the harness? Is T5 driveable? Name the fixtures.**

Mostly yes. The harness has everything T5 needs; T5's *assertion* is what breaks (issue 2).

Reusable fixtures, all verified present in `scripts/test-cmux-sync.sh`:
* **Restored adoption on:** `FLYWHEEL_CMUX_RESTORED_ADOPTION=1` (`:1191`, and per-test at
  `:7793`, `:7825`, `:7910`, …); `restored_adoption_enabled` is `:7261` in the main script.
* **Grace:** `FLYWHEEL_CMUX_ADOPTION_GRACE` (default `300` at `:1192`; set `0` as at `:8040`,
  `:10429`). Only gates `W1dead` (`:7583`), so W1p needs no change — but set it anyway for
  determinism.
* **Live source window:** `MOCK_TOPOLOGY_MODE=1` + `topo_add_session runner-flywheel '$1'` +
  `topo_add_window runner-flywheel '@42' "$title" 1 0` — exact pattern at `:7791-7797`
  (`test_fly1596_w1_two_pass_adoption_closes_restored_row`). This is what makes
  `strict_agent_window_snapshot` (`:7385`) report `live_count == 1`.
* **Forced rename-tab failure:** `MOCK_CMUX_RENAME_TAB_FAIL=1` — the mock returns 1 at
  `scripts/test-cmux-sync.sh:948`; reset to `"0"` in `reset_mocks` (`:1150`); already used at
  `:11424`. This lands in `cmux_call_guarded` (`:8203`) → `rc != 0` → `:8205`. ✓
* **Mutating mocks:** `MOCK_CMUX_MUTATE_JSON=1` + `MOCK_CMUX_MUTATE_SURFACES=1` so the workspace
  and surface faces actually change (pattern at `:6598-6599`, `:6622-6623`).
* **Surfaces:** `MOCK_CMUX_SURFACES="workspace:100;;surface:100;;terminal;;true;;Terminal 7"`
  (`:6631`). For T4's swap, `MOCK_CMUX_SURFACES` can be rewritten between the pre-check and the
  guard; there is precedent for sequenced mocks (`MOCK_CMUX_JSON_SEQ_N`, `MOCK_CMUX_READSCREEN_SEQ`)
  — if a surface sequence knob does not exist, T4 needs one (`MOCK_CMUX_SURFACES_SEQ`) or a
  wrapped `workspace_single_surface_title`. **Check this before committing to T4's shape.**
* **Ledger:** `test_ledger_upsert prepared …` (`:6611`) for legacy 4-field, or a direct
  `printf 'prepared|gen|ref|title|uuid\n' > "$VIEW_LEDGER"` (`:6634`) for 5-field UUID.
* **Lease:** `test_ensure_mutator_lease` (`:6635`) — required, since `_cmux_log_episode_commit`
  (`:9483`) and `adopt_restored_workspaces` (`:7699` `assert_or_reuse_owned_lease`) both demand it.
* **Marker state file:** `$RESTORED_STATE` (asserted at `:7804`, `:7810`).
* **Ops path:** `_ops_adopt_restored_candidate` is already driven directly at `:7949`.

So T5 is driveable exactly as described — `adopt_restored_workspaces live` →
`recover_restored_transactions` → `reconcile_prepared_ledger`, three rounds. Note
`adopt_restored_workspaces live` (no second arg) defaults `recovery_mode=recover` (`:7695`),
which calls `recover_restored_transactions` itself at `:7700`; production uses
`live discover-only` (`:11601`) with recovery happening earlier via
`refresh_linked_sessions_tail` (`:11566`). **Drive the production order explicitly** — either
`recover_restored_transactions` → `reconcile_prepared_ledger` → `adopt_restored_workspaces live
discover-only`, or accept the doubled recovery and say so — otherwise T5 tests an ordering that
never occurs.

Gaps:
* **T5's "恰一条 WARN"** — unachievable as specified (issue 2).
* **T11 / T12** — host file and assertion style unspecified (issue 8).
* **Missing test:** the pre-existing-marker retraction (issue 3) and the `--rebuild-views` W1p
  behaviour (issue 1) both need coverage.
* **T7** is writable directly (`_cmux_log_episode_state_valid` takes no args and reads
  `$CMUX_LOG_EPISODE_STATE`), and its "只改分发门必须红" framing is the right TDD shape.
* **T8–T10** are writable; `publish_ops_rebuild_claim` + `maintenance_entry_allowed ops_rebuild`
  are already driven together at `:8740-8745`.

**Q6 — Anything still missing for (a)–(d)? Any new risk v2 introduces that v1 did not?**

Missing:
* **(d)** — the plan names `--rebuild-views` as the parked-fleet exit, and C1b breaks it
  (issue 1). Either fix the ops path or retarget the exit to `--refresh` (which does work).
  The other three `--verify-agent-visible` rules the plan lists — `rule=render` (`:12180-12196`),
  `rule=client-count >= 1` (`:12171-12178`), `rule=a1-topology` (`:12152-12158`) — are correctly
  identified as delivered by the watcher returning to health, and `rule=receipt-uuid` (`:12209`)
  is worth adding to the table: it FAILs if a birth record exists and the receipt is `__LEGACY__`,
  which is a real (if unlikely) interaction with the legacy path T6 preserves.
* **(a)** — the deploy note is wrong (issue 3) and would mis-time the 30-minute window.
* **(c)** — delivered mechanically, but the alerting half is a log line only (issue 9).
* **(b)** — adequately argued now (`self_heal_sweep_all:11624`, create-time retry
  `:10310-10320`); no gap.

**New risks v2 introduces that v1 did not:**
1. **Loss of the `--rebuild-views` W1p recovery capability** (issue 1) — a capability regression
   shipped as a side effect, the most serious new risk.
2. **`--converge-runners` becomes runnable against a parked fleet** (issue 5) — a strictly wider
   blast radius than v1's C3, which only claimed `--refresh`/`--rebuild-views`.
3. **A new class of immortal ledger row** (issue 9) — v1's C1 left the W1p recycler armed, so
   nothing could get permanently stuck; v2 deliberately removes the recycler without adding a
   bounded escalation.
4. **Cross-script marker coupling in `restart-services.sh`** (issue 7) — a third copy of a path
   contract that must stay in sync with two test-fixture override paths.

None of these is a reason to abandon the v2 design. All four are disclosure/scoping fixes plus
one small mechanism addition.

## Verdict

**CHANGES REQUESTED.** v2 correctly identifies the recycler, and C1 + C1b together genuinely
break the create loop — I verified the full path table and found no remaining closer. The
exact-byte pinning is sound and the author's placement argument is better than my round-1
suggestion. But C1b is applied to a five-caller shared probe and silently removes the
`--rebuild-views` recovery path the plan itself designates as the operator exit for acceptance
(d) (issue 1); C2 suppresses a WARN that C1 makes unreachable while leaving the one that
actually repeats un-suppressed, so T5 cannot pass as written (issue 2); the post-deploy
convergence paragraph describes churn that C1b prevents (issue 3); C3a's `refresh` rule cannot
be implemented without a new branch and a literal reading relaxes `once`/`reaper` too (issue 4);
and C3b un-gates `--converge-runners` outside the stated blast radius (issue 5).

Fix issues 1–5 and re-submit; 6–10 should be folded in at the same time. This is close — the
remaining work is scoping and disclosure, not redesign.
