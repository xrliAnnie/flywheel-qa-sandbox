# Founder HTML Delivery (FLY-203)

> **Layer**: flywheel base. Loaded by **every** Lead role (department leads
> AND cos-lead). Voice is generic — refer to abstract slots like `the founder`
> and `your project's channel`. The project layer (`<project>/.lead/shared/…`)
> may add concrete channel IDs and project names.

---

## When this rule applies

**Any time the founder asks you to produce something in HTML for them to
look at** — a triage summary, a ship review, a status page, a comparison
table, a change list, any HTML artifact whose audience is the founder. Not
just things called "reports": if the founder will *view* it and it's HTML,
this is how you hand it over.

The founder is frequently on a phone with only Discord. A file on this
machine does not reach them. This pipeline is what does.

## The reply format (fixed)

Generate the HTML locally as usual, then deliver it with:

```bash
flywheel-comm publish-report \
  --html /tmp/<your-artifact>.html \
  --project <projectName> \
  --title "<short human title>"
```

This publishes the artifact to an unguessable hosted URL and posts ONE
Discord message: **title + full-page image + link**. The image lets the
founder scan the structure at a glance; the link opens the real HTML for
reading on any device. That one message IS your delivery — your follow-up
reply should reference it (and include the returned URL), not re-send the
content another way.

**The link is valid for 7 days** (it expires automatically afterwards —
a privacy requirement). If the founder asks for the artifact again after
it has expired, simply run `publish-report` again: same command, fresh
link. Do not treat an expired link as an error to investigate.

Example: the founder says "把这几个方案整理成一页 HTML 给我看" — you build
the page, run `publish-report` with a title like "方案对比 — <topic>", and
reply in the conversation where they asked, pointing at the delivered
message/link.

## Never do this

- **Never post a local file path** (`/tmp/x.html`, `~/Dev/...`) into a
  channel as the way to "share" an HTML artifact. A path on this machine is
  meaningless on the founder's phone. A path is not delivery.
- Do not paste raw HTML or giant text dumps into the channel as a
  substitute.

Opening the artifact locally for yourself (e.g. `open /tmp/x.html`) is fine
and unaffected — local viewing and remote delivery coexist. The rule is
about what you put **in front of the founder**.

## Where the message lands (precedence)

- Default: the project's general channel (`--project` resolves it).
- If the founder asked inside a specific issue thread or channel and the
  artifact belongs there, pass `--channel <id>` so the delivery lands where
  the conversation lives.
- This artifact-delivery path intentionally complements — not replaces —
  the issue-bound reply discipline: your **text** replies about an issue
  still go through the canonical issue thread as the existing rules
  require; the **HTML artifact** travels via `publish-report`, and your
  issue-thread reply links to it.

## Mechanics you can rely on

- The HTML must be a complete document (with a `<head>`) and ≤512KB.
  Artifacts built from the standard templates already satisfy this.
- stdout is exactly one JSON envelope. `"delivered": true` plus a `url`
  means success — quote that URL in your follow-up.
- A screenshot failure degrades automatically to a link-only message. That
  still counts as delivered; do not retry just to attach an image.
- Links expire after 7 days (see above) — re-publish on request, never
  hand out local paths as a substitute for an expired link.

## When publishing fails

If the command exits non-zero (Bridge down, hosting failure, channel not
resolvable), **fall back to a clear explanation in the channel**: say that
remote publishing failed, give the artifact's title and one-line takeaway,
and only then mention the local path so a human at the machine can open it.
A bare path with no context is still not acceptable — the explanation is
the fallback, the path is a detail inside it.

## Why this is a rule and not a tip

HTML artifacts used to be generated and opened locally only. The founder
asked for exactly this delivery shape (full-page image to scan + link to
read) after comparing the alternatives on a real phone. Posting paths or
skipping delivery silently re-creates the problem this pipeline was built
to solve.
