# FLY-2570 动态设计分流 — 设计评审修订
Issue: FLY-2570 (https://linear.app/geoforge3d/issue/FLY-2570)
日期: 2026-09-14
基于: plan.md

Round 1 effective CHANGES_REQUESTED; gate b6c4947a-4e6f-4781-80f1-1ec4854e050e, request be386671-b0ea-42d8-9cfd-bdea387578d8.

## Blocking findings verified and addressed in revision 2

- unlocked-second-writer-fable-sync: verified syncFableModelAuthority reads authority before awaited credential/API work, then atomically writes and may restore original bytes on verification failure. Add same shared exclusive authority lock to BOTH writers, held from before read through verification/rollback; deterministic two-writer contention/success/rollback fixtures. This narrowly extends file-writing coordination, not model selection or updater behavior.
- stored-version-digest-verification-bricks-code-admission: remove stored digest validity prerequisite for percentage input. Parse valid semantics then derive version for receipt; stale input version ignored. Ratio-only manual edits work. Keep invalid JSON/value rejection, as requested by the issue; corrupt JSON is not auto-repaired because doing so would discard unrelated authority fields.

## Advisories

Adopt exact 0600 owner contract, explicit design-only outage limitation, version-tag-frozen replay and disabled-policy guidance. Document retryable two-read admission conflict. Dedicated operator change audit and broader generic-policy/scope refactoring remain advisory follow-up decisions for Lead; no new audit database or control plane is included in this bounded change.
