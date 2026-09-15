import type Database from "better-sqlite3";
import { StateStore } from "../../StateStore.js";

export const HEAD = "a".repeat(40);
export const NOW = "2026-09-11T00:00:00.000Z";
export const CHANNEL = "123456789012345670";
export async function bindingFixture(path = ":memory:"): Promise<{
	store: StateStore;
	db: Database.Database;
	channel: string;
}> {
	const store = await StateStore.create(path);
	const db = (store as unknown as { db: { raw: Database.Database } }).db.raw;
	store.createWorkflowRun({
		runId: "r",
		issueId: "FLY-2399",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	store.upsertWorkflowRunNode({
		runId: "r",
		nodeId: "implement",
		attempt: 1,
		state: "completed",
		executionId: "execution",
	});
	store.upsertWorkflowRunNode({
		runId: "r",
		nodeId: "founder_gate",
		attempt: 1,
		state: "running",
	});
	// Exercise actual durable bindings, without mocks of the binding reader.
	db.prepare(`INSERT INTO workflow_gate_holder(run_id,gate_node_id,attempt,head_sha,source_execution_id,question_id,
		authority_mode,subject_kind,carrier_binding_state,card_message_id,state,materialization_stage,created_at,updated_at)
		VALUES ('r','founder_gate',1,?,'execution','q','land','git_head','bound','123456789012345678','awaiting_review','completed',?,?)`).run(
		HEAD,
		NOW,
		NOW,
	);
	db.prepare(`INSERT INTO workflow_node_pr_binding(run_id,node_id,attempt,pr_number,head_sha,target_repo_identity,probe_repo_slug,
		target_repo_path,worktree_binding_generation,receipt_id,bound_at)
		VALUES ('r','implement',1,2399,?,'__main__','owner/repo','/tmp/test','g','receipt',?)`).run(
		HEAD,
		NOW,
	);
	db.prepare(`INSERT INTO workflow_ship_target_binding(approve_question_id,run_id,target_repo_path,target_repo_identity,
		probe_repo_slug,frozen_head_sha,worktree_binding_generation)
		VALUES ('q','r','/tmp/test','__main__','owner/repo',?,'g')`).run(HEAD);
	db.prepare(
		"INSERT INTO chat_threads(thread_id,channel_id,issue_id) VALUES ('123456789012345679',?,'FLY-2399')",
	).run(CHANNEL);
	return { store, db, channel: CHANNEL };
}
