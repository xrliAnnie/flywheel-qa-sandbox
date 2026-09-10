import { describe, expect, it, vi } from "vitest";
import {
	advanceCodexQuotaRunRecovery,
	type CodexRunRecoveryPorts,
	type CodexRunRecoveryTarget,
} from "../../codex-quota/run-recovery.js";

function fixture() {
	const target: CodexRunRecoveryTarget = {
		incidentId: "codex:root:1",
		runId: "old-run",
		oldExecutionId: "old-exec",
		state: "waiting",
		installedGeneration: 2,
		startRequest: {
			issueId: "FLY-1",
			projectName: "fixture",
			quotaRecoveryId: "target-1",
		},
	};
	const post = vi.fn().mockResolvedValue({
		status: 200,
		body: { success: true, status: "cancelled" },
	});
	const persist = vi.fn(async (patch: Partial<CodexRunRecoveryTarget>) => {
		Object.assign(target, patch);
	});
	const ports: CodexRunRecoveryPorts = {
		readAuthority: vi.fn(async () => ({
			committed: false,
			generation: 2,
			canonicalMatches: true,
			quotaProvenance: true,
			liveOldExecution: false,
			operatorStopped: false,
			healthySuccessor: false,
		})),
		post,
		persist,
		verifyRunning: vi.fn(async () => false),
	};
	return { target, ports, post, persist };
}

describe("Codex quota run recovery", () => {
	it("does not start on a rejected terminate body and preserves the retry cursor on transport loss", async () => {
		const { target, ports, post } = fixture();
		vi.mocked(ports.readAuthority).mockResolvedValue({
			committed: true,
			generation: 2,
			canonicalMatches: true,
			quotaProvenance: true,
			liveOldExecution: false,
			operatorStopped: false,
			healthySuccessor: false,
		});
		post.mockResolvedValueOnce({ status: 200, body: { success: false } });
		await advanceCodexQuotaRunRecovery(target, ports);
		expect(post).toHaveBeenCalledTimes(1);
		const key = post.mock.calls[0]?.[1].clientRequestId;
		post.mockRejectedValueOnce(new Error("response lost"));
		await expect(advanceCodexQuotaRunRecovery(target, ports)).rejects.toThrow(
			"response lost",
		);
		expect(target.state).toBe("terminating");
		expect(post.mock.calls[1]?.[1].clientRequestId).toBe(key);
	});

	it("rechecks permission after terminate so a manual account change prevents start", async () => {
		const { target, ports, post } = fixture();
		const authority = {
			committed: true,
			generation: 2,
			canonicalMatches: true,
			quotaProvenance: true,
			liveOldExecution: false,
			operatorStopped: false,
			healthySuccessor: false,
		};
		vi.mocked(ports.readAuthority)
			.mockResolvedValueOnce(authority)
			.mockResolvedValue({ ...authority, generation: 3 });
		await advanceCodexQuotaRunRecovery(target, ports);
		expect(post.mock.calls.map((call) => call[0])).toEqual([
			"/api/runs/old-run/terminate",
		]);
		expect(target.state).toBe("terminated");
	});

	it.each([
		"operatorStopped",
		"healthySuccessor",
		"liveOldExecution",
		"quotaProvenance",
	] as const)("refuses recovery when %s authority forbids it", async (flag) => {
		const { target, ports, post } = fixture();
		vi.mocked(ports.readAuthority).mockResolvedValue({
			committed: true,
			generation: 2,
			canonicalMatches: true,
			quotaProvenance: true,
			liveOldExecution: false,
			operatorStopped: false,
			healthySuccessor: false,
			[flag]: flag !== "quotaProvenance",
		});
		await advanceCodexQuotaRunRecovery(target, ports);
		expect(post).not.toHaveBeenCalled();
	});

	it("persists terminate then replays a queued start key until running is independently verified", async () => {
		const { target, ports, post } = fixture();
		vi.mocked(ports.readAuthority).mockResolvedValue({
			committed: true,
			generation: 2,
			canonicalMatches: true,
			quotaProvenance: true,
			liveOldExecution: false,
			operatorStopped: false,
			healthySuccessor: false,
		});
		post
			.mockResolvedValueOnce({
				status: 200,
				body: { success: true, status: "cancelled" },
			})
			.mockResolvedValueOnce({
				status: 202,
				body: {
					code: "CODEX_QUOTA_QUEUED",
					runId: "new-run",
					executionId: "new-exec",
				},
			})
			.mockResolvedValue({
				status: 200,
				body: { status: "running", runId: "new-run", executionId: "new-exec" },
			});
		expect(await advanceCodexQuotaRunRecovery(target, ports)).toBe("queued");
		expect(ports.verifyRunning).not.toHaveBeenCalled();
		expect(post.mock.calls.map((call) => call[0])).toEqual([
			"/api/runs/old-run/terminate",
			"/api/runs/start",
		]);
		vi.mocked(ports.verifyRunning).mockResolvedValue(true);
		expect(await advanceCodexQuotaRunRecovery(target, ports)).toBe("recovered");
		expect(post.mock.calls[1]?.[1]).toEqual(post.mock.calls[2]?.[1]);
		expect(ports.verifyRunning).toHaveBeenCalledWith("new-exec", 2);
	});

	it("never terminates or starts without a committed probe and current credential permission", async () => {
		const { target, ports, post } = fixture();
		expect(await advanceCodexQuotaRunRecovery(target, ports)).toBe("waiting");
		expect(post).not.toHaveBeenCalled();
	});
	it("accepts the real generalized runs/start workflowRunId response", async () => {
		const { target, ports, post } = fixture();
		vi.mocked(ports.readAuthority).mockResolvedValue({
			committed: true,
			generation: 2,
			canonicalMatches: true,
			quotaProvenance: true,
			liveOldExecution: false,
			operatorStopped: false,
			healthySuccessor: false,
		});
		post
			.mockResolvedValueOnce({
				status: 200,
				body: { success: true, status: "terminated" },
			})
			.mockResolvedValueOnce({
				status: 200,
				body: {
					success: true,
					workflowRunId: "actual-run",
					executionId: "actual-exec",
					issueId: "FLY-1",
					generalized: true,
					workflowNodeId: "implement",
					message: "Runner started for FLY-1",
				},
			});
		vi.mocked(ports.verifyRunning).mockResolvedValue(true);
		expect(await advanceCodexQuotaRunRecovery(target, ports)).toBe("recovered");
		expect(target.newRunId).toBe("actual-run");
		expect(ports.verifyRunning).toHaveBeenCalledWith("actual-exec", 2);
	});
});
