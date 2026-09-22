import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CiFullCommandRunner,
	type CiFullDeps,
	ensureFullCi,
	runCiFullCommand,
} from "../commands/ci-full.js";

const HEAD = "a".repeat(40);
const MOVED_HEAD = "b".repeat(40);
const REPO = "xrliAnnie/flywheel";
const PR = 621;
const NOW = Date.parse("2026-09-17T23:00:00Z");
const RAW_AGGREGATE_NAME =
	"contains(fromJSON('[\"full\",\"docs_only\",\"reuse\"]'), needs.classify.outputs.mode) && 'CI OK' || 'CI Scope OK'";
const WORKFLOW = [
	"name: CI",
	"jobs:",
	"  ci-ok:",
	"    name: $" + `{{ ${RAW_AGGREGATE_NAME} }}`,
	"    runs-on: ubuntu-latest",
].join("\n");
const MANIFEST = JSON.parse(
	readFileSync(
		resolve(import.meta.dirname, "../../../../.github/ci-required-jobs.json"),
		"utf8",
	),
) as {
	schema: number;
	aggregate: string;
	aggregate_scoped: string;
	always: string[];
	heavy: string[];
};

type Job = { name: string; status: string; conclusion: string | null };
type RunFixture = {
	id: number;
	status: string;
	conclusion: string | null;
	title: string;
	createdAt: string;
	epoch: string;
	jobs: Job[];
	url?: string;
};

const fullJobs = (conclusion = "success"): Job[] =>
	[...MANIFEST.always, ...MANIFEST.heavy, MANIFEST.aggregate].map((name) => ({
		name,
		status: "completed",
		conclusion,
	}));

const scopedJobs = (): Job[] => [
	{ name: MANIFEST.always[0], status: "completed", conclusion: "success" },
	{ name: MANIFEST.always[1], status: "completed", conclusion: "success" },
	{
		name: "Unit ($" + "{{ matrix.name }})",
		status: "completed",
		conclusion: "skipped",
	},
	{
		name: MANIFEST.aggregate_scoped,
		status: "completed",
		conclusion: "success",
	},
];

function fullRun(overrides: Partial<RunFixture> = {}): RunFixture {
	return {
		id: 42,
		status: "completed",
		conclusion: "success",
		title: `CI full-request ${HEAD}`,
		createdAt: "2026-09-17T20:00:00Z",
		epoch: "2026-09-17T21:00:00Z",
		jobs: fullJobs(),
		url: `https://github.com/${REPO}/actions/runs/42`,
		...overrides,
	};
}

function scopedRun(overrides: Partial<RunFixture> = {}): RunFixture {
	return {
		id: 41,
		status: "completed",
		conclusion: "success",
		title: "ordinary scoped run",
		createdAt: "2026-09-17T20:30:00Z",
		epoch: "2026-09-17T20:30:00Z",
		jobs: scopedJobs(),
		url: `https://github.com/${REPO}/actions/runs/41`,
		...overrides,
	};
}

function fixture(args?: {
	runs?: RunFixture[];
	headSequence?: string[];
	addLabelResultLost?: boolean;
	manifest?: unknown;
	manifestMissing?: boolean;
	manifestReadError?: boolean;
	legacyChecks?: Array<Record<string, unknown>>;
	legacyChecksStatus?: number;
}) {
	const runs = args?.runs ?? [];
	const calls: string[] = [];
	let viewCount = 0;
	const runner: CiFullCommandRunner = vi.fn((file, argv) => {
		calls.push(`${file} ${argv.join(" ")}`);
		if (file === "gh" && argv[0] === "pr" && argv[1] === "view") {
			const sequence = args?.headSequence ?? [HEAD, HEAD];
			const headRefOid = sequence[Math.min(viewCount++, sequence.length - 1)];
			return {
				stdout: JSON.stringify({
					number: PR,
					state: "OPEN",
					isCrossRepository: false,
					headRefOid,
					mergeStateStatus: "CLEAN",
					url: `https://github.com/${REPO}/pull/${PR}`,
					labels: [],
				}),
				status: 0,
				signal: null,
			};
		}
		if (file === "git" && argv[0] === "show") {
			if (argv[1]?.endsWith(":.github/workflows/ci.yml")) {
				return { stdout: WORKFLOW, status: 0, signal: null };
			}
			if (args?.manifestMissing || args?.manifestReadError) {
				return { stdout: "", status: 128, signal: null };
			}
			return {
				stdout: JSON.stringify(args?.manifest ?? MANIFEST),
				status: 0,
				signal: null,
			};
		}
		if (file === "git" && argv[0] === "ls-tree") {
			return {
				stdout: args?.manifestMissing ? "" : ".github/ci-required-jobs.json\n",
				status: 0,
				signal: null,
			};
		}
		if (file === "gh" && argv[0] === "pr" && argv[1] === "checks") {
			return {
				stdout: JSON.stringify(
					args?.legacyChecks ?? [
						{
							bucket: "pass",
							name: "Build & Test",
							state: "SUCCESS",
							workflow: "CI",
							link: `https://github.com/${REPO}/actions/runs/1`,
							startedAt: "2026-09-17T20:00:00Z",
							event: "pull_request",
						},
					],
				),
				status: args?.legacyChecksStatus ?? 0,
				signal: null,
			};
		}
		if (file === "gh" && argv[0] === "run" && argv[1] === "list") {
			return {
				stdout: JSON.stringify(
					runs.map((run) => ({
						databaseId: run.id,
						status: run.status,
						conclusion: run.conclusion,
						displayTitle: run.title,
						createdAt: run.createdAt,
						url: run.url,
						attempt: 1,
					})),
				),
				status: 0,
				signal: null,
			};
		}
		if (file === "gh" && argv[0] === "api") {
			const id = Number(argv[1]?.match(/runs\/(\d+)/)?.[1]);
			const run = runs.find((candidate) => candidate.id === id);
			if (!run) return { stdout: "", status: 1, signal: null };
			if (argv[1]?.includes("/jobs?")) {
				return {
					stdout: JSON.stringify({
						total_count: run.jobs.length,
						jobs: run.jobs,
					}),
					status: 0,
					signal: null,
				};
			}
			return {
				stdout: JSON.stringify({
					run_started_at: run.epoch,
					head_sha: HEAD,
					event: "pull_request",
					path: ".github/workflows/ci.yml",
					status: run.status,
					conclusion: run.conclusion,
					repository: { full_name: REPO },
					head_repository: { full_name: REPO },
				}),
				status: 0,
				signal: null,
			};
		}
		if (file === "gh" && argv[0] === "label") {
			return { stdout: "", status: 0, signal: null };
		}
		if (file === "gh" && argv[0] === "pr" && argv[1] === "edit") {
			if (argv.includes("--add-label") && args?.addLabelResultLost) {
				return {
					stdout: "",
					status: null,
					signal: "SIGTERM",
					error: new Error("response lost"),
				};
			}
			return { stdout: "", status: 0, signal: null };
		}
		if (file === "gh" && argv[0] === "run" && argv[1] === "rerun") {
			return { stdout: "", status: 0, signal: null };
		}
		throw new Error(`unexpected command: ${file} ${argv.join(" ")}`);
	});
	return { runner, calls };
}

describe("FLY-2681 ci-full ensure", () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "flywheel-ci-full-"));
	});

	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
	});

	function deps(
		run: CiFullCommandRunner,
		extra: Partial<CiFullDeps> = {},
	): CiFullDeps {
		return {
			run,
			now: () => NOW,
			sleep: async () => {},
			stateDir,
			env: { FLYWHEEL_EXEC_ID: "exec-1" },
			...extra,
		};
	}

	it("returns full_green only for the exact 17-job success multiset", async () => {
		const { runner } = fixture({ runs: [fullRun()] });
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({ exitCode: 0, status: "full_green", runId: 42 });
	});

	it("returns full_green when G4 accepts the earlier raw aggregate cancellation", async () => {
		const { runner, calls } = fixture({
			runs: [fullRun()],
			legacyChecksStatus: 1,
			legacyChecks: [
				{
					bucket: "pass",
					name: MANIFEST.aggregate,
					state: "SUCCESS",
					workflow: "CI",
					link: `https://github.com/${REPO}/actions/runs/42/job/16`,
					startedAt: "2026-09-17T21:00:00Z",
					event: "pull_request",
				},
				{
					bucket: "cancel",
					name: RAW_AGGREGATE_NAME,
					state: "CANCELLED",
					workflow: "CI",
					link: `https://github.com/${REPO}/actions/runs/41/job/15`,
					startedAt: "2026-09-17T20:00:00Z",
					event: "pull_request",
				},
			],
		});
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({ exitCode: 0, status: "full_green", runId: 42 });
		expect(calls).toContain(
			`gh pr checks ${PR} --json bucket,name,state,workflow,link,startedAt,event`,
		);
	});

	it("does not return full_green when G4 rejects the same check rollup", async () => {
		const { runner } = fixture({
			runs: [fullRun()],
			legacyChecksStatus: 1,
			legacyChecks: [
				{
					bucket: "pass",
					name: MANIFEST.aggregate,
					state: "SUCCESS",
					workflow: "CI",
					link: `https://github.com/${REPO}/actions/runs/42/job/16`,
					startedAt: "2026-09-17T21:00:00Z",
					event: "pull_request",
				},
				{
					bucket: "cancel",
					name: RAW_AGGREGATE_NAME,
					state: "CANCELLED",
					workflow: "CI",
					link: `https://github.com/${REPO}/actions/runs/41/job/15`,
					startedAt: "2026-09-17T22:00:00Z",
					event: "pull_request",
				},
			],
		});
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({
			exitCode: 1,
			status: "ship_ci_not_green",
		});
	});

	it("returns inconsistent for a success run with a missing required job", async () => {
		const run = fullRun();
		run.jobs.pop();
		const { runner } = fixture({ runs: [run] });
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({ exitCode: 2, status: "inconsistent" });
	});

	it("recognizes an in-progress full request", async () => {
		const run = fullRun({
			status: "in_progress",
			conclusion: null,
			jobs: [
				{
					name: MANIFEST.always[0],
					status: "completed",
					conclusion: "success",
				},
			],
		});
		const { runner } = fixture({ runs: [run] });
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({ exitCode: 8, status: "full_running" });
	});

	it("waits for an ordinary in-progress run to reveal its shape", async () => {
		const run = scopedRun({
			status: "in_progress",
			conclusion: null,
			jobs: [
				{
					name: MANIFEST.always[0],
					status: "completed",
					conclusion: "success",
				},
			],
		});
		const { runner } = fixture({ runs: [run] });
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({ exitCode: 8, status: "run_shape_pending" });
	});

	it("recognizes an unlabeled merge-head run by its immutable full shape", async () => {
		const { runner } = fixture({
			runs: [fullRun({ title: "ordinary synchronize" })],
		});
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({ exitCode: 0, status: "full_green" });
	});

	it("uses latest-attempt epoch: full A, scoped B, rerun A becomes green", async () => {
		const a = fullRun({
			id: 10,
			createdAt: "2026-09-17T19:00:00Z",
			epoch: "2026-09-17T22:00:00Z",
		});
		const b = scopedRun({ id: 11, epoch: "2026-09-17T21:00:00Z" });
		const { runner } = fixture({ runs: [a, b] });
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({ exitCode: 0, status: "full_green", runId: 10 });
	});

	it("uses latest-attempt epoch: rerun scoped A after full B supersedes full", async () => {
		const a = scopedRun({
			id: 10,
			createdAt: "2026-09-17T19:00:00Z",
			epoch: "2026-09-17T22:00:00Z",
		});
		const b = fullRun({ id: 11, epoch: "2026-09-17T21:00:00Z" });
		const { runner } = fixture({ runs: [a, b] });
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({
			exitCode: 1,
			status: "superseded_by_scoped_run",
			runId: 11,
		});
	});

	it("rejects a stale non-success CI OK from another full run", async () => {
		const stale = fullRun({
			id: 10,
			conclusion: "failure",
			jobs: fullJobs("failure"),
		});
		const current = fullRun({ id: 11, epoch: "2026-09-17T22:00:00Z" });
		const { runner } = fixture({ runs: [stale, current] });
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({
			exitCode: 1,
			status: "stale_non_success_ci_ok",
		});
	});

	it.each([
		["failure", "full_failed", 1],
		["timed_out", "full_failed", 1],
		["startup_failure", "full_failed", 1],
		["action_required", "unrecognized_conclusion", 2],
		["neutral", "unrecognized_conclusion", 2],
		["skipped", "unrecognized_conclusion", 2],
		["stale", "unrecognized_conclusion", 2],
	] as const)(
		"closes completed conclusion %s",
		async (conclusion, status, exitCode) => {
			const { runner } = fixture({ runs: [fullRun({ conclusion })] });
			await expect(
				ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
			).resolves.toMatchObject({ exitCode, status });
		},
	);

	it("reruns one cancelled full run at most once", async () => {
		const cancelled = fullRun({ conclusion: "cancelled" });
		const { runner, calls } = fixture({ runs: [cancelled] });
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({
			exitCode: 8,
			status: "full_rerun_after_cancel",
		});
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({ exitCode: 1, status: "cancelled_again" });
		expect(calls.filter((call) => call === "gh run rerun 42")).toHaveLength(1);
	});

	it("writes intent before labeling and never creates a second request", async () => {
		const { runner, calls } = fixture();
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({ exitCode: 8, status: "full_requested" });
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({
			exitCode: 8,
			status: "request_pending_visibility",
		});
		expect(
			calls.filter((call) => call.includes("--add-label ci:full")),
		).toHaveLength(1);
	});

	it("does not relabel after add-label succeeded but its response was lost", async () => {
		const { runner, calls } = fixture({ addLabelResultLost: true });
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({
			exitCode: 8,
			status: "request_pending_visibility",
		});
		await ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner));
		expect(
			calls.filter((call) => call.includes("--add-label ci:full")),
		).toHaveLength(1);
	});

	it("aborts without labeling when the PR head moves inside the lock", async () => {
		const { runner, calls } = fixture({ headSequence: [HEAD, MOVED_HEAD] });
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({ exitCode: 2, status: "head_moved" });
		expect(calls.some((call) => call.includes("--add-label"))).toBe(false);
	});

	it("requires explicit retry-lost after ten minutes and permits only one retry", async () => {
		const receiptDir = join(
			stateDir,
			"ci-full",
			"xrliAnnie__flywheel",
			String(PR),
		);
		mkdirSync(receiptDir, { recursive: true });
		writeFileSync(
			join(receiptDir, `${HEAD}.json`),
			JSON.stringify({
				schema: 1,
				head: HEAD,
				pr: PR,
				state: "intent",
				requested_at: new Date(NOW - 11 * 60_000).toISOString(),
				requester_exec_id: "exec-1",
				lost_retries: 0,
				reran: [],
			}),
		);
		const { runner, calls } = fixture();
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({ exitCode: 2, status: "request_lost" });
		await expect(
			ensureFullCi(
				{ cwd: "/worktree", pr: PR, head: HEAD, retryLost: true },
				deps(runner),
			),
		).resolves.toMatchObject({ exitCode: 8 });
		expect(
			calls.filter((call) => call.includes("--add-label ci:full")),
		).toHaveLength(1);
	});

	it("does not issue a third label toggle after the explicit lost retry is also lost", async () => {
		let clock = NOW;
		const receiptDir = join(
			stateDir,
			"ci-full",
			"xrliAnnie__flywheel",
			String(PR),
		);
		mkdirSync(receiptDir, { recursive: true });
		writeFileSync(
			join(receiptDir, `${HEAD}.json`),
			JSON.stringify({
				schema: 1,
				head: HEAD,
				pr: PR,
				state: "intent",
				requested_at: new Date(clock - 11 * 60_000).toISOString(),
				requester_exec_id: "exec-1",
				lost_retries: 0,
				reran: [],
			}),
		);
		const { runner, calls } = fixture({ addLabelResultLost: true });
		const clockDeps = deps(runner, { now: () => clock });
		await ensureFullCi(
			{ cwd: "/worktree", pr: PR, head: HEAD, retryLost: true },
			clockDeps,
		);
		clock += 11 * 60_000;
		await expect(
			ensureFullCi(
				{ cwd: "/worktree", pr: PR, head: HEAD, retryLost: true },
				clockDeps,
			),
		).resolves.toMatchObject({ exitCode: 2, status: "request_lost" });
		expect(
			calls.filter((call) => call.includes("--add-label ci:full")),
		).toHaveLength(1);
	});

	it("treats lock contention as a retryable status", async () => {
		const { runner } = fixture();
		await expect(
			ensureFullCi(
				{ cwd: "/worktree", pr: PR, head: HEAD },
				deps(runner, {
					withLock: async () => {
						throw new Error("withMkdirLock: timeout acquiring fixture");
					},
				}),
			),
		).resolves.toMatchObject({ exitCode: 8, status: "lock_busy" });
	});

	it("recovers an abandoned stale lock before requesting", async () => {
		const lockPath = join(
			stateDir,
			"ci-full",
			"locks",
			"xrliAnnie__flywheel__621.lock",
		);
		mkdirSync(lockPath, { recursive: true });
		const old = new Date(Date.now() - 5 * 60_000);
		utimesSync(lockPath, old, old);
		const { runner, calls } = fixture();
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({ exitCode: 8, status: "full_requested" });
		expect(
			calls.filter((call) => call.includes("--add-label ci:full")),
		).toHaveLength(1);
	});

	it("serializes concurrent callers so only one toggles the label", async () => {
		const { runner, calls } = fixture();
		await Promise.all([
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		]);
		expect(
			calls.filter((call) => call.includes("--add-label ci:full")),
		).toHaveLength(1);
	});

	it("does not reinterpret historical shape when the repository switch changes", async () => {
		const { runner } = fixture({ runs: [scopedRun()] });
		for (const value of ["on", "off"]) {
			await expect(
				ensureFullCi(
					{ cwd: "/worktree", pr: PR, head: HEAD },
					deps(runner, {
						env: { CI_SCOPED_MODE: value, FLYWHEEL_EXEC_ID: "exec-1" },
					}),
				),
			).resolves.toMatchObject({ exitCode: 8 });
		}
	});

	it("fails closed when the required-jobs manifest is invalid", async () => {
		const { runner } = fixture({ manifest: { schema: 2 }, runs: [fullRun()] });
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({ exitCode: 2, status: "manifest_invalid" });
	});

	it("fails closed when a manifest present in the tree cannot be read", async () => {
		const { runner } = fixture({ manifestReadError: true });
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({ exitCode: 2, status: "manifest_invalid" });
	});

	it("preserves legacy all-pass CI when the repository has no manifest", async () => {
		const { runner, calls } = fixture({ manifestMissing: true });
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({ exitCode: 0, status: "legacy_ci_green" });
		expect(calls).not.toContain(expect.stringContaining("--add-label ci:full"));
	});

	it("reports legacy CI still running without requesting a full label", async () => {
		const { runner, calls } = fixture({
			manifestMissing: true,
			legacyChecks: [
				{
					bucket: "pending",
					name: "Build & Test",
					state: "IN_PROGRESS",
					workflow: "CI",
					link: `https://github.com/${REPO}/actions/runs/1`,
					startedAt: "2026-09-17T20:00:00Z",
					event: "pull_request",
				},
			],
			legacyChecksStatus: 8,
		});
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({ exitCode: 8, status: "legacy_ci_pending" });
		expect(calls).not.toContain(expect.stringContaining("--add-label ci:full"));
	});

	it("keeps failed legacy CI closed when the repository has no manifest", async () => {
		const { runner } = fixture({
			manifestMissing: true,
			legacyChecks: [
				{
					bucket: "fail",
					name: "Build & Test",
					state: "FAILURE",
					workflow: "CI",
					link: `https://github.com/${REPO}/actions/runs/1`,
					startedAt: "2026-09-17T20:00:00Z",
					event: "pull_request",
				},
			],
			legacyChecksStatus: 1,
		});
		await expect(
			ensureFullCi({ cwd: "/worktree", pr: PR, head: HEAD }, deps(runner)),
		).resolves.toMatchObject({ exitCode: 1, status: "legacy_ci_not_green" });
	});

	it("exposes a zero-exit help probe for deployment canaries", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await expect(runCiFullCommand(["--help"])).resolves.toBe(0);
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining("ci-full ensure"),
			);
		} finally {
			log.mockRestore();
		}
	});
});
