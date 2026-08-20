# Design Review — FLY-1905 plan.md v4 (Codex Round 2)

Date: 2026-08-19
Author: Codex
Status: APPROVED

## Summary

I re-read committed `plan.md` v4 at `5601b16e6` and compared it with v3 and every Codex Round 1 finding. All five findings are substantively resolved.

The recovery state machine now closes the installed-but-broken and stale-index paths; T3 has an independent watchdog; unsafe argv is rejected before privileged execution; version parsing and floor rationales are explicit implementation gates; and the hermetic suite must support macOS Bash 3.2 with a complete sealed-PATH inventory.

The plan remains proportionate: one CI-only helper, one hermetic suite, three workflow call sites, and lockstep governance updates. No production runtime behavior is touched. I found no new blocker.

## What's Good (Keep)

- Round 1 blocker 1 is closed. §2 retains the exact probe-fail set, excludes healthy packages from install argv, performs immediate fast verification, and routes both apt failure and fast-verification failure through fallback. Only post-fallback verification is terminal.
- T9 faithfully models apt’s no-op behavior without reinstall semantics. T12 covers the separate stale-index/no-upgrade case.
- Round 1 blocker 2 is closed. T3 has an independent GNU-timeout watchdog, distinguishes helper failure from watchdog termination, and proves the stall path was entered.
- `--timeout-secs` is restricted to `1..120`, preserving the hard-stop and worst-case-budget claims. T13 rejects malformed argv before sudo or apt.
- Version verification is testable: realistic tmux/lsof formats and unparseable output are covered, while every floor requires an auditable rationale.
- Bash 3.2 compatibility and complete sealed-PATH command inventory are explicit requirements.
- All existing workflow and governance coupling remains covered.
- The real-run acceptance criterion remains strong: both script shards must demonstrate fast-install success with zero fallback phases.

## Issues & Recommendations

1. **[LOW, non-blocking] Make the `--reinstall` rule textually identical across the contract, diagram, and tests.**

   §2 prose requires reinstall semantics for packages whose binary exists but fails probing, while the Mermaid command applies `--reinstall` to the entire probe-fail set. T10 expects it for a low version, but T2 does not specify whether absent rg must carry it.

   Either policy can preserve the intended behavior. Choose one canonical rule during implementation and pin it in T2 and the command-builder assertions. The simplest interpretation is the Mermaid form: apply `--reinstall` to exactly the probe-fail set, never healthy packages.

   Also interpret “`--mirror-file` 必须带值” as non-empty and include `--mirror-file ""` in T13.

No additional design-review round is required for these implementation-level clarifications.

## Verdict

APPROVED — ready to implement
