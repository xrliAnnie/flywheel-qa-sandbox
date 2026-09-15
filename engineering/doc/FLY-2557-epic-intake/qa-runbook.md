# FLY-2557 Epic 自动入口 — 隔离验收操作
Issue: FLY-2557 (https://linear.app/geoforge3d/issue/FLY-2557/epic-流程intake-epic-进-in-progress-自动触发拆解bridge-监听-linear-epic无)
日期: 2026-09-14
基于: plan.md

## Evidence boundary

Implementation fixtures use synthetic projects and temporary StateStore/CommDB files. They do not prove live Linear discovery latency, real Lead processing, a hosted page, or process-kill recovery. Those checks belong to the isolated QA environment below. Do not copy production databases or use production channels, Epics, or Lead identities. Do not restart production Bridge.

## Required isolated setup

Record the exact PR HEAD, test Linear team/project and department label, test Lead ID and test channel/thread, independent Bridge port, independent StateStore/CommDB paths, and independent publication registry/token. Use credentials scoped to the test environment; never include tokens in evidence. Configure two test departments and a second project to exercise routing. Start only the isolated Bridge/Lead processes. Record their process handles and the command/config used so kill/restart targets are unambiguous.

## Acceptance ledger

1. Finish bootstrap with no fresh started roots. Record event and mailbox counts. Create a fresh root in the test project with its department label, then set it In Progress. Read its Linear stateHistory segment start as `t0`; record journal insertion time `t_event`, stable UID, sequence, canonical deliveryId, and actual recipient mailbox `acked_at` as `t_ack`. Both elapsed times must be ≤60 seconds. Adapter delivered_at is insufficient. Capture the Lead's ACK receipt separately from its business result.
2. Repeat started and switch between two started substates: exactly one UID. Backlog then started: exactly two UIDs, based on the two segment starts. Exercise both transitions within one scan interval and a newly created Epic less than three minutes old. Do not derive identity from local observation time or issue.updatedAt.
3. Verify zero events to the target Lead for no label, parent present, two department labels, other project, directly Done/Canceled, and a zero-child root with a session or workflow_run record in this project. A root with children and runner history gets one; zero children and no dispatch history gets one. A record in another project does not exclude the root. Adding dispatch history to a pending zero-child root invalidates it. A previously existing started root is backfill=true and only receives the backfill handling.
4. In separate runs, kill the isolated process after journal commit before enqueue, and after durable enqueue before ACK. Restart using the same isolated databases. The UID, journal sequence and deliveryId must remain unchanged; exactly one delivery is ACKed. Wrong Lead ACK must fail. ACK without resolve must leave pending work visible at the next original patrol grid. Record process handles, timing, and database receipts. Graceful database reopen fixtures alone do not satisfy these kill tests.
5. Read the actual assembled Claude and Codex department bundles and show §0.11 in both. Read the actual CoS bundle and show that department patrol rules are absent. Exercise Lead handling: read full Epic, create children only when absent and not backfill, inherit labels, dependency add/show, canonical thread reply with UID, resolve evidence, and capacity pull. Verify retry does not duplicate children or replies. Resolve alone must not dispatch a runner.
6. With no children, the fixed token must show the Epic with 待拆解 and intakeAt. Add children and verify the same token updates, child ready counts agree with dependency show, and the card no longer claims zero children. Backlog/Done must remove the in-progress card. Exercise publication failure and recovery; dirty state must persist until the matching version is published.
7. Test show/resolve without master auth, with ingest auth, wrong project/owner, wrong canonical thread, forged message, invalid direct-child membership, future/stale ledger time, oversized body and an episode invalidated during observation. Unauthorized/invalid evidence must fail closed; concurrent invalidation must return 409. Verify identical resolve is idempotent and needs_founder remains pending until valid completion.
8. Fetch the hosted page (HTTP 200), verify script/style CSP nonce matches, no external resource requests, and inspect a mobile-width screenshot. Record HTML bytes and compare the same fixture with the actual FLY-2553 landing version; ≤512KB and no growth over that version. Record exact-head CI and confirm PR is non-draft. Keep host aggregate contention failures distinct from isolated successful checks.

## Fixture reproduction

For commands that may start a test Bridge, use `python3 engineering/doc/FLY-2557-epic-intake/run-isolated-validation.py <command...>`. The wrapper gives the subprocess a fresh temporary HOME and explicit Codex/CommDB roots; completion markers use their normal path under that isolated HOME. It inherits only PATH and basic locale/terminal settings and preserves the resident runner's own environment. Its printed `ISOLATION_RECEIPT` records the command, directory and exit status; it does not copy credentials or production databases. Tests with explicit absolute paths still need their own fixture audit. Do not add `FLYWHEEL_COMPLETE_MARKER_DIR`: the adapter forwards that optional variable to runner panes and would change exact-argv fixtures unnecessarily.

The original wiring test only isolated CommDB and touched global lifecycle state. Keep that incident receipt in `implementation-evidence.md`; an unchanged-assertion pass under the old environment is not isolation proof. Full package verification is being repeated through the wrapper.

Run `pnpm exec tsx engineering/doc/FLY-2557-epic-intake/render-intake-fixture.mts /tmp/fly2557-intake-visual` to create synthetic pending-card HTML and JSON. This artifact uses no real channel, Epic or publication token. It is a local renderer check, not the hosted/live receipt above.

Run the integration fixture with `VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run src/__tests__/epic-intake.e2e.test.ts`. It connects real StateStore, canonical event reconstruction, MailboxQueue, recipient ACK, scan invalidation and page rendering; Linear collection is synthetic.
