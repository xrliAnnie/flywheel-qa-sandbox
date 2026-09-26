# FLY-2910 production replay reconciliation

This is an observed-through capture, not full-day acceptance. Requested window: 2026-09-25 00:00 PT through 2026-09-26 00:00 PT (UTC 2026-09-25T07:00:00Z–2026-09-26T07:00:00Z).

Captured at **2026-09-26T05:40:11.899Z** (2026-09-25 22:40 PT). Latest observed source row: **2026-09-26T05:40:04.716Z**. `coverageComplete=false`; rerun the same script after the requested day closes. No savings threshold is asserted.

| Window / generation evidence | Before wake batches | After wake batches |
|---|---:|---:|
| Observed through capture / verified | 202 | 178 |
| Observed through capture / hypothetical same correlation | 202 | 148 |
| Frozen design window 00:00–21:00 PT / verified | 152 | 134 |
| Frozen design window 00:00–21:00 PT / hypothetical same correlation | 152 | 107 |

The frozen verified result matches the design lower bound **152→134**. The production hypothetical result is **152→107**, compared with the earlier Python estimate **152→102**. The five added wakes are expected: the earlier Python replay wrote delivered evidence at each letter’s creation time (`replay_strict.py`, replay wake branch), while the production replay waits for real adapter receipts. These five letters all arrived before the earlier equivalent was delivered. Their body/fingerprint and assumed generation were equivalent, but delivered evidence did not yet exist. No equivalence rule was weakened to match the estimate.

Each exact future-receipt case follows; all timestamps are UTC:

1. `external_merge_suspect` at `2026-09-25T14:40:00.714Z`.
   Current delivery: `infra_alert:claude-infra-bot-lead:external_merge_suspect:external-merge:cde40019-9660-4888-83ce-837783e4e8fa:Unverified external merge — FLY-2877`.
   Earlier equivalent: `infra_alert:claude-infra-bot-lead:external_merge_suspect:external-merge:0ba846a7-e0f4-4498-be2b-3da6c67afaff:Unverified external merge — FLY-2877`.
   Its adapter receipt arrived at `2026-09-25T14:40:30.789Z`.

2. `external_merge_suspect` at `2026-09-25T18:12:53.101Z`.
   Current delivery: `infra_alert:claude-infra-bot-lead:external_merge_suspect:external-merge:f560992f-5c61-4062-b6e4-392c0c5743dd:Unverified external merge — FLY-2873`.
   Earlier equivalent: `infra_alert:claude-infra-bot-lead:external_merge_suspect:external-merge:d05037ae-c0c8-430f-82c3-3d0c4e0e396f:Unverified external merge — FLY-2873`.
   Its adapter receipt arrived at `2026-09-25T18:13:23.151Z`.

3. `workflow_engine_escalation` at `2026-09-25T19:12:18.214Z`.
   Current delivery: `chat:claude-infra-bot-lead:1553121990783672341`.
   Earlier equivalent: `chat:claude-infra-bot-lead:1553121976724230299`.
   Its adapter receipt arrived at `2026-09-25T19:12:18.897Z`.

4. `external_merge_suspect` at `2026-09-25T20:54:46.189Z`.
   Current delivery: `infra_alert:claude-infra-bot-lead:external_merge_suspect:external-merge:7adbf914-1ac0-4e6e-aba5-07b9a7399dcb:Unverified external merge — FLY-2867`.
   Earlier equivalent: `infra_alert:claude-infra-bot-lead:external_merge_suspect:external-merge:3f862011-3aeb-4137-8648-0b3f9d27f551:Unverified external merge — FLY-2867`.
   Its adapter receipt arrived at `2026-09-25T20:55:16.680Z`.

5. `external_merge_suspect` at `2026-09-25T20:54:46.252Z`.
   Current delivery: `infra_alert:claude-infra-bot-lead:external_merge_suspect:external-merge:2d64aa78-0e92-430f-85f9-d865fbdba287:Unverified external merge — FLY-2867`.
   Earlier equivalent: `infra_alert:claude-infra-bot-lead:external_merge_suspect:external-merge:3f862011-3aeb-4137-8648-0b3f9d27f551:Unverified external merge — FLY-2867`.
   Its adapter receipt arrived at `2026-09-25T20:55:16.680Z`.

Four cases are A-lane `external_merge_suspect` (one FLY-2877, one FLY-2873, two FLY-2867); the fifth is a B-lane `workflow_engine_escalation`. These exactly account for the +5 after-wake difference. The frozen sample has **zero unrecognized letters** after recognizing the canonical Discord envelope and the existing exact automated-message prefix `🤖[自动] `.

| Lead / observed window | Before | Verified after | Hypothetical after |
|---|---:|---:|---:|
| `claude-infra-bot-lead` | 187 | 163 | 133 |
| `flywheel-eng-lead` | 15 | 15 | 15 |

The live database has no `alert_wake_letter` table, so verified A-lane mappings are zero. Exact current root/thread lookup returned 53 B-lane mappings; these cannot recover overwritten older generations. Verified savings in this capture are the 24 info letters. The hypothetical result assumes equal correlation means the same generation and remains an unverified upper-bound estimate.

`replay-real.json` contains every decision, per-reason/per-Lead counts, and all **32** suppressed-delivery / already-delivered-equivalent proof pairs for the observed hypothetical replay (27 in the frozen comparison). Each pair is asserted to share Lead, fingerprint and assumed generation, with the receipt no later than the suppression decision. All batch members participate in before/after counting; a surviving non-alert member keeps a mixed batch awake. Retry-count-positive rows bypass the policy and remain wakes.

Run command (exit 0; stdout saved in `/tmp/fly2910-replay-final.log`):

```sh
pnpm exec tsx engineering/doc/FLY-2910-alert-wake-dedup/evidence/replay-real.ts --dispatcher-id 1524831623164596265 --dispatcher-source 'Configured FLYWHEEL_ALERT_SENDER_TOKEN_ENV credential user-ID segment, decoded locally without emitting credential'
```

The dispatcher identity came from the trusted configured sender credential’s user-ID segment, decoded only in memory; no credential was output or stored. Both source databases were opened read-only with query-only transactions and bounded queries; handles were closed before replay. Replay writes only fresh in-memory StateStores. Raw message contents are neither emitted nor committed. This is local replay evidence, not CI, QA, production deployment or full-day proof.

Production-source hashes frozen at this run:

- `packages/teamlead/src/StateStore.ts`: `7d8b9c8b2eb4830fedc85a0d5727d9534d457967ec83bf73a0f7ab368d244f84`.

- `packages/teamlead/src/bridge/alert-wake-dedup.ts`: `e753f8c29d28469398ca3304b0b54de81b755825ff12ccc6bb5ab819ce0f59ac`.

Source-row digest: `110b625d535a29878d6a6a09189c3bf49b1d0d01c6a867b4ca5ce506ae136421`.
