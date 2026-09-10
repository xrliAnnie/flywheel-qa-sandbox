import { describe, expect, it } from "vitest";
import { resolveInboxCommCoordinates } from "../comm-db-path.js";

describe("resolveInboxCommCoordinates", () => {
	it("uses the explicit CommDB in the production carrier shape", () => {
		expect(
			resolveInboxCommCoordinates({ FLYWHEEL_COMM_DB: "/home/u/comm.db" }),
		).toEqual({
			commDbPath: "/home/u/comm.db",
			leaseDir: "/home/u",
		});
	});

	it("prefers the slot root plus project over an inherited CommDB file", () => {
		expect(
			resolveInboxCommCoordinates({
				FLYWHEEL_COMM_ROOT: "/slot/state/comm",
				FLYWHEEL_PROJECT_NAME: "flywheel-test-4",
				FLYWHEEL_COMM_DB: "/production/comm.db",
			}),
		).toEqual({
			commDbPath: "/slot/state/comm/flywheel-test-4/comm.db",
			leaseDir: "/slot/state/comm/flywheel-test-4",
		});
	});

	it("keeps the existing required-CommDB failure when no root tuple exists", () => {
		expect(() => resolveInboxCommCoordinates({})).toThrow(
			"FLYWHEEL_COMM_DB is required",
		);
	});
});
