import { expect, it } from "vitest";
import { parseMigrationWindowContext } from "../lead-backend-migration-context.js";

const expected = { home: "/test/home", root: "/test/repo" };
function context() {
	return {
		...expected,
		restartPid: 42,
		restartStart: "Fri Sep 11 00:00:00 2026",
		lockDev: 1,
		lockIno: 2,
		leaseId: "11111111-1111-4111-8111-111111111111",
		restartScript: "/test/repo/scripts/restart-services.sh",
		updaterScript: "/test/repo/scripts/update-flywheel.sh",
	};
}
it("accepts the source helper shape only at the trusted installation paths", () => {
	const input = context();
	expect(parseMigrationWindowContext(JSON.stringify(input), expected)).toEqual(
		input,
	);
});
it.each([
	{ home: "/other" },
	{ root: "/other" },
	{ restartScript: "/other/restart-services.sh" },
	{ updaterScript: "/other/update-flywheel.sh" },
	{ restartPid: 0 },
	{ restartStart: "bad\ntime" },
	{ lockIno: -1 },
	{ leaseId: "not-a-lease" },
	{ token: "DO_NOT_ECHO" },
])("rejects unsupported context without echoing values", (patch) => {
	expect(() =>
		parseMigrationWindowContext(
			JSON.stringify({ ...context(), ...patch }),
			expected,
		),
	).toThrow("invalid migration window context");
});
it("bounds JSON input before parsing and rejects incomplete objects", () => {
	expect(() =>
		parseMigrationWindowContext(" ".repeat(8193), expected),
	).toThrow();
	expect(() => parseMigrationWindowContext("{}", expected)).toThrow();
	expect(() => parseMigrationWindowContext("null", expected)).toThrow();
});
