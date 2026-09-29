---
issue: FLY-2922
phase: design
phaseCursor: 1/5
updated: 2026-09-29T09:13:49.834Z
nextStep: "Audit authoritative production head 6e21a123d, PR #1374 clean/CI OK,
  and derive a current design-only handoff without implementation or QA side
  effects"
chunks: []
pointers: {}
handoff: "implement: cd repo root; verify plan §3.1 awk/diff
  SCRIPT-MATCHES-PLAN; check 0d73b791; LANE=A zsh
  engineering/doc/FLY-2922-unified-node-recovery/handin.zsh (DRY_RUN=1 first if
  unsure); no code changes; no local tests"
---

# FLY-2922 progress
**phase**: design (1/5)
**next**: Audit authoritative production head 6e21a123d, PR #1374 clean/CI OK, and derive a current design-only handoff without implementation or QA side effects

**handoff**: implement: cd repo root; verify plan §3.1 awk/diff SCRIPT-MATCHES-PLAN; check 0d73b791; LANE=A zsh engineering/doc/FLY-2922-unified-node-recovery/handin.zsh (DRY_RUN=1 first if unsure); no code changes; no local tests
