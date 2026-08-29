# FLY-1236 QA — founder-TUI-dies is INDEPENDENT of the objective fix

Date: 2026-07-14
Harness: scripts/qa-fly-1236-e2e.mjs (real codex app-server daemon, real worktree, real tmux)

## Real-machine result (5/6)
- ✅ A0-split-shape       objective=297≤4000; old-folded=16636 (would -32600); kick=16636 carries body
- ✅ A1-goalset-succeeds  >4000-char SOURCE → goal set OK, terminal=complete succeeded=true in 168s (NO -32600)
- ✅ A2-kick-body-arrived agent committed the kick-only token → full >4000 kick reached it
- ❌ A3-founder-tui-alive `codex resume --remote` DIED immediately
- ✅ B-failclosed-guard   oversized objective (16636) rejected LOCALLY as setup_failed before RPC
- ✅ T-clean-teardown     no orphan daemon/socket

## A3 root cause (focused probe, remain-on-exit capture)
```
thread/resume failed during TUI bootstrap: thread/resume failed:
no rollout found for thread id 019f5edf-... (code -32600)
Pane is dead (status 1)
```
The founder TUI is opened on `onThreadReady`, which fires right after `thread/start`
and BEFORE the first turn — so the thread's rollout file
(~/.codex/sessions/.../rollout-*.jsonl) has NOT been persisted yet. `codex resume
--remote <threadId>` reads the rollout from disk, finds none, and exits → the pane
dies. This is a timing race in the TUI-open path (codex-runner-tui-window.ts /
CodexTmuxAdapter.openWindow), ORTHOGONAL to the /goal objective 4000-char cap.

## Why the same-cause hypothesis is refuted
The brainstorm assumed the TUI died as collateral of the setGoal(-32600) failure
(onThreadReady opens window → setGoal throws → finally killWindow). But here goal-set
SUCCEEDED (A1) and the TUI still died — different code (-32600 from thread/resume "no
rollout found", not thread/goal/set "objective too long"). The FLY-1236 objective fix
neither causes nor fixes this; it is the issue's anticipated "若独立 → 另立" case.

## Recommendation
- Ship FLY-1236's objective fix (A1/A2/B proven) — the P1 setup_failed is gone.
- File a SEPARATE issue for the TUI rollout race (open `codex resume --remote` only
  after the first turn / rollout exists, or bounded retry on "no rollout found").
- Scope decision (fix-here vs separate) is the Lead's, given FLY-398 founder-visibility.
