import { expect, it } from "vitest";
import {
	COMM_TABLE_CLASSIFICATION,
	TEAMLEAD_TABLE_CLASSIFICATION,
} from "../../../../scripts/lib/fly-2006-retention-registry.mjs";

// Frozen migration safety contracts. New features own their own protection tests.
it("preserves existing feature protection contracts at the FLY-2413 migration", () => {
	const retiredNames = [
		"founder_page_ledger",
		"runbook_issues",
		"ticket_escalations",
	];

	expect(TEAMLEAD_TABLE_CLASSIFICATION.deleteTarget).toContain(
		"alert_mailbox_ledger",
	);
	expect(TEAMLEAD_TABLE_CLASSIFICATION.deleteTarget).toContain(
		"workflow_completion_drain_challenge",
	);
	expect(TEAMLEAD_TABLE_CLASSIFICATION.protectedAuthority).toContain(
		"workflow_founder_gate_verdict",
	);
	expect(TEAMLEAD_TABLE_CLASSIFICATION.protectedAuthority).toContain(
		"workflow_gate_holder_recovery_evidence",
	);
	expect(TEAMLEAD_TABLE_CLASSIFICATION.protectedCurrentOrReference).toEqual(
		expect.arrayContaining([
			"pre_adapter_failure_receipts",
			"beta_schedule_lanes",
			"beta_schedule_occurrences",
			"ship_judgment_clarification",
			"ship_judgment_delivery",
			"ship_judgment_evaluation",
			"ship_judgment_input",
			"ship_judgment_job",
			"ship_judgment_opinion",
			"ship_judgment_outcome",
			"ship_judgment_project_state",
			"discord_config",
			"lead_note",
			"auto_merge_shadow_declaration",
			"auto_merge_shadow_observation",
			"auto_narrow_control_event",
			"auto_narrow_decision_audit",
			"auto_narrow_opinion_delivery",
			"auto_narrow_opinion_snapshot",
			"ship_relevant_declared_pr",
			"ship_relevant_pr_snapshot",
			"strength_two_evidence_record",
			"voice_outbound",
			"voice_sessions",
		]),
	);
	expect(TEAMLEAD_TABLE_CLASSIFICATION.protectedCurrentOrReference).toContain(
		"flag_scan_scope_state",
	);
	expect(TEAMLEAD_TABLE_CLASSIFICATION.protectedCurrentOrReference).toContain(
		"node_dwell_review",
	);
	expect(TEAMLEAD_TABLE_CLASSIFICATION.protectedCurrentOrReference).toContain(
		"recovery_claim",
	);
	expect(TEAMLEAD_TABLE_CLASSIFICATION.protectedCurrentOrReference).toContain(
		"account_switch_action_receipt",
	);
	expect(TEAMLEAD_TABLE_CLASSIFICATION.protectedCurrentOrReference).toEqual(
		expect.arrayContaining(["workflow_resident_hold"]),
	);
	expect(
		TEAMLEAD_TABLE_CLASSIFICATION.protectedCurrentOrReference,
	).not.toContain("workflow_completion_drain_challenge");
	expect(
		(TEAMLEAD_TABLE_CLASSIFICATION as Record<string, readonly string[]>)
			.retiredOptional,
	).toEqual(retiredNames);
	expect(COMM_TABLE_CLASSIFICATION.protectedCurrentOrAuthority).toEqual(
		expect.arrayContaining(["mailbox_archive", "runner_stop_declarations"]),
	);
	expect(TEAMLEAD_TABLE_CLASSIFICATION.protectedCurrentOrReference).toContain(
		"epic_page",
	);
	expect(TEAMLEAD_TABLE_CLASSIFICATION.protectedCurrentOrReference).toEqual(
		expect.arrayContaining(["epic_page_publication", "epic_page_refresh"]),
	);
});
