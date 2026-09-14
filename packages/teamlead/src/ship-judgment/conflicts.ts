import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
	canonicalDigest,
	type PointVerdict,
	prFileInventorySchema,
} from "./contract.js";

export interface FileConflictResult {
	verdict: PointVerdict;
	reason: string;
	openPrCount: number | null;
	overlaps: { repo_identity: string; pr_number: number; path: string }[];
}

export function checkFileConflicts(
	targetValue: unknown,
	openValue: unknown,
	paginationComplete: boolean,
): FileConflictResult {
	const unknown = (reason: string): FileConflictResult => ({
		verdict: "undetermined",
		reason,
		openPrCount: null,
		overlaps: [],
	});
	const targets = z
		.array(prFileInventorySchema)
		.min(1)
		.max(200)
		.safeParse(targetValue);
	const open = z.array(prFileInventorySchema).max(200).safeParse(openValue);
	if (!targets.success || !open.success)
		return unknown("invalid_or_oversized_inventory");
	const targetRepos = new Set(targets.data.map((pr) => pr.repo_identity));
	if (
		!paginationComplete ||
		targets.data.some((pr) => !pr.filesComplete) ||
		open.data.some(
			(pr) => targetRepos.has(pr.repo_identity) && !pr.filesComplete,
		)
	)
		return unknown("incomplete_inventory");
	const key = (repo: string, pr: number) => canonicalDigest([repo, pr]);
	if (
		new Set(targets.data.map((pr) => key(pr.repo_identity, pr.pr_number)))
			.size !== targets.data.length ||
		new Set(open.data.map((pr) => key(pr.repo_identity, pr.pr_number))).size !==
			open.data.length
	)
		return unknown("duplicate_pr_inventory");
	const own = new Set(
		targets.data.map((pr) => key(pr.repo_identity, pr.pr_number)),
	);
	if (
		open.data.some((pr) =>
			targets.data.some(
				(target) =>
					key(pr.repo_identity, pr.pr_number) ===
						key(target.repo_identity, target.pr_number) &&
					pr.head_sha !== target.head_sha,
			),
		)
	)
		return unknown("target_head_changed");
	const targetPaths = new Set<string>();
	for (const pr of targets.data) {
		for (const file of pr.files) {
			targetPaths.add(canonicalDigest([pr.repo_identity, file.path]));
			if (file.previous_path)
				targetPaths.add(
					canonicalDigest([pr.repo_identity, file.previous_path]),
				);
		}
	}
	const others = open.data.filter(
		(pr) => !own.has(key(pr.repo_identity, pr.pr_number)),
	);
	const overlaps = new Map<string, FileConflictResult["overlaps"][number]>();
	for (const pr of others) {
		for (const file of pr.files) {
			for (const path of [file.path, file.previous_path]) {
				if (
					path &&
					targetPaths.has(canonicalDigest([pr.repo_identity, path]))
				) {
					const overlap = {
						repo_identity: pr.repo_identity,
						pr_number: pr.pr_number,
						path,
					};
					overlaps.set(canonicalDigest(overlap), overlap);
					if (overlaps.size > 1000) return unknown("overlap_budget_exceeded");
				}
			}
		}
	}
	return {
		verdict: overlaps.size ? "fail" : "pass",
		reason: overlaps.size ? "overlapping_files" : "no_overlapping_files",
		openPrCount: others.length,
		overlaps: [...overlaps.entries()]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([, value]) => value),
	};
}

function git(
	gitDir: string,
	args: string[],
	signal?: AbortSignal,
): Promise<{ code: number | string; stdout: string }> {
	return new Promise((resolve) => {
		execFile(
			"git",
			[
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"core.fsmonitor=false",
				`--git-dir=${gitDir}`,
				...args,
			],
			{
				encoding: "utf8",
				timeout: 20_000,
				killSignal: "SIGKILL",
				maxBuffer: 131_072,
				signal,
				env: {
					PATH: process.env.PATH,
					LC_ALL: "C",
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_TERMINAL_PROMPT: "0",
					GIT_NO_LAZY_FETCH: "1",
				},
			},
			(error, stdout) =>
				resolve({
					code: error ? (error.killed ? "killed" : (error.code ?? "error")) : 0,
					stdout,
				}),
		);
	});
}

/** gitDir must be a caller-owned isolated bare object store, never the shared worktree. */
export async function checkGitMerge(input: {
	gitDir: string;
	mainSha: string;
	headSha: string;
	targetBaseSha?: string;
	signal?: AbortSignal;
}): Promise<{ verdict: PointVerdict; reason: string }> {
	const validSha = (value: string) => /^[0-9a-f]{40}$/.test(value);
	if (
		!isAbsolute(input.gitDir) ||
		!validSha(input.mainSha) ||
		!validSha(input.headSha) ||
		(input.targetBaseSha !== undefined && !validSha(input.targetBaseSha))
	)
		return { verdict: "undetermined", reason: "invalid_git_probe" };
	const bare = await git(
		input.gitDir,
		["rev-parse", "--is-bare-repository"],
		input.signal,
	);
	if (bare.code !== 0 || bare.stdout.trim() !== "true")
		return { verdict: "undetermined", reason: "isolated_bare_required" };
	let conflict = false;
	for (const base of new Set([
		input.mainSha,
		input.targetBaseSha ?? input.mainSha,
	])) {
		const result = await git(
			input.gitDir,
			["merge-tree", "--write-tree", base, input.headSha],
			input.signal,
		);
		if (result.code === 0 && /^[0-9a-f]{40}\s*$/.test(result.stdout)) continue;
		if (
			result.code === 1 &&
			/^[0-9a-f]{40}\n/.test(result.stdout) &&
			result.stdout.includes("CONFLICT")
		) {
			conflict = true;
			continue;
		}
		return { verdict: "undetermined", reason: "merge_probe_failed" };
	}
	return {
		verdict: conflict ? "fail" : "pass",
		reason: conflict ? "merge_conflict" : "merge_clean",
	};
}
