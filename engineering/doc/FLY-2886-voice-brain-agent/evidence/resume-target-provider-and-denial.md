# Bounded implementation self-check: target locks, provider evidence, founder-only denial

This is targeted implementation evidence, not registered code review, full CI, QA, production proof, or shipping authority. No production/room mutation, commit, or push was performed by the delegated agent.

## Target/provider work

Added real StateStore + SqliteJournalStore + LeadCapabilityBroker integration coverage for:

- Voice timeout followed by disable keeps the resident's same-target write rejected until original late terminal success; unchanged remote state cannot manufacture an old-request receipt.
- Transport failure with possible remote commit keeps the durable receipt and target unknown.
- Resident waiter cancellation and Bridge restart remove abandoned waiters while preserving the dispatched holder's fence.
- Real browser handler late success records terminal evidence before revoked output-delivery checks; browser `isError` results remain unknown.

Adopted the root-owned trusted `recordTerminalEvidence` callback for browser, direct GitHub Bridge write handlers, and bounded Bridge HTTP terminal replies for GitHub, Discord reply/edit/react, and runner start/send/respond. Only the original response is inspected; no additional provider request is made. Original post-provider authority/output guards remain. Shared HTTP proof reading is capped at 256 KiB and two seconds and awaits the callback inside the existing work continuation. Correlation includes request, operation output schema, resource reference, and target fields. Unknown/rejected/incomplete responses do not become success proof. GitHub label edits settle only after the single mutation's validated response, before guarded follow-up reads; no additional write is performed.

Production audit found inner Bridge GitHub brokers have no target-lock client. Root fixed their receipt-only callback settlement; a real GitHub handler + no-lock broker regression verifies cancellation returns unknown, then late validated success updates its durable Bridge receipt without new I/O. Root separately added Bridge receipt reconciliation.

RED logs: `resume-target-integration-red.txt`, `resume-browser-error-red.txt`, `resume-bridge-terminal-red.txt`, `resume-github-terminal-red.txt`, `resume-github-inner-broker.txt`.

Final relevant sweep: `resume-provider-wrapper-final.txt`, **7 files / 132 tests passed**. Teamlead `tsc --noEmit`: `resume-provider-wrappers-tsc-final.txt`, **exit 0**.

Limits: low-level GitHub/Linear transports can abort without delivering a terminal provider response; those writes correctly remain unknown. No inference of success from an unchanged provider value was introduced. Multistep Discord thread creation was not retrofitted with early terminal callbacks.

## Founder-only denial (§4.5)

Voice factory alone installs classified denial reporting. Trusted catalog classification yields `founder_only_denied` for reserved operations, `unavailable` for known operations missing from the admitted manifest, and `invalid` for unknown operations. The voice MCP proxy forwards only the otherwise-rejected envelope for classification; out-of-manifest success is still refused, and those operations are not added to discovery. Resident behavior remains unchanged.

Only reserved denials reach the fixed Bridge `/api/lead-capabilities/target-lock/founder-denial` endpoint. Bridge revalidates current voice authority, enabled policy, exact operation class, and the derived target, then appends an idempotent `voice_founder_only_denied` Lead mailbox event. No founder gate or other requested operation is submitted. A positive correlated `lead-event:<seq>` receipt is required before returning `这个只能你本人做，我已经记给 <Lead>`; otherwise the wording is `这个只能你本人做`. No card claim is returned without a trusted matching card; this path uses the conservative wording.

RED logs: `resume-founder-denial-red.txt` (four expected failures), `resume-founder-denial-client-red.txt` (missing client method).

First focused green: `resume-founder-denial-green.txt`, **4 files / 26 tests passed**. Final checks, including resident output compatibility, out-of-manifest success refusal, broker/runtime regression coverage, are captured in `resume-founder-denial-final.txt`. Teamlead `tsc --noEmit`: `resume-founder-denial-types.txt`, **exit 0**.
