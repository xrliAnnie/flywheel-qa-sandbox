import { describe, expect, it, vi } from "vitest";
import { founderTime } from "../commands/founder-time.js";

function fixedIo(timezone = "America/Los_Angeles") {
	return {
		now: () => new Date("2026-07-17T02:23:05.000Z"),
		resolveTimezone: () => timezone,
		stdout: vi.fn(),
	};
}

describe("FLY-1319 flywheel-comm founder-time", () => {
	it("prints founder local wall time, IANA timezone, and UTC offset", () => {
		const io = fixedIo();

		founderTime([], io);

		expect(io.stdout).toHaveBeenCalledWith(
			"2026-07-16 19:23 PDT — America/Los_Angeles (UTC-07:00)",
		);
	});

	it("prints a machine-readable JSON contract", () => {
		const io = fixedIo();

		founderTime(["--json"], io);

		expect(JSON.parse(io.stdout.mock.calls[0][0])).toEqual({
			iso: "2026-07-16T19:23:05-07:00",
			tz: "America/Los_Angeles",
			abbrev: "PDT",
			offsetMinutes: -420,
		});
	});

	it("uses the timezone resolved for this invocation", () => {
		const io = fixedIo("Asia/Tokyo");

		founderTime([], io);

		expect(io.stdout).toHaveBeenCalledWith(
			"2026-07-17 11:23 GMT+9 — Asia/Tokyo (UTC+09:00)",
		);
	});
});
