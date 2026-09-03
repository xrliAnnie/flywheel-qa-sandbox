import { describe, expect, it } from "vitest";
import { parseReportHostOverride } from "../bridge/report-host-override.js";

describe("parseReportHostOverride", () => {
	it.each([undefined, "", "   "])(
		"leaves production unchanged for %j",
		(raw) => {
			expect(parseReportHostOverride(raw)).toBeUndefined();
		},
	);

	it.each(["http://127.0.0.1:4321", "http://127.0.0.1:4321/"])(
		"accepts and normalizes an explicit IPv4 loopback endpoint: %s",
		(raw) => {
			expect(parseReportHostOverride(raw)).toEqual({
				apiBaseUrl: "http://127.0.0.1:4321",
				publicBaseUrl: "http://127.0.0.1:4321",
			});
		},
	);

	it.each([
		"https://127.0.0.1:1",
		"http://localhost:1",
		"http://[::1]:1",
		"http://127.1:1",
		"http://2130706433:1",
		"http://0x7f000001:1",
		"http://10.0.0.5:1",
		"http://127.0.0.1",
		"http://127.0.0.1:0",
		"http://127.0.0.1:65536",
		"http://127.0.0.1:1/x",
		"http://127.0.0.1:1?x",
		"http://127.0.0.1:1#x",
		"http://u:p@127.0.0.1:1",
		"not a url",
	])("rejects a non-canonical or non-loopback endpoint: %s", (raw) => {
		expect(() => parseReportHostOverride(raw)).toThrow(
			"FLYWHEEL_REPORT_HOST_OVERRIDE_URL",
		);
	});
});
