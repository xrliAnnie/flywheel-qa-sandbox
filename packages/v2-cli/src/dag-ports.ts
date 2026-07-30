import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type {
	DagPorts,
	GitHubMergePort,
	GitHubObservationPort,
	GitPort,
	LaunchLockPort,
} from "flywheel-v2-dag";

export interface OperationalDagPortsOptions {
	gitBin?: string;
	ghBin?: string;
	hostEpoch: string;
	lockRoot: string;
	shipPollMs?: number;
	shipTimeoutMs?: number;
	run?: typeof execFileSync;
	sleep?: (ms: number) => Promise<void>;
}

function output(
	run: typeof execFileSync,
	file: string,
	args: string[],
): string {
	return run(file, args, {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	}).trim();
}

function gitPort(
	run: typeof execFileSync,
	gitBin: string,
	ghBin: string,
): GitPort {
	return {
		async readHead(worktreePath) {
			return output(run, gitBin, ["-C", worktreePath, "rev-parse", "HEAD"]);
		},
		async mergeBase(worktreePath, mergeTargetRef) {
			return output(run, gitBin, [
				"-C",
				worktreePath,
				"merge-base",
				"HEAD",
				mergeTargetRef,
			]);
		},
		async isAncestor(worktreePath, ancestor, head) {
			try {
				output(run, gitBin, [
					"-C",
					worktreePath,
					"merge-base",
					"--is-ancestor",
					ancestor,
					head,
				]);
				return true;
			} catch {
				return false;
			}
		},
		async rawDiff(worktreePath, base, head) {
			return output(run, gitBin, [
				"-C",
				worktreePath,
				"diff",
				"--raw",
				"-z",
				base,
				head,
			]);
		},
		async readRef(repoIdentity, ref) {
			try {
				if (isAbsolute(repoIdentity)) {
					return output(run, gitBin, ["-C", repoIdentity, "rev-parse", ref]);
				}
				return output(run, ghBin, [
					"api",
					`repos/${repoIdentity}/git/ref/${ref.replace(/^refs\//, "")}`,
					"--jq",
					".object.sha",
				]);
			} catch {
				return null;
			}
		},
	};
}

function githubPorts(
	run: typeof execFileSync,
	ghBin: string,
	sleep: (ms: number) => Promise<void>,
	pollMs: number,
	timeoutMs: number,
): {
	observation: GitHubObservationPort;
	merge: GitHubMergePort;
} {
	const view = (repo: string, pr: number) =>
		JSON.parse(
			output(run, ghBin, [
				"pr",
				"view",
				String(pr),
				"--repo",
				repo,
				"--json",
				"headRefOid,state,mergeCommit",
			]),
		) as {
			headRefOid?: unknown;
			state?: unknown;
			mergeCommit?: { oid?: unknown } | null;
		};
	return {
		observation: {
			async readPrHead(target) {
				const result = view(target.repo, target.pr);
				if (typeof result.headRefOid !== "string") {
					throw new Error("GitHub PR head is unavailable");
				}
				return result.headRefOid;
			},
			async readMergeState(target) {
				try {
					const result = view(target.repo, target.pr);
					if (
						result.state === "MERGED" &&
						typeof result.mergeCommit?.oid === "string"
					) {
						return {
							state: "merged" as const,
							head: result.mergeCommit.oid,
						};
					}
					if (result.state === "OPEN") {
						return { state: "open" as const };
					}
					if (result.state === "CLOSED") {
						return {
							state: "rejected" as const,
							evidenceRef: `github:${target.repo}#${target.pr}:closed`,
						};
					}
					return { state: "unknown" as const };
				} catch {
					return { state: "unknown" as const };
				}
			},
		},
		merge: {
			async merge(repo, pr, expectedSha) {
				const before = view(repo, pr);
				if (before.headRefOid !== expectedSha) {
					throw new Error("GitHub PR head drifted before ship trigger");
				}
				output(run, ghBin, [
					"pr",
					"comment",
					String(pr),
					"--repo",
					repo,
					"--body",
					":cool:",
				]);
				const deadline = Date.now() + timeoutMs;
				while (Date.now() < deadline) {
					const observed = view(repo, pr);
					if (
						observed.state === "MERGED" &&
						typeof observed.mergeCommit?.oid === "string"
					) {
						return { mergedSha: observed.mergeCommit.oid };
					}
					await sleep(pollMs);
				}
				throw new Error("ship workflow did not merge before timeout");
			},
		},
	};
}

function launchLock(root: string): LaunchLockPort {
	if (!isAbsolute(root)) throw new TypeError("lockRoot must be absolute");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	return {
		async withSessionLock(sessionRef, fn) {
			const key = createHash("sha256").update(sessionRef).digest("hex");
			const path = join(root, `${key}.lock`);
			const deadline = Date.now() + 10_000;
			for (;;) {
				try {
					mkdirSync(path, { mode: 0o700 });
					break;
				} catch (error) {
					if (
						!(error instanceof Error) ||
						!("code" in error) ||
						error.code !== "EEXIST" ||
						Date.now() >= deadline
					) {
						throw error;
					}
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
			}
			try {
				return await fn();
			} finally {
				rmdirSync(path);
			}
		},
	};
}

export function createOperationalDagPorts(
	options: OperationalDagPortsOptions,
): DagPorts {
	const run = options.run ?? execFileSync;
	const git = gitPort(run, options.gitBin ?? "git", options.ghBin ?? "gh");
	const github = githubPorts(
		run,
		options.ghBin ?? "gh",
		options.sleep ??
			((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
		options.shipPollMs ?? 30_000,
		options.shipTimeoutMs ?? 600_000,
	);
	const clock = {
		nowMs: () => Date.now(),
		nowIso: () => new Date().toISOString(),
	};
	return {
		clock,
		git,
		worktreeRef: {
			async worktreePresent(worktreePath) {
				try {
					await git.readHead(worktreePath);
					return true;
				} catch {
					return false;
				}
			},
			async readExactRef(repoIdentity, ref) {
				return await git.readRef(repoIdentity, ref);
			},
		},
		process: {
			async probe() {
				throw new Error("process probing is unavailable from flywheel-v2 CLI");
			},
		},
		runnerControl: {
			async requestStop() {
				throw new Error("runner control is unavailable from flywheel-v2 CLI");
			},
		},
		host: { hostEpoch: () => options.hostEpoch },
		locks: launchLock(options.lockRoot),
		spawn: {
			async spawn() {
				throw new Error("runner spawn is owned by the v2 host");
			},
		},
		githubObservation: github.observation,
		githubMerge: github.merge,
	};
}
