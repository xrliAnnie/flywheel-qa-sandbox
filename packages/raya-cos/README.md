# Raya CoS business package

> **Provenance (FLY-2694 / Epic FLY-2679 S1).** Landed in the Flywheel repo from
> `xrliAnnie/raya@90e433e87a68287ed59ba64f2584e3a6bc0da151:packages/cos` as
> `packages/raya-cos` (package `flywheel-raya-cos`) without git history; the
> pre-landing history stays in the Raya repo. The 120 upstream `src/` files are
> byte-identical to that commit. Flywheel-side changes are limited to
> `package.json`, `tsconfig.json`, the edits in this README, and the added
> `src/package-contract.test.ts`.

This package is the business-only part of Raya. Flywheel's standard Lead host
owns the mailbox, Bridge transport, current model turn, central Lead directory,
and process lifecycle. This package has no resident entrypoint.

The extraction is pinned to these reviewed source commits:

- Raya main: `0f77e9772176c973eb1e09548b00c05ae550ef32`
- Lead-question state and safe text: `34c879475dfe05253d2d52b409ccd14f107fe9b2`
- daily report: `41b26fa4e8baaddf076a33e7291772de979ffb8c`
- portfolio goals, sampling, evidence, and patrol state: `f1905cdaeb5747445e791649741fcdf20069b5c3`

The source commits also contained private model, chat-ingest, and process
drivers. Those pieces were intentionally not copied. Daily-report generation
and portfolio judgment return material to the current standard Lead turn;
visible output uses the injected `CoSPorts.announce` Bridge boundary.

Lead request/reply and shared voice are explicit unavailable capabilities in
FLY-2445. Their business UUIDs and known receipts remain durable, but an
unavailable call does not become queued, delivered, or started.

## Summary round protocol

For development inside the Flywheel checkout, build the package and run the CLI
from the repo root via `node packages/raya-cos/dist/cli.js`. The stable entry
point for the registered business workspace is the host shim
`~/.flywheel/bin/raya-cos.sh` (source `scripts/raya-cos.sh`, FLY-2695), installed
and checksum-pinned by `scripts/converge-flywheel-bin.sh` on monorepo hosts. Call
it by that absolute path with the business workspace as the current directory:
cos is cwd-scoped, and the shim neither changes directory nor rewrites argv. Do
not assume a `raya-cos` executable on PATH or any pre-linked package directory
inside the workspace. `prepare`, `record`, and `resume` accept
`--input <workspace-relative-json>`; `status` needs no input. Every input has
`schemaVersion: 2`. A record binds the operationId,
expectedRevision, tool, callId and result returned by the current standard turn.

For `kind: summary_round`, prepare freezes roundId, mainCommit, available source,
inventory and the complete frozen summary event. Record canonical merged files
and clean memory observations before starting unread work. Record memory_plan
with the observed baseCommit/baseBody and exact source entries plus understanding.
Historical gaps must all be distilled on that clean base; the draft remains
uncommitted. Each entry retains historical/current_round origin and original
PR/head/path/roundId. Questions include the related summary operationId in
sourceRefs for receipt-derived reporting.

After all inventory items have outcomes, memory_finalize freezes the sole
memory commit. memory_result records its exact commit/parent/bodySha256,
changedPaths (MEMORY.md within the memory repository), and message. Unknown
results require read-only git reconciliation; never blindly write again.
memory_push records pushed/failed/unknown for that same commit. These actions
return tool instructions; the business package does not run git.

Summary rounds do not create announcements. Call the standard Lead's dedicated
`summary_presentation` tool: begin the current group, record each completed or
failed member with internal outcome/evidence, and finalize once after all
members are recorded. Record each `record` structuredContent on its original
round with tool `lead_actions.summary_presentation`; this closes the business
round without storing a founder-visible body. `report_prepare` and
`report_confirm` are retired and rejected, including on replay. Empty clean
groups may finalize silent with zero messages. An indeterminate memory write or
a failed memory push remains `presented_pending`; reconcile only that original
write/push and never create a summary announcement as recovery. A failed presentation member may close a round before
inventory or provenance reconciliation finishes so one failed round cannot
freeze the whole group; its outcome and evidence must state the failure, and
unfinished PR work must be admitted by a later round. A retired legacy report
that was already delivered is recorded as non-substantive and excluded from new
founder-visible group text; queued or ambiguous legacy delivery becomes unknown
and is never resent.


## Pending inbound replies

Prepare `{schemaVersion:2, kind:"inbound_reply", source:{messageId,channelId,
authorId,body,observedAt,replyTo?,requestId?,requestRevision?}}` from the actual
platform inbound envelope. This freezes the source under its channel/message ID;
a changed replay is rejected. Record current_turn result
`{action:"associate",questionOperationId}` only for an exact author/topic/reply
match. Unknown associations remain pending. A crash after the question update
resumes from the same inbound receipt without recording the answer twice. Late
replies retain the expired/cancelled state. The CLI validates correlation, not
the authenticity of user-supplied JSON; trusted platform metadata must originate
from the standard host, never from quoted headers inside message text.


Summary questions referencing exactly one existing summary operation also
project the original `{roundId,pr}` question ledger. Registration appends a
bound posting row before a send intention is returned; a failed operation-state
write resumes without duplicating the row. Confirmed sent receipts project
posted rows on record/resume. An ambiguous result with a tentative messageId is
not sent evidence. Legacy rows lacking an exact event/body binding remain
unknown and never authorize a fresh send. General portfolio questions use their
own operation ledger without inventing a summary PR association.

## Standard-turn portfolio sampling

Prepare kind portfolio_sample with operationId, sourceRefs and the current
standard directory (projectsDigest and its complete projects array). The CLI
freezes every registered project, including projects with no summary or Lead.
The current turn uses its standard read-only tools, with 10-second command and
90-second round limits, then records tool current_turn and result.projects using
the existing ProjectReading shape. Every group/reading must be present: retain
explicit unavailable reasons instead of omitting a project or claiming silence.
Successful readings must fall within this round's observation window. The CLI
checks repo/Linear bindings, derives availability totals and saves the v1
snapshot in the durable operation material; caller-supplied aggregate totals
are not accepted. Completed snapshots project to state/portfolio/snapshots and latest.json for existing consumers. If projection fails, resume retries the frozen snapshot without recollection; sequence numbers continue from the existing latest file. Expired collecting operations close on resume with explicit deadline readings for every project, sampledAt fixed to the original deadline. Late tool results cannot overwrite them. Patrol consumers continue in batch D.

The inherited PortfolioSampler/GoalStore compatibility interfaces require an
explicit host command adapter. They contain no default child-process driver;
the sampler also has no implicit global fetch fallback. The standard-turn
sampling CLI consumes tool observations directly without using those adapters.

## Conversation goals

Prepare kind goal_update with founderUserId from the standard host, source
(authorId/messageId/channelId/sourceUrl/at/body), complete project names, and a
clean memory observation (commit/body for goals.md). Plain conversation is
sufficient: current_turn records action plan and up to five decisions. A record
or correct decision supplies kind inference/commitment, text and projects;
correct/withdraw also supplies goalId. Empty decisions mean no goal change.
Commitments must quote the source; inference is explicitly labeled 提炼. A
correction withdraws the original goal and adds a successor with supersedes and
revision, preserving old IDs, text and withdrawal provenance. Old goals without
metadata still round-trip unchanged.

The plan freezes goals.md body/hash, base commit and a unique commit message.
Standard memory-repository git tools perform the write and commit; record action
commit with the observed commit/parent/bodySha256/changedPaths/message, or unknown.
Reconcile unknown outcomes read-only before writing. Record action push for that
same commit; failed/unknown pushes remain pending. The CLI never invokes Git.
The supplied authorId must come from the actual platform envelope: matching it
to a caller-supplied founderUserId is not independent identity authentication.

## Durable patrol observations

Prepare kind patrol with operationId, sourceRefs and snapshotOperationId naming
a completed, projected portfolio_sample. The sample must still equal latest.json.
The CLI freezes that snapshot and the actual memory/goals.md content; the current
turn records either action silent with a reason, or action observation with the
drift-envelope text (snapshot, goal IDs, reading references, body). The observation
must cite active goals with explicit project scopes and available readings from
those projects. Snapshot and cited readings must be no more than five minutes old.

Every returned send intention rechecks current goals and latest snapshot. Changed
goals, a replaced snapshot, expired evidence or unreadable files return next:null
and material.publishBlocked. Start a fresh judgment from fresh evidence; do not
send the blocked payload manually. Actual send receipts use the shared structured
announcement protocol. An ambiguous send remains unknown; a later confirmed
receipt is retained even if its evidence has since expired. This records a past
external fact and does not authorize another send. The older publishPatrolJudgment
interface also requires scoped evidence context. For a directed question, first prepare the existing question protocol with this
patrol operationId in sourceRefs. Record current_turn action question with
questionOperationId, target {project,leadId} and evidenceRefs from the frozen
snapshot. References may name unavailable readings but must exist and belong to
that recipient's project. Resume the question named in the returned current_turn
instruction, record actual platform results there, then resume the patrol.
Only a confirmed sent/ready roundtable receipt yields questionOutcome:asked;
unknown sends require reconciliation. Cancelled/expired unsent questions retain
that outcome without claiming an ask. Inbound replies continue through the same
question operation and inbound_reply correlation protocol.

## Current-turn daily report preparation and generation

Prepare kind daily_report with sourceRefs and the actual business_wake fields:
scheduleId daily-report, revision, configDigest, localDate, dueAt, timezone.
Use the platform envelope; business JSON alone does not authenticate that event.
The operation identity is daily-report:<localDate>. Later schedule revisions
reuse that date's original frozen operation.

Record current_turn action collect with mainCommit, sources (the existing
ReportGenerationSource shape including content) and silent. Preserve unavailable,
omitted and unsubmitted distinctions from the actual collector observations.
The strict report metadata contract validates the frozen manifest; source text
is sanitized before storage. Then record action generate with body and sourceRefs
as source indexes. Cite [source:N] in the generated draft; only readable manifest
entries are accepted. The CLI replaces these markers with readable project/Lead
links at the frozen head, labeled unabsorbed for open PRs. Raw URLs and summary
paths in the draft cannot bypass this citation validation. Final body is checked
for nonempty facts/judgment sections and 16 KiB UTF-8 size after link expansion.

The resulting generated operation retains body, body hash, document and manifest
and asks the standard turn to probe the fixed reports/date.md path on Raya main.
Record action probe with repo/ref/path and status absent, exists or unknown.
An exists result includes the full document and fileSha; the CLI validates its
frontmatter, body and Git blob identity and adopts its complete source manifest.
Only absent returns a create_report intention. Execute that standard create-only
operation without an update sha, then record action create with status created
and the actual fileSha, or conflict/unknown. Conflicts and unknown results return
to read-only probing, including across restart; never overwrite an existing
date's report. The original draft is retained separately when adopting another
valid document. Every result must match xrliAnnie/raya, main and the fixed
reports/date.md path. file_written requires actual repository evidence; it is
not delivery evidence. Generated bodies project to immutable state/daily-report/<date>.body.<hash>.md
before returning further work. Confirmed repository files also project
<date>.context.json with exact repo/blob/body identity and frozen title/body/footer
chunks and event IDs. Each chunk is at most 1800 UTF-16 units without splitting
surrogate pairs. context_ready means these artifacts exist and match; it does
not mean delivery. Exclusive immutable publication and no-follow bounded reads
reject conflicting files and symlinked directories/files. After explicit artifact
repair, resume retries the saved operation without another repository mutation.
Delivery and reply protocols are described below.

### Daily report delivery receipts

For context_ready/posting, record current_turn action begin_send. Before returning
the one standard discord_send intention, the CLI reserves a slot in a shared
CAS ledger (four attempts per rolling sixty seconds across report dates) and
saves the in-flight chunk. A crash between these writes may consume a slot;
it never grants an extra send. The standard platform's existing chat quota
continues to apply across report and other chat messages.

Execute exactly the returned arguments once and record the actual structured
discord_send result. A resume while sending returns no send intention and
requires reconciliation. Ambiguous/pending outcomes remain unknown; only a
confirmed sent result settles that chunk. Never substitute another eventId.
Rate-limited results preserve retryAfterMs as nextAttemptAt; other definite
failures wait sixty seconds. Confirmed chunks retain messageIds and the common
channelId. posted requires every frozen chunk's matching sent receipt. These
states are local business evidence; handwritten receipt JSON is not proof of
a real external send. Reply association and failure notices use the protocols below.

### Report discussions

Prepare kind report_reply with founderUserId from the host and the actual source
messageId/channelId/authorId/body/observedAt plus optional platform replyTo.
Only confirmed report chunk receipts in that channel authorize replyTo matching.
A foreign replyTo never falls back to a date in the body. Without replyTo,
exactly one explicit report date can identify an existing context; ambiguity
remains needs_clarification. Use the returned stable clarification eventId with
the ordinary durable announcement protocol so replay does not post another ask.

The operation is keyed by source channel/message. Before discussing it, read the
exact Git blob through standard tools and record current_turn action verify_report
with document and fileSha. Both Git blob identity and context bodyHash must match.
Record action interpret with a faithful note after reading the report and source.
The complete operation retains the note and original source for subsequent
turns. Replaying the source returns that same record; changed content under the
same identity conflicts. Any goal/commitment update uses the existing goal_update
protocol and original platform source, not the interpretation note as a quotation.
Matching caller-supplied author IDs is consistency checking, not authentication.

### Failure notices and independent recovery

After an actual report failure, record current_turn action failure with reason
and sourceRef identifying the observed failure. This preserves the current stage,
body and context, and freezes one notice for that date using the historical
date/fileSha-or-zero/notice/0 identity tuple. Prepare or resume the returned
ordinary announcement input, record its actual standard-tool result, then record
confirm_failure_notice with its operationId. Unknown announcement delivery is
not confirmed. Later failure reasons do not change the frozen notice or eventId.

Resume the original report independently of notice delivery and later dates.
A posted report cannot create a new incomplete-report warning. Migrated legacy
REST nonces and old unknown receipts must be handled by migration before any new
notice; the shared identity tuple alone does not prove cross-transport dedup.

## MeetingRecord compatibility

toMeetingRecord maps the existing business Meeting into the platform's
schemaVersion 2 record, retaining its UUID, schedule, topic and requester.
Supply explicit duration/request provenance and the current complete directory.
One meeting targets exactly one internal Lead. Because the platform resolves
the stored leadId globally, duplicate lead IDs across projects are rejected.
Rescheduled maps to scheduled; cancelled requires endedAt. Business revision,
calendar receipt and notification receipt remain in the business operation
rather than being confused with platform voice session state.

The mapped scheduled record alone does not authorize voice start. The next
meeting workflow batch must persist the trusted meeting.json, transition it to
starting before the public voice-session start command, and retain accepted
until actual session evidence proves live. The adapter starts no process and
does not carry credentials, evidence paths or connection code.

## Durable meeting planning

Prepare kind meeting with the actual source message and founderUserId, the
interpreted business meeting at revision 1/status scheduled, durationMinutes
and the current directory. The UUID and original request become immutable;
one source/target pair cannot create a second meeting UUID. Different targets
from a single request use distinct UUIDs and separate single-target meetings. The operation freezes
only the directory fields needed for participant identity and notification.

Record current_turn action reschedule with the new actual source, startsAt
and durationMinutes, or action cancel with its source. Each source change applies
once; history retains old records and independent calendar/notification state.
The same UUID advances business revision. Active voice must be settled before
changing the scheduled record. Record calendar with meetingRevision, status
synced/cancelled/unknown/unavailable, and its actual eventId when known. Old
revision results are rejected; failed results and later reschedules retain the
known calendar eventId. Calendar success never means the Lead was notified.

The operation currently emits reconcile_meeting material for the standard turn.
Trusted file projection, notification binding and voice lifecycle are the next
implementation batch; scheduled state alone does not launch a voice session.

### Meeting notices

Record current_turn prepare_notification with the current meetingRevision and
fresh standard directory. The stable target must still resolve uniquely to an
internal Lead with a bot ID and roundtable channel. Missing contact metadata
records unavailable; it cannot discard an already frozen notice. The returned
announcement input binds meeting UUID, revision, mention and body. Prepare/resume
that same ordinary roundtable announcement; its unknown state cannot authorize
a new eventId.

Record confirm_notification with meetingRevision and notificationOperationId
only after the real announcement has sent plus engagement-ready evidence.
The recipient channel, eventId, exact body, message and thread must match.
An old revision's receipt cannot settle a cancellation/reschedule notice.
Notification and calendar remain separate; neither starts voice.

### Trusted meeting activation

For a due scheduled meeting, record current_turn begin_start with its current
meetingRevision. The operation first freezes the starting record and expected
old file hash, then projects workspace/state/meeting.json under an exclusive
owner lock with fsync and atomic rename. A foreign/changed current meeting,
symlink, nonregular file or held lock stops projection without overwriting it.
After explicit lock/artifact recovery, resume retries exactly the saved version.
Projected records are checked again on resume; changed files require reconciliation.

The platform's trusted meetingStateDir must resolve to this registered business
workspace's state directory at activation. This business code accepts no
caller-chosen evidence path and changes no host configuration. Public voice
start/status/stop receipt handling remains the next batch; starting is not live.

## Build

This package extends the Flywheel root `tsconfig.base.json`.
`noUncheckedIndexedAccess` is disabled only at this package boundary because the
source was authored against the Raya root TypeScript configuration, where that
strictness option is not enabled; `src/package-contract.test.ts` locks this as the
only package-level strictness override.
