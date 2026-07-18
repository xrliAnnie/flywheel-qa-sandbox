# FLY-1182 生产 Claude 账号池重建证据

Issue: FLY-1182
日期: 2026-07-16 (America/Los_Angeles; journal 时间为 UTC)
基于: plan.md / qa-report-phase3.md / recovery-runbook.md

## Verdict

**PASS — 5/5 production slots rebuilt and verified; finalActive is `personal`;
the quota daemon remains monitor-only and the journal is durably parked at
`awaiting_1252`.** No `promote-enabled` command ran, and the frozen production
config remains `trigger5hPct: 100`, `order: []`.

This evidence proves the pool and final machine identity are internally
consistent. It does **not** claim that automatic switching is enabled. FLY-1252
precheck plus the supervised Annie GO/unfreeze remain separate authority.

## Frozen transaction preconditions

| Item | Observed fact |
|---|---|
| Reviewed code head | `57341432066f0e896fc83f4ae7bcf2a4b539ae6e` (cross-family review APPROVED) |
| Candidate runtime tree | `743e76d8c24caa431712ae33173b0c1eeecda792ee78a61772b064083339a693` |
| Candidate plist | committed `candidate-quota-monitor.plist`; sha256 `ab3dde3a7d5015cf3809efb0f15c7506d7943dbce35afa2bb401f4d4f9ab1553` |
| Frozen config | mode 0600; sha256 `9ffa886d33fc059e0acb434f498afdfe11cfbeaa37a3ca7e8b8e1391a6cbfbe9`; `100 / []` |
| Config preimage | mode 0600; `quota-monitor.json.pre-freeze-fly1182-20260716`; sha256 `1c26820b7748e582f3be47e9bb36e1ed9a357d2c8a38b6ff308ff5c8647e80fa` |
| Identity map | installed mode 0600; installed/evidence sha256 both `9ecd961a350f05e06639f89f11a5eb08caeab2a934466cf262453dc480d5cc07` |
| Rebuild latch | `mapped` → `slots_rebuilding` only after candidate PID/runtime health and frozen-config CAS matched |

Production mutations were run by the unsandboxed host operator one exact command
at a time. Before every capture, the browser login had to report `Login
successful` for the expected account and a separate read-only
`~/.claude.json.oauthAccount` check had to match its email and UUID. No token or
credential bytes were printed; all five credential files finished mode 0600.

## Slot ledger

| Order | Slot | Confirmed identity | Account UUID | Journal `verifiedAt` (UTC) | Pool verify |
|---:|---|---|---|---|---|
| 1 | `business` | `xrliannie.b@gmail.com` | `4e4bb360-6236-4149-bc9f-6fad33998f24` | `2026-07-17T02:16:38.916Z` | `source=pool verdict=match` |
| 2 | `personal1` | `xrliannie.1@gmail.com` | `6a3830af-c47d-4816-a605-299a340f6db2` | `2026-07-17T02:23:56.144Z` | `source=pool verdict=match` |
| 3 | `school` | `xiaorongli2011@u.northwestern.edu` | `eb20288e-09ed-4584-8522-617bebbc0241` | `2026-07-17T02:34:44.806Z` | `source=pool verdict=match` |
| 4 | `shopping` | `xrliannie.shopping@gmail.com` | `8e29f51d-5748-4dcb-a366-6a83e4191c2e` | `2026-07-17T02:47:24.559Z` | `source=pool verdict=match` |
| 5 | `personal` | `xrliannie@gmail.com` | `f2caedf8-4d28-4c01-9fdf-498a45d49e79` | `2026-07-17T02:57:22.702Z` | `source=pool verdict=match` |

Per slot the sequence was fixed: `anchor --migrate` → inspect anchor identity →
`capture` → inspect mode/display identity → `verify --source pool` →
`mark-slot-verified`. The final `personal` browser login was intentionally last,
so no later login could move Keychain away from finalActive.

### Fail-closed path observed live

The first `mark-slot-verified business` attempt exited 1 before a journal write:
its internal verifier resolved the canonical checkout's older
`flywheel-claude-profile`, while the direct reviewed-worktree verifier had
already returned `match`. The journal correctly remained `business=pending`.

The retry used the maintenance CLI's existing explicit contract:
`FLYWHEEL_CLAUDE_PROFILE_BIN=<reviewed-worktree-bin>`, together with the reviewed
quota-monitor dist and candidate plist paths. It succeeded. Every later mark and
the final commit carried all three explicit paths. This is evidence that a
verification/path mismatch fails closed rather than consuming the slot.

## Journaled commit and post-commit verifier

The guarded `commit` command ran with the audible FLY-913 restart-bypass reason,
all reviewed worktree paths pinned, and **without** `promote-enabled`. It stopped
the candidate daemon, reverified all five pool profiles plus finalActive
Keychain, reconciled machine witnesses under locks, restarted monitor-only, and
reported:

```json
{
  "stage": "awaiting_1252",
  "verifiedSlots": 5,
  "totalSlots": 5,
  "targetGeneration": 4,
  "finalActive": "personal",
  "actualConfigSha256": "9ffa886d33fc059e0acb434f498afdfe11cfbeaa37a3ca7e8b8e1391a6cbfbe9",
  "consistent": true,
  "errors": []
}
```

Independent post-commit reads at journal `updatedAt=2026-07-17T03:01:12.423Z`:

- `flywheel-claude-profile verify personal --source keychain` → exit 0,
  `verdict=match`;
- pool `.active=personal`;
- `~/.claude.json` → `xrliannie@gmail.com`, UUID
  `f2caedf8-4d28-4c01-9fdf-498a45d49e79`;
- account store → `generation=4`, `activeAccount=personal`,
  `identityStale=false`, all five auth-failure flags false;
- quota state → `observedGeneration=4`, no pending detection/confirmation;
- `resolveMachineAccount(...)` → `{kind:"resolved",name:"personal"}`;
- launchd job → committed candidate plist, running as PID 96314;
- health marker → same PID/start time, reviewed runtime tree `743e76d8…`,
  `outcome=local_scan` (fresh at `2026-07-17T03:03:12.170Z`);
- production config → unchanged mode 0600, hash `9ffa886d…`, `100 / []`.

Across the full five-slot window, no existing Runner/Lead was closed, restarted,
killed, or redispatched. Unrelated new dispatches and the attended browser-login
session were not existing-runner interruptions. Existing Claude processes were
not migrated; the v1 recovery boundary in `recovery-runbook.md` remains unchanged.

## Authority boundary

- Do not run `promote-enabled` from FLY-1182.
- Do not restore the candidate order or lower `trigger5hPct` from the frozen
  values before the FLY-1252 precheck and supervised GO.
- Do not describe `awaiting_1252` as “automatic switching is active.”
- The durable resumption cursor is the production rebuild journal. The Flywheel
  `progress` command was attempted after the first slot but refused because this
  execution is already `awaiting_review`; the journal, not a hand-edited
  `progress.md`, therefore records the live transaction.
