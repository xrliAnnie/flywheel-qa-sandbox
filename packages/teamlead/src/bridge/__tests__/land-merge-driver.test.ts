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

	it("correlates the latest workflow receipt to the trigger comment and head", async () => {
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
							body: `<!-- flywheel-ship-receipt trigger_comment_id=9001 run_id=77 run_url=https://github.test/runs/77 head=${HEAD} status=failure -->`,
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
		});
		expect(exec).toHaveBeenLastCalledWith(
			"gh",
			[
				"api",
				"repos/owner/flywheel/issues/1375/comments",
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
		).resolves.toMatchObject({ state: "failed", reason: "ci_failure" });

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
			} else if (vector.receiver === "retryable") {
				expect(result).toMatchObject({
					state: "failed",
					reason: `run_${vector.conclusion}`,
				});
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
});
