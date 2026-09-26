import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { canonicalSubmissionDigest } from "flywheel-config";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { workflowRecoveryReceiptSchema } from "../workflow-recovery-contract.js";

const directories: string[] = [];
const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function dispatchReceipt() {
	const canonicalDigest = "a".repeat(64);
	return {
		operationId: `hold-resume:${canonicalDigest}`,
		canonicalDigest,
		target: {
			operationKind: "redispatch_current",
			runId: "run-2922",
			nodeId: "implement",
			attempt: 1,
			previousExecutionId: "old-worker",
			previousLaunchOrdinal: 3,
			snapshotDigest: "b".repeat(64),
			holdSetDigest: canonicalSubmissionDigest(["hold:2922"]),
			startAuthority: null,
			sourceHoldEventUids: ["hold:2922"],
			rework: null,
			land: null,
		},
		state: "dispatch_recorded",
		executionId: "new-worker",
		launchOrdinal: 4,
		dispatchLedgerId: 19,
	};
}

describe("FLY-2922 durable recovery receipts", () => {
	it("distinguishes dispatch commitment from state-only results and rejects invented dispatch proof", () => {
		const receipt = dispatchReceipt();
		expect(workflowRecoveryReceiptSchema.safeParse(receipt).success).toBe(true);
		for (const invalid of [
			{ ...receipt, dispatchLedgerId: undefined },
			{ ...receipt, dispatchLedgerId: 0 },
			{ ...receipt, launchOrdinal: 3 },
			{ ...receipt, executionId: "old-worker" },
			{ ...receipt, operationId: "other-operation" },
			{ ...receipt, state: "state_applied" },
			{ ...receipt, launched: true },
		]) {
			expect(workflowRecoveryReceiptSchema.safeParse(invalid).success).toBe(
				false,
			);
		}
		const {
			executionId: _execution,
			launchOrdinal: _ordinal,
			dispatchLedgerId: _ledger,
			...stateOnly
		} = receipt;
		stateOnly.state = "state_applied";
		expect(workflowRecoveryReceiptSchema.safeParse(stateOnly).success).toBe(
			false,
		);
		stateOnly.target.operationKind = "resume_existing";
		expect(workflowRecoveryReceiptSchema.safeParse(stateOnly).success).toBe(
			true,
		);
	});

	it("upgrades populated pre-recovery tables without backfilling dispatches, and preserves receipt bytes across restart", async () => {
		const directory = mkdtempSync(join(tmpdir(), "fly2922-receipt-"));
		directories.push(directory);
		const path = join(directory, "fixture.db");
		const initial = await StateStore.create(path);
		initial.createWorkflowRun({
			runId: "run-2922",
			issueId: "FLY-2922",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		initial.close();
		const legacy = new Database(path);
		const columns = legacy.pragma(
			"table_info(workflow_delivery_operation)",
		) as Array<{ name: string }>;
		if (columns.some(({ name }) => name === "recovery_receipt_json")) {
			legacy.exec(
				"ALTER TABLE workflow_delivery_operation DROP COLUMN recovery_receipt_json",
			);
		}
		legacy
			.prepare(`INSERT INTO workflow_delivery_operation
			(operation_id, kind, run_id, shape_id, hold_event_uid, client_request_id,
			 canonical_digest, state, created_at, updated_at)
			VALUES ('old-operation', 'hold_resume', 'run-2922', 'run_held_by_operator',
			 'old-hold', 'old-request', 'old-digest', 'projected', 'before', 'before')`)
			.run();
		const original = legacy
			.prepare("SELECT * FROM workflow_delivery_operation")
			.get();
		legacy.close();

		const upgraded = await StateStore.create(path);
		stores.push(upgraded);
		const raw = (upgraded as unknown as { db: { raw: Database.Database } }).db
			.raw;
		expect(
			raw.prepare("SELECT * FROM workflow_delivery_operation").get(),
		).toEqual({
			...(original as object),
			recovery_receipt_json: null,
		});
		expect(upgraded.getWorkflowHoldResumeReceipt("old-request")).toMatchObject({
			state: "projected",
			receiptKind: "legacy_result",
			recoveryReceipt: null,
		});
		expect(
			raw
				.prepare("SELECT COUNT(*) AS n FROM workflow_side_effect_ledger")
				.get(),
		).toEqual({ n: 0 });
		const receipt = dispatchReceipt();
		const bytes = JSON.stringify(receipt, null, 2);
		// Storage/restart fixture only; dispatcher acceptance uses the real producer fixtures.
		raw
			.prepare(`INSERT INTO workflow_side_effect_ledger
			(id, run_id, node_id, attempt, kind, launch_ordinal, execution_id, purpose, state)
			VALUES (19, 'run-2922', 'implement', 1, 'dispatch', 4, 'new-worker', 'fault_replacement', 'intent_recorded')`)
			.run();
		raw
			.prepare(`INSERT INTO workflow_delivery_operation
			(operation_id, kind, run_id, shape_id, hold_event_uid, client_request_id,
			 canonical_digest, state, recovery_receipt_json, created_at, updated_at)
			VALUES (?, 'hold_resume', 'run-2922', 'workflow_node_recovery', 'hold:2922',
			 'new-request', ?, 'projected', ?, 'now', 'now')`)
			.run(receipt.operationId, receipt.canonicalDigest, bytes);
		upgraded.close();
		stores.splice(stores.indexOf(upgraded), 1);
		const reopened = await StateStore.create(path);
		stores.push(reopened);
		const reopenedRaw = (
			reopened as unknown as { db: { raw: Database.Database } }
		).db.raw;
		expect(
			reopenedRaw
				.prepare(
					"SELECT recovery_receipt_json FROM workflow_delivery_operation WHERE client_request_id = 'new-request'",
				)
				.get(),
		).toEqual({ recovery_receipt_json: bytes });
		expect(reopened.getWorkflowHoldResumeReceipt("new-request")).toMatchObject({
			receiptKind: "dispatch_recorded",
			recoveryReceipt: receipt,
			dispatchState: "intent_recorded",
		});
		expect(reopenedRaw.pragma("foreign_key_check")).toEqual([]);
		expect(reopenedRaw.pragma("integrity_check", { simple: true })).toBe("ok");
		reopenedRaw
			.prepare(
				"UPDATE workflow_side_effect_ledger SET state = 'started' WHERE id = 19",
			)
			.run();
		expect(reopened.getWorkflowHoldResumeReceipt("new-request")).toMatchObject({
			receiptKind: "dispatch_recorded",
			recoveryReceipt: receipt,
			dispatchState: "started",
		});
		reopenedRaw
			.prepare(
				"UPDATE workflow_delivery_operation SET recovery_receipt_json = ? WHERE client_request_id = 'new-request'",
			)
			.run(JSON.stringify({ ...receipt, executionId: "different-worker" }));
		expect(reopened.getWorkflowHoldResumeReceipt("new-request")).toMatchObject({
			receiptKind: "invalid_receipt",
			recoveryReceipt: null,
		});

		// A damaged new receipt cannot silently fall back to legacy success.
		reopenedRaw
			.prepare(
				"UPDATE workflow_delivery_operation SET recovery_receipt_json = '{}' WHERE client_request_id = 'new-request'",
			)
			.run();
		expect(reopened.getWorkflowHoldResumeReceipt("new-request")).toMatchObject({
			receiptKind: "invalid_receipt",
			recoveryReceipt: null,
		});
	});
});
