# FLY-1942 通信层防线三件套 — C5 实施证据
Issue: FLY-1942 (https://linear.app/geoforge3d/issue/FLY-1942/通信层防线-三件套发信短-id-静默死信-bot-永久偷听-guard-误拦并-19431953)
日期: 2026-09-11
基于: plan.md

## Scope and implementation

Implemented frozen M3 TypeScript subscription state, ledger, accepted-only wiring, discovery reconciliation, router callback, explicit roundtable configuration and both runtime startup paths. Socket/CLI and shell launcher changes are owned by the parent/other implementation worker and have separate receipts.

- Registry preserves no-argument construction, add(string), list(), has(), oldest(), size. New pure plans compute TTL, touch, cap eviction, restore domain/expiry/duplicate/cap filtering; only commit changes authority for durable callers.
- Ledger parser is read-only, validates top-level schema and every entry, and preserves dropped-entry reasons. Snapshot writes use unique wx/0600 temporary files, rename and cleanup. Corruption is quarantined to unique names; audit is best-effort and rotated.
- Route resolution no longer subscribes. Only accepted new journal entries call topic engagement; accepted socket batches also call the accepted-input callback. Persist failure keeps registry/source unchanged. Touch persists but intentionally does not audit (plan M3).
- Discovery never creates subscriptions from joined Discord threads. It removes through the durable callback and repairs missing source slots for existing active subscriptions.
- Runtime config consumes only explicit roundtable parent, carries bounded TTL, and does not add roundtable variables to the model-child allowlist. Both runtime inbox servers expose the shared list/remove handlers.
- Production runtime startup callbacks invoke exported runtime-specific startup functions that await restoreState before gateway.start, then activateSource after handlers are installed. Restore failure prevents inbound gateway startup entirely.
- During activation, restored membership is rechecked after each awaited dynamic drain. An unsubscribe during an earlier drain cannot resurrect a later captured entry.

## TDD receipts

1. New registry tests initially failed `planAdd is not a function` / `planRestore is not a function`; minimum implementation made them green. One intermediate failure distinguished duplicate from cap drops; classification fixed before green. Existing registry tests unchanged and green.
2. Ledger test initially failed module resolution because ledger did not exist; implementation passed two initial tests.
3. Durable wiring tests initially failed `restoreState is not a function` (3/3); implementation passed.
4. Discovery tests changed to the approved semantics before implementation: 4 expected failures (new interest minted, existing slot not repaired, durable remove callback not invoked, expired/removed thread resurrected); all 5 passed after implementation.
5. Router callback regression first needed fixture-constructor correction, then failed expected `spy called 2 times, got 0`; callback implementation passed all 26 router tests.
6. Explicit-parent/default-TTL tests failed 5 expected assertions before runtime config change; 11 config/wiring tests passed afterward.
7. Both production startup entry points initially failed `start is not a function`; implementation passed. Stronger real-ledger A/B preservation and backlog C tests pass for both runtime-specific startup functions, and the existing real RestPoll downtime-drain test passes with restored ledger interest.
8. Restore-loop unsubscribe race regression failed with two source additions rather than one. Rechecking membership before each awaited restore addition made all 8 wiring tests green.

## Verification receipts and limits

- `pnpm --filter flywheel-teamlead build`: first attempt failed TypeScript circular return-type inference in the changed runtime startup closures. Explicit Promise<void> annotation fixed the issue; retry exited 0. This package build preceded the final test additions and minor cleanup; parent owns final full-repository build/lint/test gates.
- Focused aggregate (15 files, 249 tests) exited 0. It included state, ledger, wiring, startup, unchanged registry and five protected consumer suites, discovery, router, both full runtime suites, and actual RestPoll startup ordering.
- The subsequent narrow restore-loop race fix has an independent green receipt: wiring suite 8/8. Aggregate total including this additional test is 250, pending parent final aggregate/full gates.
- Scoped Biome checks passed after formatting. No untouched consumer tests or approved plan were edited.
- Executable tests cover no creation for gateway durableAccept retry, journal write failure, duplicate and expired replay; new accepted mention recreation; atomic cap+evict snapshot; source failure followed by restart repair; wrong-parent/expiry/duplicate/cap normalization; abandoned temporary files; unique corrupt quarantine; TTL sweep; manual unsubscribe and restart absence; and persist-failure startup authority.
- No real Discord/host runtime replay, service restart, deployment, push or commit was performed by this worker. The production replay remains conditional on an authorized running Codex Lead, as stated in research.md.
