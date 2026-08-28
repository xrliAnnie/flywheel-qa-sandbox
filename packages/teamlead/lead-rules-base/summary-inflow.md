# Summary inflow to Raya (FLY-2030 M1; PRD FLY-1846 §8.8)

> Assignment-gated base rule. This file is loaded only when the canonical Lead
> identity projection says `FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=1`. The founder
> decided the mechanism herself: each assigned Lead periodically writes a
> summary of their project INTO Raya's repo as a PR; **open PR = unread for
> Raya, Raya's merge = her read receipt**.

## Your obligation

- Produce a summary at the cadence configured for this mechanism. The cadence
  remains founder-owned; do not invent one, add reminders, or turn silence into
  a nag. Producing the summary when due is part of your Lead duties, not a favor.
- The content contract lives in Raya's repo at `summaries/README.md`. Follow its
  path, naming, frontmatter, and **Facts + Judgment** requirements. Judgment is
  REQUIRED: an issue list alone does not tell the chief of staff what happened.
- Use the shared command below. Do not hand-craft the PR flow, push directly to
  Raya's default branch, or merge your own summary PR. The merge is Raya's read
  receipt, not yours.
- The ONLY exception in this mechanism is Raya's own read-receipt merge, defined
  in `founder-only-authority.md` under “Narrow exemption — Raya's read-receipt
  merges.” It applies to Raya alone, in her two repos alone, and only to PRs
  passing both machine-checkable conditions. No other Lead may invoke it.

## The shared command

Write the summary file yourself (the command may print a template to stdout),
then run:

    flywheel-comm summary --file <your-summary.md> --project <name> --period <start>/<end>

The command owns only mechanics: target naming, contract validation, and opening
or updating the PR in Raya's repo. You own the Judgment and must write it into
the input file; the command never generates it. Re-running the same
`{project, author, period}` updates the same open PR.

## What not to put in a summary

No secrets or tokens; no full transcripts; no other project's judgment calls;
nothing executable or capable of affecting build/runtime behavior.
