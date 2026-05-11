# Lead → Runner Messaging — FLY-142 PR 1.4 Cutover

When you (the Lead) need to message a Runner agent, choose the path by purpose:

## Ordinary chat / non-gate instructions → `SendMessage` MCP tool

- For everyday "talk to Runner" — context handoff, status checks, follow-up
  questions, course corrections, "please look at X", etc. — use the **`SendMessage`**
  MCP tool (claude-code teammate API).
- The Runner's stock `useInboxPoller` reads its mailbox at
  `~/.claude/teams/<your-id>/inboxes/<runner-id>.json` on its own loop and
  injects your message directly into the Runner's conversation as a new turn.
- This path is **vendor-neutral** (works for Codex/other Runners once their
  adapters land) and **bypasses the buggy `inbox-check.sh` hook** that was the
  root cause of FLY-142 (hook only read `type='instruction'`, dropping
  `type='response'`).

## Hard gate responses → `flywheel-comm respond` CLI (still required, Batch 2 will replace)

- For unblocking a `gate_question` Runner is waiting on (the Runner is sitting
  in `flywheel-comm gate wait` polling CommDB), you **must still** use:
  ```bash
  flywheel-comm respond --db <DB-path-from-gate-question> \
    --lead <your-id> <question-id> "<your-reply>"
  ```
- The Bridge bootstrap message includes the exact command for each pending
  gate question — copy-paste it.
- Why this still uses CommDB: the Runner's gate-wait loop polls CommDB
  directly via `getResponse(questionId)`. It does NOT go through the
  `inbox-check.sh` hook, so it is unaffected by the FLY-142 wake bug. PR 1.4
  preserves this path; **Batch 2 PR 2.1** will replace it with await-mcp +
  `StructuredInboxRouter`.

## Quick decision table

| Scenario | Path |
|---|---|
| "Hey Runner, can you also look at file X?" | `SendMessage` |
| "Status update — Annie wants ETA" | `SendMessage` |
| Approving `approve_to_ship` gate | `flywheel-comm respond` |
| Answering a `clarify_question` gate | `flywheel-comm respond` |
| Asking the Runner to abort | `SendMessage` (Runner cooperatively stops) |

## Sentinel safety net

Even if you accidentally use `flywheel-comm respond` for an ordinary message,
the Runner's `inbox-check.sh` hook now short-circuits to a no-op when the
`~/.flywheel/runner-state/<exec-id>/mailbox-active` sentinel is present
(written automatically by TmuxAdapter at Runner spawn). The message will land
in CommDB audit but **will not be delivered** to the Runner conversation. So
if the Runner doesn't acknowledge, switch to `SendMessage` and try again.

> Rollback: `FLYWHEEL_COMM_BACKEND=commdb` env var on the Bridge daemon
> reverts to the legacy CommDBLeadRuntime (Bridge → Lead via CommDB), and
> ops can `rm -f ~/.flywheel/runner-state/<exec-id>/mailbox-active` to
> re-enable the buggy CommDB hook polling for that Runner. Use only as a
> last resort during the PR 1.4 rollout window.
