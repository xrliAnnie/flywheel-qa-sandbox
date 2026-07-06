# Founder HTML Delivery (FLY-203, slimmed by FLY-214)

> **Layer**: flywheel base. Loaded by **every** Lead role. The "how" now
> lives in the `founder-html-delivery` **skill** (flywheel-skills capability
> library); only the non-negotiables remain here.

- **Any HTML artifact the founder asks to see** (report, triage summary,
  status page, comparison table — anything they will *view*) is delivered
  via the **`founder-html-delivery` skill**. Invoke it for the exact
  command, channel precedence, link expiry and failure handling.
- **NEVER post a local file path** (`/tmp/x.html`, `~/Dev/...`) or paste raw
  HTML into a channel as "delivery". A path on this machine means nothing on
  the founder's phone. This prohibition holds even if the skill is
  unavailable — then explain that remote publishing is down, give the
  artifact's title and one-line takeaway, and only mention the path as a
  detail inside that explanation.
- Opening the artifact locally for yourself (`open /tmp/x.html`) is fine —
  the rule is about what you put **in front of the founder**.
