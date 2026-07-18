# FLY-1365 QA running log (capability-level, Tadashi 铁规)

PR #645 · head `d7eedd86f` · QA runner e36c85eb · branch flywheel-FLY-1365

## Progress cursor
- [x] Root-cause redirection independently verified (bridge-watchdog.log confirms issue's "09:39:15" = 07-17, not 07-18)
- [x] Full suite triage: 17 "failures" all environmental (long TMPDIR > SUN_LEN) or pre-existing flakes on files this PR doesn't touch (claude-profile / scaffold-prune). codex-daemon-runtime 43/43 green with TMPDIR=/tmp.
- [x] Cap ① stall immunity + ④ regression — PASS (cap1-stall-immunity.mts): real watchdog worker; async fix loops 3× past death line, gap 54ms, no self-kill; old sync path → independent worker records stall_age_ms=812 → would SIGKILL (positive control).
- [x] Cap ③ kill radius — PASS (cap3-kill-radius.mts): real createDefaultKillGroup; refuses pid/ppid/Bridge-real-pgid; mutation control shows old guard WOULD kill Bridge group -28163.
- [x] Cap ② part A attribution correctness — PASS (cap2a-attribution-logic.mts): real findWatchdogStallForExit + buildAbnormalExitAlertContent; mutation-controlled pollution rejection; stable dedup eventId.
- [x] Cap ② part B — real Discord delivery — PASS (cap2b-real-discord-alert.mts + cap2b-run.sh): real LeadAlertNotifier.alert() → real POST → isolated #test-flywheel-alerts, latency 772ms<30s, attributed content received, prod alert dirs untouched. (First run 403 = prod FLYWHEEL_ALERT_SENDER_TOKEN_ENV leaked into test proc → wrong sender bot; pinpointed via injected logging fetchFn, unset it → PASS. Harness env-isolation, not a FLY-1365 defect.)
- [x] VERDICT.md written — PASS @ head d7eedd86f.
- [ ] Commit QA artifacts + push · emit qa-result PASS · report DONE to Tadashi (he opens the gate per his instruction).

## FINAL: all four Tadashi requirements PASS @ d7eedd86f. No test regressions.

## Notes for next iteration
- Run all harnesses with `TMPDIR=/tmp` (QA session's default TMPDIR is too long → SUN_LEN false-fails).
- For ②B: check LeadAlertNotifier delivery mechanism + FLY-529 `--alerts` mirror (env FLYWHEEL_ALERT_QUEUE_DIR / DEADLETTER_DIR + isolated #test-flywheel-alerts) + existing driver scripts/qa-fly-529-fire-bridge-alert.mjs. Founder rule: real send/receive, isolated channel, no prod pollution.
- Do NOT stand up a full prod Bridge on host (load high; memory warns). Prefer driving the real alert sink with isolated queue dir + isolated test channel.
