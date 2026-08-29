---
issue: FLY-944
phase: implement
phaseCursor: 6/6
updated: 2026-07-07T06:26:05.702Z
nextStep: "Codex APPROVED (2 rounds) + gate passed — polling CI on PR #484, then
  approve-gate + park"
chunks: []
pointers: {}
---

# FLY-944 progress
**phase**: qa (PASS + live 529 N-to-N PASS)
**next**: QA PASS — decision-level E2E 16/16 + shell 19/19 + gate vitest 17/17 + CI green + LIVE 529-room lead-to-lead N-to-N PASS (Annie chose (b)). Reported DONE to Tadashi; awaiting his go for Annie to ship #484.

## Live 529 N-to-N (2026-07-07, Annie chose (b))
- 2 real Claude Leads in isolated 529 guild #test-core-mirror, zero prod config touched.
- BEFORE (allowFrom missing sibling): test-2 @ test-3 → dropped, no reply (incident reproduced).
- AFTER (branch apply --id-only): test-2@test-3 → reply, test-3@test-2 → reply, no-@ → neither replies.
- Evidence: Discord REST + tmux panes + Claude-in-Chrome screenshot. Channel link posted to Tadashi.
- Fixed 2 env-only 529-room gotchas (TMPDIR socket limit + stale session-id crash-loop; not FLY-944 defects).
- Test leads torn down via test-teardown.sh. commit 6b943d6c on PR #484.

## QA verdict (2026-07-07)
- **PASS**. See qa-report.md.
- Added decision-level E2E (`qa-fly-944-gate-decision-e2e.sh` + `gate_sim.mjs`): reproduces the FSM @-drop incident on the BEFORE config, proves the fix on the AFTER config across non-CoS core / CoS core / roundtable, preserves FLY-152/898 discipline.
- Full teamlead vitest: only failure = known-environmental codex-lead-runtime timeout (124/124 in isolation), unrelated to FLY-944.
- Deploy-ready: roundtable id resolves in prod (env + file = 1512578695468941333); access.json hot-reloads (zero restart).
- Ship note: flipped non-CoS lead → founder no-@ silent (rule ②, deliberate; communicate to Annie). Live N-to-N Discord = post-merge ship step (§Ship step 3).
