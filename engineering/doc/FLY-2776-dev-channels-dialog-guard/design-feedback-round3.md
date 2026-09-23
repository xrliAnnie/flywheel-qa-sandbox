# Design Review — FLY-2776 plan.md (Round 3, Codex)

Date: 2026-09-22
Review target: `9cfd9807238d091356ad0a2390d9d3319b377c08` (`bad98d5fc..9cfd9807`)
Status: CHANGES REQUESTED

## Summary

The three round-2 blockers are closed in the production implementation. At the requested commit,
the recognizer keeps the sub-44-column keystroke path fail-closed, the NOT_SEEN path detects the
43x16 and 30x16 captures through `match_option_squashed && match_modal_footer`, and the live-composer
veto suppresses alerts for a receiving Lead. Alert delivery now uses `--strict-delivery` and treats
an absent or negative receipt as UNSENT; the signature includes a UTC-day bucket. G1/G2 now require
both a live pane and Claude's `⏵⏵` composer after dismissal. I found no contradiction in the measured
root-cause facts and did not reopen them.

The requested commit is not approvable, however. Its new H layer deterministically fails on GitHub
Actions because H1 inherits `CI=true`, and the plan's normative snippets still describe the
pre-round-3 recognizer and drift gate. The final decision matrix also says successfully recognized
dialogs alert, which contradicts both the implementation and the intended contract.

The branch advanced while this review was running, from the requested `9cfd9807` to `9f3a7177`.
Commit `ef007d74` appears to fix the H1 CI inheritance bug described below, but it is outside this
verdict. The plan mismatches remain present after that branch movement.

## What's Good (Keep)

- The current production predicate at `9cfd9807` requires all three distinct classes of evidence:
  the line-anchored option row, modal-footer present/live-composer absent, and one normalized body
  sentence (`claude-lead.sh:1719-1771`). P15-P18 cover the newly relevant false-positive and
  fail-closed boundaries.
- The narrow-layout alert signal is diagnostic only; it never authorizes a key. The code detects the
  squashed option label and modal footer at 43x16/30x16, then applies the composer veto before alerting
  (`claude-lead.sh:2007-2027,2071-2078`). A1g/A1h/A2c exercise the three critical branches.
- `lead-alert.sh`'s actual contract supports the new delivery classification: strict stdout receipts
  distinguish `queued_transient` from `dead_lettered`/`config_error`, while both can share exit 2.
  The caller's unparseable-receipt fallback is correctly fail-closed.
- `external_config_error` remains outside `AlertChannelHub.LEAD_KINDS`; a drained non-informational
  alert gets a persistent Hub thread but does not inherit the `permission_blocked` pane auto-resolve
  probe. `warningHold=5` supports the plan's corrected, bounded severity statement.
- The milestone is the literal last commit at the requested target, and it accurately records the
  three-part recognizer and alert behavior.

## Issues & Recommendations

### BLOCKER 1 — H1 inherits `CI=true`, so the new suite is red on the CI environment it is meant to guard

At `9cfd9807`, `h_case` runs `fake_claude_case` without controlling `CI`
(`fly2776-dev-channels-geometry.test.sh:763-773`). H1 then forces an affirmative raw-tty denial and
expects a local-host SKIP with no FAIL (`:776-784`). On GitHub Actions, the parent process exports
`CI=true`; the subshell inherits it. The denial therefore takes `fake_claude_case`'s CI-only failure
branch and emits `FAIL: H1 raw tty denied in CI`, after which H1's outer assertion necessarily fails.
H3 sets `CI=true` explicitly, but H1/H2 never set it false or empty.

This is not hypothetical branch reasoning: while the review was in progress, the branch added
`ef007d74`, whose commit message records the actual shard failure with exactly that H1 output and
pins `CI` per H case. That later commit is the right minimal repair: make `h_case` accept an explicit
CI value, run H1/H2 with `CI=''`, and H3 with `CI=true`. The fix must be part of the reviewed head
before approval.

### BLOCKER 2 — The plan's executable contracts still omit the protections that closed the prior blockers

The explanatory prose was updated, but the normative examples and schemas were not:

- Plan §2.2 (`plan.md:67-85`) still shows only option-row + body matching. It omits `footer_re`, the
  required modal-footer match, and the `⏵⏵` live-composer rejection implemented at
  `claude-lead.sh:1734-1762`. Following the plan's code block reintroduces code-review blocker 1.
- Plan §3.1 (`:133-140`) omits `match_option_squashed`, `match_modal_footer`, and
  `match_live_prompt`, even though those fields are now part of the byte-pinned classification at
  `claude-lead.sh:2035`.
- Plan §3.2 (`:148-153`) still shows the old two-path gate and five-bit shape. It omits both the
  sub-44-column third path and the live-composer veto implemented at `claude-lead.sh:2071-2078`.
  Following this snippet reopens round-2 blocker 1 and pages Leads that render the committed capture.
- Plan §3.3's call sketch (`:177-184`) omits `--strict-delivery` and shows a bare-shape signature,
  despite the surrounding prose and implementation requiring strict receipts and a UTC-day bucket.

These are archived implementation contracts, not cosmetic abbreviations: they prescribe exactly the
unsafe versions rejected in the previous reviews. Update the snippets/schema to the current source,
or replace them with precise pseudocode that includes every load-bearing predicate and receipt rule.

### BLOCKER 3 — The final decision matrix requires an alert after successful auto-confirmation

Plan §8 says `真框 120x40 / 49x16 | ✅ | 告警` (`plan.md:418-423`). The code instead recognizes
those geometries, sends one `1`, verifies dismissal, and returns at `claude-lead.sh:1937-1970`; the
NOT_SEEN classification and drift alert are unreachable on that successful path. That is also the
desired behavior: an auto-confirmed dialog is not drift and should not page anyone.

Change the first row's alert result to `不告警`/`❌`. Leaving it as `告警` makes the acceptance matrix
contradict the implementation and turns a correct no-alert result into a plan violation.

### NIT 1 — The summary and change inventory still describe the pre-round-3 scope

Plan §0 still calls the recognizer “two independent features” (`plan.md:11-13`) although §2.2 and the
milestone now define three required feature classes. In §1, T1 says only P8-P14, T2 lists F/G/M/A
but omits H, and C2 lists only the older classification fields (`plan.md:17-23`). Align those short
summaries with P8-P18, F/G/M/A/H, and the three new diagnostic flags so the archived index is usable.

## Verdict

**CHANGES REQUESTED.** The production behavior closes the three round-2 blockers, but the exact
requested head has a deterministic CI failure in H1 and the plan still publishes pre-fix executable
contracts plus an incorrect acceptance-matrix row. Incorporate the H-case CI pin into the reviewed
head, synchronize §§0-3 with the shipped code, and change the 120x40/49x16 matrix entry to no alert.

Verification performed: `git diff --check bad98d5fc..9cfd9807` and shell syntax checks passed;
`fly1679` passed 49/0 under locale unset with its real-tmux E layer explicitly skipped for host tty
denial; the hermetic `fly2776` run passed 20/0 with F/G/M explicitly skipped for the same host
capability; `fly1680` passed 7/0, `discord-plugin-cutover` passed 23/0, and the shell-suite
enumeration guards passed. This sandbox could not independently rerun G1/G2 because it denies raw tty;
their strengthened pane-live/composer assertions were verified by reading the exact target source.
