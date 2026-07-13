---
issue: FLY-1048
phase: implement
phaseCursor: 6/6
updated: 2026-07-09
nextStep: "approve gate open on PR #539 head 15e2e2c4 — awaiting review/QA; #525 merge 后 PR-C 自动 retarget main"
chunks:
  - { id: C1, status: done }
  - { id: C2, status: done }
  - { id: C3, status: done }
  - { id: C4a, status: done }
  - { id: C4, status: done }
  - { id: C5, status: done }
pointers:
  plan: engineering/doc/FLY-1048-watchdog-detection-remaining/plan.md
  prd_section: product/doc/FLY-942-proactive-reporting/prd.md §3.3b (merged #526, bc9c9bfb)
  qa_report: engineering/doc/FLY-1048-watchdog-detection-remaining/qa-report.md
---

# FLY-1048 progress

**phase**: implement — PR-C 统一升级流 + BI-4 (branch flywheel-FLY-1048-pr-c, stacked on #525 head 17e0e5d0; Tadashi approved stacking)

Lineage: PR-A #522 MERGED (9acffbdf). PR-B #525 OPEN awaiting HL look +
Tadashi executor-merge (gate c2c9363c, Codex R4 APPROVED, CI green).

PR-C tasks — ALL DONE (plan §4, kinds/thresholds per PRD §3.3b definitive):
- C1/C2/C3 done (prior lap): durable episode store + Lead-first leg +
  ~30min reconcile/fleet guard/founder pager/ACK endpoint + GatePoller seam.
- C4a done: StuckRunnerDetector.unifiedOwnsEpisode per-poll guard (old
  emitters + Q7 stand down while a unified episode is active; resume on
  inactive; throw = fail toward alerting) + bidirectional ACK mirror
  (stuck-disposition ↔ detection-ack, case-c kind only).
- C4 done: detection-detector-wiring.ts (gap→kind map + stable episode fps
  + case-c fp families aligned with old-flow keys via exported
  sigFingerprint) + FN4 lead_events reconcile (fire attempts-exhausted /
  overdue + clear delivered/pruned; detection-family recursion guard) +
  plugin notify legs (gap / focused-frame c / judge-confirmed c) all through
  notifyUnlessClearing + runDetectionReconcileTick assembly.
- C5 done: CLEARING marked on closeRunner SUCCESS paths only (failed kill
  leaves episodes armed), target-level notify mute, 2h TTL rebound
  (FLYWHEEL_CLEARING_TTL_MS), ESCALATED never re-alerts (FLY-970).
- Hardening beyond plan text (will flag to Codex review): progress evidence
  may only resolve case-c episodes (progressResolvableKinds) — target-wide
  progress auto-RESOLVE would have killed the R3 漏② 30min→@Annie guarantee.
- Flags: detection_escalation registered (prior lap); FLYWHEEL_CLEARING_TTL_MS
  allowlisted this lap; drift guard green.

Verification: 341 detection-related tests green across 15 files; tsc clean;
pnpm lint exit 0 (15 pre-existing warnings in unrelated packages). Known
environmental full-suite failures (prod env leakage / real-tmux ports) are
the same set as PR-A/PR-B; CI is the arbiter.
