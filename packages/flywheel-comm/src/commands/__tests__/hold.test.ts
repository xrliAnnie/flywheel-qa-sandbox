import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runHoldCommand } from "../hold.js";

function response(status: number, body: unknown) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	};
}

describe("flywheel-comm hold", () => {
	it("is exposed by the top-level CLI dispatcher", () => {
		const source = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");
		expect(source).toContain(
			'import { runHoldCommand } from "./commands/hold.js"',
		);
		expect(source).toContain('case "hold":');
	});

	it("lists current holds through the authenticated loopback endpoint", async () => {
		const httpJson = vi.fn(async () =>
			response(200, { ok: true, holds: [{ shape: "retry_limit_escalated" }] }),
		);
		const log = vi.fn();
		expect(
			await runHoldCommand(["list", "--run", "run-1"], {
				env: {
					TEAMLEAD_API_TOKEN: "secret",
					FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
				},
				httpJson,
				log,
			}),
		).toBe(0);
		expect(httpJson).toHaveBeenCalledWith(
			"http://127.0.0.1:9876/api/runs/run-1/holds",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({
					Authorization: "Bearer secret",
					Origin: "http://127.0.0.1:9876",
				}),
			}),
		);
		expect(log).toHaveBeenCalledWith(
			JSON.stringify({
				ok: true,
				holds: [{ shape: "retry_limit_escalated" }],
			}),
		);
	});

	it("completes the stage/apply confirmation for one exact resume tuple", async () => {
		const httpJson = vi
			.fn()
			.mockResolvedValueOnce(
				response(200, {
					ok: true,
					canonical: { exact: "tuple" },
					confirmToken: "confirm-once",
				}),
			)
			.mockResolvedValueOnce(response(200, { ok: true, state: "projected" }));
		const log = vi.fn();
		expect(
			await runHoldCommand(
				[
					"resume",
					"--run",
					"run-1",
					"--shape",
					"retry_limit_escalated",
					"--hold-event",
					"hold:retry-limit",
					"--reason",
					"operator verified environment",
					"--decision",
					"retry",
					"--request-id",
					"resume-request-1",
				],
				{
					env: {
						TEAMLEAD_API_TOKEN: "secret",
						FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
					},
					httpJson,
					log,
				},
			),
		).toBe(0);
		expect(JSON.parse(httpJson.mock.calls[0]![1].body)).toEqual({
			runId: "run-1",
			shape: "retry_limit_escalated",
			holdEventUid: "hold:retry-limit",
			decision: "retry",
			reason: "operator verified environment",
			principal: "master",
			clientRequestId: "resume-request-1",
		});
		expect(JSON.parse(httpJson.mock.calls[1]![1].body)).toEqual({
			canonical: { exact: "tuple" },
			confirmToken: "confirm-once",
		});
		expect(log).toHaveBeenCalledWith(
			JSON.stringify({ ok: true, state: "projected" }),
		);
	});

	it("fails closed when authentication or required resume arguments are missing", async () => {
		const errorLog = vi.fn();
		const httpJson = vi.fn();
		expect(
			await runHoldCommand(["list", "--run", "run-1"], {
				env: {},
				httpJson,
				errorLog,
			}),
		).toBe(1);
		expect(
			await runHoldCommand(["resume", "--run", "run-1"], {
				env: { TEAMLEAD_API_TOKEN: "secret" },
				httpJson,
				errorLog,
			}),
		).toBe(1);
		expect(httpJson).not.toHaveBeenCalled();
	});
});
