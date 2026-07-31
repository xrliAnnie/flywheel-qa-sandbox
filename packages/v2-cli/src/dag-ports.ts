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
	/** Test seam only (like `run`/`sleep`); the CLI never exposes it. */
	observationTimeoutMs?: number;
	run?: typeof execFileSync;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Codex R1 MEDIUM-2: every CI observation subprocess is bounded, otherwise a
 * wedged `gh` (network hang, stuck credential helper) blocks `executeShip`
 * inside `readCiState` and the 30min CI deadline never gets a chance to
 * fire. Timeout/signal death maps to fail-closed red.
 */
export const OBSERVATION_TIMEOUT_MS = 30_000;

/**
 * FLY-1545 ①: the ship merge poll must outlive the `:cool:` ship workflow.
 * 35min = ship-on-comment.yml `timeout-minutes: 30` + 5min propagation
 * buffer. The two numbers are coupled: changing the workflow timeout must
 * update this constant in the same change. The pointer is one-way (this file
 * -> ship-on-comment.yml) because runner push credentials lack the `workflow`
 * scope to carry the reciprocal comment.
 */
export const DEFAULT_SHIP_TIMEOUT_MS = 2_100_000;

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

interface StructuredRunResult {
	status: number;
	stdout: string;
	stderr: string;
}

/**
 * FLY-1545 ①: `gh pr checks` speaks through exit codes -- exit 8 means
 * "checks pending" (even with valid `--json` output), so the throw-on-nonzero
 * `output()` helper would collapse pending into failure (the v1
 * ship-ci-guard structural trap). This runner surfaces {status, stdout,
 * stderr} so the caller can treat exit 0 and exit 8 as parseable
 * observations and everything else as fail-closed red.
 */
function runStructured(
	run: typeof execFileSync,
	file: string,
	args: string[],
	timeoutMs: number,
): StructuredRunResult {
	try {
		const stdout = run(file, args, {
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
			timeout: timeoutMs,
		});
		return { status: 0, stdout: String(stdout), stderr: "" };
	} catch (error) {
		const failure = error as {
			status?: unknown;
			signal?: unknown;
			code?: unknown;
			stdout?: unknown;
			stderr?: unknown;
			message?: unknown;
		};
		// A timeout kill surfaces as ETIMEDOUT / a signal death with no exit
		// status -- not a parseable observation, fail-closed.
		if (failure.code === "ETIMEDOUT" || typeof failure.signal === "string") {
			return {
				status: -1,
				stdout: "",
				stderr: `gh observation timed out after ${timeoutMs}ms`,
			};
		}
		return {
			status: typeof failure.status === "number" ? failure.status : -1,
			stdout: typeof failure.stdout === "string" ? failure.stdout : "",
			stderr:
				typeof failure.stderr === "string" && failure.stderr.length > 0
					? failure.stderr
					: String(failure.message ?? "subprocess failed"),
		};
	}
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
	observationTimeoutMs: number,
): {
	observation: GitHubObservationPort;
	merge: GitHubMergePort;
} {
	// Codex R2: the head/merge observations are bounded like the CI ones -- a
	// wedged `gh pr view` would otherwise hang executeShip in the head probes
	// (before the first CI observation, per poll, and post-green) where the CI
	// deadline is never consulted. Timeout throws, which every caller already
	// treats as an observation failure.
	const view = (repo: string, pr: number) => {
		const result = runStructured(
			run,
			ghBin,
			[
				"pr",
				"view",
				String(pr),
				"--repo",
				repo,
				"--json",
				"headRefOid,state,mergeCommit",
			],
			observationTimeoutMs,
		);
		if (result.status !== 0) {
			throw new Error(
				`gh pr view exited ${result.status}: ${result.stderr.trim()}`,
			);
		}
		return JSON.parse(result.stdout) as {
			headRefOid?: unknown;
			state?: unknown;
			mergeCommit?: { oid?: unknown } | null;
		};
	};
	// FLY-1545 ①: v1 ship-ci-guard's fail-closed matrix, ported without its
	// kill-switch and without its exit-8 trap. Every ambiguous observation is
	// red; only a fully green (pass/skipping) non-empty check list on the
	// expected head with a decided mergeStateStatus is green.
	const CHECK_BUCKETS = new Set([
		"pass",
		"fail",
		"pending",
		"skipping",
		"cancel",
	]);
	// Codex R1 LOW-3: the decided states are an ALLOWLIST (gh's documented
	// enum minus the undecided/unmergeable four), so an unknown or malformed
	// future value fails closed instead of sailing through a denylist.
	const DECIDED_MERGE_STATES = new Set([
		"BEHIND",
		"BLOCKED",
		"CLEAN",
		"DRAFT",
		"HAS_HOOKS",
	]);
	const red = (detail: string) => ({ state: "red" as const, detail });
	return {
		observation: {
			async readPrHead(target) {
				const result = view(target.repo, target.pr);
				if (typeof result.headRefOid !== "string") {
					throw new Error("GitHub PR head is unavailable");
				}
				return result.headRefOid;
			},
			async readCiState(target) {
				const viewResult = runStructured(
					run,
					ghBin,
					[
						"pr",
						"view",
						String(target.pr),
						"--repo",
						target.repo,
						"--json",
						"headRefOid,mergeStateStatus",
					],
					observationTimeoutMs,
				);
				if (viewResult.status !== 0) {
					return red(
						`gh pr view exited ${viewResult.status}: ${viewResult.stderr.trim()}`,
					);
				}
				let viewJson: { headRefOid?: unknown; mergeStateStatus?: unknown };
				try {
					viewJson = JSON.parse(viewResult.stdout) as typeof viewJson;
				} catch {
					return red("gh pr view returned unparseable JSON");
				}
				if (viewJson.headRefOid !== target.head) {
					return red(
						`PR head ${String(viewJson.headRefOid)} is not the authorized head ${target.head}`,
					);
				}
				if (
					typeof viewJson.mergeStateStatus !== "string" ||
					!DECIDED_MERGE_STATES.has(viewJson.mergeStateStatus)
				) {
					return red(
						`mergeStateStatus is undecided: ${String(viewJson.mergeStateStatus)}`,
					);
				}
				const checksResult = runStructured(
					run,
					ghBin,
					[
						"pr",
						"checks",
						String(target.pr),
						"--repo",
						target.repo,
						"--json",
						"bucket,name,state",
					],
					observationTimeoutMs,
				);
				if (checksResult.status !== 0 && checksResult.status !== 8) {
					return red(
						`gh pr checks exited ${checksResult.status}: ${checksResult.stderr.trim()}`,
					);
				}
				let checks: unknown;
				try {
					checks = JSON.parse(checksResult.stdout);
				} catch {
					return red("gh pr checks returned unparseable JSON");
				}
				if (!Array.isArray(checks)) {
					return red("gh pr checks JSON is not an array");
				}
				if (checks.length === 0) {
					// This repo always has CI; an empty list is a broken observation,
					// not a green one (v1 empty-list semantics, kept).
					return red("PR reports an empty check list");
				}
				const names = (bucket: string) =>
					checks
						.filter(
							(item): item is { bucket: string; name?: unknown } =>
								typeof item === "object" &&
								item !== null &&
								(item as { bucket?: unknown }).bucket === bucket,
						)
						.map((item) => String(item.name ?? "unnamed"))
						.join(", ");
				for (const item of checks) {
					const bucket =
						typeof item === "object" && item !== null
							? (item as { bucket?: unknown }).bucket
							: undefined;
					if (typeof bucket !== "string" || !CHECK_BUCKETS.has(bucket)) {
						return red(`check bucket is out of domain: ${String(bucket)}`);
					}
				}
				const typed = checks as { bucket: string }[];
				if (typed.some((item) => item.bucket === "fail")) {
					return red(`checks failed: ${names("fail")}`);
				}
				if (typed.some((item) => item.bucket === "cancel")) {
					return red(`checks cancelled: ${names("cancel")}`);
				}
				if (typed.some((item) => item.bucket === "pending")) {
					return {
						state: "pending" as const,
						detail: `checks pending: ${names("pending")}`,
					};
				}
				if (checksResult.status === 8) {
					// exit 8 claims pending but the JSON shows none -- contradictory
					// observation, fail-closed.
					return red("gh pr checks exited 8 without a pending bucket");
				}
				return { state: "green" as const };
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
		options.shipTimeoutMs ?? DEFAULT_SHIP_TIMEOUT_MS,
		options.observationTimeoutMs ?? OBSERVATION_TIMEOUT_MS,
	);
	const clock = {
		nowMs: () => Date.now(),
		nowIso: () => new Date().toISOString(),
		sleep: (ms: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, ms)),
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
