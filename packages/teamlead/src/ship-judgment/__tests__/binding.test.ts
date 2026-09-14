import { describe, expect, it } from "vitest";
import { bindingFixture, CHANNEL, HEAD, NOW } from "./binding-fixture.js";

describe("ship judgment current binding", () => {
	it("does not silently reduce an unsealed multi-repository run to its primary PR", async () => {
		const { store, db } = await bindingFixture();
		try {
			store.upsertWorkflowRunNode({
				runId: "r",
				nodeId: "nested",
				attempt: 1,
				state: "completed",
				executionId: "nested-execution",
			});
			db.prepare(`INSERT INTO workflow_node_pr_binding(run_id,node_id,attempt,pr_number,head_sha,target_repo_identity,probe_repo_slug,
				target_repo_path,worktree_binding_generation,receipt_id,bound_at)
				VALUES ('r','nested',1,12,?,'nested','owner/nested','/tmp/nested','g','nested-receipt',?)`).run(
				"b".repeat(40),
				NOW,
			);
			expect(store.readShipJudgmentBinding("q", CHANNEL)).toBeUndefined();
		} finally {
			store.close();
		}
	});
	it("derives exact primary card, thread, and PR identity from durable records", async () => {
		const { store } = await bindingFixture();
		try {
			expect(store.readShipJudgmentBinding("q", CHANNEL)).toEqual({
				projectName: "flywheel",
				runId: "r",
				questionId: "q",
				issueId: "FLY-2399",
				cardMessageId: "123456789012345678",
				threadId: "123456789012345679",
				manifestRevision: 0,
				targets: [
					{
						repo_identity: "__main__",
						repo_slug: "owner/repo",
						pr_number: 2399,
						head_sha: HEAD,
					},
				],
			});
			expect(
				store.readShipJudgmentBinding("q", "wrong-channel"),
			).toBeUndefined();
		} finally {
			store.close();
		}
	});
	it("requires complete sealed multi-repository identity and rejects head drift", async () => {
		const { store, db } = await bindingFixture();
		try {
			db.prepare(
				"INSERT INTO workflow_pr_manifest(run_id,expected_count,current_revision,created_at,updated_at) VALUES ('r',2,1,?,?)",
			).run(NOW, NOW);
			expect(store.readShipJudgmentBinding("q", CHANNEL)).toBeUndefined();
			db.prepare("UPDATE workflow_pr_manifest SET sealed_at=?").run(NOW);
			const insert =
				db.prepare(`INSERT INTO workflow_declared_pr(run_id,revision,repo_identity,probe_repo_slug,pr_number,frozen_head_sha,declared_at)
				VALUES ('r',1,?,?,?,?,?)`);
			insert.run("__main__", "owner/repo", 2399, HEAD, NOW);
			expect(store.readShipJudgmentBinding("q", CHANNEL)).toBeUndefined();
			insert.run("nested", "owner/nested", 12, "b".repeat(40), NOW);
			expect(store.readShipJudgmentBinding("q", CHANNEL)?.targets).toHaveLength(
				2,
			);
			db.prepare(
				"UPDATE workflow_declared_pr SET frozen_head_sha=? WHERE repo_identity='__main__'",
			).run("c".repeat(40));
			expect(store.readShipJudgmentBinding("q", CHANNEL)).toBeUndefined();
		} finally {
			store.close();
		}
	});
	it.each([
		"UPDATE workflow_run SET project_name='raya'",
		"UPDATE workflow_run SET status='completed'",
		"UPDATE workflow_gate_holder SET state='approved'",
		"UPDATE workflow_gate_holder SET materialization_stage='card_posted'",
		"UPDATE workflow_ship_target_binding SET superseded_at='2026-09-11'",
		"UPDATE chat_threads SET discord_missing_at='2026-09-11'",
	])("rejects inactive or incomplete bindings: %s", async (sql) => {
		const { store, db } = await bindingFixture();
		try {
			db.exec(sql);
			expect(store.readShipJudgmentBinding("q", CHANNEL)).toBeUndefined();
		} finally {
			store.close();
		}
	});
});
