import type Database from "better-sqlite3";
import { StateStore } from "../../StateStore.js";
import { buildWorkflowRunSnapshotV1 } from "../../workflow-run-snapshot.js";
export function landSnapshot(): string {
	return JSON.stringify(
		buildWorkflowRunSnapshotV1({
			template: { id: "tpl_eng_heavy_land_v1", revision: 1 },
			manifest: {
				schema_version: 1,
				manifest_variant: "land_v1",
				nodes: [
					{
						id: "design",
						type: "design",
						vendor: "claude",
						model: "claude-fable-5",
					},
					{
						id: "implement",
						type: "implement",
						vendor: "codex",
						model: "gpt-5.6-sol",
						effort: "xhigh",
					},
					{
						id: "qa",
						type: "qa",
						vendor: "claude",
						model: "claude-opus-5",
					},
					{ id: "founder_gate", type: "gate" },
					{ id: "land", type: "land", execution: "engine" },
				],
				edges: [
					{
						id: "design_done",
						from: "design",
						to: "implement",
						condition: "design_done",
					},
					{
						id: "implement_done",
						from: "implement",
						to: "qa",
						condition: "implement_done",
					},
					{
						id: "qa_pass",
						from: "qa",
						to: "founder_gate",
						condition: "qa_pass",
					},
					{
						id: "founder_approved",
						from: "founder_gate",
						to: "land",
						condition: "founder_approved",
					},
				],
				loops: [
					{
						id: "qa_retry",
						from: "qa",
						to: "implement",
						loop_when: "qa_fail",
						exit_when: "qa_pass",
						max_iterations: 3,
						on_limit: "escalate",
					},
					{
						id: "founder_feedback",
						from: "founder_gate",
						to: "implement",
						loop_when: "founder_feedback_kickback",
						exit_when: "founder_approved",
						max_iterations: 3,
						on_limit: "escalate",
					},
				],
				approval_gate: {
					node: "founder_gate",
					predicate: "founder_approved",
				},
				terminal_node: { node: "land" },
				ship_claims: ["qa_passed", "founder_approved"],
			},
		}),
	);
}

function db(s: StateStore) {
	return (s as unknown as { db: { raw: Database.Database } }).db.raw;
}
export async function createAttentionGateStore() {
	const s = await StateStore.create(":memory:");
	s.createWorkflowRun({
		runId: "run",
		issueId: "issue",
		projectName: "flywheel",
		snapshotJson: landSnapshot(),
		claimsReadEnrolled: true,
	});
	db(s)
		.prepare(
			"UPDATE workflow_run SET engine_owned=1,current_node_id='founder_gate' WHERE run_id='run'",
		)
		.run();
	s.upsertWorkflowRunNode({
		runId: "run",
		nodeId: "founder_gate",
		attempt: 1,
		state: "review",
		executionId: "ended-execution",
	});
	db(s)
		.prepare(
			"INSERT INTO workflow_gate_holder(run_id,gate_node_id,attempt,head_sha,source_execution_id,question_id,state,created_at,updated_at) VALUES('run','founder_gate',1,?,'ended-execution','full-question-123456789','awaiting_review','2026-09-01 10:00:00','2026-09-01 10:00:00')",
		)
		.run("a".repeat(40));
	db(s)
		.prepare(
			"UPDATE workflow_gate_holder SET state='awaiting_review', created_at='2026-09-01 10:00:00'",
		)
		.run();
	return s;
}
