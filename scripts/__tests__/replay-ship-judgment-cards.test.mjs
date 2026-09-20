import assert from "node:assert/strict";
import {
	linkSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	postDecisionMergeEvidence,
	resolveReplayBinding,
	verifySnapshotPath,
} from "../replay-ship-judgment-cards.mjs";

const require = createRequire(
	new URL("../../packages/teamlead/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const AT = "2026-09-14T20:00:00.000Z",
	BEFORE = "2026-09-14T19:00:00.000Z",
	AFTER = "2026-09-14T21:00:00.000Z";
const HEAD = "a".repeat(40),
	OTHER = "b".repeat(40);
const outcome = {
	question_id: "q",
	run_id: "r",
	card_message_id: "card",
	decided_at: AT,
};
function fixture() {
	const db = new Database(":memory:");
	db.exec(`
 CREATE TABLE workflow_run(run_id TEXT,issue_id TEXT,project_name TEXT);
 CREATE TABLE workflow_gate_holder(question_id TEXT,run_id TEXT,head_sha TEXT,card_message_id TEXT,created_at TEXT);
 CREATE TABLE workflow_ship_target_binding(approve_question_id TEXT,run_id TEXT,target_repo_identity TEXT,probe_repo_slug TEXT,frozen_head_sha TEXT);
 CREATE TABLE workflow_node_pr_binding(run_id TEXT,target_repo_identity TEXT,probe_repo_slug TEXT,pr_number INTEGER,head_sha TEXT,bound_at TEXT);
 CREATE TABLE workflow_declared_pr(run_id TEXT,revision INTEGER,repo_identity TEXT,probe_repo_slug TEXT,pr_number INTEGER,frozen_head_sha TEXT,state TEXT,merged_at TEXT,declared_at TEXT);
 CREATE TABLE ship_judgment_opinion(opinion_id TEXT,question_id TEXT,mechanical_json TEXT,created_at TEXT,ordinal INTEGER);
 CREATE TABLE workflow_run_event(run_id TEXT,kind TEXT,payload TEXT,at TEXT);
 CREATE TABLE land_operation(operation_id TEXT,run_id TEXT,project_name TEXT,pr_number INTEGER,approved_head TEXT,merge_confirmed_at TEXT);
 INSERT INTO workflow_run VALUES ('r','FLY-2553','flywheel');
 `);
	db.prepare(
		"INSERT INTO workflow_gate_holder VALUES ('q','r',?,'card',?)",
	).run(HEAD, BEFORE);
	db.prepare(
		"INSERT INTO workflow_ship_target_binding VALUES ('q','r','__main__','owner/main',?)",
	).run(HEAD);
	db.prepare(
		"INSERT INTO workflow_node_pr_binding VALUES ('r','__main__','owner/main',1194,?,?)",
	).run(HEAD, BEFORE);
	return db;
}
test("restores primary target from a decision-time node binding, never a future PR", () => {
	const db = fixture();
	try {
		db.prepare(
			"INSERT INTO workflow_node_pr_binding VALUES ('r','__main__','owner/main',9999,?,?)",
		).run(HEAD, AFTER);
		const b = resolveReplayBinding(db, outcome);
		assert.equal(b.source, "ship_binding");
		assert.deepEqual(b.binding.targets, [
			{
				repo_identity: "__main__",
				repo_slug: "owner/main",
				pr_number: 1194,
				head_sha: HEAD,
			},
		]);
	} finally {
		db.close();
	}
});
test("uses the as-of declared revision and keeps identical PR numbers in separate repos", () => {
	const db = fixture();
	try {
		const put = db.prepare(
			"INSERT INTO workflow_declared_pr VALUES ('r',?,?,?,?,?,'declared',NULL,?)",
		);
		put.run(1, "__main__", "owner/main", 1194, HEAD, BEFORE);
		put.run(1, "nested", "owner/nested", 1194, OTHER, BEFORE);
		put.run(2, "future", "owner/future", 1111, OTHER, AFTER);
		const result = resolveReplayBinding(db, outcome);
		assert.equal(result.binding.manifestRevision, 1);
		assert.deepEqual(
			result.binding.targets.map((t) => t.repo_identity),
			["__main__", "nested"],
		);
	} finally {
		db.close();
	}
});
test("prefers the first visible frozen opinion and ignores post-decision visibility", () => {
	const db = fixture();
	try {
		const base = resolveReplayBinding(db, outcome).binding;
		const frozen = { ...base, manifestRevision: 3 };
		db.prepare("INSERT INTO ship_judgment_opinion VALUES ('o','q',?,?,1)").run(
			JSON.stringify({ binding: frozen }),
			BEFORE,
		);
		const event = db.prepare(
			"INSERT INTO workflow_run_event VALUES ('r','ship_judgment_visible',?,?)",
		);
		event.run(
			JSON.stringify({
				opinion_id: "o",
				question_id: "q",
				receipt_time: AFTER,
				observed_at: AFTER,
			}),
			AFTER,
		);
		assert.equal(resolveReplayBinding(db, outcome).source, "ship_binding");
		event.run(
			JSON.stringify({
				opinion_id: "o",
				question_id: "q",
				receipt_time: BEFORE,
				observed_at: BEFORE,
			}),
			BEFORE,
		);
		assert.equal(resolveReplayBinding(db, outcome).binding.manifestRevision, 3);
	} finally {
		db.close();
	}
});
test("post-decision merge proof uses exact head and repo, without ancestry or borrowing another repo's PR", () => {
	const db = fixture();
	try {
		const resolved = resolveReplayBinding(db, outcome);
		db.prepare(
			"INSERT INTO land_operation VALUES ('land','r','flywheel',1194,?,?)",
		).run(HEAD, AFTER);
		assert.deepEqual(
			postDecisionMergeEvidence(db, resolved, resolved.binding.targets[0]),
			{
				id: "land",
				kind: "land_operation",
				observedAt: AFTER,
				postDecision: true,
			},
		);
		assert.equal(
			postDecisionMergeEvidence(db, resolved, {
				repo_identity: "nested",
				repo_slug: "owner/nested",
				pr_number: 1194,
				head_sha: HEAD,
			}),
			undefined,
		);
		assert.equal(
			postDecisionMergeEvidence(db, resolved, {
				...resolved.binding.targets[0],
				head_sha: OTHER,
			}),
			undefined,
		);
	} finally {
		db.close();
	}
});
test("rejects live paths, symlinks resolved under live home, and same-inode hard links", () => {
	const root = mkdtempSync(join(tmpdir(), "fly-2560-snapshot-"));
	try {
		const home = join(root, "home");
		mkdirSync(join(home, ".flywheel"), { recursive: true });
		const live = join(home, ".flywheel", "teamlead.db");
		writeFileSync(live, "fixture");
		const hard = join(root, "hard.db");
		linkSync(live, hard);
		assert.throws(
			() => verifySnapshotPath(live, { home, livePaths: [live] }),
			/live_database/,
		);
		assert.throws(
			() => verifySnapshotPath(hard, { home, livePaths: [live] }),
			/live_database/,
		);
		const safe = join(root, "snapshot.db");
		writeFileSync(safe, "snapshot");
		assert.equal(
			verifySnapshotPath(safe, { home, livePaths: [live] }),
			realpathSync(safe),
		);
		const symlink = join(root, "linked.db");
		symlinkSync(live, symlink);
		assert.throws(
			() => verifySnapshotPath(symlink, { home, livePaths: [live] }),
			/live_database/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

for (const { scenario, alignmentMissing, coverageMissing } of [
	{
		scenario: "complete",
		alignmentMissing: ["reviewed_plan_blob", "input"],
		coverageMissing: ["input"],
	},
	{
		scenario: "no_qa",
		alignmentMissing: ["reviewed_plan_blob", "input"],
		coverageMissing: ["qa_claim", "qa_report", "input"],
	},
	{
		scenario: "no_design",
		alignmentMissing: ["design_review", "plan_at_head", "input"],
		coverageMissing: ["input"],
	},
	{
		scenario: "future_qa",
		alignmentMissing: ["reviewed_plan_blob", "input"],
		coverageMissing: ["qa_claim", "qa_report", "input"],
	},
	{
		scenario: "future_design",
		alignmentMissing: ["design_review", "plan_at_head", "input"],
		coverageMissing: ["input"],
	},
])
	test(`replay uses shared as-of evidence: ${scenario}`, async () => {
		const { replayCards } = await import("../replay-ship-judgment-cards.mjs");
		const db = fixture();
		try {
			db.exec(`
 CREATE TABLE workflow_run_issue_alias(run_id TEXT,issue_alias TEXT);
 CREATE TABLE codex_review_job(request_id TEXT,execution_id TEXT,issue_id TEXT,project_name TEXT,review_type TEXT,round INTEGER,target_repo_identity TEXT,frozen_head_sha TEXT,status TEXT,verdict TEXT,target_path TEXT,created_at TEXT,responded_at TEXT);
 CREATE TABLE design_review_manifest(execution_id TEXT,expected_plan_path TEXT,expected_blob_sha TEXT,is_current INTEGER,created_at TEXT);
 CREATE TABLE workflow_run_node(run_id TEXT,node_id TEXT,attempt INTEGER,execution_id TEXT,started_at TEXT);
 CREATE TABLE workflow_claims(id INTEGER,server_seq INTEGER,workflow_run_id TEXT,node_id TEXT,decision_kind TEXT,subject_kind TEXT,subject_digest TEXT,attempt INTEGER,issuer_kind TEXT,issuer_node_id TEXT,issuer_execution_id TEXT,predicate TEXT,issued_at TEXT,permanent INTEGER,expires_at TEXT,evidence TEXT);
 CREATE TABLE workflow_claim_revocation(claim_id INTEGER,revoked_at TEXT);
 CREATE TABLE ship_judgment_outcome(outcome_id TEXT,question_id TEXT,run_id TEXT,card_message_id TEXT,targets_digest TEXT,source_kind TEXT,authorship TEXT,decision TEXT,decided_at TEXT,observed_at TEXT,evidence_json TEXT);
 `);
			const review = db.prepare(
				"INSERT INTO codex_review_job VALUES (?,?,'FLY-2553','flywheel',?,1,'__main__',?,'done','APPROVED','engineering/doc/plan.md',?,?)",
			);
			review.run("code", "exec-code", "code", HEAD, BEFORE, BEFORE);
			if (scenario !== "no_design")
				review.run(
					"design",
					"exec-design",
					"design",
					HEAD,
					scenario === "future_design" ? AFTER : BEFORE,
					scenario === "future_design" ? AFTER : BEFORE,
				);
			db.prepare(
				"INSERT INTO workflow_run_node VALUES ('r','qa',1,'qa-exec',?)",
			).run(BEFORE);
			if (scenario !== "no_qa")
				db.prepare(
					"INSERT INTO workflow_claims VALUES (1148,1148,'r','qa','qa_verdict','git_head',?,1,'runner_node','qa','qa-exec','qa_passed',?,1,NULL,?)",
				).run(
					HEAD,
					scenario === "future_qa" ? AFTER : BEFORE,
					JSON.stringify({
						summary:
							"Product https://reports.example/r/product/ Preview https://reports.example/r/preview/ Ship report (publish-only): https://reports.example/r/report/",
					}),
				);
			db.prepare(
				"INSERT INTO land_operation VALUES ('land','r','flywheel',1194,?,?)",
			).run(HEAD, AFTER);
			const put = db.prepare(
				"INSERT INTO ship_judgment_outcome VALUES (?,'q','r','card','digest','founder_verdict','founder_verified',?,?,?,'{}')",
			);
			put.run("decision", "approved", AT, AT);
			put.run("override", "rework", AFTER, AFTER);
			let reads = 0;
			const options = {
				issues: ["FLY-2553"],
				asOf: AFTER,
				repositories: new Map([["__main__", {}]]),
				readMaterial: async (target, design) => {
					reads++;
					assert.equal(target.head_sha, HEAD);
					return {
						diffBaseSha: OTHER,
						diff: {
							text: "+ fix",
							files: [{ path: "src/fix.ts", status: "M" }],
							complete: true,
							digest: "d".repeat(64),
						},
						...(design
							? { planBlob: { text: "approved plan", blobSha: "c".repeat(40) } }
							: {}),
					};
				},
			};
			const report = await replayCards(db, options);
			assert.equal(reads, 1);
			assert.equal(report.rows.length, 1);
			const row = report.rows[0];
			assert.equal(row.evidence.conflict.verdict, "pass");
			assert.equal(row.evidence.alignment.verdict, "undetermined");
			assert.deepEqual(row.evidence.alignment.missing, alignmentMissing);
			assert.equal(row.evidence.coverage.verdict, "undetermined");
			assert.deepEqual(row.evidence.coverage.missing, coverageMissing);
			assert.equal(row.postDecisionEvidence[0].observedAt, AFTER);
			assert.equal(row.asOf, AT);
			assert.equal(report.excluded[0].reason, "post_decision_override");
			assert.equal(report.summary.wouldApprove, 0);
			assert.equal(report.summary.wrongApprovals, 0);
			if (scenario === "complete") {
				assert.equal(row.materialProvenance[0].qaReport, "report");
				const windowed = await replayCards(db, { ...options, from: AFTER });
				assert.equal(windowed.rows.length, 0);
				assert.equal(windowed.excluded[0].reason, "post_decision_override");
				db.prepare(
					"UPDATE ship_judgment_outcome SET decision='rework' WHERE outcome_id='decision'",
				).run();
				const divergent = await replayCards(db, options);
				assert.equal(divergent.summary.wouldApprove, 0);
				assert.equal(divergent.summary.wrongApprovals, 0);
				assert.equal(divergent.rows[0].relation, "abstained");
			}
		} finally {
			db.close();
		}
	});

test("HTML escapes evidence and labels hindsight and the non-abstention denominator", async () => {
	const { renderReplayHtml } = await import(
		"../replay-ship-judgment-cards.mjs"
	);
	const html = renderReplayHtml({
		summary: {
			wouldApprove: 1,
			wrongApprovals: 0,
			abstained: 1,
			aligned: 1,
			assessed: 1,
			consistency: 1,
		},
		asOf: AT,
		missingIssues: [],
		excluded: [],
		rows: [
			{
				issue: "<script>alert(1)</script>",
				targets: [],
				asOf: AT,
				evidence: {
					evidence: [{ kind: "design_review", id: '"><img src=x>' }],
				},
				errors: [],
				overall: "undetermined",
				founderDecision: "approved",
				relation: "abstained",
				points: { alignment: "缺设计", conflict: "通过", coverage: "通过" },
			},
		],
	});
	assert.ok(html.includes("事后合入记录"));
	assert.ok(html.includes("1/1 个非弃权结论"));
	assert.ok(html.includes("&lt;script&gt;"));
	assert.ok(!html.includes("<script>"));
	assert.ok(!html.includes("<img src=x>"));
	assert.ok(Buffer.byteLength(html) < 512 * 1024);
});

test("accepts only an explicit immutable managed snapshot exception, still rejecting live inode aliases", async () => {
	const { chmodSync } = await import("node:fs");
	const root = mkdtempSync(join(tmpdir(), "fly-2560-managed-"));
	try {
		const home = join(root, "home"),
			folder = join(home, ".flywheel", "patrol-repairs");
		mkdirSync(folder, { recursive: true });
		const snapshot = join(folder, "FLY-2560__teamlead-global__fixture.db");
		writeFileSync(snapshot, "snapshot");
		assert.throws(
			() => verifySnapshotPath(snapshot, { home, managedSnapshot: snapshot }),
			/live_database/,
		);
		chmodSync(snapshot, 0o444);
		assert.equal(
			verifySnapshotPath(snapshot, { home, managedSnapshot: snapshot }),
			realpathSync(snapshot),
		);
		assert.throws(
			() => verifySnapshotPath(snapshot, { home }),
			/live_database/,
		);
		const live = join(home, ".flywheel", "teamlead.db");
		linkSync(snapshot, live);
		assert.throws(
			() =>
				verifySnapshotPath(snapshot, {
					home,
					managedSnapshot: snapshot,
					livePaths: [live],
				}),
			/live_database/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reads a sealed WAL-header snapshot without creating sidecars or changing its bytes", async () => {
	const { openReplaySnapshot } = await import(
		"../replay-ship-judgment-cards.mjs"
	);
	const { readFileSync, existsSync, chmodSync } = await import("node:fs");
	const root = mkdtempSync(join(tmpdir(), "fly-2560-wal-"));
	let source, reader;
	try {
		const original = join(root, "fixture.db"),
			snapshot = join(root, "snapshot.db");
		source = new Database(original);
		source.pragma("journal_mode=WAL");
		source.exec("CREATE TABLE evidence(id INTEGER, value TEXT)");
		source
			.prepare("INSERT INTO evidence VALUES (?,?)")
			.run(1, "committed-in-WAL");
		assert.ok(existsSync(original + "-wal"));
		await source.backup(snapshot);
		chmodSync(snapshot, 0o444);
		const before = readFileSync(snapshot);
		reader = openReplaySnapshot(snapshot);
		assert.deepEqual(
			reader.prepare("SELECT * FROM evidence WHERE id=?").get(1),
			{ id: 1, value: "committed-in-WAL" },
		);
		assert.throws(
			() => reader.prepare("DELETE FROM evidence").all(),
			/readonly/,
		);
		assert.ok(!existsSync(snapshot + "-wal"));
		assert.ok(!existsSync(snapshot + "-shm"));
		assert.deepEqual(readFileSync(snapshot), before);
	} finally {
		reader?.close();
		source?.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("reads two real checkouts with identical PR numbers and reconstructs a squash PR diff from merge receipts", async () => {
	const { prepareReplayRepositories, createReplayMaterialReader } =
		await import("../replay-ship-judgment-cards.mjs");
	const { execFileSync } = await import("node:child_process");
	const root = mkdtempSync(join(tmpdir(), "fly-2560-git-"));
	const db = fixture();
	let prepared;
	const git = (cwd, ...args) =>
		execFileSync(
			"git",
			[
				"-c",
				"user.name=fixture",
				"-c",
				"user.email=fixture@example.com",
				"-c",
				"commit.gpgsign=false",
				...args,
			],
			{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		).trim();
	try {
		const repos = [];
		for (const name of ["main", "nested"]) {
			const path = join(root, name);
			mkdirSync(path);
			git(path, "init", "--initial-branch=main");
			writeFileSync(join(path, "file.txt"), "base\n");
			git(path, "add", ".");
			git(path, "commit", "-m", "base");
			const base = git(path, "rev-parse", "HEAD");
			git(path, "checkout", "-b", "feature");
			mkdirSync(join(path, "engineering", "doc"), { recursive: true });
			writeFileSync(
				join(path, "engineering", "doc", "plan.md"),
				"plan for " + name,
			);
			writeFileSync(join(path, name + ".txt"), "fix " + name);
			git(path, "add", ".");
			git(path, "commit", "-m", "feature");
			const head = git(path, "rev-parse", "HEAD");
			git(path, "checkout", "main");
			git(path, "merge", "--squash", "feature");
			git(path, "commit", "-m", "squash");
			const merge = git(path, "rev-parse", "HEAD");
			git(
				path,
				"remote",
				"add",
				"origin",
				"https://github.com/owner/" + name + ".git",
			);
			repos.push({ name, path, base, head, merge });
		}
		const [main, nested] = repos;
		db.prepare("UPDATE workflow_gate_holder SET head_sha=?").run(main.head);
		db.prepare("UPDATE workflow_ship_target_binding SET frozen_head_sha=?").run(
			main.head,
		);
		db.prepare("UPDATE workflow_node_pr_binding SET head_sha=?").run(main.head);
		const declared = db.prepare(
			"INSERT INTO workflow_declared_pr VALUES ('r',1,?,?,1194,?,'merged',?,?)",
		);
		declared.run("__main__", "owner/main", main.head, AFTER, BEFORE);
		declared.run("nested", "owner/nested", nested.head, AFTER, BEFORE);
		db.prepare(
			"INSERT INTO land_operation VALUES ('land','r','flywheel',1194,?,?)",
		).run(main.head, AFTER);
		db.exec(
			"CREATE TABLE land_operation_step(operation_id TEXT,step TEXT,receipt_json TEXT); CREATE TABLE ship_judgment_input(question_id TEXT,targets_json TEXT,requested_at TEXT,semantic_ordinal INTEGER)",
		);
		db.prepare(
			"INSERT INTO land_operation_step VALUES ('land','merge_confirmed',?)",
		).run(JSON.stringify({ mergeSha: main.merge, headSha: main.head }));
		const resolved = resolveReplayBinding(db, outcome);
		prepared = await prepareReplayRepositories([
			["__main__", main.path],
			["nested", nested.path],
		]);
		let lookups = 0;
		const reader = createReplayMaterialReader(db, prepared.repositories, {
			lookupPr: async (target) => {
				lookups++;
				assert.equal(target.repo_identity, "nested");
				return {
					headSha: nested.head,
					baseSha: nested.base,
					mergeSha: nested.merge,
					mergedAt: AFTER,
					observedAt: AFTER,
					receiptSha256: "e".repeat(64),
				};
			},
		});
		for (const target of resolved.binding.targets) {
			const input = await reader(
				target,
				{ status: "approved", path: "engineering/doc/plan.md" },
				resolved,
			);
			const repo = target.repo_identity === "__main__" ? main : nested;
			assert.equal(input.diffBaseSha, repo.base);
			assert.equal(input.planBlob.text, "plan for " + repo.name);
			assert.ok(
				input.diff.files.some((file) => file.path === repo.name + ".txt"),
			);
			assert.equal(
				input.provenance.diffBaseSource,
				"merge_receipt_first_parent_merge_base",
			);
		}
		assert.equal(lookups, 1);
		for (const repo of repos)
			assert.equal(git(repo.path, "status", "--porcelain"), "");
	} finally {
		await prepared?.dispose();
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failed diff read preserves the available frozen plan and identifies the diff failure", async () => {
	const { createReplayMaterialReader } = await import(
		"../replay-ship-judgment-cards.mjs"
	);
	const db = fixture();
	try {
		db.exec(
			"CREATE TABLE ship_judgment_input(question_id TEXT,targets_json TEXT,requested_at TEXT,semantic_ordinal INTEGER)",
		);
		db.prepare("INSERT INTO ship_judgment_input VALUES ('q',?,?,1)").run(
			JSON.stringify([
				{
					repo_identity: "__main__",
					pr_number: 1194,
					head_sha: HEAD,
					diff_base_sha: OTHER,
				},
			]),
			BEFORE,
		);
		const repo = {
			repoSlug: "owner/main",
			reader: {
				readText: async () => ({
					blobSha: "c".repeat(40),
					text: "available plan",
				}),
				diff: async () => {
					const error = new Error("stdout maxBuffer length exceeded");
					error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
					throw error;
				},
			},
		};
		const read = createReplayMaterialReader(db, new Map([["__main__", repo]]), {
			lookupPr: async () => undefined,
		});
		const resolved = resolveReplayBinding(db, outcome);
		const result = await read(
			resolved.binding.targets[0],
			{ status: "approved", path: "engineering/doc/plan.md" },
			resolved,
		);
		assert.equal(result.planBlob.text, "available plan");
		assert.equal(result.diffBaseSha, OTHER);
		assert.equal(result.provenance.diffReadError, "diff_budget_exceeded");
		assert.equal(result.diff, undefined);
	} finally {
		db.close();
	}
});
