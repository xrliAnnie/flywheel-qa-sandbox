# Container wiring focused evidence
Issue: FLY-2886 (https://linear.app/geoforge3d/issue/FLY-2886)
日期: 2026-09-26
基于: ../plan.md

Assigned scope: C1/C2 container parent lifecycle, C6 isolated scribe lifecycle, C10 natural reopen. No live context append added. No production room/daemon changes or commits by this subagent.

Red/green sequence:

- Fresh natural reopen regression: first run failed with loader calls `[[]]` instead of `[[1],[2]]`; after refreshing the snapshot per generation, 21 container tests passed. Initial call later changed to `undefined` so Bridge can allocate a monotonically increasing persisted generation.
- Capability home admission: missing `assertVoiceCapabilityHome` failed the new managed-config/auth-link test; after implementation, 20 home tests passed.
- Capability and scribe startup wiring: new production-boundary fixture first failed because `createCapabilityParent` had 0 calls; after wiring subscription/config/skills/effective MCP tools/thread profile checks, two child processes, ordinary scribe turn probe and begin/end turn delivery context, 42 container/home tests passed.
- Added account/profile/tool/probe admission matrix: background API account, scribe API account, extra/missing capability tool, extra server, scribe tool, wrong managed profile and failed ordinary scribe turn. 50 tests passed (`resume-container-admission.txt`).
- Failed child shutdown initially skipped parent/scribe cleanup. Exact red retained in `resume-container-cleanup-red.txt`; independent cleanup passed in `resume-container-cleanup-green.txt`.
- Durable restart generation initially returned 1 when Bridge snapshot allocated 8. Exact red retained in `resume-container-generation-red.txt`; startup generation 8, failed restart 9, successful restart 10 pass in `resume-container-generation-green.txt` (52 tests across container/home).

- Actual enabled Bridge context is split: frontend brief does not contain full background detail. New test failed with `context_invalid` (`resume-container-split-context-red.txt`); enabled-only split admission, 4096-token brief limit and full-detail `developerInstructions` passed (`resume-container-split-context-green.txt`, 53 tests).

Package verification: refreshed teamlead `tsc` passed (exit 0; `resume-container-teamlead-tsc.txt`). Voice `tsc --noEmit` found no container/home errors but remains red in concurrent C11 work: CLI references a not-yet-added backend.actionLedger and voice-minutes fields are still unknown (`resume-container-voice-tsc.txt`). Those errors were relayed to the owning agent; final package typecheck is coordinated by root after integration. These injected-process tests are focused local evidence, not actual Codex account/tool acceptance, full CI, QA or production proof.

Integration seams: constructor capability identity comes from CLI projection/lease; `loadContext(undefined)` allocates opening `contextGeneration`, explicit later generations are consumed per restart attempt; conversation exposes `rewriteSpeech()` and `actionLedger()`. Capability parent owns durable journal and config/auth construction. Full-action logs, minutes/failure handoff, startup ring/Bridge generation allocation and revalidation are owned by the other assigned agents.
