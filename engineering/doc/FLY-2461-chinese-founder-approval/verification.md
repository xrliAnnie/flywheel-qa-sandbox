# FLY-2461 中文批准 — 验证记录
Issue: FLY-2461 (https://linear.app/geoforge3d/issue/FLY-2461/founder-ux静默失败-批准只认英文approve-look-good-to-me打回却认中文打回-founder)
日期: 2026-09-09
基于: plan-r2.md、implementation-audit.md

## Product evidence

- Five Chinese tokens (通过 / 可以 / 同意 / 批准 / 行) share the existing exact normalized protocol with approve / look good to me. No LLM or schema changes. Tests cover all five on review classifier and ship text source, plus anchored review ingress.
- Current-card, canonical-founder, latest-review-round and writer guards remain in place. Unanchored, wrong-card/channel, non-founder and non-protocol inputs cannot write a response. Chinese kickback tests remain.
- Unanchored exact approval gets guidance after Lead delivery. Workflow-superseded cards get latest-card guidance only after their required alert is recorded; stale founder-review rounds also get latest-card guidance rather than being pointed back to the stale card.
- Guidance POST false/throw is audited, never routed to the undelivered-message retry ledger. Same-batch subsequent current-card approval still succeeds, including after old-card guidance failures. Default HTTP POST failure and later recovery/new input are tested. FileInboundCursorStore reconstruction preserves the consumed cursor; no exactly-once Discord claim is made for a crash between POST and cursor save.
- Notifier, materializer, anchored-neither explanation and Blueprint FOUNDER REVIEW ROUND list the bilingual protocol. Actual outgoing message/prompt assertions were red before copy changes. These are textual payload checks, not real-room acceptance.

## Verification receipts

| Command | Outcome | Evidence |
| --- | --- | --- |
| pnpm lint | exit 0, 14 warnings | /tmp/FLY-2461-lint.log |
| pnpm -r build | exit 0 | /tmp/FLY-2461-build.log |
| pnpm --filter flywheel-teamlead typecheck | exit 0 after final test additions | /tmp/FLY-2461-final-typecheck.log |
| pnpm test:packages:run | exit 1; claude-runner 46 files / 1138 passed, 2 skipped, one unhandled onTaskUpdate RPC timeout | /tmp/FLY-2461-packages.log |
| VITEST_MAX_FORKS=1 pnpm --filter flywheel-edge-worker exec vitest run | exit 0; 111 files passed / 6 skipped; 1310 tests passed / 14 skipped | /tmp/FLY-2461-flywheel-edge-worker-package.log |
| VITEST_MAX_FORKS=1 pnpm --filter flywheel-voice-bridge exec vitest run | exit 0; 60 files / 649 tests passed | /tmp/FLY-2461-flywheel-voice-bridge-package.log |
| VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run | exit 1; 896 files passed / 1 failed; 12301 tests passed / 1 failed / 6 skipped | /tmp/FLY-2461-flywheel-teamlead-package.log |

Only explicit exclusion: packages/core/test/tmux-viewer.macos.test.ts, per Lead ruling 9cb9573d-ab9f-4b8f-8267-1648c84acd96, because it opens real Terminal GUI. Applied temporarily to core Vitest config with default exclusions preserved, then restored. No committed config changes and no other added exclusions. No new scripts/__tests__/*.test.sh files.

The first aggregate stopped before edge-worker, voice-bridge and teamlead. A lower-concurrency aggregate rerun was started before the next ruling; upon receipt of standing ruling 317743ec-0fbc-480e-93f2-98bda3fc14b5 it was stopped (session 6361 exit 130), config restored, and the three unreached packages run individually as directed. Lead accepts the zero-assertion-failure RPC artifact; this does not turn the original aggregate green. Exact-head CI remains the final aggregate authority.

TeamLead's only assertion failure was unchanged `src/__tests__/lead-lease-bridge-gate.test.ts`, audit_only compatibility: its local HTTP response was `not found`, causing JSON parsing failure. Lead triage 8ee77403-3e19-464c-8756-003564168fb3 identified the same full-run ordering/load failure elsewhere and directed one isolated run. `VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run src/__tests__/lead-lease-bridge-gate.test.ts` exited 0, 6/6 passed, with no code/test changes (log /tmp/FLY-2461-lease-isolated.log). Per the ruling, disclose this as a load/ordering flake with both results; do not claim the TeamLead full run passed.

## Deliberate boundaries and remaining handoff

- FLY-2461 product definition supersedes FLY-1847's English-only PASS vocabulary; precise current-card authority remains. The historical negative test retains 都可以了 / 可以了 / LGTM / approved, moving only exact 通过 into supported approval.
- 通过了 / 可以了 / 都可以了 / 通过 👍 / 批准 ✅ remain outside approval and unanchored guidance vocabulary; they route to Lead. Per-message best-effort guidance can coexist with a Lead reply; it is not guaranteed delivery or semantic interpretation.
- Language fixtures lock current en/zh parity. A future kickback language addition must update the fixture matrix; it is not automatic language discovery.
- Historical FLY-2244 message anchor remains unverified. No old verdicts were written, no timeout changed, no FLY-1919 native-button work, no production restart/merge/deploy/QA dispatch.
- Real-card test in a test/529 room belongs to QA: reply-to 通过 resolves; bare 通过 prompts without resolving. Not performed or claimed in this implementation phase.
- Remaining before handoff: exact-head code review, PR/CI evidence, literal-last milestone commit, and needs_review completion route. All required local commands have been run; their non-green boundaries and Lead dispositions are recorded above.
