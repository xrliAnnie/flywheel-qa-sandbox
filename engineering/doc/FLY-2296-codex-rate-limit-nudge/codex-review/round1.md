# Design Review — plan.md (Round 1)

Date: 2026-09-03
Author: Codex
Status: CHANGES REQUESTED

## Summary

The core choice is correct and appropriately narrow: pin Codex's own notice key at home-provision time, and prove its effect with a real-TUI red/green probe. The plan is not ready to implement as written because its Lead insertion point misses the production full-access path, and several rejection/copy paths need tighter fail-closed handling to avoid invalid configs, dispatch-wide failures, or credential duplication.

## What's Good (Keep)

- Uses the exact upstream read/write key, `notice.hide_rate_limit_model_nudge`, without adding argv overrides, environment switches, model changes, or patrol behavior.
- Places the runner pin before the managed blocks and retains a parsed postcondition, so a malformed rewrite cannot be written as a successful provision.
- The fake app-server probe is genuinely discriminating: missing/false produces the menu while true suppresses it against the real TUI, rather than merely asserting static config text.
- Rollout and honesty boundaries are accurate: new/recovered TUIs re-read the setting; already-running TUIs do not hot-reload it; goal pause/resume and account switching remain out of scope.

## Issues & Recommendations

1. [BLOCKER] The proposed Lead insertion point is unreachable for the production full-access path. `ensure_home` calls `write_full_access_config`, appends the Lead-actions MCP block, and returns before the read-only trust section; the production Mufasa and infra launchers explicitly set `FLYWHEEL_CODEX_LEAD_PROFILE=full-access`. Adding `ensure_notice_pin` only after the trust section therefore leaves those generated configs without the key, and every full-access ensure rewrites away any prior manual pin. Invoke the notice pin after final config assembly in both branches (or emit and validate the same key inside `write_full_access_config`), and add a full-access `ensure-home` test plus an E5 full-access readback assertion.

2. [HIGH] The Lead `absent` classifier can write an invalid TOML file for supported parser shapes that lack a literal `[notice]` header. `tomllib` represents `notice = { ... }`, root dotted `notice.foo = ...`, and `["notice"]` as dictionaries; the proposed code therefore reports `absent`, the literal-header grep misses them, and appending `[notice]` illegally redefines the table. This was reproduced with the repository's `smol-toml` 1.6.1. Keep the Lead mechanism conservative: append only when the top-level `notice` key is entirely absent; if `notice` exists but the target key is missing, fail closed with manual-fix guidance. Add inline, dotted, and quoted-header cases (or build a temporary candidate, parse/verify it, and atomically replace the file).

3. [HIGH] The runner pin's planned rejection path is both over-broad and outside the existing scrub boundary. A file such as `[other]\nnotice.foo = "x"` is valid and defines `other.notice.foo`, but the unscoped `dottedOrInline` scan rejects it as a root `notice` definition, potentially blocking every Codex dispatch because of an unrelated nested key. In addition, the planned call remains after `auth.json`/`.active` are written and before `provisionCodexHome`'s `try`; a rejection during re-provision can bypass `scrubCodexHomeCredential` and leave the prior managed GH token in place. Restrict root-assignment checks to text before the first table header, add the relative-key control case, and either compute/validate the pinned base before filesystem writes or move the pin inside the scrubbed `try` with a failure-path residue test.

4. [MED] The probe's “config.toml only” copy is still a credential copy. A live provisioned runner config contains the managed `[shell_environment_policy.set] GH_TOKEN`, so E4 duplicates that token into another home and launches a process with it even though `auth.json` is omitted; unix-only fake-server transport does not remove that local exposure. Strip the Flywheel-managed credential block from the temporary probe config, assert no `GH_TOKEN` remains, preserve mode 0600, and guarantee cleanup with a trap before starting tmux. This does not alter the source home or the notice-key variable under test.

## Verdict

CHANGES REQUESTED — address items above
