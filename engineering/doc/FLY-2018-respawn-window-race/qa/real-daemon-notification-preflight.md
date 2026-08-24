# FLY-2018 real Codex daemon notification preflight

Date: 2026-08-23
Codex CLI: `0.149.1`
Command: `node engineering/doc/FLY-2018-respawn-window-race/qa/real-daemon-notification-preflight.mjs`

The harness copied the current Codex configuration and credentials into a
temporary `CODEX_HOME`, expired only the copied access token, replaced only the
copied refresh token, ran a real `codex app-server --remote-control`, then
removed the complete scratch directory. It did not mutate the source home or
print credential values.

## Results

| Question | Observed answer |
|---|---|
| Terminal turn error method/path | `turn/completed.params.turn.error` |
| Stable error code | `params.turn.error.codexErrorInfo === "unauthorized"` |
| Error text | `params.turn.error.message` |
| Independent turn ownership authority | `turn/start` response contains `result.turn.id` |
| Pre-response ordering | `turn/started` arrived before the `turn/start` response and carried the same nested `turn.id` |
| Stale-completion discriminator | `turn/completed` carries top-level `threadId` plus nested `turn.id`; capture can require both the owned thread and a turn ID claimed from the RPC response |
| Goal/result behavior | Goal moved to `blocked`; current `GoalRunResult` omitted the turn error, reproducing Fix A's RED baseline |

Observed sequence: goal active → `turn/started` → `turn/start` response → goal
blocked → `turn/completed(error=unauthorized)` → `GoalRunResult(status=blocked)`.

The production design therefore uses a bounded pre-response buffer and claims
only the turn ID returned by `turn/start`. `turn/completed` never self-registers
ownership; a mismatched or unclaimed turn remains diagnostics only.
