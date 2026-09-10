import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { commDbPathForProject, commDbRootDir } from "../bridge/commdb-path.js";
import { resolveGateResponseCommRoot } from "../bridge/founder-consent/gate-response-router.js";

describe("CommDB production parity", () => {
	it("keeps ROOT > DIR > HOME precedence explicit", () => {
		expect(
			commDbRootDir({
				FLYWHEEL_COMM_ROOT: "/root-override",
				FLYWHEEL_COMM_DIR: "/dir-override",
			}),
		).toBe("/root-override");
		expect(commDbRootDir({ FLYWHEEL_COMM_DIR: "/dir-override" })).toBe(
			"/dir-override",
		);
		expect(commDbRootDir({})).toBe(join(homedir(), ".flywheel", "comm"));
	});

	it("keeps the all-unset project path byte-identical", () => {
		expect(commDbPathForProject("flywheel", {})).toBe(
			join(homedir(), ".flywheel", "comm", "flywheel", "comm.db"),
		);
	});

	it("uses the same default root for founder gate responses", () => {
		expect(resolveGateResponseCommRoot(undefined, {})).toBe(
			resolve(join(homedir(), ".flywheel", "comm")),
		);
		expect(
			resolveGateResponseCommRoot(undefined, {
				FLYWHEEL_COMM_DIR: "/slot/comm",
			}),
		).toBe("/slot/comm");
	});
});
