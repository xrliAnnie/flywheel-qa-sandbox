/**
 * FLY-871 R1/C2 — freshness CLI exit-code mapping (the bash contract).
 *   refreshed → 0 · stale → 30 · error/active-refusal/bad-usage → 31
 */
import { describe, expect, it, vi } from "vitest";
import { ActiveAccountRefreshRefused } from "../account-heal/freshness.js";
import { runFreshnessCli } from "../account-heal/freshness-cli.js";

const silent = { log: () => {} };

describe("runFreshnessCli exit codes", () => {
	it("refreshed → 0", async () => {
		const verify = vi.fn(
			async () => ({ fresh: "refreshed", expiresAt: 1 }) as const,
		);
		const code = await runFreshnessCli(
			["verify", "--name", "school", "--active", "personal", "--pool", "/p"],
			{ verify, log: silent.log },
		);
		expect(code).toBe(0);
		expect(verify).toHaveBeenCalledWith({
			name: "school",
			activeName: "personal",
			poolDir: "/p",
		});
	});

	it("stale → 30", async () => {
		const verify = vi.fn(
			async () => ({ fresh: "stale", reason: "refused" }) as const,
		);
		const code = await runFreshnessCli(
			["verify", "--name", "school", "--active", "personal", "--pool", "/p"],
			{ verify, log: silent.log },
		);
		expect(code).toBe(30);
	});

	it("active-refusal throw → 31", async () => {
		const verify = vi.fn(async () => {
			throw new ActiveAccountRefreshRefused("personal");
		});
		const code = await runFreshnessCli(
			["verify", "--name", "personal", "--active", "personal", "--pool", "/p"],
			{ verify, log: silent.log },
		);
		expect(code).toBe(31);
	});

	it("empty --active → activeName null (no active set)", async () => {
		const verify = vi.fn(
			async () => ({ fresh: "refreshed", expiresAt: null }) as const,
		);
		await runFreshnessCli(
			["verify", "--name", "school", "--active", "", "--pool", "/p"],
			{ verify, log: silent.log },
		);
		expect(verify).toHaveBeenCalledWith({
			name: "school",
			activeName: null,
			poolDir: "/p",
		});
	});

	it("bad subcommand → 31", async () => {
		const code = await runFreshnessCli(["bogus"], { log: silent.log });
		expect(code).toBe(31);
	});

	it("missing --name / --pool → 31", async () => {
		expect(
			await runFreshnessCli(["verify", "--active", "x"], { log: silent.log }),
		).toBe(31);
	});
});
