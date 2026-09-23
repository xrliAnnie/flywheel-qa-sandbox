# Design Review — FLY-2776 plan.md (Round 2, Codex)
Date: 2026-09-23
Status: CHANGES REQUESTED

## Summary

The established diagnosis is correct: the strings did not change; the 49x16 visible viewport hides the title and wraps the hint. I did not reopen that premise or the eight round-1 findings that the current plan actually fixes. The two-feature recognizer, C-locale handling, border folding, and single-`1` action agree with the code. The alert and acceptance contracts still have three blocking gaps. Review is against commit `bad98d5fc` (`main...HEAD`); a concurrent uncommitted edit to the geometry suite appeared after the review began and is not part of this verdict.

## What's Good (Keep)

- The structural option-row anchor AND one independent, whitespace-normalized body sentence recognize both recorded geometries while P4/P12 quoted inline transcripts remain absent. The code uses `LC_ALL=C`, literal multibyte substitutions, `grep -e`, and no short-circuiting producer pipe in the predicate (`packages/teamlead/scripts/claude-lead.sh:1707-1744`). P1–P14 passed locally.
- The drift gate uses the structural flag OR two body sentences, not one quoted label (`claude-lead.sh:1985-1989`). T4c and A2b are meaningful benign-transcript controls. A shape signature bounds duplicate alerts; `external_config_error` avoids the `permission_blocked` pane auto-resolution path (`AlertChannelHub.ts:280-286,699-710`). `warning` avoids a one-observation severe hold.
- The new suite is enumerated in CI immediately after fly1679 (`.github/workflows/ci.yml:1389-1390`); the shell enumeration check passed. The CI-installed tmux permits F/A to gate without a Claude binary. G/M explicitly print SKIP without one. Locally, G1/G2/M1 against Claude 2.1.280 passed; the F1 fake-child keystroke failed because this sandbox denies raw tty, so this host does not establish an F-layer pass. The older fly1679 E layer explicitly reported the same tty denial and skipped; its remaining 45 checks passed.
- Failing closed on an option row that wraps below 44 columns is the right keystroke decision. A whole captured dialog pasted into a transcript remains a bounded false-positive risk: one `1` with no Enter. The plan correctly records it.

## Issues & Recommendations

### BLOCKER 1 — Below 44 columns, the promised drift alert can be silent

**Issue.** Plan §2.3 promises an alert whenever the option row wraps (`plan.md:103-107`), and the code comment repeats that promise (`claude-lead.sh:1659-1664`). I launched the installed Claude 2.1.280 in an isolated **30x16** tmux pane. Its visible capture has the hint split across three lines and the option split into `❯ 1. I am using this for` / `local development`; both the title and `--dangerously-...` sentence have scrolled out. Thus `match_option_row=0` and only `match_channels_hint=1`. The actual drift gate requires the row OR **two** body hits (`claude-lead.sh:1985-1989`), so it neither presses a key nor alerts. This is a real partial-match screen, not a hypothetical narrower viewport.

**Why it matters.** The issue's observability requirement is to distinguish a parked Lead from no dialog. The registered residual-risk bound is false exactly where the recognizer intentionally fails closed. Current A tests use a screen with two body hits (`fly2776-dev-channels-geometry.test.sh:390-404` at HEAD), so they cannot catch this.

**Suggested fix.** Keep the keystroke predicate fail-closed. Add a separate narrow-layout alert signal, such as a line-anchored `❯ 1.` prefix plus the normalized hint (and a geometry check if needed), that cannot fire on the inline P4 transcript. Test a byte-verbatim 30x16 real capture and an inline quoted negative control. If this geometry is deliberately outside the alert contract, remove the “no longer silent” claim and state the operational limit explicitly; that choice needs to be reconciled with the partial-match requirement.

### BLOCKER 2 — Exit code 2 is also permanent dead-letter, but the plan and code call it delivered

**Issue.** Plan §3.3 says `2 = 已持久入队, Bridge drain 会送` (`plan.md:188-190`); the implementation logs `DRIFT_ALERT_SENT rc=2` for every such exit (`claude-lead.sh:1818-1824`). In `lead-alert.sh`, missing channel/token dead-letters and exits 2 (`:1471-1482`), as do permanent Discord failures and queue-write failures (`:1590-1607`); an already dead-lettered receipt also exits 2 (`:1259-1262`). A4 only stubs `FAKE_ALERT_RC=2` and checks the misleading log (`fly2776-dev-channels-geometry.test.sh:501-508`).

**Why it matters.** The sole new alarm can be permanently undeliverable while the startup log reports success. The shape signature is then claimed against that incident, so a restart with the same shape does not supply a fresh page.

**Suggested fix.** Call `lead-alert.sh` with its existing `--strict-delivery` switch, which emits `sent`, `queued_transient`, `dead_lettered`, and `config_error` (`lead-alert.sh:160-193`). Treat only sent/queued as delivered; log dead-letter/config as unsent, retaining poller survival. Update the plan and add separate queued and dead-letter A cases. Preserve the shell result in the command substitution instead of discarding `out`.

### BLOCKER 3 — G1/G2 do not prove the Lead reached a receiving prompt

**Issue.** The archived plan says G1/G2 must establish `matched + confirmed + Lead 落到可收信的 prompt` (`plan.md:231-233`). The actual success check only finds two log strings and verifies that the final capture lacks the dialog's option row (`fly2776-dev-channels-geometry.test.sh:272-283` at HEAD). `_poll_dev_channels_dialog_v2` itself defines `confirmed=1` as “the recognizer no longer sees the dialog” (`claude-lead.sh:1904-1920`). A post-confirmation error, exited Claude, or a changed dialog would satisfy both checks without a receiving prompt.

**Why it matters.** G is the one-time real-binary acceptance evidence that CI cannot provide. As written, its strongest promised outcome is untested, so a green G result does not establish the plan's QA criterion.

**Suggested fix.** Require evidence of a live Claude pane and its actual ready-input UI after dismissal, or perform a harmless non-submitting input/readback probe, then check that the dialog is gone. Add a negative case with a non-prompt post-dialog screen so the assertion is proven non-vacuous. If only dismissal is intended, narrow the plan's claim accordingly and record prompt readiness separately.

### NIT 1 — The alert's queue-drain lifecycle is understated

Plan §3.3 calls `external_config_error` “an alert rather than a durable ticket” and says the contact book routes it to Tadashi (`plan.md:165-176`). The kind is absent from the informational allowlist (`scripts/lead-alert.sh:138-144`; `LeadAlertNotifier.ts:389-404`); in unified-channel mode the shell renders a `🎫 ... 状态 NEW` header (`lead-alert.sh:1357-1363`). On a successful queue drain, noninformational roots are passed to the Hub for a persistent thread (`drained-alert-routing.ts:28-47`; `AlertChannelHub.ts:564-571`). There is no `LEAD_KINDS` auto-resolve, which is good, but the plan should describe the direct-post and queued-drain behaviors accurately. The contact book is a responder convention, not a kind-based routing branch in `lead-alert.sh:914-930`.

### NIT 2 — “Warning cannot hold a release” is too strong

A1c's pass text says the chosen severity “cannot hold a release” (`fly2776-dev-channels-geometry.test.sh:445-449` at HEAD). `warningHold=5` (`release-readiness/policy.ts:7-8`); readiness counts distinct event IDs after dedup (`release-readiness/evaluate.ts:267-276,358-365`). Five distinct Lead/shape events attributed to the subject commit can still meet the warning threshold. The plan's narrower claim that a **single** diagnostic signal will not cause a severe hold is correct; align the test wording and risk note with that bound.

### NIT 3 — CI budget and remaining plan work

The plan budgets “F 层三个 pane” (`plan.md:251-253`), but HEAD launches two F panes, F1 and F2; F3a checks only that a regex mutation changes source text (`fly2776-dev-channels-geometry.test.sh:204-218`). P4/P12 do provide a real line-anchor negative, so this is a budget/description correction, not a missing CI gate. The planned milestone `engineering/doc/milestones/FLY-2776.md` is absent from `main...HEAD` despite D1 in the change list and sequencing (`plan.md:16-20,272-280`); finish or mark it pending before calling the branch complete.

## Verdict

**CHANGES REQUESTED.** Preserve the recognizer and the 49x16 fix. Repair the sub-44 alert boundary, distinguish queued from dead-lettered delivery, and make the real-binary prompt assertion prove what the plan says. Then update the plan's lifecycle and CI descriptions to match the shipped code.
