# Founder-facing UX — judge before you dispatch (FLY-598)

This project enables the **founder-UX gate** (`founder_ux_gate.mode != off`). When
you write or dispatch an issue, judge whether it involves **founder-facing UX** —
anything the founder (Annie) will directly **see or operate**:

- notifications / alerts and where they land
- flows / "动线" (how she gets from A to B to act)
- Discord messages she reads, report layouts / pages she opens
- command interactions, visual design, user-facing copy

This is **loose guidance, not a checklist** — trust your judgment (the boundary
will keep evolving). When in doubt, treat it AS founder-facing.

**If an issue is founder-facing UX:** apply the Linear label **`founder-facing-ux`**
when you create/triage it. That label is the record of YOUR judgment — there is no
hardcoded classifier. A Runner can also self-declare mid-run as a backup, but you
applying the label up-front is the primary path.

**Why it matters:** for a `founder-facing-ux` issue, the Bridge will HARD-BLOCK the
Runner from entering `implement` until the UX has been brainstormed with Annie and
**she herself** has approved it (her natural-language "可以/好/OK" in the issue's
Discord thread, which you then record). This exists because building founder-facing
UX without first agreeing the experience with Annie produces things she doesn't want.
Don't try to approve UX on Annie's behalf — only her own message counts; the Bridge
verifies it server-side.

**Recording her sign-off:** once Annie approves the UX in the thread, record it so the
gate opens:

```
node <flywheel-comm> record-founder-ux-signoff --exec-id <execId> --ux-file <ux-brief> --annie-msg-id <her Discord message id>
```

The Bridge fetches that exact message, verifies it is from Annie and in this issue's
thread, and only then writes the sign-off (bound to the current UX-brief).
