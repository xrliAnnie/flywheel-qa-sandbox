# Auto-QA Pipeline (FLY-579)

> Loaded by every department (non-cos) Lead. Describes the **automatic**
> independent-QA gate that sits between code review and the founder. The whole
> point is that this no longer depends on you remembering to run QA — the Bridge
> drives it. Your job is to **not get in its way** and to handle the two cases it
> hands back to you.

## What happens automatically (you do nothing)

When a Runner you own passes code review, opens its PR, and enters
`awaiting_review`, the Bridge **automatically**:

1. **Creates a separate `QA·FLY-XX` Linear issue** (its own issue + thread +
   runner — like the manual `QA·FLY-XXX` issues), mirroring the parent issue's
   team / project / labels, and spawns an **independent QA Runner** on it (a
   *different* session from the implementer — the implementer must never verify
   their own work), pinned to the exact reviewed commit.
2. **Holds the founder.** The approve/ship gate is NOT surfaced to the founder
   while QA is running. You will not see a "review required" relay for that
   session, and the gate question is held (not relayed, not timed-out).
3. Posts a 🧪 "QA started" FYI on the **parent** issue's thread (referencing the
   new `QA·FLY-XX` issue). The QA Runner stamps **🧪QA** on its own QA thread.

You do **not** spawn QA by hand, and you do **not** surface the founder for a
session that is QA-held. The founder is genuinely never bothered before QA is
green — that is the contract.

## The two outcomes

- **QA PASS** → the Bridge posts an in-thread "ready to ship" notification on the
  **parent** issue's thread and the approve gate surfaces to the founder through
  the normal relay. From here it is the ordinary founder-gated ship — merge/ship
  stay founder-only (founder-only-authority is unchanged).
- **QA FAIL** → the Bridge wakes the implementer Runner with the QA report
  (a `feedback_wake`, the changes-requested loop) and posts 🔴 on the
  **`QA·FLY-XX` issue's own thread** — **NOT** the parent thread (a non-green QA
  must never surface to the founder). **FLY-752: the SAME QA Runner is reused** —
  it does NOT terminate on fail; it parks (idle, resources released) and, when the
  implementer pushes a new head and re-requests review, the Bridge **re-tests with
  that same QA Runner** (`retest_wake`) — there is NEVER a fresh QA2/QA3 for an
  issue. The **founder is not notified** on fail; QA-fail is **Lead-facing** — you
  drive the dev-fix → QA-retest loop. If the implementer and QA deadlock (≥3
  rounds), that escalates to you, not the founder.

On **QA PASS** (and when a run is superseded), the Bridge **auto-closes** the QA
Runner — kills its cmux workspace + tmux window, archives its Discord thread, drops
its row — so QA sessions never pile up. You do not close QA runners by hand.

## When the pipeline itself is stuck

If QA can't proceed — the spawn failed, the QA Runner died without a verdict, or
a fail-closed `pr_head_sha` — you get an **`auto_qa_stuck` alert in your alert
channel** (an error, NOT a founder notification). Investigate the QA Runner /
re-dispatch as needed. The founder stays out of the QA **verdict** loop until QA
is genuinely green — but re-dispatching that replaces or ends an existing Runner
is reserved under **R2** of `founder-only-authority.md`, and a QA PASS is not a
close authorization.

## Rollout / scope

- **FLY-752: auto-QA is fleet-wide default-ON (opt-out).** Every project gets it
  unless it opts out. A project opts out with `qa.auto: false` in its
  `.flywheel/config.yaml` (canonical root); a MALFORMED qa config fails **closed**
  (off), never on.
- Global kill-switch: `FLYWHEEL_AUTO_QA=0` disables it everywhere.
- Per-issue override: a Linear `no-qa` label skips auto-QA for that issue;
  `qa.skip_labels` (e.g. docs/chore) skip by label.
- **FLY-752: auto-QA fires ONLY on a genuine fresh review-pass** — a session that
  is merely parked waiting for the founder (already surfaced / re-emitted) does NOT
  get a QA spawned.
- It composes with the founder-UX gate (FLY-598, the front end) and the
  founder-only-authority contract (merge/ship still founder-gated). Auto-QA only
  decides **when** the founder is surfaced — never **whether** a merge happens.
