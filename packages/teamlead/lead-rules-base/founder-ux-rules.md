# Brainstorm-with-founder gate — default ON for every substantial issue (FLY-598 / FLY-869)

This project enables the **founder-UX gate** (`founder_ux_gate.mode != off`) — which, since
FLY-869, is the default even when the project's `.flywheel/config.yaml` says nothing about
`founder_ux_gate` at all. **Every substantial issue is gated by default.** You do NOT need to
label an issue to put it in scope — that is the old (FLY-598) opt-in behavior. The gate now
only needs your action to take an issue **OUT** of scope.

**Default: every substantial issue must be brainstormed and aligned with the founder (Annie)
before implementation begins.** This includes UX Annie will see or operate (notifications,
flows, Discord messages, report layouts, command interactions, visuals, copy) **and** anything
else with real product/architecture judgment calls — not just visual UX.

**Only trivial / purely mechanical work may skip the gate.** If — and only if — an issue is
truly trivial (a typo fix, a one-line config bump, a mechanical rename, dependency bump with
no behavior change, etc.), apply the Linear label **`brainstorm-exempt`** when you create/triage
it. That label is the record of YOUR judgment that this issue needs no founder alignment —
there is no hardcoded classifier. When in doubt, do NOT apply the label — let the gate run.
(The legacy `founder-facing-ux` label from FLY-598 still puts an issue in scope if applied, but
it is redundant now — every issue is already in scope unless exempted.)

**Why it matters:** for any non-exempt issue, the Bridge will HARD-BLOCK the Runner from
entering `implement` until the plan/approach has been brainstormed with Annie and **she
herself** has approved it (her natural-language "可以/好/OK" in the issue's Discord thread,
which you then record). This exists because building things without first agreeing the
approach with Annie produces things she doesn't want. Don't try to approve on Annie's behalf —
only her own message counts; the Bridge verifies it server-side.

**Recording her sign-off:** once Annie approves in the thread, record it so the gate opens:

```
node <flywheel-comm> record-founder-ux-signoff --exec-id <execId> --ux-file <ux-brief> --annie-msg-id <her Discord message id>
```

The Bridge fetches that exact message, verifies it is from Annie and in this issue's thread, and
only then writes the sign-off (bound to the current UX-brief).

**Project override:** a project can dial this down via `.flywheel/config.yaml`:

```yaml
founder_ux_gate:
  mode: enforce # default when the key is absent entirely
  exempt_labels: # optional — defaults to ["brainstorm-exempt"]
    - brainstorm-exempt
```

Setting `mode: off` returns to the fully-inert pre-FLY-598 behavior (no gate, no prompt change).
`mode: audit_only` keeps the judgment prose and records sign-offs, but never blocks `implement`.
