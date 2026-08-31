import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import {
	importWorkflowMenuSeeds,
	workflowMenuBindings,
} from "../workflow-menu.js";
import { importLegacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

const BASELINE = [{ taskCategory: "*", templateId: "tpl_eng_heavy" }] as const;

const TARGET = workflowMenuBindings();
const TARGET_SORTED = [...TARGET].sort((a, b) =>
	a.taskCategory.localeCompare(b.taskCategory),
);

async function seededStore(): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	importLegacyWorkflowSeeds(store);
	importWorkflowMenuSeeds(store);
	store.bindWorkflowCategory({
		project: "flywheel",
		templateId: "tpl_eng_heavy",
		updatedBy: "system:bundled-default",
	});
	return store;
}

function cutoverInput(overrides: Record<string, unknown> = {}) {
	return {
		operationId: "fly-1436-activate-1",
		activationId: "FLY-1436",
		kind: "activate" as const,
		canonicalHash: "activate-hash",
		snapshotHash: "snapshot-hash",
		project: "flywheel",
		actor: "system:fly-1436-cutover",
		expectedBefore: BASELINE,
		targetBindings: TARGET,
		...overrides,
	};
}

describe("StateStore FLY-1436 work-kind cutover", () => {
	it("keeps an exact-only binding read separate from wildcard fallback", async () => {
		const store = await seededStore();

		expect(
			store.getWorkflowCategoryBinding("flywheel", "generic"),
		).toMatchObject({ task_category: "*", template_id: "tpl_eng_heavy" });
		expect(
			store.getWorkflowCategoryBindingExact("flywheel", "generic"),
		).toBeUndefined();
		expect(
			store.getWorkflowCategoryBindingExact("flywheel", "*"),
		).toMatchObject({ task_category: "*", template_id: "tpl_eng_heavy" });
		store.close();
	});

	it("commits all six bindings, row audits, and the durable receipt in one transaction", async () => {
		const store = await seededStore();
		const auditBefore = store.listWorkflowTemplateAudit().length;

		const committed = store.commitWorkflowBindingCutover(cutoverInput());
		expect(committed).toMatchObject({
			status: "committed",
			receipt: {
				operationId: "fly-1436-activate-1",
				activationId: "FLY-1436",
				kind: "activate",
				canonicalHash: "activate-hash",
				snapshotHash: "snapshot-hash",
				before: BASELINE,
				after: TARGET_SORTED,
				auditCount: TARGET.length + 1,
			},
		});
		expect(store.listWorkflowCategoryBindings("flywheel")).toMatchObject(
			TARGET_SORTED.map((binding) => ({
				task_category: binding.taskCategory,
				template_id: binding.templateId,
			})),
		);
		expect(store.listWorkflowTemplateAudit()).toHaveLength(
			auditBefore + TARGET.length + 1,
		);
		expect(
			store.getWorkflowBindingCutoverClaim("fly-1436-activate-1"),
		).toMatchObject({
			operation_id: "fly-1436-activate-1",
			status: "committed",
			canonical_hash: "activate-hash",
		});
		store.close();
	});

	it("replays a committed operation without a second mutation and rejects operation-id drift", async () => {
		const store = await seededStore();
		expect(store.commitWorkflowBindingCutover(cutoverInput()).status).toBe(
			"committed",
		);
		const auditCount = store.listWorkflowTemplateAudit().length;

		expect(store.commitWorkflowBindingCutover(cutoverInput())).toMatchObject({
			status: "replayed",
			receipt: { operationId: "fly-1436-activate-1" },
		});
		expect(store.listWorkflowTemplateAudit()).toHaveLength(auditCount);
		expect(
			store.commitWorkflowBindingCutover(
				cutoverInput({ canonicalHash: "different-hash" }),
			),
		).toEqual({ status: "operation_conflict" });
		store.close();
	});

	it("replays the durable receipt after reopening SQLite and keeps claims immutable", async () => {
		const directory = mkdtempSync(join(tmpdir(), "fly1436-state-"));
		const dbPath = join(directory, "state.db");
		try {
			const first = await StateStore.create(dbPath);
			importLegacyWorkflowSeeds(first);
			importWorkflowMenuSeeds(first);
			first.bindWorkflowCategory({
				project: "flywheel",
				templateId: "tpl_eng_heavy",
				updatedBy: "system:bundled-default",
			});
			expect(first.commitWorkflowBindingCutover(cutoverInput()).status).toBe(
				"committed",
			);
			first.close();

			const reopened = await StateStore.create(dbPath);
			const auditCount = reopened.listWorkflowTemplateAudit().length;
			expect(
				reopened.commitWorkflowBindingCutover(cutoverInput()),
			).toMatchObject({
				status: "replayed",
				receipt: { operationId: "fly-1436-activate-1" },
			});
			expect(reopened.listWorkflowTemplateAudit()).toHaveLength(auditCount);
			const raw = (
				reopened as unknown as {
					db: { run(sql: string, params?: unknown[]): void };
				}
			).db;
			expect(() =>
				raw.run(
					"UPDATE workflow_binding_cutover_claim SET status = 'tampered' WHERE operation_id = ?",
					["fly-1436-activate-1"],
				),
			).toThrow(/append-only/);
			expect(() =>
				raw.run(
					"DELETE FROM workflow_binding_cutover_claim WHERE operation_id = ?",
					["fly-1436-activate-1"],
				),
			).toThrow(/append-only/);
			reopened.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rolls back the whole transaction on target validation or baseline drift", async () => {
		const store = await seededStore();
		const auditCount = store.listWorkflowTemplateAudit().length;

		expect(
			store.commitWorkflowBindingCutover(
				cutoverInput({
					targetBindings: [
						...TARGET.slice(0, -1),
						{ taskCategory: "generic", templateId: "missing-template" },
					],
				}),
			),
		).toMatchObject({ status: "target_invalid" });
		expect(store.listWorkflowCategoryBindings("flywheel")).toMatchObject([
			{ task_category: "*", template_id: "tpl_eng_heavy" },
		]);
		expect(store.listWorkflowTemplateAudit()).toHaveLength(auditCount);
		expect(
			store.getWorkflowBindingCutoverClaim("fly-1436-activate-1"),
		).toBeUndefined();

		expect(
			store.commitWorkflowBindingCutover(
				cutoverInput({
					expectedBefore: [{ taskCategory: "*", templateId: "tpl_eng_light" }],
				}),
			),
		).toEqual({ status: "baseline_mismatch" });
		store.close();
	});

	it("restores only from the committed activation receipt and refuses later drift", async () => {
		const store = await seededStore();
		expect(store.commitWorkflowBindingCutover(cutoverInput()).status).toBe(
			"committed",
		);

		const restore = {
			operationId: "fly-1436-restore-1",
			activationId: "FLY-1436",
			kind: "restore" as const,
			sourceOperationId: "fly-1436-activate-1",
			canonicalHash: "restore-hash",
			snapshotHash: "snapshot-hash",
			project: "flywheel",
			actor: "system:fly-1436-cutover",
			expectedBefore: TARGET,
			targetBindings: BASELINE,
		};
		expect(store.commitWorkflowBindingCutover(restore)).toMatchObject({
			status: "committed",
			receipt: { kind: "restore", before: TARGET_SORTED, after: BASELINE },
		});
		expect(store.listWorkflowCategoryBindings("flywheel")).toMatchObject([
			{ task_category: "*", template_id: "tpl_eng_heavy" },
		]);

		expect(
			store.commitWorkflowBindingCutover({
				...restore,
				operationId: "fly-1436-restore-2",
				canonicalHash: "restore-hash-2",
			}),
		).toEqual({ status: "target_drift" });
		expect(
			store.commitWorkflowBindingCutover({
				...restore,
				operationId: "fly-1436-restore-3",
				sourceOperationId: "missing-activation",
				canonicalHash: "restore-hash-3",
			}),
		).toEqual({ status: "activation_receipt_not_found" });
		store.close();
	});

	it("counts only releasable state tied to active schema-2 runs", async () => {
		const store = await seededStore();
		const raw = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		for (const [runId, status] of [
			["active-v2", "active"],
			["completed-v2", "completed"],
		] as const) {
			raw.run(
				`INSERT INTO workflow_run
				 (run_id, issue_id, project_name, template_id, template_revision,
				  status, claims_read_enrolled, engine_owned)
				 VALUES (?, ?, 'flywheel', 'tpl_generic', 1, ?, 1, 1)`,
				[runId, `issue-${runId}`, status],
			);
			raw.run(
				`INSERT INTO workflow_side_effect_ledger
				 (run_id, node_id, attempt, kind, launch_ordinal, execution_id, state)
				 VALUES (?, 'implement', 1, 'dispatch', 1, ?, 'launch_committed')`,
				[runId, `exec-${runId}`],
			);
			raw.run(
				`INSERT INTO workflow_start_reservation
				 (idempotency_key, selection_digest, run_id, node_id, attempt,
				  execution_id, created_at)
				 VALUES (?, 'selection', ?, 'implement', 1, ?, '2026-07-23T00:00:00.000Z')`,
				[`key-${runId}`, runId, `start-${runId}`],
			);
			raw.run(
				`INSERT INTO workflow_start_stage
				 (idempotency_key, stage, updated_at)
				 VALUES (?, 'launch_committed', '2026-07-23T00:00:00.000Z')`,
				[`key-${runId}`],
			);
		}

		expect(store.getGeneralizedWorkflowReleaseState()).toMatchObject({
			activeSchema2Runs: 1,
			nonterminalSideEffects: 1,
			unrespondedReservations: 1,
			releasable: false,
			activeRunIds: ["active-v2"],
			activeSideEffectExecutionIds: ["exec-active-v2"],
			activeReservationKeys: ["key-active-v2"],
			diagnostics: {
				terminalSchema2RunsWithResidue: 1,
			},
		});

		raw.run(
			"UPDATE workflow_start_stage SET stage = 'responded' WHERE idempotency_key = 'key-active-v2'",
		);
		expect(store.getGeneralizedWorkflowReleaseState()).toMatchObject({
			activeSchema2Runs: 1,
			nonterminalSideEffects: 1,
			unrespondedReservations: 0,
			releasable: false,
			activeReservationKeys: [],
		});

		raw.run(
			"UPDATE workflow_side_effect_ledger SET state = 'started' WHERE run_id = 'active-v2'",
		);
		expect(store.getGeneralizedWorkflowReleaseState()).toMatchObject({
			activeSchema2Runs: 1,
			nonterminalSideEffects: 0,
			unrespondedReservations: 0,
			releasable: false,
			activeSideEffectExecutionIds: [],
		});

		raw.run(
			"UPDATE workflow_run SET status = 'terminated' WHERE run_id = 'active-v2'",
		);
		expect(store.getGeneralizedWorkflowReleaseState()).toMatchObject({
			activeSchema2Runs: 0,
			nonterminalSideEffects: 0,
			unrespondedReservations: 0,
			releasable: true,
			activeRunIds: [],
			activeSideEffectExecutionIds: [],
			activeReservationKeys: [],
		});
		store.close();
	});
});
