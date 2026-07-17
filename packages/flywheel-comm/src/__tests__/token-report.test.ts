import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runTokenReportCli } = vi.hoisted(() => ({
	runTokenReportCli: vi.fn(),
}));

vi.mock("flywheel-token-usage", () => ({ runTokenReportCli }));

import { runTokenReport } from "../commands/token-report.js";

describe("runTokenReport integrity exit propagation (FLY-1348)", () => {
	let originalExitCode: number | string | null | undefined;

	beforeEach(() => {
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
		runTokenReportCli.mockReset();
	});

	afterEach(() => {
		process.exitCode = originalExitCode;
	});

	it("propagates integrity exit code 3 to the outer CLI process", async () => {
		runTokenReportCli.mockResolvedValue(3);

		await runTokenReport(["daily", "--out", "/tmp/report.html"]);

		expect(runTokenReportCli).toHaveBeenCalledWith([
			"daily",
			"--out",
			"/tmp/report.html",
		]);
		expect(process.exitCode).toBe(3);
	});

	it("leaves the outer process exit code unset on success", async () => {
		runTokenReportCli.mockResolvedValue(0);

		await runTokenReport(["report"]);

		expect(process.exitCode).toBeUndefined();
	});
});
