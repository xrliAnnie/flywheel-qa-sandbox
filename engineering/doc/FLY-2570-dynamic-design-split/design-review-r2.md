# FLY-2570 动态设计分流 — 第二轮设计评审修订
Issue: FLY-2570 (https://linear.app/geoforge3d/issue/FLY-2570)
日期: 2026-09-14
基于: plan.md

Round 2 CHANGES_REQUESTED: lock-no-stale-reclaim-deadlocks-emergency-set.

Verified existing packages/config/src/mkdir-lock.ts already implements PID liveness, process-start identity, unique holder token, exact-marker stale removal and protected release. Revision 3 reuses that primitive instead of inventing an unrecoverable lock file. Tests cover killed child -> automatic set 0 recovery and live-owner protection. Empty orphan before marker publication follows existing 120-second fallback with operator retry guidance.

Also address related advisories: Fable network/keychain reads occur before locking; locked re-read builds update against latest authority, so a percentage update during probe is preserved. Both writers use real parent directory plus basename, with an explicit aliased-parent mutual-exclusion test including absent authority on first create. No changes to generic mkdir-lock semantics or fleet credentials.
