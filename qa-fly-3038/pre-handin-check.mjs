#!/usr/bin/env node
// FLY-3038: pre-handin self-check. Before an implementation node hands a PR to
// review, run the repository's rule-guard tests (static registries, inventories,
// projections: seconds each) and prove the committed HEAD still merges cleanly
// with the main this very run fetched. Local only: no CI, no labels, no network
// other than the single `git fetch`. `flywheel-comm complete --route
// needs_review` re-runs this script and refuses the handoff unless it passes.
//
// Output contract: stdout carries exactly one `pre-handin/v1` JSON object;
// progress and the human summary go to stderr. Exit 0 only when every guard
// passed, the merge is clean and HEAD/worktree never changed; otherwise exit 1.
// Usage errors exit 2. `--list` prints the frozen guard manifest.
//
// Adding a guard: append one entry to GUARDS below. It must name one concrete
// test file (no glob, directory, package suite or `-t` filter), read only static
// repository sources (write `inputScope`), finish well inside GUARD_MAX_MS, and
// be timed standalone. Record why in `reason`; the unit suite pins the list.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

export const SCHEMA = "pre-handin/v1";
export const TOTAL_BUDGET_MS = 120_000;
export const CLEANUP_RESERVE_MS = 2_000;
export const FETCH_MAX_MS = 20_000;
export const MERGE_MAX_MS = 10_000;
// Measured on the shared runner host (FLY-3038 replay, load average 50-100):
// a cold first Vitest start alone can exceed 30s, so one guard may use up to
// 60s; the 120s whole-run budget above stays the binding limit.
export const GUARD_MAX_MS = 60_000;
const GIT_LOCAL_MAX_MS = 5_000;
const TERM_GRACE_MS = 1_000;
const REAP_GRACE_MS = 500;
/** A timed-out child may take this long to be stopped; every timer leaves it. */
const STOP_GRACE_MS = TERM_GRACE_MS + REAP_GRACE_MS;
const CAPTURE_LIMIT_CHARS = 64 * 1024;
/** Raw -z output (status, merge-tree) kept in memory; the rest is drained. */
export const BINARY_CAPTURE_LIMIT_BYTES = 8 * 1024 * 1024;
const OUTPUT_TAIL_CHARS = 4_000;
const CONFLICT_FILES_LIMIT = 200;
const DIRTY_LIST_LIMIT = 20;
const DIAGNOSTIC_LIMIT = 8_000;
const BASE_REMOTE = "origin";
const BASE_BRANCH = "main";

const VITEST_ONE_FILE_PASSED = String.raw`Test Files\s+1 passed \(1\)`;
/** Vitest's own per-test timeout message. */
const TEST_TIMEOUT = /\bTest timed out in \d+ms\b/;

/**
 * True only when every failure Vitest reported is its own per-test timeout:
 * each ` FAIL ` block carries the timeout message, the block count equals the
 * summary's failed-test count, no suite failed to load, and Vitest reported
 * no unhandled error. Anything else (a mixed file, a truncated capture, an
 * import error, an unhandled error) is a real failure.
 */
export function onlyTestTimeouts(output, { truncated = false } = {}) {
	if (truncated) return false;
	const text = output.replace(ANSI, "");
	const failed = /\bTests\s+(\d+) failed\b/.exec(text);
	if (
		!failed ||
		/Failed Suites|Unhandled (?:Errors?|Rejections?)|\bErrors\s+\d+ errors?\b/.test(
			text,
		)
	) {
		return false;
	}
	const blocks = text.split(/\n(?=[ \t]*FAIL\s)/).slice(1);
	return (
		blocks.length > 0 &&
		blocks.length === Number(failed[1]) &&
		blocks.every((block) => TEST_TIMEOUT.test(block))
	);
}

function vitestGuard(id, owner, packageDir, relativeFile, reason, inputScope) {
	return {
		id,
		owner,
		file: `${packageDir}/${relativeFile}`,
		argv: ["pnpm", "--filter", owner, "exec", "vitest", "run", relativeFile],
		successPattern: VITEST_ONE_FILE_PASSED,
		reason,
		inputScope,
		maxMs: GUARD_MAX_MS,
	};
}

/**
 * The single frozen list of rule guards. Order is execution order. Every entry
 * was measured standalone in FLY-3038 research (baseline-timings.json).
 */
export const GUARDS = deepFreeze([
	{
		id: "probe-registry",
		owner: "qa-fly-3038",
		file: "qa-fly-3038/probe-registry.test.mjs",
		argv: ["node", "--test", "qa-fly-3038/probe-registry.test.mjs"],
		reason:
			"every probe.txt under qa-fly-3038/runs must be listed in qa-fly-3038/probes.txt",
		inputScope: ["qa-fly-3038"],
		maxMs: GUARD_MAX_MS,
	},
]);

function deepFreeze(value) {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

function sha256(data) {
	return createHash("sha256").update(data).digest("hex");
}

export function manifestSha256(guards = GUARDS) {
	return sha256(JSON.stringify(guards));
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escapes
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Children never see Flywheel identities or anything shaped like a secret. */
function guardEnv(base, tempDir) {
	const env = {};
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined) continue;
		if (/^(?:FLYWHEEL|TEAMLEAD)_/.test(key)) continue;
		if (/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i.test(key)) continue;
		env[key] = value;
	}
	env.TMPDIR = tempDir;
	env.NO_COLOR = "1";
	return env;
}

function gitEnv(base) {
	return {
		...base,
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
		LC_ALL: "C",
		...(base.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: "ssh -oBatchMode=yes" }),
	};
}

/** Process groups this run created and has not yet seen close. */
const activeGroups = new Set();

function signalGroup(pid, signal) {
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		return false;
	}
}

/**
 * Run one argv in its own process group with a hard deadline. On timeout the
 * whole group gets TERM, then KILL; the call resolves even if a descendant
 * that escaped the group keeps the pipes open. Never uses a shell.
 */
function runProcess(
	argv,
	{
		cwd,
		env,
		timeoutMs,
		binary = false,
		byteLimit = BINARY_CAPTURE_LIMIT_BYTES,
	},
) {
	return new Promise((settle) => {
		const started = performance.now();
		const chunks = [];
		let bytes = 0;
		let overflow = false;
		let truncated = false;
		let text = "";
		let timedOut = false;
		let reaped = true;
		let done = false;
		let child;
		const timers = [];
		const finish = (fields) => {
			if (done) return;
			done = true;
			for (const timer of timers) clearTimeout(timer);
			if (child?.pid) activeGroups.delete(child.pid);
			settle({
				exitCode: null,
				signal: null,
				spawnError: undefined,
				timedOut,
				reaped,
				overflow,
				truncated,
				output: binary ? Buffer.concat(chunks) : text,
				durationMs: Math.round(performance.now() - started),
				...fields,
			});
		};
		try {
			child = spawn(argv[0], argv.slice(1), {
				cwd,
				env,
				shell: false,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			finish({ spawnError: error });
			return;
		}
		if (child.pid) activeGroups.add(child.pid);
		const collect = (chunk) => {
			if (binary) {
				if (bytes + chunk.length > byteLimit) {
					overflow = true;
					const room = byteLimit - bytes;
					if (room > 0) chunks.push(chunk.subarray(0, room));
					bytes = byteLimit;
					return;
				}
				bytes += chunk.length;
				chunks.push(chunk);
				return;
			}
			text += chunk.toString("utf8");
			if (text.length > CAPTURE_LIMIT_CHARS * 2) {
				text = text.slice(-CAPTURE_LIMIT_CHARS);
				truncated = true;
			}
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", binary ? () => {} : collect);
		child.on("error", (error) => finish({ spawnError: error }));
		child.on("close", (exitCode, signal) => {
			if (child.pid) signalGroup(child.pid, "SIGKILL");
			finish({ exitCode, signal });
		});
		timers.push(
			setTimeout(
				() => {
					timedOut = true;
					if (!child.pid) return;
					signalGroup(child.pid, "SIGTERM");
					timers.push(
						setTimeout(() => {
							signalGroup(child.pid, "SIGKILL");
							timers.push(
								setTimeout(() => {
									reaped = false;
									child.stdout.destroy();
									child.stderr.destroy();
									finish({
										exitCode: child.exitCode,
										signal: child.signalCode,
									});
								}, REAP_GRACE_MS),
							);
						}, TERM_GRACE_MS),
					);
				},
				Math.max(1, timeoutMs),
			),
		);
	});
}

/**
 * Parse `git merge-tree --write-tree --name-only -z` (messages included):
 * `<tree>\0<path>\0...\0\0` then records `<n>\0<path>{n}\0<type>\0<message>\0`.
 */
export function parseMergeTreeOutput(buffer) {
	const parts = buffer.toString("utf8").split("\0");
	const tree = parts[0];
	if (!tree || !OBJECT_ID.test(tree)) return undefined;
	const conflictFiles = [];
	let index = 1;
	while (index < parts.length && parts[index] !== "") {
		conflictFiles.push(parts[index]);
		index += 1;
	}
	// False when the output ended inside the path list (a capped capture).
	const pathsComplete = index < parts.length;
	index += 1;
	const conflictTypes = [];
	while (index < parts.length) {
		const count = Number(parts[index]);
		if (!Number.isInteger(count) || count < 0) break;
		const type = parts[index + 1 + count];
		if (typeof type === "string" && type.startsWith("CONFLICT")) {
			if (!conflictTypes.includes(type)) conflictTypes.push(type);
		}
		index += count + 3;
	}
	return { tree, conflictFiles, conflictTypes, pathsComplete };
}

function tail(text, limit) {
	const clean = text.replace(ANSI, "").trimEnd();
	return clean.length > limit ? `…${clean.slice(-limit)}` : clean;
}

function jsonLine(value) {
	return JSON.stringify(value);
}

/**
 * Run the full check. Tests inject throwaway guards/budgets; the CLI entry
 * point below always uses the frozen GUARDS and constants.
 */
export async function runPreHandinCheck({
	cwd = process.cwd(),
	guards = GUARDS,
	env = process.env,
	budgetMs = TOTAL_BUDGET_MS,
	cleanupReserveMs = CLEANUP_RESERVE_MS,
	fetchMaxMs = FETCH_MAX_MS,
	mergeMaxMs = MERGE_MAX_MS,
	captureLimitBytes = BINARY_CAPTURE_LIMIT_BYTES,
	log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
	const started = performance.now();
	// Fetch, merge and guards stop at `deadline`; the reserve after it pays for
	// the final identity re-check and teardown, all inside `budgetMs`.
	const deadline = started + budgetMs - cleanupReserveMs;
	const finalDeadline =
		started + budgetMs - Math.min(250, cleanupReserveMs / 2);
	let activeDeadline = deadline;
	const remaining = () => Math.floor(activeDeadline - performance.now());
	const tempDir = mkdtempSync(join(tmpdir(), "pre-handin-"));
	const childEnv = guardEnv(env, tempDir);
	// Git itself may need the caller's credential environment for the fetch.
	const commandEnv = gitEnv(env);
	const problems = [];
	const result = {
		schema: SCHEMA,
		status: "passed",
		repoRoot: "",
		head: "",
		scriptSha256: sha256(readFileSync(SCRIPT_PATH)),
		manifestSha256: manifestSha256(guards),
		startedAt: new Date().toISOString(),
		durationMs: 0,
		budgetMs,
		guards: guards.map((entry) => ({
			id: entry.id,
			status: "not_run",
			exitCode: null,
			signal: null,
			durationMs: 0,
		})),
		conflictFiles: [],
		conflictFilesTruncated: false,
		conflictTypes: [],
		diagnostic: "",
	};
	const flags = {
		dirty: false,
		timeout: false,
		unavailable: false,
		guardFailed: false,
		conflict: false,
		changed: false,
	};

	const git = async (args, maxMs = GIT_LOCAL_MAX_MS, options = {}) => {
		const timeoutMs = Math.min(maxMs, remaining() - STOP_GRACE_MS);
		if (timeoutMs <= 0) {
			flags.timeout = true;
			return { exitCode: null, output: "", timedOut: true };
		}
		const run = await runProcess(["git", ...args], {
			cwd: options.cwd ?? (result.repoRoot || cwd),
			env: commandEnv,
			timeoutMs,
			binary: options.binary ?? false,
			byteLimit: captureLimitBytes,
		});
		if (run.timedOut) flags.timeout = true;
		return run;
	};
	const readHead = async () => {
		const run = await git([
			"rev-parse",
			"--verify",
			"--quiet",
			"HEAD^{commit}",
		]);
		const sha = run.exitCode === 0 ? String(run.output).trim() : "";
		return OBJECT_ID.test(sha) ? sha : undefined;
	};
	const readStatus = async () => {
		const run = await git(
			["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
			GIT_LOCAL_MAX_MS,
			{ binary: true },
		);
		if (run.exitCode !== 0) return undefined;
		const entries = run.output
			.toString("utf8")
			.split("\0")
			.filter((entry) => entry !== "");
		// Past the cap the listing is incomplete but the tree is certainly dirty.
		if (run.overflow) {
			entries.push(`… (git status output exceeded ${captureLimitBytes} bytes)`);
		}
		return entries;
	};

	try {
		const top = await git(["rev-parse", "--show-toplevel"], GIT_LOCAL_MAX_MS, {
			cwd,
		});
		const topPath = top.exitCode === 0 ? String(top.output).trim() : "";
		if (!topPath || !isAbsolute(topPath)) {
			flags.unavailable = true;
			problems.push(`not inside a Git worktree: ${cwd}`);
			return result;
		}
		result.repoRoot = realpathSync(topPath);
		const head = await readHead();
		if (!head) {
			flags.unavailable = true;
			problems.push("cannot resolve HEAD to a commit");
			return result;
		}
		result.head = head;
		const status = await readStatus();
		if (!status) {
			flags.unavailable = true;
			problems.push("git status failed");
			return result;
		}
		if (status.length > 0) {
			flags.dirty = true;
			const listed = status.slice(0, DIRTY_LIST_LIMIT).map(jsonLine).join(", ");
			problems.push(
				`worktree has uncommitted or untracked changes; commit or remove them first: ${listed}${status.length > DIRTY_LIST_LIMIT ? ", …" : ""}`,
			);
			return result;
		}

		log(`[pre-handin] fetching ${BASE_REMOTE}/${BASE_BRANCH} …`);
		// Fetch into a ref no other process can name: refs/remotes/origin/main
		// is shared by every worktree and FETCH_HEAD by every fetch in this one,
		// so either could be moved between our fetch and our read.
		const privateRef = `refs/flywheel-pre-handin/${process.pid}-${randomUUID()}`;
		const fetch = await git(
			[
				"fetch",
				"--no-tags",
				"--quiet",
				"--no-write-fetch-head",
				BASE_REMOTE,
				`+refs/heads/${BASE_BRANCH}:${privateRef}`,
			],
			fetchMaxMs,
		);
		let mainSha;
		if (fetch.exitCode === 0) {
			const resolved = await git([
				"rev-parse",
				"--verify",
				"--quiet",
				`${privateRef}^{commit}`,
			]);
			const sha = resolved.exitCode === 0 ? String(resolved.output).trim() : "";
			if (OBJECT_ID.test(sha)) mainSha = sha;
		}
		// The objects stay; only the name goes. merge-tree uses the SHA.
		const removed = await git(["update-ref", "-d", privateRef]);
		if (removed.exitCode !== 0) {
			flags.unavailable = true;
			problems.push(
				`could not delete the private fetch ref ${privateRef}; remove it with git update-ref -d ${privateRef}`,
			);
		}
		if (!mainSha) {
			flags.unavailable = true;
			problems.push(
				fetch.timedOut
					? `git fetch ${BASE_REMOTE} ${BASE_BRANCH} timed out`
					: `git fetch ${BASE_REMOTE} ${BASE_BRANCH} failed: ${tail(String(fetch.output ?? ""), 600) || `exit ${fetch.exitCode}`}`,
			);
		} else {
			result.mainSha = mainSha;
			log(
				`[pre-handin] merge-tree ${BASE_REMOTE}/${BASE_BRANCH}@${mainSha} ⟵ HEAD@${head}`,
			);
			const merge = await git(
				["merge-tree", "--write-tree", "--name-only", "-z", mainSha, head],
				mergeMaxMs,
				{ binary: true },
			);
			// A conflict listing past the cap is still a conflict; any other
			// truncated answer cannot be trusted.
			const parsed =
				merge.exitCode === 1 || (merge.exitCode === 0 && !merge.overflow)
					? parseMergeTreeOutput(merge.output)
					: undefined;
			if (parsed && merge.overflow) {
				if (!parsed.pathsComplete) parsed.conflictFiles.pop();
				parsed.truncated = true;
			}
			if (merge.timedOut) {
				problems.push(`git merge-tree against main ${mainSha} timed out`);
			} else if (!parsed) {
				flags.unavailable = true;
				problems.push(
					`git merge-tree against main ${mainSha} failed (exit ${merge.exitCode ?? merge.signal}${merge.overflow ? `, output exceeded ${captureLimitBytes} bytes` : ""})`,
				);
			} else if (merge.exitCode === 1) {
				flags.conflict = true;
				result.conflictFiles = parsed.conflictFiles.slice(
					0,
					CONFLICT_FILES_LIMIT,
				);
				result.conflictFilesTruncated =
					parsed.truncated === true ||
					parsed.conflictFiles.length > CONFLICT_FILES_LIMIT;
				result.conflictTypes = parsed.conflictTypes;
				problems.push(
					`HEAD ${head} does not merge cleanly with ${BASE_REMOTE}/${BASE_BRANCH} ${mainSha}: merge origin/main into the branch and resolve ${parsed.conflictFiles.length} conflicted file(s): ${parsed.conflictFiles.slice(0, DIRTY_LIST_LIMIT).map(jsonLine).join(", ")}${parsed.conflictTypes.length ? ` (${parsed.conflictTypes.join("; ")})` : ""}`,
				);
			}
		}

		for (const [index, entry] of guards.entries()) {
			const row = result.guards[index];
			const budget = Math.min(entry.maxMs, remaining() - STOP_GRACE_MS);
			if (budget <= 0) {
				flags.timeout = true;
				problems.push(`total budget exhausted before guard ${entry.id}`);
				break;
			}
			if (!existsSync(join(result.repoRoot, entry.file))) {
				row.status = "unavailable";
				flags.unavailable = true;
				problems.push(
					`guard ${entry.id}: registered file ${entry.file} is missing`,
				);
				continue;
			}
			log(`[pre-handin] ${entry.id}: ${entry.argv.join(" ")}`);
			const run = await runProcess(entry.argv, {
				cwd: result.repoRoot,
				env: childEnv,
				timeoutMs: budget,
			});
			row.exitCode = run.exitCode;
			row.signal = run.signal;
			row.durationMs = run.durationMs;
			row.outputTail = tail(run.output, OUTPUT_TAIL_CHARS);
			if (run.spawnError) {
				row.status = "unavailable";
				flags.unavailable = true;
				problems.push(
					`guard ${entry.id}: cannot start ${entry.argv[0]} (${run.spawnError.code ?? run.spawnError.message})`,
				);
			} else if (run.timedOut) {
				row.status = "timeout";
				flags.timeout = true;
				problems.push(
					`guard ${entry.id}: timed out after ${run.durationMs}ms${run.reaped ? "" : " and its processes could not be reaped"}; remaining guards were not run`,
				);
				log(`[pre-handin] ${entry.id}: timeout (${run.durationMs}ms)`);
				break;
			} else if (
				run.exitCode !== 0 &&
				onlyTestTimeouts(run.output, { truncated: run.truncated })
			) {
				// The guard's own test hit its timeout: under host load that says
				// nothing about the change, so it is a retry, not a finding.
				row.status = "timeout";
				flags.timeout = true;
				problems.push(
					`guard ${entry.id}: its own test timed out (host load?), not a finding; run complete again. rerun alone: ${entry.argv.join(" ")}`,
				);
			} else if (run.exitCode !== 0) {
				row.status = "failed";
				flags.guardFailed = true;
				problems.push(
					`guard ${entry.id} failed (${run.exitCode === null ? `signal ${run.signal}` : `exit ${run.exitCode}`}); rerun: ${entry.argv.join(" ")}\n${tail(run.output, 1_200)}`,
				);
			} else if (
				entry.successPattern &&
				!new RegExp(entry.successPattern).test(run.output.replace(ANSI, ""))
			) {
				row.status = "failed";
				flags.guardFailed = true;
				problems.push(
					`guard ${entry.id}: exit 0 without its success evidence /${entry.successPattern}/ (no test file ran?); rerun: ${entry.argv.join(" ")}`,
				);
			} else {
				row.status = "passed";
			}
			log(`[pre-handin] ${entry.id}: ${row.status} (${run.durationMs}ms)`);
		}
		for (const row of result.guards) {
			if (row.status === "not_run") flags.timeout = true;
		}

		activeDeadline = finalDeadline;
		const finalHead = await readHead();
		const finalStatus = await readStatus();
		if (!finalHead || !finalStatus) {
			// Unprovable is never a pass; without a positive observation of a
			// change it is reported as the budget/tool problem it is.
			flags.unavailable = true;
			problems.push("could not re-read HEAD/worktree status after the check");
		} else if (finalHead !== head || finalStatus.length > 0) {
			flags.changed = true;
			problems.push(
				`HEAD or worktree changed during the check (HEAD ${head} → ${finalHead}, ${finalStatus.length} changed path(s)); commit and run again`,
			);
		}
		return result;
	} finally {
		// Real findings outrank "could not finish": a guard that really failed
		// or a real conflict is the author's to fix even if the run also ran
		// out of time or could not reach something.
		result.status = flags.dirty
			? "dirty_worktree"
			: flags.changed
				? "inputs_changed"
				: flags.guardFailed
					? "guard_failed"
					: flags.conflict
						? "merge_conflict"
						: flags.timeout
							? "timeout"
							: flags.unavailable
								? "unavailable"
								: "passed";
		const header = `pre-handin ${result.status === "passed" ? "PASSED" : `FAILED (${result.status})`}: head ${result.head || "?"} vs ${BASE_REMOTE}/${BASE_BRANCH} ${result.mainSha ?? "not fetched"}`;
		const diagnostic = [
			header,
			...problems.map((problem) => `- ${problem}`),
		].join("\n");
		result.diagnostic =
			diagnostic.length > DIAGNOSTIC_LIMIT
				? `${diagnostic.slice(0, DIAGNOSTIC_LIMIT)}…`
				: diagnostic;
		rmSync(tempDir, { recursive: true, force: true });
		result.durationMs = Math.round(performance.now() - started);
	}
}

async function main(args) {
	if (args.length === 1 && args[0] === "--list") {
		process.stdout.write(
			`${JSON.stringify({ schema: "pre-handin-guards/v1", manifestSha256: manifestSha256(), guards: GUARDS })}\n`,
		);
		return 0;
	}
	if (args.length > 0) {
		process.stderr.write(
			"usage: node scripts/pre-handin-check.mjs [--list]\n  run from the worktree to check; there are no skip or override options\n",
		);
		return 2;
	}
	// Guard children run in their own process groups, so a caller that gives
	// up on this script must not orphan them: tear them down on the way out.
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
		process.once(signal, () => {
			for (const pid of activeGroups) signalGroup(pid, "SIGKILL");
			process.stderr.write(`[pre-handin] interrupted by ${signal}\n`);
			process.exit(1);
		});
	}
	const result = await runPreHandinCheck();
	process.stdout.write(`${JSON.stringify(result)}\n`);
	process.stderr.write(`${result.diagnostic}\n`);
	return result.status === "passed" ? 0 : 1;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === SCRIPT_PATH) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			process.stderr.write(
				`[pre-handin] internal error: ${error?.stack ?? error}\n`,
			);
			process.exitCode = 1;
		},
	);
}
