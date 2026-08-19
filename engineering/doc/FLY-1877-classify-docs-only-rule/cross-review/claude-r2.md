# Cross-family Design Review — FLY-1877 plan.md (R2 stand-in)
Date: 2026-08-18
Reviewer: Claude (independent context)
Status: PASS

All claims below were checked against the real repo at branch `flywheel-FLY-1877` (HEAD `e1b19e845`), not taken from the plan. The §5 merge-base block was additionally executed verbatim in a scratch harness against real git fixtures (criss-cross, unrelated histories, single-base, base==head, zero-match grep under pipefail, and a `set -e` mutation control).

## Q1 Faithful folding — verdict per R1 item

### Item 1 (merge-base --all + exactly-one-line acceptance + ambiguous diagnostic + criss-cross vector) — FAITHFUL
- §3 branch table adds both `merge_base_unresolvable` (git failure or zero 40-hex lines) and a distinct `merge_base_ambiguous` (>1 line), with the criss-cross fail-open rationale and explicit attribution to the R1 fixture. Codex offered "reuse unresolvable OR a named ambiguous reason"; the plan took the stronger named-diagnostic option.
- §3 closing paragraph states the exactly-one-40-hex-line acceptance rule verbatim, framed as "determinizing the single rule, not a new mechanism" — matching R1's own framing.
- §5 sketch implements it (`--all`, count gate `-ge 1` then `-eq 1`).
- §6 vector 12a is the prescribed criss-cross negative vector (two equal merge bases, one base view docs-only, the other containing code) → `merge_base_ambiguous`, labeled as the R1 blocker anchor.
- Empirically confirmed: my criss-cross fixture produced 2 merge bases and the sketch block emitted `merge_base_ambiguous` with exit 0.

### Item 2 (table-driven positive matrix + uppercase SHA positive + allowlisted deletion positive) — FAITHFUL, with one inherited count error
- §6 item 1: table-driven zip pairing, all four prefixes at least once × every allowed suffix at least once, explicitly motivated as the "implementation silently drops `content/doc/` or a cold suffix" contract regression guard — matches R1's prescription including the "no 4×14 cartesian product" allowance.
- §6 item 3a: uppercase HEAD_SHA/BASE_SHA docs-only → true (normalization branch). Matches.
- §6 item 3b: deletion of an allowlisted plain file → true ("touches ≠ only additions"). Matches.
- **Count error (non-blocking, inherited from R1 itself)**: both R1 and the plan say "14 个后缀"; the actual `allowed_suffixes` tuple in `scripts/ci-classify.sh` L113-127 has **13** entries (`.md .markdown .mmd .html .htm .svg .png .jpg .jpeg .gif .webp .avif .pdf`), and the plan's own §3 enumeration correctly lists exactly those 13. The enumerated set — declared "逐字沿用现行,不动" — is authoritative and correct; only the count word is wrong. Fix "14"→"13" in §6 item 1 so no implementer hunts for (or invents) a phantom 14th suffix. This is dilution of neither scope nor intent, so the item still rates FAITHFUL.

### Item 3 (§7 lists all three guards + diff-zero + exact land-driver pnpm command) — FAITHFUL
- §7 self-verify explicitly lists all three: `bash scripts/__tests__/ci-structure.test.sh` + `ci-matrix-coverage.test.sh` + `ci-shell-suite-enumeration.test.sh`.
- diff-zero check present with the exact command (`git diff --stat main -- <three guard files>` must be empty) and the "green ≠ unmodified, both required" note R1 demanded.
- land-driver command is written exactly: `pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/land-merge-driver.test.ts`. Verified `packages/teamlead/package.json` name is `flywheel-teamlead` and the test path exists. `ship-await-ci.test.sh` also listed.

No drift, dilution, or omission found on any of the three items.

## Q2 New defects from folding — findings

I executed the §5 merge-base block verbatim (only `fail_closed` instrumented) under `set -uo pipefail`. Results:

| Scenario | Result |
|---|---|
| criss-cross (2 equal bases) | `merge_base_ambiguous`, exit 0 |
| unrelated histories (git rc=1, empty stdout) | `merge_base_unresolvable` via the `\|\|` catch, exit 0 |
| normal single base | correct 40-hex `merge_base` selected |
| base == head (degenerate) | single base (itself) → empty diff → true path |
| grep -cE with 0 matches (empty merge_bases, simulated rc-0 git) | assignment carries rc=1 but **script continues** (no `-e`), `count=0`, `-ge 1` gate fail-closes correctly |
| same zero-match path under `set -euo pipefail` (mutation control) | script **aborts rc=1 with no no_code line** — proves the contract depends on NOT adding `-e` |

Specific answers to the mandated scrutiny points:

1. **`A && B || C` pitfall** — not present. The sketch uses only single `||` chains (`assignment || fail_closed`, `[[ ]] || fail_closed`); there is no `A && B || C` construction anywhere in §5.
2. **`grep -cE` exit 1 on zero count** — handled correctly *as written*. The assignment line has no `||` guard, so under `set -uo pipefail` (no `-e`) the rc=1 is discarded, the variable still receives `"0"`, and the next line fail-closes. Also verified `[[ "" -ge 1 ]]` (empty count from a catastrophic grep failure) evaluates false → fail-closed, not error. **Non-blocking caution for the implementer**: the surrounding contract breaks if anyone "hardens" the shebang to `set -euo pipefail` (mutation control above). The plan pins `set -uo pipefail` verbatim from the current script and the existing harness's `assert_value` checks `CLASSIFY_RC -eq 0` on every vector, so a regression here would be caught — but the plan could add half a sentence saying `-e` is deliberately absent. Not required to close design.
3. **`head -1` reliability** — the count gate guarantees exactly one *matching* line but not that the *first* raw line is the matching one, and `merge_base` is taken from the first raw line. No released git emits anything but SHA lines on `merge-base --all` stdout (stderr is discarded), so I could not construct a concrete inputs→wrong-output scenario; this is theoretical only. Non-blocking hardening if desired: `merge_base="$(printf '%s\n' "$merge_bases" | grep -E '^[0-9a-f]{40}$' | head -1)"`, which also makes the "恰好一行 40-hex" acceptance literal.
4. **No unproven `no_code=true`; always exit 0; exactly one line** — verified by path enumeration: every early exit goes through `fail_closed` (one `no_code=false` line, exit 0); the only `no_code=true` write is the final line, reachable solely after input validation + both commits present + unique merge base + Python inert proof (`python3 … || fail_closed`, so a missing python3 → rc 127 → fail-closed, same as today). No path writes two lines (fail_closed exits immediately). The only non-zero exits are the pre-existing ones shared with the current script (`GITHUB_OUTPUT` unset guard; unwritable GITHUB_OUTPUT on the true path) — no regression introduced by the folding.

Additional non-blocking observations (none has a concrete failure scenario):
- §0/§4's "~70 行" estimate is optimistic; verbatim-ported Python block (53 lines) + ~30 bash lines ≈ 80-85. Immaterial — direction (net deletion, gh/jq gone) holds.
- §6 vector 15 ("零 gh/jq 调用") leaves the grep pattern to implementation; a naive substring grep can false-positive on comment words containing "gh". Failure direction is loud (test fails), and vector 13's positive control guards the dangerous (false-negative) direction. Fine.
- §7's diff-zero baseline is `main` tip rather than the merge-base; if main independently touched a guard file the check would fire spuriously — loud, safe direction. Fine.
- §3 table's `merge_base_ambiguous` row contains the phrase "fail-open" mid-description (describing the *old single-value* behavior it prevents); the output column correctly says false. Reads slightly confusingly but is not wrong.

**No BLOCKING findings.** I genuinely tried to break the block (six executed scenarios including one mutation control) and to find drift in the folding; the sketch behaves per contract and the folds match R1's prescriptions.

## Secondary spot-checks — what you verified and result
1. `scripts/ci-classify.sh` is 145 lines; segment map in §2.1 (L14-19 input, L24-67 paging, L69-75 selection, L77-89 validation, L91-143 Python) matches exactly. ✓
2. `ci-structure.test.sh` (735 lines) pins: `needs == ["classify"]` + if-expr for the four heavy jobs; `permissions == {"contents": "read", "actions": "read"}` **exact dict equality** (L106-110); checkout `fetch-depth: 0`; run line `bash scripts/ci-classify.sh` exactly once; step id `classify`. It does **not** pin classify step `name` or `env` (steps selected by run-string and id only) — so plan item 4 (rename step, drop 3 env keys, rewrite comment) cannot trip the guard. ✓
3. `ci-status-vectors.json` consumers: exactly three in-repo. `ci-classify.test.sh` L284-293 reads `.baseline` (rewritten by this plan); `ship-await-ci.test.sh` L186 jq reads only `.status/.conclusion/.await`; `land-merge-driver.test.ts` L7-18 is a TS cast declaring only `status/conclusion/receiver`, no schema validation. Deleting the `baseline` key is safe for the two untouched consumers. ✓
4. ci.yml `script-tests-2` runs `ship-await-ci` + `ship-report-failure` + `ci-classify` tests in one step (L744-748); path unchanged by the plan, and neither `ci-matrix-coverage.test.sh` nor `ci-shell-suite-enumeration.test.sh` references `ci-classify` directly. ✓
5. §6 vector 6's "沿用现 6 条" non-inert paths match the existing suite's loop verbatim (L189-195). ✓
6. Founder-constraint sanity: single history-free rule ✓; net deletion (runs API/gh/jq fully gone) ✓; no flags/coexistence (§9 explicit) ✓; three guard files 0-diff with both run-green and diff-zero proof ✓. The one item outside the literal "script + tests" boundary (ci.yml comment/step-name/env cleanup) is self-declared in §8.5 with an explicit retreat option, touches only non-structural bytes the guard provably does not pin, and was already endorsed as bounded by Codex R1. Not a violation.

## Verdict

**PASS (design closes).**

Required editorial correction before implement (does not reopen review): fix "14 个后缀" → "13 个后缀" in §6 item 1 (the §3 enumeration and the script's 13-entry tuple are the authority; the "14" is an off-by-one echoed from R1's own text).

Recommended (optional, non-blocking): (a) note in §5 that `-e` is deliberately absent from `set -uo pipefail` — adding it breaks the always-exit-0 contract on the zero-match grep path; (b) harden `merge_base` extraction with a `grep -E '^[0-9a-f]{40}$' | head -1` filter to make the "exactly one 40-hex line" acceptance literal.
