# FLY-2461 两词批准 — 返工验证
Issue: FLY-2461
日期: 2026-09-09
基于: plan-r2.md

Founder message 1547460312624664686 selected A; Lead handoff
7bf78333-49f7-4451-bb08-3dc6c5863b0e confirms rework:2a5b2e2a.
This instruction supersedes the earlier seven-word vocabulary and associated
five-Chinese-word acceptance criteria. Pinned design documents remain unchanged.
Base: 8cac2808835a53c0059d2e8e09937d213c4f704b (existing PR #1141).

Only whole-message `approve` and `通过` approve a current-card reply; case and
outer whitespace are ignored, with at most one existing non-question terminal
punctuation character (period/exclamation). The shared kickback normalizer and
all identity, anchor, reaction, routing, delivery/dedup and ship-gate guards are
unchanged. No new synonym or behavioral case is introduced.

The approval line on review/ship cards is exactly:
`批准 → 在本卡点 ✅,或 reply-to 本卡只回:approve / 通过`
Existing rendered payload tests extract the advertised words and compare them
with the parser's exported finite set, then call the real parser for each word.
Removed synonyms are negative fixtures; the existing repeat-message dedup test
now repeats accepted tokens. Blueprint and existing explanatory copy use the
same two words. The longer approval receipt sentence is removed from ship copy.

TDD receipts (logs under /tmp/fly2461-a-*):
- parser red: 6 failures (removed words and repeated punctuation); green: 36/36.
- rendered card red: 4 failures; then green with both vocabulary assertions.
- shortened ship copy red: 1 failure; then green.
- final six TeamLead files: 172/172; Blueprint two files: 16/16.
- lint: initial four formatting errors fixed; rerun exit 0, 14 existing warnings.
- full repository build: exit 0, repeated after final copy cleanup: exit 0.
- full package run exited 1 at unchanged claude-runner: 46 files, 1138 passed /
  2 skipped, but unhandled Vitest onTaskUpdate timeout. This is a failed receipt,
  not aggregate green. Lead confirmation 0d82b35d-757d-4530-892a-b99bb75e25e3
  accepts this exact known signature for A; requires finishing remaining suites,
  exact-head review and CI 14/14 before needs_review. No runner fixes.
  edge-worker: 111 files PASS / 6 files SKIP, 1313 tests PASS / 14 SKIP, exit 0.
  voice-bridge: 60 files / 649 tests PASS, exit 0.
  TeamLead: 899 files PASS, 12312 tests PASS / 6 SKIP, but exit 1 with one
  unhandled onTaskUpdate timeout (1354.06s). Separate Lead acceptance requested
  as 286810f6-94b1-42f5-b8e6-9cf22ec8aab8; no assertion failures.
  Final lint after all copy changes: exit 0, 14 existing warnings.
  Lead ruling 9cb9573d permits the sole exclusion
  packages/core/test/tmux-viewer.macos.test.ts (real Terminal GUI); temporary
  configuration was restored after process exit. No other exclusions.
- isolated copies of the real parser and its existing tests: baseline exit 0;
  remove Chinese token, restore legacy English phrase, and repeat-punctuation
  mutants all exit 1 with expected assertion failures (3/1/1 respectively).
  Logs: /tmp/fly2461-a-mutations/. Shared source was not mutated.
- merge-tree with fetched origin/main 42869f935e7c29cda56ba6b66a9455e3a2663202
  exited 0 (no conflict); no merge performed.

Review, exact-head CI 14/14 and needs_review handoff remain pending. No live-room,
production approval, merge or deployment is claimed. QA owns real-card validation.

## Raw failed receipts

Both full receipts remain failed; log paths are /tmp/fly2461-a-packages.log and
/tmp/fly2461-a-teamlead.log. Relevant original tails follow verbatim.

```text
packages/claude-runner test:run: ⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
packages/claude-runner test:run: Error: [vitest-worker]: Timeout calling "onTaskUpdate"
packages/claude-runner test:run:  ❯ Object.onTimeoutError ../../node_modules/.pnpm/vitest@3.2.4_@types+node@20.19.21_@vitest+ui@3.2.4_happy-dom@20.10.6_tsx@4.20.6_yaml@2.8.1/node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:53:10
packages/claude-runner test:run:  ❯ Timeout._onTimeout ../../node_modules/.pnpm/vitest@3.2.4_@types+node@20.19.21_@vitest+ui@3.2.4_happy-dom@20.10.6_tsx@4.20.6_yaml@2.8.1/node_modules/vitest/dist/chunks/index.B521nVV-.js:59:62
packages/claude-runner test:run:  ❯ listOnTimeout node:internal/timers:605:17
packages/claude-runner test:run:  ❯ processTimers node:internal/timers:541:7
packages/claude-runner test:run: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
packages/claude-runner test:run:  Test Files  46 passed (46)
packages/claude-runner test:run:       Tests  1138 passed | 2 skipped (1140)
packages/claude-runner test:run:      Errors  1 error
packages/claude-runner test:run:    Start at  21:30:20
packages/claude-runner test:run:    Duration  341.11s (transform 918ms, setup 0ms, collect 5.26s, tests 328.18s, environment 4ms, prepare 1.61s)
packages/claude-runner test:run: Failed
/Users/xiaorongli/Dev/flywheel-FLY-2461/packages/claude-runner:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  flywheel-claude-runner@0.2.24 test:run: `vitest run`
Exit status 1
 ELIFECYCLE  Command failed with exit code 1.
```

```text
⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 ❯ Object.onTimeoutError ../../node_modules/.pnpm/vitest@3.2.4_@types+node@20.19.21_@vitest+ui@3.2.4_happy-dom@20.10.6_tsx@4.20.6_yaml@2.8.1/node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:53:10
 ❯ Timeout._onTimeout ../../node_modules/.pnpm/vitest@3.2.4_@types+node@20.19.21_@vitest+ui@3.2.4_happy-dom@20.10.6_tsx@4.20.6_yaml@2.8.1/node_modules/vitest/dist/chunks/index.B521nVV-.js:59:62
 ❯ listOnTimeout node:internal/timers:605:17
 ❯ processTimers node:internal/timers:541:7

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯


 Test Files  899 passed (899)
      Tests  12312 passed | 6 skipped (12318)
     Errors  1 error
   Start at  21:37:39
   Duration  1354.06s (transform 12.45s, setup 8.28s, collect 476.33s, tests 601.75s, environment 1.10s, prepare 58.93s)

/Users/xiaorongli/Dev/flywheel-FLY-2461/packages/teamlead:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  flywheel-teamlead@0.5.0 test:run: `vitest run`
Exit status 1
```

