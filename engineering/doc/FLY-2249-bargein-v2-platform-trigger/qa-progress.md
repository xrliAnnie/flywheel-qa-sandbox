---
issue: FLY-2249
phase: qa
phaseCursor: 4/8
attempt: 2
updated: 2026-09-02
nextStep: real-room N=5 note-ON run, then note semantic arm + verdict
---

# FLY-2249 QA progress (attempt 2 · re-verify)
- ✅ R1 heads bound: raya 2b5ecd37 (== origin/fly-2249-bargein-v2), flywheel 4801590f (== baseRevision == anchor PR #1035 head)
- ✅ R2 anchor PR #1035 registered on __main__ (base=main, MERGEABLE/OPEN), CI green (CI OK / Quick Gate / Classify CI scope)
- ✅ R3 static gates at rework head: lint/build/typecheck rc0, contracts 62 + brain 125 + voice 516 + qa 124 = 827 pass
- ✅ R4 ruler mutation A (Lead): forged bot-side tap NEVER credited, even when earlier than the real ear gap
- ⚠️ R4b ruler mutation B (mine): pre-trigger ear gap still accepted silently; selectEarSideStopCandidate arity=2, never sees the trigger
- ⏳ R5 real-room true_speech N=5, note ON
- ⏳ R6 note semantic arm (noteAckAtMs / nextResponseAtMs)
- ⏳ R7 F1 crash-path replay
- ⏳ R8 verdict
