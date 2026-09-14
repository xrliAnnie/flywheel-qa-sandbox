import { expect, it } from "vitest";
import { bindingFixture } from "./binding-fixture.js";

it("derives configured and declared Flywheel repositories and rejects conflicting identities", async () => {
	const { store, db } = await bindingFixture();
	try {
		expect(store.readShipJudgmentRepositories("owner/repo")).toEqual([
			{ repo_identity: "__main__", repo_slug: "owner/repo" },
		]);
		db.prepare(
			"INSERT INTO workflow_pr_manifest(run_id,expected_count,current_revision,sealed_at,created_at,updated_at) VALUES ('r',1,1,'now','now','now')",
		).run();
		db.prepare(
			"INSERT INTO workflow_declared_pr(run_id,revision,repo_identity,probe_repo_slug,pr_number,frozen_head_sha,declared_at) VALUES ('r',1,'nested','owner/nested',2,?,'now')",
		).run("a".repeat(40));
		expect(store.readShipJudgmentRepositories("owner/repo")).toEqual([
			{ repo_identity: "__main__", repo_slug: "owner/repo" },
			{ repo_identity: "nested", repo_slug: "owner/nested" },
		]);
		expect(store.readShipJudgmentRepositories("wrong/repo")).toBeUndefined();
		db.prepare(
			"UPDATE workflow_pr_manifest SET sealed_at=NULL WHERE run_id='r'",
		).run();
		expect(store.readShipJudgmentRepositories("owner/repo")).toBeUndefined();
	} finally {
		store.close();
	}
});
