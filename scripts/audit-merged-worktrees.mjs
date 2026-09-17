#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	createReadStream,
	existsSync,
	readdirSync,
	realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = realpathSync(
	resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);
const requireFromTeamlead = createRequire(
	join(scriptRoot, "packages/teamlead/package.json"),
);
const Database = requireFromTeamlead("better-sqlite3");

function fail(reason) {
	process.stderr.write(`${JSON.stringify({ ok: false, reason })}\n`);
	process.exitCode = 1;
}

function args(argv) {
	const allowed = new Set([
		"--project",
		"--repo",
		"--state-snapshot",
		"--format",
	]);
	const out = {};
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!allowed.has(key) || !value || value.startsWith("--")) {
			throw new Error(`invalid_or_mutating_argument:${key ?? "missing"}`);
		}
		out[key.slice(2)] = value;
	}
	if (
		!out.project ||
		!out.repo ||
		!out["state-snapshot"] ||
		out.format !== "json"
	) {
		throw new Error(
			"usage: --project NAME --repo ROOT --state-snapshot DB --format json",
		);
	}
	return out;
}

function git(repo, argv) {
	return spawnSync("git", ["-C", repo, ...argv], {
		encoding: "utf8",
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
	});
}

function parseWorktrees(repo) {
	const result = git(repo, ["worktree", "list", "--porcelain"]);
	if (result.status !== 0)
		throw new Error(`git_worktree_list_failed:${result.stderr.trim()}`);
	const rows = [];
	let row;
	for (const line of result.stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (row) rows.push(row);
			row = { path: line.slice("worktree ".length), locked: false };
		} else if (row && line.startsWith("HEAD ")) {
			row.head = line.slice(5).toLowerCase();
		} else if (row && line.startsWith("branch refs/heads/")) {
			row.branch = line.slice("branch refs/heads/".length);
		} else if (row && line === "detached") {
			row.detached = true;
		} else if (row && line.startsWith("locked")) {
			row.locked = true;
		}
	}
	if (row) rows.push(row);
	return rows;
}

function tableExists(db, name) {
	return Boolean(
		db
			.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
			.get(name),
	);
}

function parseJson(value) {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

async function fileDigest(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

function localMainSha(repo) {
	for (const ref of ["refs/remotes/origin/main", "refs/heads/main"]) {
		const result = git(repo, ["rev-parse", "--verify", "-q", ref]);
		if (result.status === 0) return result.stdout.trim().toLowerCase();
	}
	return null;
}

async function main() {
	const input = args(process.argv.slice(2));
	if (!existsSync(input.repo) || !existsSync(input["state-snapshot"])) {
		throw new Error("repo_or_snapshot_missing");
	}
	const repo = realpathSync(input.repo);
	const snapshot = realpathSync(input["state-snapshot"]);
	if (basename(repo).toLowerCase() !== input.project.toLowerCase()) {
		throw new Error("project_repo_identity_mismatch");
	}
	const top = execFileSync(
		"git",
		["-C", repo, "rev-parse", "--show-toplevel"],
		{
			encoding: "utf8",
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		},
	).trim();
	if (realpathSync(top) !== repo) throw new Error("repo_not_exact_toplevel");

	const snapshotDigest = await fileDigest(snapshot);
	const db = new Database(snapshot, { readonly: true, fileMustExist: true });
	let operations = [];
	let steps = [];
	let bindings = [];
	try {
		db.pragma("query_only = ON");
		if (tableExists(db, "land_operation")) {
			operations = db
				.prepare(
					`SELECT operation_id, issue_id, project_name, pr_number, approved_head,
					        merge_confirmed_at, state, closeout_targets_json
					   FROM land_operation WHERE project_name = ?`,
				)
				.all(input.project);
		}
		if (tableExists(db, "land_operation_step")) {
			steps = db
				.prepare(
					`SELECT operation_id, step, receipt_json, completed_at
					   FROM land_operation_step ORDER BY completed_at, step`,
				)
				.all()
				.map((row) => ({ ...row, receipt: parseJson(row.receipt_json) }));
		}
		if (tableExists(db, "sessions")) {
			bindings = db
				.prepare(
					`SELECT execution_id, issue_id, status,
					        worktree_binding_path AS path,
					        worktree_binding_branch AS branch,
					        worktree_binding_generation AS generation
					   FROM sessions
					  WHERE project_name = ? AND worktree_binding_path IS NOT NULL`,
				)
				.all(input.project);
		}
	} finally {
		db.close();
	}

	const registered = parseWorktrees(repo);
	const registeredByPath = new Map(
		registered.map((row) => [resolve(row.path), row]),
	);
	const operationByPath = new Map();
	const candidates = new Set(
		registered
			.filter((row) => resolve(row.path) !== repo)
			.map((row) => resolve(row.path)),
	);
	const prefix = `${basename(repo)}-FLY-`;
	for (const entry of readdirSync(dirname(repo), { withFileTypes: true })) {
		if (entry.isDirectory() && entry.name.startsWith(prefix)) {
			candidates.add(join(dirname(repo), entry.name));
		}
	}
	for (const operation of operations) {
		const targetDoc = parseJson(operation.closeout_targets_json);
		for (const target of targetDoc?.targets ?? []) {
			if (target?.kind !== "bound_worktree" || typeof target.path !== "string")
				continue;
			const path = resolve(target.path);
			candidates.add(path);
			operationByPath.set(path, { operation, target });
		}
	}

	const mainSha = localMainSha(repo);
	const observedAt = new Date().toISOString();
	const rows = [];
	for (const path of [...candidates].sort()) {
		const linked = operationByPath.get(path);
		const operation = linked?.operation;
		const target = linked?.target;
		const reg = registeredByPath.get(path);
		const pathExists = existsSync(path);
		const opSteps = steps.filter(
			(step) => step.operation_id === operation?.operation_id,
		);
		const proof = opSteps.find(
			(step) => step.step === "aux:merged_worktree_proof",
		)?.receipt;
		const merge = opSteps.find(
			(step) => step.step === "merge_confirmed",
		)?.receipt;
		const mergedPrHead =
			proof?.headSha ?? merge?.headSha ?? operation?.approved_head ?? null;
		const mergeSha = proof?.mergeSha ?? merge?.mergeSha ?? null;
		let coverage = "unknown";
		if (
			reg?.head &&
			mergedPrHead &&
			reg.head === String(mergedPrHead).toLowerCase()
		) {
			coverage = "exact_pr_head";
		} else if (reg?.head && mainSha) {
			const ancestor = git(repo, [
				"merge-base",
				"--is-ancestor",
				reg.head,
				mainSha,
			]);
			coverage =
				ancestor.status === 0
					? "ancestor_of_main"
					: ancestor.status === 1
						? "not_merged"
						: "unknown";
		}
		const binding = bindings.find((row) => resolve(row.path) === path);
		let generation = null;
		if (reg) {
			const marker = git(path, [
				"rev-parse",
				"--path-format=absolute",
				"--git-path",
				"flywheel.generation",
			]);
			if (marker.status === 0 && existsSync(marker.stdout.trim())) {
				generation = await import("node:fs/promises").then(({ readFile }) =>
					readFile(marker.stdout.trim(), "utf8")
						.then((value) => value.trim())
						.catch(() => null),
				);
			}
		}
		let clean = "unknown";
		if (reg && pathExists) {
			const status = git(path, ["status", "--porcelain"]);
			if (status.status === 0) clean = status.stdout.trim() === "";
		}
		const mergeConfirmed = Boolean(
			operation?.merge_confirmed_at ||
				proof?.state === "MERGED" ||
				opSteps.some((step) => step.step === "merge_confirmed"),
		);
		const blockingReasons = [];
		if (!mergeConfirmed) blockingReasons.push("merge_not_proven");
		if (!reg) blockingReasons.push("not_registered");
		if (reg?.detached) blockingReasons.push("detached");
		if (reg?.locked) blockingReasons.push("locked");
		if (coverage === "not_merged" || coverage === "unknown")
			blockingReasons.push(`coverage_${coverage}`);
		if (clean !== true)
			blockingReasons.push(clean === false ? "dirty" : "clean_unknown");
		const classification = !pathExists
			? "directory_missing"
			: mergeConfirmed &&
					(coverage === "exact_pr_head" || coverage === "ancestor_of_main")
				? "merged_residue"
				: operation
					? "unmerged"
					: "unknown";
		rows.push({
			issue: operation?.issue_id ?? binding?.issue_id ?? null,
			pr: operation?.pr_number ?? null,
			operationId: operation?.operation_id ?? null,
			repo,
			path,
			pathExists,
			registered: Boolean(reg),
			registeredBranch: reg?.branch ?? null,
			expectedBranch: target?.branch ?? null,
			bindingBranch: binding?.branch ?? null,
			generationMatch:
				binding?.generation && generation
					? binding.generation === generation
					: null,
			observedHead: reg?.head ?? null,
			mergedPrHead,
			mergeSha,
			mainSha,
			coverage,
			clean,
			active: binding
				? !["completed", "failed", "cancelled"].includes(binding.status)
				: "unknown",
			locked: reg?.locked ?? "unknown",
			blockingReasons,
			classification,
			observedAt,
			deletionPerformed: false,
		});
	}
	process.stdout.write(
		`${JSON.stringify({
			mode: "read_only",
			project: input.project,
			repo,
			stateSnapshot: snapshot,
			snapshotDigest,
			observedAt,
			candidates: rows,
			unknownCandidates: rows.filter((row) => row.classification === "unknown"),
			deletionPerformed: false,
		})}\n`,
	);
}

main().catch((error) =>
	fail(error instanceof Error ? error.message : String(error)),
);
