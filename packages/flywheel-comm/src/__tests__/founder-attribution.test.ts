import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveFounderId } from "../founder-attribution.js";

describe("resolveFounderId", () => {
	let tmpDir: string;
	let dotenvPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "founder-attribution-"));
		dotenvPath = join(tmpDir, ".env");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function resolve(args?: {
		argsEnv?: NodeJS.ProcessEnv;
		processEnv?: NodeJS.ProcessEnv;
	}): string | undefined {
		return resolveFounderId({
			argsEnv: args?.argsEnv,
			processEnv: args?.processEnv ?? {},
			dotenvPath,
		});
	}

	it("uses canonical identity before a matching legacy identity", () => {
		writeFileSync(
			dotenvPath,
			"DISCORD_OWNER_USER_ID=canonical\nFLYWHEEL_FOUNDER_USER_ID=canonical\n",
		);

		expect(resolve()).toBe("canonical");
	});

	it("falls back to the legacy identity within the selected source", () => {
		writeFileSync(dotenvPath, "FLYWHEEL_FOUNDER_USER_ID=legacy\n");

		expect(resolve()).toBe("legacy");
	});

	it("fails closed without exposing either value when identities differ", () => {
		writeFileSync(
			dotenvPath,
			"DISCORD_OWNER_USER_ID=canonical-secret\nFLYWHEEL_FOUNDER_USER_ID=legacy-secret\n",
		);

		expect(() => resolve()).toThrowError(
			new Error(
				"Founder identity mismatch: DISCORD_OWNER_USER_ID does not match the configured founder identity; remove the founder override or set it to the same Discord user ID",
			),
		);
	});

	it("treats explicit argsEnv containing either identity key as one coherent source", () => {
		writeFileSync(dotenvPath, "DISCORD_OWNER_USER_ID=dotenv-canonical\n");

		expect(
			resolve({
				argsEnv: { FLYWHEEL_FOUNDER_USER_ID: "args-legacy" },
				processEnv: { DISCORD_OWNER_USER_ID: "process-canonical" },
			}),
		).toBe("args-legacy");
	});

	it("does not mix a dotenv canonical identity with a process legacy identity", () => {
		writeFileSync(dotenvPath, "DISCORD_OWNER_USER_ID=dotenv-canonical\n");

		expect(
			resolve({ processEnv: { FLYWHEEL_FOUNDER_USER_ID: "process-legacy" } }),
		).toBe("dotenv-canonical");
	});

	it("evaluates canonical and legacy identities together in processEnv fallback", () => {
		expect(
			resolve({
				processEnv: {
					DISCORD_OWNER_USER_ID: "same",
					FLYWHEEL_FOUNDER_USER_ID: "same",
				},
			}),
		).toBe("same");
	});

	it("fails closed when processEnv fallback identities differ", () => {
		expect(() =>
			resolve({
				processEnv: {
					DISCORD_OWNER_USER_ID: "process-canonical",
					FLYWHEEL_FOUNDER_USER_ID: "process-legacy",
				},
			}),
		).toThrowError("Founder identity mismatch");
	});
});
