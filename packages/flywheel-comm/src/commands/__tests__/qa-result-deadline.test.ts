vi.mock("../../bridge-pressure-snapshot.js", () => ({
	printBridgePressure: vi.fn(),
}));

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { qaResult } from "../qa-result.js";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it("FLY-1956: aborts a stalled response body at 20 seconds and replays the same request", async () => {
	const home = mkdtempSync(join(tmpdir(), "fly1956-qa-deadline-"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("FLYWHEEL_COMM_DB", join(home, "comm.db"));
	vi.stubEnv("FLYWHEEL_EXEC_ID", "qa-deadline");
	vi.stubEnv("FLYWHEEL_ISSUE_ID", "FLY-1956");
	vi.stubEnv("FLYWHEEL_PROJECT_NAME", "flywheel");
	vi.stubEnv("FLYWHEEL_BRIDGE_URL", "http://bridge.invalid");
	vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "test-credential");
	vi.stubEnv("FLYWHEEL_RUNNER_MEMORY_DIR", "");
	vi.stubEnv("FLYWHEEL_RUNNER_MEMORY_SNAPSHOT", "");
	vi.useFakeTimers();
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
	let signal: AbortSignal | undefined;
	let publishedMarker: Record<string, unknown> | undefined;
	const fetchMock = vi
		.fn<typeof fetch>()
		.mockImplementationOnce(async (_url, init) => {
			const path = join(
				home,
				".flywheel",
				"state",
				"qa-result-failed",
				"qa-deadline.json",
			);
			if (existsSync(path))
				publishedMarker = JSON.parse(readFileSync(path, "utf8"));
			signal = init?.signal ?? undefined;
			return {
				text: () =>
					new Promise<string>((_resolve, reject) => {
						signal?.addEventListener(
							"abort",
							() => reject(new Error("body aborted")),
							{ once: true },
						);
					}),
			} as Response;
		})
		.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					ok: true,
					claimId: 1,
					serverSeq: 2,
					idempotentReplay: true,
				}),
			),
		);
	vi.stubGlobal("fetch", fetchMock);
	try {
		const pending = qaResult({ status: "pass", targetExec: "impl" });
		await vi.advanceTimersByTimeAsync(19999);
		expect(signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(signal?.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(1000);
		await pending;
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(publishedMarker).toMatchObject({
			phase: "in_flight",
			client_request_id: JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
				.client_request_id,
			recoverable_verdict: { status: "pass", targetExecutionId: "impl" },
		});
		expect(JSON.stringify(publishedMarker)).not.toContain("test-credential");
		expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
			fetchMock.mock.calls[0]?.[1]?.body,
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
