import { describe, expect, it, vi } from "vitest";
import { GhCliLandMergeDriver } from "../land-executor.js";

const HEAD = "a".repeat(40);

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
});
