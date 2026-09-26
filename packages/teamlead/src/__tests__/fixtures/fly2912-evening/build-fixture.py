#!/usr/bin/env python3
"""Rebuild the public fixture from hash-frozen private exports, never live DBs."""

import collections
import datetime
import hashlib
import json
import pathlib
import re


HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[5]
EVIDENCE = ROOT / "engineering/doc/FLY-2912-quiet-notification-expansion/evidence"
MANIFESTS = ("evening-manifest-v2.json", "producer-authority-manifest-v3.json")
JSON_FIELDS = {"payload", "routing_snapshot", "sender_ref"}
IDENTITY_KEYS = set("""
id event_id eventId event_uid eventUid execution_id executionId executionId8
issue_id issueId issueUuid issueKey issue_identifier issueIdentifier identifier
run_id runId runId8 workflow_run_id node_id nodeId workflow_node_id targetNodeId
activation_id activationId edge_id edgeId sourceEventId leadEventId
source_ref sourceRef sourceSpanIds delivery_id batch_id ref_id question_id
questionId requestId rework_request_id reworkRequestId preparedEventUid
successorExecutionId producerExecutionId preferredActorExecutionId
newExecutionId attachmentId workflow_event_id startReservationKey
lead_id leadId ownerLeadId ack_owner_lead_id project_name projectName
from_agent to_agent claimed_by session_key sessionKey from to
chat_channel chat_thread_id threadId founder_message_id mentionUserId
ownerUserId ownerRef notification_proof_ref superseded_by turnHolderExecId8
phaseWakes expectedProducerMirrorHead gateEntryHead
""".split())
ENUM_KEYS = set("""
event_type eventType kind type source source_kind sourceKind state status
delivery_disposition content_type recipient_kind msg_class carrier relay_state
resolved_via notification_policy_version notification_reason checkpoint
question_kind session_role sessionRole stage filter_priority action mode
severity method result liveness target decision_route workflow_decision_kind
workflow_predicate next_check_disposition fromRole toRole disposition
retryDisposition failureKind failure_kind attemptedStatus effectiveStatus signal
outcome via predicate authority authorityMode carrierBindingState subjectKind
reviewType reviewType policy producerVendor producerModel reviewerVendor
reviewerModel reviewerEffort authorVendor authorModel vendor model effort arm
modelAlias resolvedModel policyVersion ruleVersion impliedFromState
invalidationScope verificationPolicy currentNode currentAttemptState light
runStatus turnPhase step watermark setBy
""".split())
TIME_KEYS = {"ts", "at"}
SECRET_KEYS = {"token", "challengeId", "credential", "password", "secret"}
METADATA_TOKEN = re.compile(r"[A-Za-z0-9_.:#/@+|=,\-]{1,512}\Z")
TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}[T ][0-9:.]+(?:Z|[+-][0-9:]+)?\Z")
ALIASES = {}


def dump(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"))


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def utc(value):
    result = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    return result.replace(tzinfo=datetime.timezone.utc) if result.tzinfo is None else result


def redact(value):
    # No digest of individual private text: avoid committing guessable text hashes.
    if value not in ALIASES:
        ALIASES[value] = f"[redacted:{len(ALIASES) + 1:05d}]"
    return ALIASES[value]


def sanitize(value, key, path, changes):
    if isinstance(value, dict):
        return {k: sanitize(v, k, f"{path}.{k}", changes) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize(v, key, f"{path}[{i}]", changes) for i, v in enumerate(value)]
    if not isinstance(value, str) or value == "":
        return value
    if key in JSON_FIELDS:
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            pass
        else:
            return dump(sanitize(parsed, key, path, changes))
    if key not in SECRET_KEYS and not value.startswith(("/", "~", "file:")):
        if (key in TIME_KEYS or key.endswith(("_at", "At", "Until"))) and TIMESTAMP.fullmatch(value):
            return value
        if key in IDENTITY_KEYS | ENUM_KEYS and METADATA_TOKEN.fullmatch(value):
            return value
    changes.append(path)
    return redact(value)


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def main():
    sources = []
    original = {}
    sanitized = {}
    row_redactions = {}
    # Verify every input before writing any output.
    for manifest_name in MANIFESTS:
        manifest = json.loads((EVIDENCE / manifest_name).read_text())
        for source in manifest["files"]:
            path = pathlib.Path(source["path"])
            raw = path.read_bytes()
            rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
            assert sha(raw) == source["sha256"], f"Hash mismatch: {path.name}"
            assert len(rows) == source["rows"], f"Count mismatch: {path.name}"
            original[path.name] = rows
            sources.append({"file": path.name, "sourceManifest": manifest_name,
                            "sourceSha256": sha(raw), "rows": len(rows),
                            "sourceHashVerified": True, "sourceCountVerified": True})
    for source in sources:
        name = source["file"]
        sanitized[name] = []
        row_redactions[name] = []
        for row in original[name]:
            changes = []
            sanitized[name].append(sanitize(row, "", "$", changes))
            row_redactions[name].append(changes)
        output = ("\n".join(dump(row) for row in sanitized[name]) + "\n").encode()
        (HERE / name).write_bytes(output)
        source["fixtureSha256"] = sha(output)
        source["fixtureBytes"] = len(output)
        source["redactedStringOccurrences"] = sum(map(len, row_redactions[name]))

    leads = original["lead-events-v2.jsonl"]
    sessions = original["session-events-v2.jsonl"]
    direct = original["direct-start-source-v3.jsonl"]
    mailbox = original["mailbox-v2.jsonl"]
    workflow = original["workflow-events-v3.jsonl"]
    dispatches = original["dispatch-ledger-v3.jsonl"]
    bindings = original["execution-binding-v3.jsonl"]
    entries = []
    for index, lead in enumerate(leads):
        payload = json.loads(lead["payload"])
        execution = payload.get("execution_id", payload.get("metadata", {}).get("workflowEngine", {}).get("executionId"))
        raw_matches = [row for row in sessions if row["event_id"] == lead["event_id"]]
        direct_candidates = [row for row in direct
                             if lead["event_type"] == "session_started"
                             and row["execution_id"] == execution
                             and row["issue_id"] == payload.get("issue_id")
                             and row["project_name"] == payload.get("project_name")
                             and row["event_type"] == lead["event_type"]
                             and row["source"] == "direct-event-sink"
                             and utc(row["ts"]) <= utc(lead["created_at"])]
        related_workflow = [row for row in workflow if row["execution_id"] == execution]
        question = payload.get("question_id")
        linked_mail = [row for row in mailbox if
                       (row["source_kind"] == "lead_event" and row["source_ref"] == str(lead["seq"]))
                       or (question and row["source_kind"] == "question"
                           and row["source_ref"] == str(lead["seq"]) and row["id"] == question)
                       or (payload.get("founder_message_id") and row["source_kind"] == "discord_chat"
                           and row["source_ref"] == f"chat:{lead['lead_id']}:{payload['founder_message_id']}")]
        unresolved = ["historical_obligation_state_not_exported", "historical_policy_flag_and_runtime_build_not_exported",
                      "carrier_busy_idle_and_model_turn_timeline_not_exported"]
        if row_redactions["lead-events-v2.jsonl"][index]:
            unresolved.append("private_text_redacted_not_asserted_actionless_or_template")
        if not raw_matches:
            unresolved.append("raw_ingress_payload_not_exported")
        if lead["event_type"] == "session_started":
            unresolved += ["dispatch_purpose_column_absent_do_not_infer_initial",
                           "session_registration_and_thread_outcome_not_exported",
                           "workflow_snapshot_and_at_event_node_state_not_exported"]
        if lead["event_type"] == "stage_changed":
            unresolved += ["at_event_review_ownership_and_runner_contract_binding_not_exported"]
        if lead["event_type"] == "session_monitoring_reestablished":
            unresolved += ["producer_episode_membership_and_alert_state_not_exported"]
            if not payload.get("liveness_probe"):
                unresolved.append("alive_probe_not_exported")
        if lead["event_type"] == "workflow_replacement_eligibility":
            unresolved += ["at_event_retry_policy_and_fault_count_not_exported",
                           "independent_fault_submission_receipt_not_exported"]
        entries.append({
            "inputIndex": index, "eventId": lead["event_id"], "seq": lead["seq"],
            "createdAt": lead["created_at"], "eventType": lead["event_type"],
            "observedJournalDisposition": lead["delivery_disposition"], "executionId": execution,
            "producerRaw": {"exactEventIdMatches": [row["event_id"] for row in raw_matches],
                            "directCandidates": [{"eventId": row["event_id"], "source": row["source"],
                                                  "sourceAt": row["ts"], "rawPayloadAvailable": row["payload"] is not None,
                                                  "notificationDelayMs": int((utc(lead["created_at"]) - utc(row["ts"])).total_seconds() * 1000)}
                                                 for row in direct_candidates],
                            "directCorrelation": "exact_execution_issue_project_type_source_and_ordered_timestamp_not_event_id_equality"
                            if direct_candidates else None},
            "bindings": [{"activationId": row["activation_id"], "boundAt": row["bound_at"],
                          "atOrBeforeNotification": utc(row["bound_at"]) <= utc(lead["created_at"])}
                         for row in bindings if row["execution_id"] == execution],
            "dispatchLedgerIds": [row["id"] for row in dispatches if row["execution_id"] == execution],
            "dispatchPurpose": {"status": "unknown", "reason": "column_not_in_frozen_export"},
            "workflowEventsAtOrBefore": [row["event_uid"] for row in related_workflow if utc(row["at"]) <= utc(lead["created_at"])],
            "workflowEventsAfter": [row["event_uid"] for row in related_workflow if utc(row["at"]) > utc(lead["created_at"])],
            "mailboxIds": [row["id"] for row in linked_mail],
            "redactedPaths": row_redactions["lead-events-v2.jsonl"][index],
            "unresolved": unresolved,
        })
    assert len(leads) == 257 and len({row["event_id"] for row in leads}) == 257
    assert all(a["seq"] < b["seq"] and utc(a["created_at"]) <= utc(b["created_at"]) for a, b in zip(leads, leads[1:]))
    assert all(len(row["producerRaw"]["directCandidates"]) == 1 for row in entries if row["eventType"] == "session_started")
    index_path = HERE / "replay-index.json"
    write_json(index_path, {"schemaVersion": 1, "entries": entries})
    counts = collections.Counter((row["event_type"], row["delivery_disposition"]) for row in leads)
    expected_counts = json.loads((EVIDENCE / MANIFESTS[0]).read_text())["counts"]
    assert counts == {(row["type"], row["disposition"]): row["count"] for row in expected_counts}
    verification = {
        "schemaVersion": 1, "scope": "frozen_input_verification_only_no_replay_results",
        "windowUtc": ["2026-09-26T01:30:00Z", "2026-09-26T04:00:00Z"],
        "project": "flywheel", "lead": "flywheel-eng-lead", "files": sources,
        "checks": {"allSevenSourcesMatch": True, "leadRowsRetained": len(entries),
                   "originalLeadOrderIdsSeqPreserved": True, "originalTimestampsPreserved": True,
                   "stageRawExactIdMatches": sum(bool(row["producerRaw"]["exactEventIdMatches"]) for row in entries),
                   "directStartSourceCorrelations": sum(bool(row["producerRaw"]["directCandidates"]) for row in entries),
                   "directStartSourcePayloadsMissing": sum(row["payload"] is None for row in direct),
                   "dispatchPurposePresent": any("purpose" in row for row in dispatches),
                   "leadRowsWithExactMailboxLink": sum(bool(row["mailboxIds"]) for row in entries),
                   "separateCarrierTurnTimelineAvailable": False,
                   "workflowEventsAfterWindowRetainedAsLaterEvidence": sum(utc(row["at"]) >= utc("2026-09-26T04:00:00Z") for row in workflow)},
        "observedJournalCounts": [{"eventType": key[0], "disposition": key[1], "count": value} for key, value in sorted(counts.items())],
        "sanitization": {"version": 1, "strategy": "allowlisted_identity_enum_timestamp_strings_else_stable_opaque_alias",
                         "privateTextDigestsCommitted": False, "emptyAndNullValuesPreserved": True,
                         "objectKeysArrayOrderAndScalarTypesPreserved": True,
                         "jsonEncodedColumnsReencoded": sorted(JSON_FIELDS),
                         "aliasesAreNotProducerTemplates": True,
                         "redactedStringOccurrences": sum(file["redactedStringOccurrences"] for file in sources)},
        "replayIndexSha256": sha(index_path.read_bytes()),
        "limitations": [
            "The 257 retained rows are journal inputs, not wake or model turn counts.",
            "Only 80 stage rows have exact linked raw payloads; 21 direct source rows have NULL payload; other producer ingress is absent.",
            "Direct notification IDs differ from raw source IDs; the index records candidate correlation and timestamp delta, not fabricated ID equality.",
            "All dispatch purpose fields are absent. No initial, retry, replacement, or resume purpose is inferred from default values or nearby events.",
            "V3 rows were captured after the window. Mutable ledger values are observations at export, not at-event authority; later workflow evidence is separated.",
            "Mailbox row batch IDs and delivery timestamps are retained, but busy/idle state and model turn receipts are missing.",
            "Private free text and machine paths are redacted; the fixture cannot prove original payload byte equality or classify redacted text as actionless.",
            "Historical obligation, review ownership, alert/episode, runtime build, and policy flag snapshots are incomplete or absent.",
            "No counterfactual disposition, actionable latency, adapter wake count, or model consumption result is asserted by this artifact."
        ],
        "unresolvedPolicy": "Missing or redacted authority cannot mint quiet proof; replay must retain conservative model handling and disclose unresolved acceptance evidence.",
    }
    write_json(HERE / "manifest.json", verification)
    write_json(EVIDENCE / "replay-input-verification.json", verification)
    print(json.dumps({"verifiedSources": len(sources), "leadRows": len(entries), "fixtureRows": sum(file["rows"] for file in sources), "replayExecuted": False}))


if __name__ == "__main__":
    main()
