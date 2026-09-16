---
name: founder-html-delivery
description: Deliver a complete HTML report, comparison, status page or other founder-facing HTML artifact through the authorized report broker, verify the hosted page, and deliver one Discord message containing title, image and link.
metadata:
  skill-author: flywheel
  skill-version: 1.0.0-codex
---

# Founder HTML delivery

The founder often reads Discord on a phone. Deliver a hosted artifact, with one title + full-page image + link message. A local file path is not delivery. Apply this whenever the founder asks to view HTML, including comparisons and triage pages.

## Prepare and publish

Use the current activation's advertised `lead_operation` tools and schemas. Each operation uses the result-only envelope `{schemaVersion: 1, operationId, requestId, input}`. Assign a fresh UUID to a new logical operation; retry the identical operation with the same UUID. Never change a payload under an existing UUID or mint another UUID merely because a write result is unknown. Parent authorization controls the canonical project, Lead and issue; do not infer permissions from this skill.

1. Produce a complete HTML document with a head, at most 512 KiB of UTF-8. Escape user-derived content. Keep credentials and signed/private URLs out of the document. Use `artifact.text.create` with exactly `{mimeType: "text/html", text: <complete HTML>}`. It returns `artifactHandle`; a successful replay can return that handle in `resourceRefs` instead of repeating data. Handles belong to this activation. Do not manufacture a handle from a path.
2. Call `report.publish` with `{artifactHandle, title, issueId}`. Use the canonical issue where this artifact belongs and a short human title (at most 200 characters). Retain the succeeded result's `reportId` and hosted `url`. This is publish-only and sends no Discord message. A URL alone is not a delivery receipt.
3. Call `report.verify` with `{reportId}`. Require `httpStatus: 200`, `cspValid: true` and `nonceValid: true`. For an interactive page, open the returned hosted URL in the approved native browser and exercise its controls; inspect for leftover placeholders such as `__CSP_NONCE__`, missing content and console/CSP errors. Generated HTML or a successful delivery does not establish hosted behavior. Never claim a browser check that was unavailable.
4. Call `report.deliver` with `{reportId, issueId}`. The parent chooses the authorized canonical destination; there is no arbitrary channel override in this adapter. Retain the succeeded `channelId`, `messageId` and `delivery` receipt. `image-and-link` is the normal result; `link-only` is a valid delivery when screenshot capture fails. Do not resend merely to attach an image.
5. Reply in the conversation where the founder asked, referencing the delivered message and its retained hosted URL. Do not repost the artifact as another dump or another delivery. Issue-related text still follows canonical issue-thread discipline.

## Expiry and failure

Links expire after seven days. Republish on a later explicit request for an expired artifact, using a fresh operation identity for that new publication. Do not investigate normal expiry as a hosting incident.

On rejected/unknown/pending results, preserve the receipt and report the precise incomplete step. Read-only verification may clarify a known report's hosted state; it does not establish that an unknown delivery occurred. Do not guess a URL from an ID, claim a missing receipt, or blindly repeat a write. If remote publication is unavailable, explain the failure, artifact title and one-line takeaway in the authorized conversation. A local path may be a secondary detail for a human at that machine, never the means of delivery. Do not paste raw HTML or giant text dumps into Discord.

This Codex adaptation replaces the original shell publish-report invocation with typed parent operations. It neither invokes credential-bearing helper scripts nor changes publication/destination authorization.
