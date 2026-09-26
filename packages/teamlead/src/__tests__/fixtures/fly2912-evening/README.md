# FLY-2912 frozen evening replay inputs

This fixture preserves all **257 Lead journal rows**, in their original order,
for `flywheel` / `flywheel-eng-lead` in
`[2026-09-26T01:30:00Z, 2026-09-26T04:00:00Z)` (September 25,
18:30–21:00 America/Los_Angeles). It verifies and sanitizes inputs only.
It contains no replay result, inferred wake count, or quiet-policy verdict.

The authoritative source hashes and counts are in
`engineering/doc/FLY-2912-quiet-notification-expansion/evidence/evening-manifest-v2.json`
and `producer-authority-manifest-v3.json`. All seven private exports matched
those hashes and counts before fixture generation. The private sources remain
at the controlled paths in those manifests and are not committed here.

| File | Rows | Meaning |
| --- | ---: | --- |
| `lead-events-v2.jsonl` | 257 | Original journal IDs, seq, timestamps, disposition, payload projection, and routing snapshot |
| `session-events-v2.jsonl` | 80 | Raw `stage_changed` producer payloads, linked by exact event ID |
| `mailbox-v2.jsonl` | 206 | Available mailbox rows, source references, batch IDs, delivery/retry/ACK timestamps |
| `direct-start-source-v3.jsonl` | 21 | Raw DirectEventSink start records; all original payloads are NULL |
| `dispatch-ledger-v3.jsonl` | 21 | Dispatch ledger observed after the window; no `purpose` column |
| `execution-binding-v3.jsonl` | 22 | Available execution/activation/attempt bindings and binding timestamps |
| `workflow-events-v3.jsonl` | 191 | Timestamped workflow events, including evidence after the window |

`manifest.json` records the original export hashes, sanitized file hashes,
counts, sanitization policy, and unresolved evidence. The same verification
record lives at the task's `evidence/replay-input-verification.json`.
`replay-index.json` has one entry per Lead input, including:

- Original input index, event ID, seq, timestamp, and observed journal disposition.
- Exact stage raw-event links and DirectEventSink source candidates. Direct start
  source IDs differ from notification IDs; correlation requires matching exact
  execution/issue/project/type/source and an earlier source timestamp. The
  recorded delay is 1–24 seconds, not an invented timestamp equality.
- Exact mailbox links by Lead seq and, for questions, question ID. All mailbox
  rows are retained even when they have no Lead-row linkage in this export.
- Execution bindings with an explicit at-or-before flag, and workflow event
  references split into at-or-before and after-notification lists.
- Explicit unknown dispatch purpose, redacted field paths, and unresolved
  provenance. Later observations must not become at-event authority.

JSONL preserves the original row shape. `payload`, `routing_snapshot`, and
`sender_ref` remain JSON-encoded strings when they originally were JSON strings;
parse them once to obtain their objects. Object keys, array order, numeric and
boolean values, nulls, empty strings, and safe identifiers/timestamps remain.
Each JSONL row's position is unchanged. Serialization whitespace is canonicalized.

Private message bodies, summaries, notification prose, issue titles, machine
paths, account labels, credentials, and non-allowlisted strings become stable
opaque `[redacted:NNNNN]` strings. Equal private strings share an alias, including
across files; there is no committed text-to-alias map or per-text digest.
Aliases preserve nonempty string shape only. They are **not producer templates**,
proof of absent actionable content, valid credentials, or real message text.

The fixture is complete with respect to the seven frozen export files, not with
respect to every fact required for the planned producer replay. In particular:

- Raw ingress is available for 80 stage rows. All 21 direct-start source
  payloads are NULL; monitoring and replacement ingress are not separately
  exported. A projected `liveness_probe` is not a newly authenticated producer
  episode proof.
- Dispatch purpose is absent for every exported dispatch. Do not infer
  `initial`, `fault_replacement`, `resume_fallback`, or retry purpose from a
  migration default, running status, or nearby events.
- The V3 export was captured at `2026-09-26T04:26:15.127521+00:00`. Mutable state
  is an export-time observation. Timestamped earlier workflow events can be
  inspected, while later events cannot justify an earlier quiet decision.
- Historical registration/thread outcomes, workflow snapshots, obligation and
  review ownership, alert/episode state, policy flags, and runtime build are not
  fully available. Redaction also prevents claiming original text byte equality
  or checking the semantics of private free text.
- Mailbox batches and delivery timestamps do not establish carrier busy/idle
  transitions, adapter invocations, or observed model turns. The mailbox input
  includes independently recorded Discord and infrastructure traffic; neither
  its 206 rows nor the 257 Lead rows are a wake count.

The replay harness must use real producers, preserve all input rows and these
limitations, and keep missing authority conservative. Synthetic coverage must
remain separate from this real-window denominator. Missing evidence is an
unresolved acceptance requirement, not permission to mint quiet proof or report
a passing before/after wake comparison.

To rebuild from the controlled private exports, run from the repository root:

```sh
python3 packages/teamlead/src/__tests__/fixtures/fly2912-evening/build-fixture.py
```

The script only reads the two manifests and their seven JSONL exports. It never
opens a live database, invokes a service, sends a message, or runs a model. It
checks every original hash/count before writing deterministic sanitized files,
the linkage index, and the two verification manifests. Tests in another checkout
consume the committed sanitized JSONL and do not need the private exports.
