# FLY-2471 语音运行恢复 — 探索
Issue: FLY-2471 (https://linear.app/geoforge3d/issue/FLY-2471)
日期: 2026-09-10
基于: 无

## Scope and current evidence

Only the two FLY-2446 follow-ups are assigned: isolate throwing/hanging runtime provisioning and coalesce repeated poll-failure status with exponential backoff.

At onboarding HEAD `d964e9fca`, `voice-session-runtime.ts` awaits each provision without a per-session catch or timeout. Its outer finally releases `ticking` after rejection, so rejection aborts the current tick rather than permanently retaining the lock. A never-settling promise does retain the lock and prevents subsequent ticks. A repeatedly throwing first provisioning candidate can starve later candidates and polling.

Poll failures call `reportPollFailure` every tick; services posts the same Discord status every time. Reporter rejection also interrupts the current tick.

The provisioner has durable step and epoch checks but accepts no AbortSignal. A runtime timeout alone must not allow late provisioning work to continue issuing effects or writing state after cancellation. Implementation needs to inspect cancellation propagation and existing restart/replay tests before choosing the minimum change.

No FLY-2471 upstream plan or progress ledger exists on the assigned clean branch. TURN returned yours, implement epoch 1. Requested the pinned design handoff or bounded design preparation authorization from Lead under question `a1590a4b-32a2-479e-8a01-86de627e1580`. No implementation has started.
