# Default-Enable Policy — ship built features ON, not dormant (FLY-707 / FLY-698)

Flywheel keeps shipping features that are **built, merged, and deployed — but
never turned on**, because they hide behind a per-project opt-in that nobody
flipped. Real cases: ponytail (FLY-615), the token channel, and the auto-QA
pipeline (FLY-579) — auto-QA was live for weeks yet *never fired once* for the
flywheel project, because its `qa.auto` config key was simply absent (default
OFF). This is the FLY-698 enablement disease, and it wastes the whole build.

## The rule

**A feature that is built and applicable to your project ships ENABLED by
default — not dormant.** When a capability lands behind a per-project opt-in,
turning it on for your project is **part of shipping it**, not a separate
follow-up that gets forgotten.

Opt-ins come in two shapes; both count:

- **Config opt-ins** in `<your-project>/.flywheel/config.yaml` — e.g.
  `qa.auto: true`, `doc_flow.enabled: true`, `proofshot.enabled: true`. These
  are repo changes and ship in the feature's PR (or a fast-follow enablement PR).
- **Deployment env flags** (`FLYWHEEL_*`) set in the production launchd / wrapper
  / `~/.flywheel/.env`. Distinguish the two flag idioms before touching anything:
  a flag read as `=== "1"` is **default-OFF opt-in** (set it to enable); a flag
  read as `!== "0"` is a **default-ON kill-switch** (already on — do NOT "enable"
  it, there is nothing to do, and forcing it can only break the escape hatch).

**Verify it really fires — do not just merge the flag.** A config diff that
parses is not proof the feature runs. Confirm the live behavior (a real session,
a 529-Room run, or a regression test that drives the actual code path with the
canonical config). "Enabled" means *observed firing*, not *key present*.

## Hard exemptions — NEVER auto-enable these

The default-enable rule applies to **user-facing and workflow features**. It does
**NOT** apply to security / governance / safety gates. Flipping those ON does not
"unlock a feature" — it *restricts or blocks* the pipeline, and they are designed
for a deliberate, staged rollout with a calibration corpus. Blindly enabling them
can wedge merge/ship for the whole fleet.

Exempt (leave at their shipped default unless the founder approves a dedicated
rollout — and then `audit_only` before `enforce`, never straight to `enforce`):

- **`founder_consent` / `FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE`** (FLY-175) — the
  server-side hard gate on merge / ship / runner-lifecycle actions.
- **Branch-protection / merge gates** and anything whose "on" state *enforces
  consent* or *blocks the pipeline* rather than adding a capability.

Also do **not** auto-enable:

- A flag the **founder explicitly told you to keep off** (e.g. ponytail / FLY-615
  — Annie said do not enable). An explicit "off" instruction wins over this policy.
- A feature that is **inapplicable** to your project — enabling it only adds
  noise (e.g. `proofshot` visual capture on a pure-backend project with no UI).
  Skip it and say so in one line; don't enable for completeness' sake.

## When unsure

If a flag's category is ambiguous (capability vs governance gate), or enabling it
has a blast radius beyond your project, **list it for the founder and ask before
flipping** — never blind-enable a gate you cannot clearly classify as a
user/workflow capability.
