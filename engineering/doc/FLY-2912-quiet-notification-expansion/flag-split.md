# FLY-2912 — Founder-approved notification flag split

The latest Lead instruction authorizes four independent project-scoped controls on top of the existing `lead_token_savings` master. This is the approved amendment to the original single-switch design; routine-stage membership and all evidence/action guards remain unchanged. The branch merged `origin/main` at `53245dbbe` before implementation.

| Flag | Event | Live read site |
| --- | --- | --- |
| `lead_stage_changed_audit` | `stage_changed` | `createEventRouter` |
| `lead_session_started_audit` | `session_started` initial notice | `DirectEventSink.pushNotification` |
| `lead_monitoring_reestablished_audit` | `session_monitoring_reestablished` | `RegistryHeartbeatNotifier.deliverHook` |
| `lead_replacement_notice_audit` | `workflow_replacement_eligibility` | `StateStore.appendWorkflowReplacementLeadIntentTx` |

All four are registered bool/project/default_on/onMeans=enables, with founder-facing whenOn text and precise delegated call_time readers. Scoped SQLite storage uses the existing project → global → registry-default resolution. Invalid values or read failures restore model delivery. Each event reads its current category value. A disabled category returns model with that flag name in the reason; other categories retain existing decisions. Master OFF still takes precedence. No new configuration or environment channel, timer, migration, or history replay is introduced.

## Verification

TDD: the four category-OFF assertions failed (model expected, audit_only received), and registry copy coverage failed for the four absent entries before implementation. The classifier now also exercises actual scoped writes, ON/OFF/ON without restart, other-category continuity, another project's independence, master OFF, malformed values and read failures. Actual startup, HTTP stage, monitoring and replacement producers each have category-OFF coverage; monitoring toggles on the same service, and stage duplicates preserve existing audit rows. Management stage/apply routes cover all four new flags.

The original fixed flag-count assertion was still present after merging main; only that count assertion was removed, as authorized. Exact founder-copy and registry/drift guards remain enforced. Guard failures during implementation identified missing configKey metadata and required class-qualified read-site anchors; both were fixed without relaxing guards.

Local selection is recorded in `flag-split-consumer-audit.json.gz`: changed-file full paths, names and parent directories plus old/new flag strings, with retained tests and exclusions. Explicit tests run one concrete file at a time. Additional `vitest related` uses a bounded config containing the retained concrete files, to prevent the shared StateStore import graph from expanding into a prohibited local package suite; the collection is checked for duplicate files. No new shell tests are added. No schema/SQL change requires a new migration fixture; no new process operation requires an inventory entry. Existing lexical, flag compatibility and query-audit guards are retained.

Final results: 34 unique explicit files, 779 passed. Bounded related: config 7 files / 181 passed; teamlead 18 files / 482 passed / 1 existing skipped. Related and explicit checks overlap and their counts must not be added. Lint passed with 25 warnings, the affected-package-plus-dependency build and dependent typechecks passed. Command results are recorded in `flag-split-verification.json`. Scoped CI, review, QA and shipping are separate evidence. This implementation does not request full CI; QA owns frozen-head full CI and 529 live Claude Lead checks for four switches and master OFF. Historical replay limitations remain exactly as disclosed in `rework.md`; no conditional estimate is promoted to measured production savings.
