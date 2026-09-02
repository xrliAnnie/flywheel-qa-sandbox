---
issue: FLY-2249
phase: implement
phaseCursor: 23/24
updated: 2026-09-02T19:41:14.725Z
nextStep: Refresh milestone as the literal last anchor commit, sync PR bodies,
  verify exact heads and gates, then route needs_review to QA@6.
chunks:
  - id: C0
    order: 0
    deps: []
    done: ORT/model pin and dedicated worktree
    status: done
  - id: C1
    order: 1
    deps:
      - C0
    done: realtime item events and transcript/tap corrections
    status: done
  - id: C2
    order: 2
    deps:
      - C0
    done: Silero gate, timing contracts, serial probes and first calibration
    status: done
  - id: C3
    order: 3
    deps:
      - C2
    done: uplink/runtime integration, rejected-layer deletion and byte ledger
    status: done
  - id: C4
    order: 4
    deps:
      - C1
      - C3
    done: platform trigger, fallback and heard position
    status: done
  - id: C5
    order: 5
    deps:
      - C4
    done: backchannel arbitration
    status: done
  - id: C6
    order: 6
    deps:
      - C4
    done: developer heard-position note
    status: done
  - id: C7
    order: 7
    deps:
      - C5
      - C6
    done: room harness, full gates and calibration handoff
    status: done
pointers:
  plan: engineering/doc/FLY-2249-bargein-v2-platform-trigger/plan.md
  reviewedSha: 2215c113dd82e2b5590076a50744537c6a96f7c1
---

# FLY-2249 progress
**phase**: implement (23/24)
**next**: Refresh milestone as the literal last anchor commit, sync PR bodies, verify exact heads and gates, then route needs_review to QA@6.

## chunks
- ✅ C0 — ORT/model pin and dedicated worktree
- ✅ C1 — realtime item events and transcript/tap corrections
- ✅ C2 — Silero gate, timing contracts, serial probes and first calibration
- ✅ C3 — uplink/runtime integration, rejected-layer deletion and byte ledger
- ✅ C4 — platform trigger, fallback and heard position
- ✅ C5 — backchannel arbitration
- ✅ C6 — developer heard-position note
- ✅ C7 — room harness, full gates and calibration handoff
