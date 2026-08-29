/**
 * FLY-123 WS-B (P1 = 4-C): repo-owned, CODEX_HOME-aware rotation shim.
 * - resolver returns the bundled executable (or an explicit override);
 * - flywheel-codex-profile rotates ONLY the per-runner CODEX_HOME (its own
 *   auth.json + .active), seeding from the shared pool — never the global
 *   ~/.codex, never another home. This is the property that lets concurrent
 *   runners share accounts without clobbering each other.
 */
import { execFileSync } from "node:child_process";
import {
	accessSync,
	constants,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flywheelCodexBin } from "../src/codex-home.js";

const PROFILE_BIN = join(
	dirname(flywheelCodexBin({})),
	"flywheel-codex-profile",
);

let tmp: string;
let pool: string;
let homeA: string;
let homeB: string;

function runProfile(home: string, args: string[]): string {
	return execFileSync("bash", [PROFILE_BIN, ...args], {
		env: {
			...process.env,
			CODEX_HOME: home,
			FLYWHEEL_CODEX_PROFILES_DIR: pool,
		},
		encoding: "utf-8",
	});
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "fly123-shim-"));
	pool = join(tmp, "pool");
	mkdirSync(join(pool, "personal"), { recursive: true });
	mkdirSync(join(pool, "business"), { recursive: true });
	writeFileSync(join(pool, "personal", "auth.json"), '{"acct":"personal"}');
	writeFileSync(join(pool, "business", "auth.json"), '{"acct":"business"}');
	homeA = join(tmp, "homeA");
	homeB = join(tmp, "homeB");
	mkdirSync(homeA, { recursive: true });
	mkdirSync(homeB, { recursive: true });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("flywheelCodexBin resolver", () => {
	it("honors an explicit FLYWHEEL_CODEX_BIN override", () => {
		expect(flywheelCodexBin({ FLYWHEEL_CODEX_BIN: "/custom/bin" })).toBe(
			"/custom/bin",
		);
	});

	it("defaults to the bundled, executable repo shim", () => {
		const bin = flywheelCodexBin({});
		expect(bin).toMatch(/bin\/flywheel-codex-with-fallback$/);
		// exists + executable
		expect(() => accessSync(bin, constants.X_OK)).not.toThrow();
		expect(() => accessSync(PROFILE_BIN, constants.X_OK)).not.toThrow();
	});
});

describe("flywheel-codex-profile per-home rotation (the isolation property)", () => {
	it("`use` seeds THIS home's auth.json + .active from the shared pool", () => {
		runProfile(homeA, ["use", "personal"]);
		expect(readFileSync(join(homeA, "auth.json"), "utf-8")).toBe(
			'{"acct":"personal"}',
		);
		expect(readFileSync(join(homeA, ".active"), "utf-8").trim()).toBe(
			"personal",
		);
	});

	it("`next` round-robins within the same home only", () => {
		runProfile(homeA, ["use", "personal"]);
		runProfile(homeA, ["next"]);
		expect(readFileSync(join(homeA, "auth.json"), "utf-8")).toBe(
			'{"acct":"business"}',
		);
		expect(readFileSync(join(homeA, ".active"), "utf-8").trim()).toBe(
			"business",
		);
	});

	it("two homes rotate independently — one runner's switch never touches another's", () => {
		runProfile(homeA, ["use", "personal"]);
		runProfile(homeB, ["use", "business"]);
		// A's next must not be influenced by B's active.
		runProfile(homeA, ["next"]);
		expect(readFileSync(join(homeA, ".active"), "utf-8").trim()).toBe(
			"business",
		);
		// B is untouched by A's rotation.
		expect(readFileSync(join(homeB, ".active"), "utf-8").trim()).toBe(
			"business",
		);
		expect(readFileSync(join(homeB, "auth.json"), "utf-8")).toBe(
			'{"acct":"business"}',
		);
	});

	it("`status` reports this home's active profile", () => {
		runProfile(homeA, ["use", "personal"]);
		expect(runProfile(homeA, ["status"])).toContain("Active profile: personal");
	});
});
