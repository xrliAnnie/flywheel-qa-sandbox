import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const ANCHOR = "a".repeat(40);
const REF = "refs/flywheel/checkpoints/run-1/shared";

describe("workflow resume checkpoint retention", () => {
	it("keeps a shared ref for a recent live root, prunes invalid recent history, and closes the admission race", async () => {
		const store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-1",
			issueId: "FLY-1707",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run(
			"UPDATE workflow_run SET status = 'completed' WHERE run_id = 'run-1'",
		);
		const insert = (id: string, attempt: number, createdAt: string) => {
			db.run(
				`INSERT INTO workflow_resume_attachment
				   (attachment_id, run_id, target_node_id, target_attempt, transition_uid,
				    receipt_kind, receipt_digest, carrier_kind, anchor_ref, anchor_commit,
				    repo_identity, snapshot_digest, resolved_node_digest,
				    rework_authority_digest, envelope_json, created_at)
				 VALUES (?, 'run-1', 'implement', ?, ?, 'resume_replacement', ?,
				         'git_checkpoint', ?, ?, 'flywheel', 'snapshot', 'node',
				         'none', '{}', ?)`,
				[
					id,
					attempt,
					`transition:${id}`,
					`receipt:${id}`,
					REF,
					ANCHOR,
					createdAt,
				],
			);
			db.run(
				`INSERT INTO workflow_resume_attachment_state
				   (attachment_id, state, store_locator, envelope_stamped_json,
				    runtime_semantics_stamped, updated_at)
				 VALUES (?, 'ready', '{}', '{}', 'runtime', ?)`,
				[id, createdAt],
			);
		};
		insert("old", 1, "2026-01-01T00:00:00.000Z");
		insert("recent", 2, "2026-08-10T00:00:00.000Z");

		expect(
			store.listWorkflowResumeCheckpointPruneWork({
				now: "2026-08-15T00:00:00.000Z",
			}),
		).toEqual([]);
		db.run(
			`UPDATE workflow_resume_attachment_state
			    SET state = 'invalid', invalid_reason = 'anchor_unreachable'
			  WHERE attachment_id = 'recent'`,
		);
		const [candidate] = store.listWorkflowResumeCheckpointPruneWork({
			now: "2026-08-15T00:00:00.000Z",
		});
		expect(candidate).toMatchObject({
			projectName: "flywheel",
			ref: REF,
			anchor: ANCHOR,
		});
		expect(
			store.isWorkflowResumeCheckpointRefPrunable({
				...candidate!,
				now: "2026-08-15T00:00:00.000Z",
			}),
		).toBe(true);

		insert("raced-child", 3, "2026-08-15T00:00:00.000Z");
		expect(
			store.isWorkflowResumeCheckpointRefPrunable({
				...candidate!,
				now: "2026-08-15T00:00:00.000Z",
			}),
		).toBe(false);
		store.close();
	});
});
