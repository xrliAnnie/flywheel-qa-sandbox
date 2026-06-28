# Auto-QA Pipeline (FLY-579)

> Loaded by every department (non-cos) Lead. Describes the **automatic**
> independent-QA gate that sits between code review and the founder. The whole
> point is that this no longer depends on you remembering to run QA — the Bridge
> drives it. Your job is to **not get in its way** and to handle the two cases it
> hands back to you.

## What happens automatically (you do nothing)

When a Runner you own passes code review, opens its PR, and enters
`awaiting_review`, the Bridge **automatically**:

1. Spawns an **independent QA Runner** (a *different* session from the
   implementer — the implementer must never verify their own work), pinned to
   the exact reviewed commit.
2. **Holds the founder.** The approve/ship gate is NOT surfaced to the founder
   while QA is running. You will not see a "review required" relay for that
   session, and the gate question is held (not relayed, not timed-out).
3. Stamps the issue's `[FLY-XX]` thread with **🧪QA** and posts a "QA started"
   line.

You do **not** spawn QA by hand, and you do **not** surface the founder for a
session that is QA-held. The founder is genuinely never bothered before QA is
green — that is the contract.

## The two outcomes

- **QA PASS** → the Bridge posts an in-thread "ready to ship" notification and
  the approve gate surfaces to the founder through the normal relay. From here
  it is the ordinary founder-gated ship — merge/ship stay founder-only
  (founder-only-authority is unchanged).
- **QA FAIL** → the Bridge wakes the implementer Runner with the QA report
  (a `feedback_wake`, the changes-requested loop). The implementer fixes,
  pushes a new head, and re-requests review — which re-triggers a fresh QA. The
  **founder is not notified** on fail. If the implementer and QA deadlock
  (≥3 rounds), that escalates to you, not the founder.

## When the pipeline itself is stuck

If QA can't proceed — the spawn failed, the QA Runner died without a verdict, or
a fail-closed `pr_head_sha` — you get an **`auto_qa_stuck` alert in your alert
channel** (an error, NOT a founder notification). Investigate the QA Runner /
re-dispatch as needed. The founder stays out of it until QA is genuinely green.

## Rollout / scope

- Auto-QA is **per-project opt-in** (`qa.auto: true` in the project's
  `.flywheel/config.yaml`, read from the canonical root). Default off =
  byte-compatible: a project that hasn't opted in behaves exactly as before.
- Global kill-switch: `FLYWHEEL_AUTO_QA=0` disables it everywhere.
- Per-issue override: a Linear `no-qa` label skips auto-QA for that issue;
  `qa.skip_labels` (e.g. docs/chore) skip by label.
- It composes with the founder-UX gate (FLY-598, the front end) and the
  founder-only-authority contract (merge/ship still founder-gated). Auto-QA only
  decides **when** the founder is surfaced — never **whether** a merge happens.
