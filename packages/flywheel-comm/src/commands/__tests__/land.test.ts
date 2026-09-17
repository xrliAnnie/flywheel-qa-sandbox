import { describe, expect, it, vi } from "vitest";
import { runLandCommand } from "../land.js";

describe("flywheel-comm land reclose", () => {
	it("submits the exact closeout-only tuple with the master credential", async () => {
		const httpJson = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ state: "partial", resume_generation: 4 }),
		}));
		const log = vi.fn();
		await expect(
			runLandCommand(
				[
					"reclose",
					"--operation",
					"land:one",
					"--expected-generation",
					"3",
					"--expected-head",
					"a".repeat(40),
					"--reason",
					"retry closeout evidence",
					"--request-id",
					"11111111-1111-4111-8111-111111111111",
				],
				{
					env: {
						TEAMLEAD_API_TOKEN: "master-secret",
						FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876/",
					},
					httpJson,
					log,
					errorLog: vi.fn(),
				},
			),
		).resolves.toBe(0);
		expect(httpJson).toHaveBeenCalledWith(
			"http://127.0.0.1:9876/api/lifecycle/land/land%3Aone/resume",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer master-secret",
				}),
				body: JSON.stringify({
					mode: "closeout_only",
					expectedResumeGeneration: 3,
					expectedApprovedHead: "a".repeat(40),
					reason: "retry closeout evidence",
					requestId: "11111111-1111-4111-8111-111111111111",
				}),
			}),
		);
		expect(log).toHaveBeenCalledWith(
			JSON.stringify({ state: "partial", resume_generation: 4 }),
		);
	});

	it("fails closed without the master token or an exact tuple", async () => {
		const httpJson = vi.fn();
		const errorLog = vi.fn();
		expect(
			await runLandCommand(["reclose", "--operation", "land:one"], {
				env: {},
				httpJson,
				log: vi.fn(),
				errorLog,
			}),
		).toBe(1);
		expect(httpJson).not.toHaveBeenCalled();
		expect(errorLog).toHaveBeenCalled();
	});
});
