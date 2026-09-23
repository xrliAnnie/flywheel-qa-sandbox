# Design Review — FLY-2776 plan.md (Round 4, scoped verification)
Date: 2026-09-23
Review target: 0265c9d9cf36030ba2b283af7079426d4ebcff79
Status: APPROVED

## Question 1 — plan contracts vs shipped source

### §2.2 `_dev_channels_dialog_present` — MATCHES

The executable lines in the plan match the shipped function at
`packages/teamlead/scripts/claude-lead.sh:1719-1771`, including the exact
`footer_re`, the modal-footer requirement, and the `⏵⏵` live-composer rejection.
The only executable-line differences are the expressly permitted trailing
`# 必需 …` reading aids in the plan. Exact differing contract lines: none.

### §2.2 `_dev_channels_squash_ws` — MATCHES

The block matches `packages/teamlead/scripts/claude-lead.sh:1707-1711` line for
line. Exact differing lines: none.

### §3.1 NOT_SEEN classification — MATCHES

The plan, the `classification=` assignment at
`packages/teamlead/scripts/claude-lead.sh:2035`, and the byte-pinned T4b regex at
`scripts/__tests__/fly1679-dev-channels-v2.test.sh:520` use the same field names
in the same order:

`lines`, `geom`, `blank`, `match_warning`, `match_local_dev`,
`match_channels_hint`, `match_dangerously`, `match_option_row`,
`match_option_squashed`, `match_modal_footer`, `match_live_prompt`,
`banner_channels`, `prompt_caret`, `pane_sha256`.

Exact differing lines: none.

### §3.2 drift gate — MATCHES

The plan matches `packages/teamlead/scripts/claude-lead.sh:2071-2078` on the
three admission paths (`match_option_row`, `semantic_hits >= 2`, and
`match_option_squashed && match_modal_footer`), the outer
`match_live_prompt=0` veto, and the seven-bit `drift_shape` field sequence.
The plan abbreviates only the logging text and uses equivalent
`"$classification"` syntax instead of `"${classification}"`; neither changes
the executable gate contract under review. Exact differing gate lines: none.

### §3.3 `_dev_channels_drift_alert` call sketch — MATCHES

The sketch matches the shipped function at
`packages/teamlead/scripts/claude-lead.sh:1818-1875`: it passes
`--strict-delivery`, constructs `dev-channels-drift-<7-bit shape>-<UTC day>`,
maps `sent|duplicate|queued_transient` to `DRIFT_ALERT_SENT`, and maps
`dead_lettered|config_error|delivery_unknown` plus unparseable/empty output to
`DRIFT_ALERT_UNSENT`. `scripts/lead-alert.sh:33-37,160-180,193` confirms that
`--strict-delivery` emits the machine-readable verdict used by this mapping.
Exact differing contract lines: none.

### §0 / §1 / §5 summaries — MATCHES

- §0 states three required evidence classes: structural, modal, and semantic.
- §1 lists P8-P18, all five F/G/M/A/H layers, and the complete C2 inventory,
  including `match_option_squashed`, `match_modal_footer`, and
  `match_live_prompt`.
- §5 includes the round-2/3 reinforcement step covering P15-P18, H, A1f-A4c,
  F3, and the G evidence.

Exact differing lines: none.

## Question 2 — decision matrix vs poller control flow

### True dialog, 120x40 / 49x16 — CORRECT: key, no alert

The recognizer succeeds at `claude-lead.sh:1937`; the poller sends exactly `1`
at `:1947`, verifies a successful capture no longer matches at `:1962-1967`,
logs `confirmed=1` at `:1968`, and returns at `:1969`. The NOT_SEEN
classification at `:1981-2036` and drift gate at `:2071-2079` are therefore
unreachable on the successful-confirmation path. The matrix correctly says no
alert.

### True dialog, 43x16 / 30x16 — CORRECT: no key, alert

The option row is wrapped, so the line-anchored recognizer check at `:1740`
fails and the send branch at `:1937-1975` is never entered. After timeout,
whitespace squashing yields `match_option_squashed=1`; the squashed modal footer
yields `match_modal_footer=1`; and no live composer yields
`match_live_prompt=0`. The third admission path at `:2075` therefore logs and
calls the drift alert at `:2076-2078`. The matrix correctly says fail-safe no
key, but alert.

### Inline / block transcript (composer visible for the block case) — CORRECT: neither

An inline transcript does not satisfy the recognizer's line-anchored option-row
contract and lacks enough drift evidence (notably the modal footer), so it sends
no key and raises no alert. A rendered block with a live composer is rejected by
the recognizer's `⏵⏵` check at `:1760-1762`; on the timeout path it sets
`match_live_prompt=1` at `:2026-2027`, which vetoes every drift admission path at
`:2072`. The matrix correctly says neither key nor alert.

### Pure live prompt — CORRECT: neither

A pure live prompt lacks the option-row/modal/semantic combination, so the
recognizer never enters the send branch. Its `match_live_prompt=1` also fails the
outer drift gate at `:2072`. The matrix correctly says neither key nor alert.

## Verdict

Both scoped questions are clean. No differing executable-contract lines and no
incorrect decision-matrix rows were found. Targeted verification also passed:
`fly1679-dev-channels-v2.test.sh` reported 49 passed / 0 failed, and
`fly2776-dev-channels-geometry.test.sh` reported 20 passed / 0 failed (the host's
raw-TTY restriction produced the suites' explicit, expected skips for their
real-tmux-dependent layers).

APPROVED
