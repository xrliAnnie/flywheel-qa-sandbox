import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = realpathSync(
	resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
);
const requireFromTeamlead = createRequire(
	join(repoRoot, "packages/teamlead/package.json"),
);
const Database = requireFromTeamlead("better-sqlite3");

function git(cwd, args) {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function digestFile(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function addWorktree(root, path, branch, message) {
	git(root, ["worktree", "add", "-b", branch, path, "main"]);
	writeFileSync(join(path, `${message}.txt`), `${message}\n`);
	git(path, ["add", "."]);
	git(path, ["commit", "-m", message]);
	return git(path, ["rev-parse", "HEAD"]);
}

test("audit-merged-worktrees is read-only and distinguishes merged residue", () => {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "fly2664-audit-")));
	try {
		const root = join(parent, "flywheel");
		mkdirSync(root);
		git(root, ["init", "-b", "main"]);
		git(root, ["config", "user.name", "Flywheel Test"]);
		git(root, ["config", "user.email", "flywheel@example.invalid"]);
		writeFileSync(join(root, "README.md"), "base\n");
		git(root, ["add", "."]);
		git(root, ["commit", "-m", "base"]);
		const mergedPath = join(parent, "flywheel-FLY-2601");
		const mergedHead = addWorktree(
			root,
			mergedPath,
			"docs/FLY-2601-copy",
			"merged",
		);
		git(root, ["merge", "--ff-only", "docs/FLY-2601-copy"]);
		const unmergedPath = join(parent, "flywheel-FLY-2665");
		const unmergedHead = addWorktree(
			root,
			unmergedPath,
			"docs/FLY-2665-copy",
			"unmerged",
		);

		const dbPath = join(parent, "teamlead.db");
		const db = new Database(dbPath);
		db.exec(`
			CREATE TABLE land_operation (
			 operation_id TEXT, issue_id TEXT, project_name TEXT, pr_number INTEGER,
			 approved_head TEXT, merge_confirmed_at TEXT, state TEXT,
			 closeout_targets_json TEXT
			);
			CREATE TABLE land_operation_step (
			 operation_id TEXT, step TEXT, receipt_json TEXT, completed_at TEXT
			);
			CREATE TABLE sessions (
			 execution_id TEXT, issue_id TEXT, project_name TEXT, status TEXT,
			 worktree_binding_path TEXT, worktree_binding_branch TEXT,
			 worktree_binding_generation TEXT
			);
		`);
		const target = (path, branch) =>
			JSON.stringify({
				version: 1,
				targets: [
					{ kind: "bound_worktree", path, branch, generation: "gen-1" },
				],
			});
		db.prepare(
			"INSERT INTO land_operation VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"op-merged",
			"FLY-2601<script>",
			"flywheel",
			1232,
			mergedHead,
			"2026-09-17T00:00:00.000Z",
			"partial",
			target(mergedPath, "flywheel-FLY-2601"),
		);
		db.prepare(
			"INSERT INTO land_operation VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"op-unmerged",
			"FLY-2665",
			"flywheel",
			1235,
			unmergedHead,
			null,
			"waiting",
			target(unmergedPath, "flywheel-FLY-2665"),
		);
		db.prepare("INSERT INTO land_operation_step VALUES (?, ?, ?, ?)").run(
			"op-merged",
			"merge_confirmed",
			JSON.stringify({
				state: "MERGED",
				headSha: mergedHead,
				mergeSha: mergedHead,
			}),
			"2026-09-17T00:00:00.000Z",
		);
		db.prepare("INSERT INTO land_operation_step VALUES (?, ?, ?, ?)").run(
			"op-merged",
			"aux:merged_worktree_proof",
			JSON.stringify({
				state: "MERGED",
				headSha: mergedHead,
				mergeSha: mergedHead,
				baseRefName: "main",
				repoIdentity: "owner/flywheel",
			}),
			"2026-09-17T00:00:01.000Z",
		);
		db.close();

		const before = {
			db: digestFile(dbPath),
			head: git(root, ["rev-parse", "HEAD"]),
			refs: git(root, ["show-ref"]),
			status: git(root, ["status", "--porcelain"]),
			worktrees: git(root, ["worktree", "list", "--porcelain"]),
		};
		const result = spawnSync(
			process.execPath,
			[
				join(repoRoot, "scripts/audit-merged-worktrees.mjs"),
				"--project",
				"flywheel",
				"--repo",
				root,
				"--state-snapshot",
				dbPath,
				"--format",
				"json",
			],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);
		const report = JSON.parse(result.stdout);
		assert.equal(report.mode, "read_only");
		assert.equal(report.deletionPerformed, false);
		assert.match(JSON.stringify(report), /FLY-2601<script>/);
		assert.equal(
			report.candidates.find((candidate) => candidate.path === mergedPath)
				.classification,
			"merged_residue",
		);
		assert.notEqual(
			report.candidates.find((candidate) => candidate.path === unmergedPath)
				.classification,
			"merged_residue",
		);
		assert.deepEqual(
			{
				db: digestFile(dbPath),
				head: git(root, ["rev-parse", "HEAD"]),
				refs: git(root, ["show-ref"]),
				status: git(root, ["status", "--porcelain"]),
				worktrees: git(root, ["worktree", "list", "--porcelain"]),
			},
			before,
		);

		const rejected = spawnSync(
			process.execPath,
			[join(repoRoot, "scripts/audit-merged-worktrees.mjs"), "--apply", "yes"],
			{ encoding: "utf8" },
		);
		assert.notEqual(rejected.status, 0);
		assert.match(rejected.stderr, /invalid_or_mutating_argument/);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});
