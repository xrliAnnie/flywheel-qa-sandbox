import { describe, expect, it, vi } from "vitest";
import { probeShipCiGreen } from "../ship-ci-guard.js";

const HEAD = "a".repeat(40);

function runner(args?: {
	mergeStateStatus?: string;
	checks?: Array<{ bucket: string; name: string; state: string }>;
	viewError?: boolean;
	checksError?: boolean;
}) {
	return vi.fn((_file: string, argv: string[]) => {
		if (argv[1] === "view") {
			if (args?.viewError) throw new Error("github unavailable");
			return JSON.stringify({
				headRefOid: HEAD,
				mergeStateStatus: args?.mergeStateStatus ?? "CLEAN",
			});
		}
		if (args?.checksError) throw new Error("checks pending");
		return JSON.stringify(
			args?.checks ?? [
				{ bucket: "pass", name: "Build & Test", state: "SUCCESS" },
			],
		);
	});
}

describe("FLY-1314 ship CI guard", () => {
	it("accepts only a matching head, non-UNSTABLE/DIRTY merge state, and all reported checks passing", () => {
		const run = runner();
		expect(
			probeShipCiGreen({
				cwd: "/worktree",
				prNumber: 621,
				expectedHead: HEAD,
				run,
			}),
		).toMatchObject({ green: true, reason: "ci_green" });
		expect(run).toHaveBeenNthCalledWith(
			1,
			"gh",
			["pr", "view", "621", "--json", "headRefOid,mergeStateStatus"],
			expect.objectContaining({ cwd: "/worktree" }),
		);
		expect(run).toHaveBeenNthCalledWith(
			2,
			"gh",
			["pr", "checks", "621", "--json", "bucket,name,state"],
			expect.objectContaining({ cwd: "/worktree" }),
		);
	});

	it("FLY-1314 QA: free-tier repo (checks present, none required-marked) → green, and NEVER filters with --required", () => {
		// Real-machine ground truth (flywheel PR #627, verified 2026-07-17): the
		// flywheel repo is a PRIVATE FREE-TIER repo, so GitHub cannot report any
		// *required* checks (`branches/main/protection/required_status_checks` →
		// HTTP 403 "Upgrade to GitHub Pro"). There, `gh pr checks --required`
		// exits 1 with EMPTY stdout ("no required checks reported"), which would
		// make execFileSync throw and fail the guard closed — blocking EVERY ship
		// on this repo. The guard therefore MUST query ALL checks (no --required)
		// and pass when every reported check is green. This test pins that the
		// implementation does NOT regress toward the plan's `--required` wording.
		const run = runner({
			checks: [
				{ bucket: "pass", name: "Build & Test", state: "SUCCESS" },
				{
					bucket: "pass",
					name: "FLY-1062 payload distribution (endpoint + release pipeline)",
					state: "SUCCESS",
				},
			],
		});
		expect(
			probeShipCiGreen({
				cwd: "/worktree",
				prNumber: 627,
				expectedHead: HEAD,
				run,
			}),
		).toMatchObject({ green: true, reason: "ci_green" });
		const checksCall = run.mock.calls.find((call) => call[1][1] === "checks");
		expect(checksCall).toBeDefined();
		expect(checksCall?.[1]).toContain("--json");
		expect(checksCall?.[1]).not.toContain("--required");
	});

	it("FLY-1981 exposes no env override and retired process state still runs the real probe", () => {
		const args: Parameters<typeof probeShipCiGreen>[0] = {
			cwd: "/worktree",
			expectedHead: HEAD,
			run: runner(),
		};
		const legacyOverride: Parameters<typeof probeShipCiGreen>[0] = {
			...args,
			// @ts-expect-error FLY-1981 removed environment injection from this API.
			env: {},
		};
		void legacyOverride;

		const previous = process.env.FLYWHEEL_SHIP_CI_GUARD;
		process.env.FLYWHEEL_SHIP_CI_GUARD = "0";
		try {
			expect(probeShipCiGreen(args)).toMatchObject({
				green: true,
				reason: "ci_green",
			});
			expect(args.run).toHaveBeenCalledTimes(2);

			const failingRun = runner({
				checks: [
					{
						bucket: "fail",
						name: "Build & Test",
						state: "FAILURE",
					},
				],
			});
			expect(
				probeShipCiGreen({
					cwd: "/worktree",
					expectedHead: HEAD,
					run: failingRun,
				}),
			).toMatchObject({ green: false, reason: "ci_not_green" });
			expect(failingRun).toHaveBeenCalledTimes(2);
		} finally {
			if (previous === undefined) delete process.env.FLYWHEEL_SHIP_CI_GUARD;
			else process.env.FLYWHEEL_SHIP_CI_GUARD = previous;
		}
	});

	it.each(["UNSTABLE", "DIRTY"])(
		"fails closed when mergeStateStatus=%s",
		(mergeStateStatus) => {
			expect(
				probeShipCiGreen({
					cwd: "/worktree",
					expectedHead: HEAD,
					run: runner({ mergeStateStatus }),
				}),
			).toMatchObject({ green: false, reason: "ci_not_green" });
		},
	);

	it.each(["fail", "pending", "cancel", "skipping"])(
		"fails closed when a reported check bucket is %s",
		(bucket) => {
			expect(
				probeShipCiGreen({
					cwd: "/worktree",
					expectedHead: HEAD,
					run: runner({
						checks: [{ bucket, name: "Build & Test", state: "FAILURE" }],
					}),
				}),
			).toMatchObject({ green: false, reason: "ci_not_green" });
		},
	);

	it("fails closed on no reported checks, head mismatch, malformed output, or gh failure", () => {
		for (const run of [
			runner({ checks: [] }),
			vi.fn((_file: string, argv: string[]) =>
				argv[1] === "view"
					? JSON.stringify({
							headRefOid: "b".repeat(40),
							mergeStateStatus: "CLEAN",
						})
					: "[]",
			),
			vi.fn(() => "not-json"),
			runner({ viewError: true }),
			runner({ checksError: true }),
		]) {
			expect(
				probeShipCiGreen({ cwd: "/worktree", expectedHead: HEAD, run }),
			).toMatchObject({ green: false, reason: "ci_not_green" });
		}
	});
});
