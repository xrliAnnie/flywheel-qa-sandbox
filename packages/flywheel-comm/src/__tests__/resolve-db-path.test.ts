import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDbPath } from "../resolve-db-path.js";

describe("resolveDbPath", () => {
	const originalEnv = process.env.FLYWHEEL_COMM_DB;

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.FLYWHEEL_COMM_DB = originalEnv;
		} else {
			delete process.env.FLYWHEEL_COMM_DB;
		}
	});

	it("should prefer --db flag over everything", () => {
		process.env.FLYWHEEL_COMM_DB = "/env/path.db";
		const result = resolveDbPath({ db: "/explicit/path.db", project: "proj" });
		expect(result).toBe("/explicit/path.db");
	});

	it("should use FLYWHEEL_COMM_DB env var when no --db", () => {
		process.env.FLYWHEEL_COMM_DB = "/env/comm.db";
		const result = resolveDbPath({ project: "proj" });
		expect(result).toBe("/env/comm.db");
	});

	it("should derive from --project when no --db or env", () => {
		delete process.env.FLYWHEEL_COMM_DB;
		const result = resolveDbPath({ project: "geoforge3d" });
		expect(result).toBe(
			join(homedir(), ".flywheel", "comm", "geoforge3d", "comm.db"),
		);
	});

	it("should throw when nothing is specified", () => {
		delete process.env.FLYWHEEL_COMM_DB;
		expect(() => resolveDbPath({})).toThrow("No DB path specified");
	});
});
