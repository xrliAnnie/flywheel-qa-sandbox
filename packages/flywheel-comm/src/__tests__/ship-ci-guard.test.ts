import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	probeShipCiGreen,
	type ShipCiCommandResult,
} from "../ship-ci-guard.js";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const REPO = "xrliAnnie/flywheel";
const PR_URL = `https://github.com/${REPO}/pull/621`;
const RUN_ID = 4242;
const K_LINK = `https://github.com/${REPO}/actions/runs/${RUN_ID}/job/99`;
const K_TIME = "2026-09-17T21:00:00Z";
const EARLY = "2026-09-17T20:00:00Z";
const LATE = "2026-09-17T22:00:00Z";
const MATRIX_PLACEHOLDER = "Unit ($" + "{{ matrix.name }})";
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

type Check = {
	bucket: string;
	name: string;
	state: string;
	workflow?: string;
	link?: string;
	startedAt?: string;
	event?: string;
};

const ok = (stdout: string, status = 0): ShipCiCommandResult => ({
	stdout,
	status,
	signal: null,
});

const fullChecks = (): Check[] => [
	{
		bucket: "pass",
		name: "CI OK",
		state: "SUCCESS",
		workflow: "CI",
		link: K_LINK,
		startedAt: K_TIME,
		event: "pull_request",
	},
	{
		bucket: "skipping",
		name: MATRIX_PLACEHOLDER,
		state: "SKIPPED",
		workflow: "CI",
		link: `https://github.com/${REPO}/actions/runs/4000/job/1`,
		startedAt: EARLY,
		event: "pull_request",
	},
	{
		bucket: "cancel",
		name: "CI Scope OK",
		state: "CANCELLED",
		workflow: "CI",
		link: `https://github.com/${REPO}/actions/runs/4000/job/2`,
		startedAt: EARLY,
		event: "pull_request",
	},
];

const fullJobs = () =>
	[...MANIFEST.always, ...MANIFEST.heavy, MANIFEST.aggregate].map((name) => ({
		name,
		conclusion: "success",
	}));

function runner(args?: {
	mergeStateStatus?: string;
	head?: string;
	checks?: Check[];
	checksResult?: Partial<ShipCiCommandResult>;
	manifest?: unknown;
	manifestStatus?: number;
	workflow?: string;
	workflowStatus?: number;
	run?: Record<string, unknown>;
	jobs?: Array<Record<string, unknown>>;
	totalCount?: number;
	failApi?: boolean;
}) {
	return vi.fn((file: string, argv: string[]): ShipCiCommandResult => {
		if (file === "gh" && argv[0] === "pr" && argv[1] === "view") {
			return ok(
				JSON.stringify({
					headRefOid: args?.head ?? HEAD,
					mergeStateStatus: args?.mergeStateStatus ?? "CLEAN",
					url: PR_URL,
				}),
			);
		}
		if (file === "gh" && argv[0] === "pr" && argv[1] === "checks") {
			return {
				stdout: JSON.stringify(
					args?.checks ?? [
						{ bucket: "pass", name: "Build & Test", state: "SUCCESS" },
					],
				),
				status: args?.checksResult?.status ?? 0,
				signal: args?.checksResult?.signal ?? null,
				error: args?.checksResult?.error,
			};
		}
		if (file === "git" && argv[0] === "show") {
			if (argv[1]?.endsWith(":.github/workflows/ci.yml")) {
				return ok(args?.workflow ?? WORKFLOW, args?.workflowStatus ?? 0);
			}
			return ok(
				JSON.stringify(args?.manifest ?? MANIFEST),
				args?.manifestStatus ?? 0,
			);
		}
		if (file === "gh" && argv[0] === "api") {
			if (args?.failApi) return ok("", 1);
			if (argv[1]?.endsWith("/jobs?filter=latest&per_page=100")) {
				const jobs = args?.jobs ?? fullJobs();
				return ok(
					JSON.stringify({
						total_count: args?.totalCount ?? jobs.length,
						jobs,
					}),
				);
			}
			return ok(
				JSON.stringify(
					args?.run ?? {
						head_sha: HEAD,
						event: "pull_request",
						path: ".github/workflows/ci.yml",
						status: "completed",
						conclusion: "success",
						repository: { full_name: REPO },
						head_repository: { full_name: REPO },
					},
				),
			);
		}
		throw new Error(`unexpected command: ${file} ${argv.join(" ")}`);
	});
}

function probe(run: ReturnType<typeof runner>) {
	return probeShipCiGreen({
		cwd: "/worktree",
		prNumber: 621,
		expectedHead: HEAD,
		run,
	});
}

describe("FLY-1314/2681 ship CI guard", () => {
	it("keeps the legacy all-pass behavior when no CI OK exists", () => {
		const run = runner();
		expect(probe(run)).toMatchObject({ green: true, reason: "ci_green" });
		expect(run).toHaveBeenNthCalledWith(
			1,
			"gh",
			["pr", "view", "621", "--json", "headRefOid,mergeStateStatus,url"],
			expect.objectContaining({ cwd: "/worktree" }),
		);
		expect(run).toHaveBeenNthCalledWith(
			2,
			"gh",
			[
				"pr",
				"checks",
				"621",
				"--json",
				"bucket,name,state,workflow,link,startedAt,event",
			],
			expect.objectContaining({ cwd: "/worktree" }),
		);
		expect(run.mock.calls[1]?.[1]).not.toContain("--required");
	});

	it("accepts a latest full CI OK after exact run and 17-job proof", () => {
		const run = runner({ checks: fullChecks(), checksResult: { status: 1 } });
		expect(probe(run)).toMatchObject({ green: true, reason: "ci_green" });
		expect(run).toHaveBeenCalledWith(
			"git",
			["show", `${HEAD}:.github/ci-required-jobs.json`],
			expect.any(Object),
		);
		expect(run).toHaveBeenCalledWith(
			"gh",
			[
				"api",
				`repos/${REPO}/actions/runs/${RUN_ID}/jobs?filter=latest&per_page=100`,
			],
			expect.any(Object),
		);
	});

	it("allows an earlier cancelled aggregate whose dynamic name was not evaluated", () => {
		const checks = fullChecks();
		checks[2]!.name = RAW_AGGREGATE_NAME;
		expect(
			probe(runner({ checks, checksResult: { status: 1 } })),
		).toMatchObject({ green: true, reason: "ci_green" });
	});

	it("rejects a raw aggregate name that is not the exact expression at the PR head", () => {
		const checks = fullChecks();
		checks[2]!.name = RAW_AGGREGATE_NAME;
		expect(
			probe(
				runner({
					checks,
					checksResult: { status: 1 },
					workflow: WORKFLOW.replace("CI Scope OK", "CI Review OK"),
				}),
			),
		).toMatchObject({ green: false, reason: "ci_not_green" });
	});

	it.each(["fail", "pending", "cancel", "skipping"])(
		"fails closed without CI OK when a reported check bucket is %s",
		(bucket) => {
			expect(
				probe(
					runner({
						checks: [{ bucket, name: "Build & Test", state: "FAILURE" }],
						checksResult: { status: bucket === "pending" ? 8 : 1 },
					}),
				),
			).toMatchObject({ green: false, reason: "ci_not_green" });
		},
	);

	it.each(["UNSTABLE", "DIRTY", "UNKNOWN"])(
		"fails closed when mergeStateStatus=%s",
		(mergeStateStatus) => {
			expect(probe(runner({ mergeStateStatus }))).toMatchObject({
				green: false,
			});
		},
	);

	it("fails closed on head mismatch, malformed checks, or empty checks", () => {
		for (const run of [
			runner({ head: OTHER_HEAD }),
			vi.fn(
				(_file: string, argv: string[]): ShipCiCommandResult =>
					argv[1] === "view"
						? ok(
								JSON.stringify({
									headRefOid: HEAD,
									mergeStateStatus: "CLEAN",
									url: PR_URL,
								}),
							)
						: ok("not-json"),
			),
			runner({ checks: [] }),
		]) {
			expect(
				probeShipCiGreen({ cwd: "/worktree", expectedHead: HEAD, run }),
			).toMatchObject({ green: false, reason: "ci_not_green" });
		}
	});

	it.each([2, 4, 127])(
		"rejects parseable checks from unknown exit status %s",
		(status) => {
			expect(
				probe(runner({ checks: fullChecks(), checksResult: { status } })),
			).toMatchObject({ green: false });
		},
	);

	it("rejects a valid green JSON prefix when the command timed out", () => {
		expect(
			probe(
				runner({
					checks: fullChecks(),
					checksResult: {
						status: null,
						signal: "SIGTERM",
						error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
					},
				}),
			),
		).toMatchObject({ green: false });
	});

	it.each([1, 8])(
		"consumes complete checks JSON from documented gh exit status %s",
		(status) => {
			expect(
				probe(runner({ checks: fullChecks(), checksResult: { status } })),
			).toMatchObject({ green: true });
		},
	);

	it.each([
		["head SHA", { head_sha: OTHER_HEAD }],
		["event", { event: "workflow_dispatch" }],
		["path", { path: ".github/workflows/other.yml" }],
		["status", { status: "in_progress" }],
		["conclusion", { conclusion: "failure" }],
		["repository", { repository: { full_name: "evil/fork" } }],
		["head repository", { head_repository: { full_name: "evil/fork" } }],
	] as const)(
		"rejects a CI OK whose run %s is not authoritative",
		(_name, patch) => {
			const authoritative = {
				head_sha: HEAD,
				event: "pull_request",
				path: ".github/workflows/ci.yml",
				status: "completed",
				conclusion: "success",
				repository: { full_name: REPO },
				head_repository: { full_name: REPO },
			};
			expect(
				probe(
					runner({ checks: fullChecks(), run: { ...authoritative, ...patch } }),
				),
			).toMatchObject({ green: false });
		},
	);

	it("rejects API failure and malformed or missing manifests", () => {
		for (const run of [
			runner({ checks: fullChecks(), failApi: true }),
			runner({ checks: fullChecks(), manifest: { schema: 2 } }),
			runner({ checks: fullChecks(), manifestStatus: 1 }),
		]) {
			expect(probe(run)).toMatchObject({ green: false });
		}
	});

	it.each([
		[
			"skipped",
			(jobs: ReturnType<typeof fullJobs>) => {
				jobs[2]!.conclusion = "skipped";
			},
		],
		[
			"cancelled",
			(jobs: ReturnType<typeof fullJobs>) => {
				jobs[2]!.conclusion = "cancelled";
			},
		],
		[
			"failure",
			(jobs: ReturnType<typeof fullJobs>) => {
				jobs[2]!.conclusion = "failure";
			},
		],
		["missing aggregate", (jobs: ReturnType<typeof fullJobs>) => jobs.pop()],
		[
			"missing matrix row",
			(jobs: ReturnType<typeof fullJobs>) => jobs.splice(3, 1),
		],
		[
			"missing script shard",
			(jobs: ReturnType<typeof fullJobs>) => jobs.splice(12, 1),
		],
		[
			"unknown extra job",
			(jobs: ReturnType<typeof fullJobs>) =>
				jobs.push({ name: "Unknown", conclusion: "success" }),
		],
		[
			"duplicate job",
			(jobs: ReturnType<typeof fullJobs>) => {
				jobs[3]!.name = jobs[2]!.name;
			},
		],
	] as const)("rejects latest-attempt jobs with %s", (_name, mutate) => {
		const jobs = fullJobs();
		mutate(jobs);
		expect(probe(runner({ checks: fullChecks(), jobs }))).toMatchObject({
			green: false,
		});
	});

	it("rejects a three-job or fifteen-job all-success shape and total_count overflow", () => {
		for (const run of [
			runner({ checks: fullChecks(), jobs: fullJobs().slice(0, 3) }),
			runner({ checks: fullChecks(), jobs: fullJobs().slice(0, 15) }),
			runner({ checks: fullChecks(), totalCount: 101 }),
		]) {
			expect(probe(run)).toMatchObject({ green: false });
		}
	});

	it("allows only configured earlier legacy checks from another run", () => {
		for (const mutate of [
			(checks: Check[]) => {
				checks[1]!.startedAt = LATE;
			},
			(checks: Check[]) => {
				checks[1]!.name = "Quick Gate (build + typecheck + lint)";
			},
			(checks: Check[]) => {
				checks[1]!.bucket = "fail";
			},
			(checks: Check[]) => delete checks[1]!.startedAt,
			(checks: Check[]) => {
				checks[1]!.link = "not-a-run-link";
			},
			(checks: Check[]) => {
				checks[1]!.link = K_LINK;
			},
		]) {
			const checks = fullChecks();
			mutate(checks);
			expect(
				probe(runner({ checks, checksResult: { status: 1 } })),
			).toMatchObject({
				green: false,
			});
		}
	});

	it("deduplicates by workflow, name, event using the newest valid startedAt", () => {
		const checks = fullChecks();
		checks.unshift({
			...checks[0]!,
			bucket: "fail",
			state: "FAILURE",
			startedAt: EARLY,
		});
		expect(
			probe(runner({ checks, checksResult: { status: 1 } })),
		).toMatchObject({
			green: true,
		});
	});

	it("takes the latest CI OK and rejects a newer failure", () => {
		const checks = fullChecks();
		checks.push({
			...checks[0]!,
			bucket: "fail",
			state: "FAILURE",
			startedAt: LATE,
		});
		expect(
			probe(runner({ checks, checksResult: { status: 1 } })),
		).toMatchObject({
			green: false,
		});
	});
});
