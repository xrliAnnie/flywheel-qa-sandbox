# FLY-1869 设计交叉评审 Round 2 — 独立上下文 Claude(同一评审上下文复核)

Issue: FLY-1869 (https://linear.app/geoforge3d/issue/FLY-1869/runner-spawn-把-issue-description-全量内联进-tmux-命令行-超过-16-20kb-后-command)
日期: 2026-08-18
基于: cross-review-r1.md、plan.md(R1 六项折入版)

处置:APPROVED;3 条 LOW 文档级修订已同 pass 折入 plan.md(§5.4 自然触线 / §2+§4 旧文件名与余量精度 / §3.1 token 派生顺序约束)。以下为评审原文。

---

# Independent Design Review — FLY-1869 plan.md (Round 2)
Status: APPROVED

## Summary
All six Round 1 items are folded correctly in the normative sections (§3.1–§3.3, §5.1–§5.2, §6, §8): the 120,000B budget is now a contract that is true on both Darwin and Linux, the blank-prompt trap is closed at the TS layer, the per-launch prompt filename eliminates the aliasing class, the breadcrumb makes exit-78 forensically legible, the test plan trips production constants without a knob, and the Top-3 heuristic is implementable as specified. I re-ran the exact revised gate script (brace-group form) through real /bin/sh: breadcrumb + exit 78 on missing and empty file, verbatim prompt delivery and empty-`pf` passthrough on the success paths — all correct. Three LOW residuals remain (one internal contradiction in §5.4, two stale-text spots); none changes a design decision, so they are approval-compatible advisories to fold in the same doc pass.

## Verified Folds
- **R1-1 (budget)**: §3.3 row now derives 120,000B from Linux `MAX_ARG_STRLEN` = 131,072B (headroom math checks: 131,072−120,000 = 11,072 ≈ 8.4% ≈ the stated "~8%"), cites the Darwin 512KB experiment correctly as macOS-only evidence, and §2/§4/§6/§8.3 all now say 120KB. Note the guard measures file bytes while the exec'd argv string is ≤ file bytes (trailing newlines stripped), so the measurement is conservative-correct against the per-string cap.
- **R1-2 (blank prompt)**: §3.1 criterion is `ctx.prompt.trim() === ""` → inline, no file; §5.1-1 and §5.1-4 both assert the whitespace-only (`"\n"`) case keeps today's inline behavior. Closes the `$()`-strips-to-empty → false exit-78 trap I demonstrated in R1.
- **R1-3 (breadcrumb)**: §3.2 script emits `FLYWHEEL_PROMPT_FILE_UNREADABLE <pf>` to stderr before each `exit 78`. Verified by running the exact revised script: missing file → `cat` stderr + breadcrumb + exit 78; empty file → breadcrumb + exit 78; success and empty-`pf` branches unchanged (prompt arrives as the literal last arg; `exec "$@"` substring still present, so the existing assertions at `TmuxAdapter.test.ts:353/447/467` keep passing).
- **R1-4 (per-launch file)**: §3.1 names the file `prompt-<launchToken>.md` with the correct structural argument (token gate already closes the workflow-path race; unique name zeroes the whole class for free). launchToken is per-launch unique on both paths (workflow: dispatcher-issued `launchGateToken`, replay writes a different token by FLY-245 R6 design; direct: fresh `randomUUID()`).
- **R1-5 (no test knob)**: §3.3 keeps hardcoded constants; §5.1-4 trips `prompt_size_budget` with a 120,001B prompt and `tmux_command_budget` with naturally oversized `allowedTools`/env; §5.2-3 tests the production threshold itself plus the 20KB real-tmux positive control. Contradiction resolved in the unit/integration sections.
- **R1-6 (Top-3 heuristic)**: §3.3 specifies preceding-`-`-flag attribution else positional index — implementable, and handles the dominant `-e KEY=VALUE` shape sensibly.
- **§9 provenance**: accurately characterizes what Round 1 did and did not verify; the six-item summary matches my report.

## Issues & Recommendations
1. **LOW — §5.4 still instructs QA to "调低预算 → typed error 出现在 `last_error`", which the design now forbids.** §3.3 says the thresholds are hardcoded constants with no knob (the R1-5 fold), so an independent QA node following §5.4 literally cannot lower the budget against a deployed build — and in this org QA nodes do follow plan text literally. Replace with the natural-trip form already used in §5.1-4/§5.2-3: e.g., "spawn 一张 description >120,001B 的单 → 断言 `last_error` 含 `LAUNCH_COMMAND_OVERSIZE`/`prompt_size_budget` 的 typed 自述,而非 tmux stderr". One-line edit; evidence: plan.md:130 vs plan.md:182.
2. **LOW — stale `prompt.md` naming in §2 and the §4 diagram contradicts §3.1's `prompt-<launchToken>.md`.** plan.md:55 and plan.md:146 (diagram node B2) predate the R1-4 fold. Cosmetic, but the diagram is what future readers skim; align both. (While touching §2: line 59's "验收的 100KB 之上留 20% 余量" is 17.2% if 100KB is read as 102,400B — either say "~17-20%" or state 100,000B explicitly, per the repo's precision discipline.)
3. **LOW — §3.1 doesn't state the ordering constraint the per-launch filename introduces.** In current source, `buildCliArgs` runs at `TmuxAdapter.ts:398` but `launchToken` is derived at `TmuxAdapter.ts:658-661` — ~260 lines later. On the workflow path `ctx.launchGateToken` is already in ctx and available inside `buildClaudeArgs`, but on the direct path the token is a `randomUUID()` minted at line 660. The implementer must either hoist the token/gate derivation above the `buildCliArgs` call or let `buildClaudeArgs` use `ctx.launchGateToken ?? randomUUID()` for the filename (uniqueness holds either way; the filename need not equal the gate token). Both are safe; the plan should pick one sentence so the implementer doesn't improvise mid-flight.

## Verdict
APPROVED

The design is correct, internally consistent in all normative sections, and every fold was verified against source and by re-running the revised gate script through real /bin/sh. The three LOW advisories above are doc-pass edits (no design decisions change); fold them before implementation starts — item 1 in particular, since §5.4 as written gives the independent QA node an unexecutable instruction.
