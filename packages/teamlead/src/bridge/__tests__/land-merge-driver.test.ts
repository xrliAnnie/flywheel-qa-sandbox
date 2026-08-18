import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { GhCliLandMergeDriver } from "../land-executor.js";

const HEAD = "a".repeat(40);
const VECTORS = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL("../../../../../scripts/ci-status-vectors.json", import.meta.url),
		),
		"utf8",
	),
) as Array<{
	status: string;
	conclusion: string | null;
	receiver: "pending" | "success" | "retryable" | "terminal";
}>;

describe("GhCliLandMergeDriver", () => {
	it("requests GitHub's update-branch endpoint with an exact expected head", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ nameWithOwner: "geoforge3d/flywheel" }),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ message: "Updating pull request branch." }),
				stderr: "",
			});
		const driver = new GhCliLandMergeDriver(() => "/repo", exec);

		await expect(
			driver.requestBaseRefresh({
				projectName: "flywheel",
				prNumber: 1375,
				expectedHeadSha: HEAD,
			}),
		).resolves.toEqual({ status: "accepted" });
		expect(exec).toHaveBeenLastCalledWith(
			"gh",
			[
				"api",
				"-X",
				"PUT",
				"repos/geoforge3d/flywheel/pulls/1375/update-branch",
				"-f",
				`expected_head_sha=${HEAD}`,
			],
			{ cwd: "/repo" },
		);
	});

	it.each([
		{
			label: "true conflict",
			observedHead: HEAD,
			stderr: "gh: There are merge conflicts (HTTP 422)",
			expected: { status: "conflict" },
		},
		{
			label: "stale expected head",
			observedHead: "c".repeat(40),
			stderr: "gh: Validation Failed (HTTP 422)",
			expected: { status: "head_moved", observedHeadSha: "c".repeat(40) },
		},
	])("re-probes a 422 before classifying $label", async (sample) => {
		const failure = Object.assign(new Error(sample.stderr), {
			stderr: sample.stderr,
			stdout: "",
		});
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ nameWithOwner: "geoforge3d/flywheel" }),
				stderr: "",
			})
			.mockRejectedValueOnce(failure)
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					state: "OPEN",
					headRefOid: sample.observedHead,
					baseRefOid: "b".repeat(40),
					mergeCommit: null,
					mergeable: "CONFLICTING",
					mergeStateStatus: "DIRTY",
					isDraft: false,
					reviewDecision: "APPROVED",
					statusCheckRollup: [],
				}),
				stderr: "",
			});
		const driver = new GhCliLandMergeDriver(() => "/repo", exec);

		await expect(
			driver.requestBaseRefresh({
				projectName: "flywheel",
				prNumber: 1375,
				expectedHeadSha: HEAD,
			}),
		).resolves.toEqual(sample.expected);
	});

	it("returns the mergeability, base, policy, and check evidence needed before departure", async () => {
		const exec = vi.fn().mockResolvedValue({
			stdout: JSON.stringify({
				state: "OPEN",
				headRefOid: HEAD,
				baseRefOid: "b".repeat(40),
				mergeCommit: null,
				mergeable: "CONFLICTING",
				mergeStateStatus: "DIRTY",
				isDraft: false,
				reviewDecision: "APPROVED",
				statusCheckRollup: [
					{
						__typename: "CheckRun",
						status: "COMPLETED",
						conclusion: "SUCCESS",
					},
				],
			}),
			stderr: "",
		});
		const driver = new GhCliLandMergeDriver(() => "/repo", exec);

		await expect(
			driver.inspectPr({ projectName: "flywheel", prNumber: 1375 }),
		).resolves.toEqual({
			state: "OPEN",
			headSha: HEAD,
			baseSha: "b".repeat(40),
			mergeable: "CONFLICTING",
			mergeStateStatus: "DIRTY",
			isDraft: false,
			reviewDecision: "APPROVED",
			checks: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
		});
		expect(exec).toHaveBeenCalledWith(
			"gh",
			[
				"pr",
				"view",
				"1375",
				"--json",
				"state,headRefOid,baseRefOid,mergeCommit,mergeable,mergeStateStatus,isDraft,reviewDecision,statusCheckRollup",
			],
			{ cwd: "/repo" },
		);
	});

	it("posts the exact sanctioned :cool: trigger body", async () => {
		const exec = vi.fn().mockResolvedValue({
			stdout: "https://github.test/flywheel/pull/1375#issuecomment-9001\n",
			stderr: "",
		});
		const driver = new GhCliLandMergeDriver(() => "/repo", exec);

		await expect(
			driver.triggerCool({
				projectName: "flywheel",
				prNumber: 1375,
				operationId: "land:durable-operation",
				headSha: HEAD,
			}),
		).resolves.toEqual({
			commentId: "9001",
			commentUrl: "https://github.test/flywheel/pull/1375#issuecomment-9001",
		});
		expect(exec).toHaveBeenCalledWith(
			"gh",
			["pr", "comment", "1375", "--body", ":cool:"],
			{ cwd: "/repo" },
		);
	});

	it("reconciles a prepared trigger to the unique remote :cool: comment", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ nameWithOwner: "owner/flywheel" }),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					[
						{
							id: 8999,
							body: ":cool:",
							created_at: "2026-08-17T19:59:59.000Z",
						},
						{
							id: 9001,
							body: ":cool:",
							created_at: "2026-08-17T20:00:31.000Z",
						},
						{
							body: `<!-- flywheel-ship-receipt trigger_comment_id=9001 run_id=77 head=${HEAD} status=started -->`,
						},
					],
				]),
				stderr: "",
			});
		const driver = new GhCliLandMergeDriver(() => "/repo", exec);

		await expect(
			driver.inspectPreparedCoolAttempt({
				projectName: "flywheel",
				prNumber: 1375,
				headSha: HEAD,
				preparedAt: "2026-08-17T20:00:30.000Z",
				now: "2026-08-17T20:00:45.000Z",
			}),
		).resolves.toEqual({ status: "found", commentId: "9001" });
	});

	it("keeps a same-second GitHub comment inside the prepared-at window despite timestamp truncation", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ nameWithOwner: "owner/flywheel" }),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					[
						{
							id: 9001,
							body: ":cool:",
							created_at: "2026-08-17T20:00:30Z",
						},
						{
							body: `<!-- flywheel-ship-receipt trigger_comment_id=9001 run_id=77 head=${HEAD} status=started -->`,
						},
					],
				]),
				stderr: "",
			});
		const driver = new GhCliLandMergeDriver(() => "/repo", exec);

		await expect(
			driver.inspectPreparedCoolAttempt({
				projectName: "flywheel",
				prNumber: 1375,
				headSha: HEAD,
				preparedAt: "2026-08-17T20:00:30.700Z",
				now: "2026-08-17T20:00:45.000Z",
			}),
		).resolves.toEqual({ status: "found", commentId: "9001" });
	});

	it("does not adopt an unreceipted :cool: comment as the engine's prepared effect", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ nameWithOwner: "owner/flywheel" }),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					[
						{
							id: 9001,
							body: ":cool:",
							created_at: "2026-08-17T20:00:31Z",
						},
					],
				]),
				stderr: "",
			});
		const driver = new GhCliLandMergeDriver(() => "/repo", exec);

		await expect(
			driver.inspectPreparedCoolAttempt({
				projectName: "flywheel",
				prNumber: 1375,
				headSha: HEAD,
				preparedAt: "2026-08-17T20:00:30.000Z",
				now: "2026-08-17T20:00:45.000Z",
			}),
		).resolves.toEqual({ status: "pending" });
	});

	it("issues a bounded absence proof only after the comment propagation window", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ nameWithOwner: "owner/flywheel" }),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify([[]]),
				stderr: "",
			});
		const driver = new GhCliLandMergeDriver(() => "/repo", exec);

		await expect(
			driver.inspectPreparedCoolAttempt({
				projectName: "flywheel",
				prNumber: 1375,
				headSha: HEAD,
				preparedAt: "2026-08-17T20:00:30.000Z",
				now: "2026-08-17T20:02:30.000Z",
			}),
		).resolves.toEqual({
			status: "absent",
			observedAt: "2026-08-17T20:02:30.000Z",
		});
	});

	it("correlates the latest structured workflow receipt to the trigger comment and head", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ nameWithOwner: "owner/flywheel" }),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					[
						{
							body: `<!-- flywheel-ship-receipt trigger_comment_id=old run_id=1 head=${HEAD} status=success -->`,
						},
						{
							body: `<!-- flywheel-ship-receipt trigger_comment_id=9001 run_id=77 run_url=https://github.test/runs/77 head=${HEAD} status=started -->`,
						},
					],
					[
						{
							body: `<!-- flywheel-ship-receipt trigger_comment_id=9001 run_id=77 run_url=https://github.test/runs/77 head=${HEAD} status=failure reason=merge_conflict -->`,
						},
					],
				]),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					status: "completed",
					conclusion: "failure",
					head_sha: HEAD,
				}),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					[
						{
							id: 501,
							conclusion: "failure",
							steps: [
								{ number: 8, name: "Test", conclusion: "success" },
								{ number: 9, name: "✅ Merge PR", conclusion: "failure" },
							],
						},
					],
				]),
				stderr: "",
			});
		const driver = new GhCliLandMergeDriver(() => "/repo", exec);

		await expect(
			driver.inspectTriggeredWorkflow({
				projectName: "flywheel",
				prNumber: 1375,
				triggerCommentId: "9001",
				headSha: HEAD,
			}),
		).resolves.toEqual({
			state: "failed",
			runId: "77",
			runUrl: "https://github.test/runs/77",
			reason: "failure",
			conclusion: "failure",
			structuredReason: "merge_conflict",
			failedStep: { number: 9, name: "✅ Merge PR" },
		});
		expect(exec).toHaveBeenLastCalledWith(
			"gh",
			[
				"api",
				"repos/owner/flywheel/actions/runs/77/jobs",
				"--paginate",
				"--slurp",
			],
			{ cwd: "/repo" },
		);
	});

	it("uses failed_step from a v2 terminal receipt while preserving old receipts", async () => {
		const comments = (terminal: string) =>
			vi
				.fn()
				.mockResolvedValueOnce({
					stdout: JSON.stringify({ nameWithOwner: "owner/flywheel" }),
					stderr: "",
				})
				.mockResolvedValueOnce({
					stdout: JSON.stringify([
						[
							{
								body: `<!-- flywheel-ship-receipt trigger_comment_id=9001 run_id=77 head=${HEAD} status=failure${terminal} -->`,
							},
						],
					]),
					stderr: "",
				});
		const v2 = new GhCliLandMergeDriver(
			() => "/repo",
			comments(" failed_step=ci_failure"),
		);
		await expect(
			v2.inspectTriggeredWorkflow({
				projectName: "flywheel",
				prNumber: 1375,
				triggerCommentId: "9001",
				headSha: HEAD,
			}),
		).resolves.toMatchObject({
			state: "failed",
			reason: "ci_failure",
			structuredReason: "ci_failure",
		});

		const legacy = new GhCliLandMergeDriver(() => "/repo", comments(""));
		await expect(
			legacy.inspectTriggeredWorkflow({
				projectName: "flywheel",
				prNumber: 1375,
				triggerCommentId: "9001",
				headSha: HEAD,
			}),
		).resolves.toMatchObject({ state: "failed", reason: "failure" });
	});

	it.each(VECTORS)(
		"closes started-only run status=$status conclusion=$conclusion as $receiver",
		async (vector) => {
			const exec = vi
				.fn()
				.mockResolvedValueOnce({
					stdout: JSON.stringify({ nameWithOwner: "owner/flywheel" }),
					stderr: "",
				})
				.mockResolvedValueOnce({
					stdout: JSON.stringify([
						[
							{
								created_at: "2026-08-18T00:00:00.000Z",
								body: `<!-- flywheel-ship-receipt trigger_comment_id=9001 run_id=77 run_url=https://github.test/runs/77 head=${HEAD} status=started -->`,
							},
						],
					]),
					stderr: "",
				})
				.mockResolvedValueOnce({
					stdout: JSON.stringify({
						status: vector.status,
						conclusion: vector.conclusion,
					}),
					stderr: "",
				});
			const driver = new GhCliLandMergeDriver(
				() => "/repo",
				exec,
				() => new Date("2026-08-18T00:46:00.000Z"),
			);
			const result = await driver.inspectTriggeredWorkflow({
				projectName: "flywheel",
				prNumber: 1375,
				triggerCommentId: "9001",
				headSha: HEAD,
			});
			if (vector.receiver === "pending") {
				expect(result).toMatchObject({ state: "pending", runId: "77" });
			} else if (vector.receiver === "success") {
				expect(result).toMatchObject({ state: "succeeded", runId: "77" });
			} else {
				expect(result).toMatchObject({
					state: "failed",
					reason: `run_${vector.conclusion ?? "unknown"}`,
				});
			}
		},
	);

	it("does not query a started-only run inside the 45-minute grace", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ nameWithOwner: "owner/flywheel" }),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					[
						{
							created_at: "2026-08-18T00:00:00.000Z",
							body: `<!-- flywheel-ship-receipt trigger_comment_id=9001 run_id=77 head=${HEAD} status=started -->`,
						},
					],
				]),
				stderr: "",
			});
		const driver = new GhCliLandMergeDriver(
			() => "/repo",
			exec,
			() => new Date("2026-08-18T00:44:59.999Z"),
		);
		await expect(
			driver.inspectTriggeredWorkflow({
				projectName: "flywheel",
				prNumber: 1375,
				triggerCommentId: "9001",
				headSha: HEAD,
			}),
		).resolves.toMatchObject({ state: "pending", runId: "77" });
		expect(exec).toHaveBeenCalledTimes(2);
	});

	it("frames a legacy merge failure log to the exact failed Actions step", async () => {
		const mergeLog = [
			"2026-08-17T10:00:00.000Z test fixture prints HTTP 503",
			"2026-08-17T10:02:00.000Z RequestError [HttpError]: Pull Request is not mergeable (status 405)",
		].join("\n");
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ nameWithOwner: "owner/flywheel" }),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					[
						{
							body: `<!-- flywheel-ship-receipt trigger_comment_id=9001 run_id=77 head=${HEAD} status=failure -->`,
						},
					],
				]),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					status: "completed",
					conclusion: "failure",
					head_sha: HEAD,
				}),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					[
						{
							id: 501,
							conclusion: "failure",
							steps: [
								{
									number: 8,
									name: "Test",
									conclusion: "success",
									started_at: "2026-08-17T09:59:00.000Z",
									completed_at: "2026-08-17T10:01:59.999Z",
								},
								{
									number: 9,
									name: "✅ Merge PR",
									conclusion: "failure",
									started_at: "2026-08-17T10:02:00.000Z",
									completed_at: "2026-08-17T10:02:59.999Z",
								},
							],
						},
					],
				]),
				stderr: "",
			})
			.mockResolvedValueOnce({ stdout: mergeLog, stderr: "" });
		const driver = new GhCliLandMergeDriver(() => "/repo", exec);

		await expect(
			driver.inspectTriggeredWorkflow({
				projectName: "flywheel",
				prNumber: 1375,
				triggerCommentId: "9001",
				headSha: HEAD,
			}),
		).resolves.toMatchObject({
			state: "failed",
			conclusion: "failure",
			failedStep: { number: 9, name: "✅ Merge PR" },
			failedStepLog:
				"2026-08-17T10:02:00.000Z RequestError [HttpError]: Pull Request is not mergeable (status 405)",
		});
		expect(exec).toHaveBeenLastCalledWith(
			"gh",
			["api", "repos/owner/flywheel/actions/jobs/501/logs"],
			{ cwd: "/repo" },
		);
	});
});
