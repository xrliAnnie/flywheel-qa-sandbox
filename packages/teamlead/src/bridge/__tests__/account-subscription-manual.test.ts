import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withMkdirLock } from "../../account-heal/mkdir-lock.js";
import {
	defaultAccountSubscriptionManualPath,
	installAccountSubscriptionManual,
	readAccountSubscriptionManual,
	resolveAccountSubscriptionConfirmation,
} from "../account-subscription-manual.js";

const generatedAt = "2026-09-23T20:00:00.000Z";
const businessIdentity = "a".repeat(64);

function confirmation(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		provider: "Claude",
		profile: "business",
		identityKey: businessIdentity,
		status: "canceled",
		expiresOn: "2026-10-14",
		confirmedBy: "founder",
		confirmedAt: "2026-09-23T18:00:00.000Z",
		sourceRef: "FLY-2792#founder-confirmation",
		...overrides,
	};
}

function payload(confirmations: unknown[] = [confirmation()]) {
	return { version: 1, confirmations };
}

function write(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

describe("FLY-2803 trusted subscription confirmations", () => {
	it("uses a dedicated state file and selects the latest identity-bound confirmation", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "fly2803-subscription-"));
		const path = defaultAccountSubscriptionManualPath(
			{ FLYWHEEL_STATE_DIR: stateDir },
			"/unused-home",
		);
		mkdirSync(join(stateDir, "account-subscriptions"), { mode: 0o700 });
		write(
			path,
			payload([
				confirmation(),
				confirmation({
					status: "unknown",
					expiresOn: null,
					confirmedAt: "2026-09-23T19:00:00.000Z",
					sourceRef: "FLY-2792#correction",
				}),
			]),
		);

		const result = readAccountSubscriptionManual({
			path,
			stateDir,
			generatedAt,
		});
		expect(result.error).toBeNull();
		expect(result.data?.confirmations).toHaveLength(2);
		expect(
			resolveAccountSubscriptionConfirmation(result.data!.confirmations, {
				provider: "Claude",
				profile: "business",
				identityKey: businessIdentity,
			}),
		).toMatchObject({
			error: null,
			confirmation: { status: "unknown", expiresOn: null },
		});
	});

	it("does not inherit a same-name confirmation after the account identity changes", () => {
		const records = readFrom(payload()).data!.confirmations;
		expect(
			resolveAccountSubscriptionConfirmation(records, {
				provider: "Claude",
				profile: "business",
				identityKey: "b".repeat(64),
			}),
		).toEqual({ confirmation: null, error: "identity_mismatch" });
		expect(
			resolveAccountSubscriptionConfirmation(records, {
				provider: "Claude",
				profile: "business",
				identityKey: null,
			}),
		).toEqual({ confirmation: null, error: "identity_missing" });
	});

	it.each([
		[
			"missing provenance",
			confirmation({ confirmedBy: undefined }),
			"invalid_schema",
		],
		[
			"invalid calendar day",
			confirmation({ expiresOn: "2026-02-30" }),
			"invalid_schema",
		],
		[
			"active with expiry",
			confirmation({ status: "active" }),
			"invalid_schema",
		],
		["unknown field", confirmation({ unexpected: true }), "invalid_schema"],
		[
			"future confirmation",
			confirmation({ confirmedAt: "2026-09-23T21:00:00.000Z" }),
			"future_confirmation",
		],
		[
			"duplicate confirmation key",
			[confirmation(), confirmation()],
			"duplicate_confirmation",
		],
	])("rejects %s for the whole input", (_label, value, error) => {
		const confirmations = Array.isArray(value) ? value : [value];
		expect(readFrom(payload(confirmations))).toMatchObject({
			data: null,
			error,
		});
	});

	it("rejects writable, symlinked, oversized, and out-of-state files", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "fly2803-subscription-"));
		const directory = join(stateDir, "account-subscriptions");
		mkdirSync(directory, { mode: 0o700 });
		const path = join(directory, "manual.json");
		write(path, payload());
		chmodSync(path, 0o666);
		expect(
			readAccountSubscriptionManual({ path, stateDir, generatedAt }).error,
		).toBe("unsafe_file");

		const outsideDir = mkdtempSync(join(tmpdir(), "fly2803-subscription-out-"));
		const outside = join(outsideDir, "manual.json");
		write(outside, payload());
		expect(
			readAccountSubscriptionManual({
				path: outside,
				stateDir,
				generatedAt,
			}).error,
		).toBe("path_escape");

		const linked = join(directory, "linked.json");
		symlinkSync(outside, linked);
		expect(
			readAccountSubscriptionManual({
				path: linked,
				stateDir,
				generatedAt,
			}).error,
		).toBe("unsafe_file");

		writeFileSync(path, "x".repeat(64 * 1024 + 1), { mode: 0o600 });
		chmodSync(path, 0o600);
		expect(
			readAccountSubscriptionManual({ path, stateDir, generatedAt }).error,
		).toBe("file_too_large");
	});

	it("atomically merges validated input without deleting history", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "fly2803-subscription-"));
		const targetPath = join(stateDir, "account-subscriptions", "manual.json");
		const firstInput = join(stateDir, "first.json");
		const secondInput = join(stateDir, "second.json");
		write(firstInput, payload());
		write(
			secondInput,
			payload([
				confirmation({
					status: "active",
					expiresOn: null,
					confirmedAt: "2026-09-23T19:00:00.000Z",
					sourceRef: "FLY-2792#renewal-state",
				}),
			]),
		);
		const identityKeys = { "Claude:business": businessIdentity };

		await installAccountSubscriptionManual({
			inputPath: firstInput,
			targetPath,
			stateDir,
			identityKeys,
			generatedAt,
		});
		await installAccountSubscriptionManual({
			inputPath: secondInput,
			targetPath,
			stateDir,
			identityKeys,
			generatedAt,
		});

		const installed = readAccountSubscriptionManual({
			path: targetPath,
			stateDir,
			generatedAt,
		});
		expect(installed.data?.confirmations).toHaveLength(2);
		expect(readFileSync(targetPath, "utf8")).not.toContain("undefined");
	});

	it("keeps the installed file byte-identical after rejected input or lock conflict", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "fly2803-subscription-"));
		const targetPath = join(stateDir, "account-subscriptions", "manual.json");
		const inputPath = join(stateDir, "input.json");
		const identityKeys = { "Claude:business": businessIdentity };
		write(inputPath, payload());
		await installAccountSubscriptionManual({
			inputPath,
			targetPath,
			stateDir,
			identityKeys,
			generatedAt,
		});
		const before = readFileSync(targetPath);

		write(
			inputPath,
			payload([confirmation({ confirmedAt: "2026-09-23T21:00:00.000Z" })]),
		);
		await expect(
			installAccountSubscriptionManual({
				inputPath,
				targetPath,
				stateDir,
				identityKeys,
				generatedAt,
			}),
		).rejects.toThrow("future_confirmation");
		expect(readFileSync(targetPath)).toEqual(before);

		write(inputPath, payload());
		await withMkdirLock(`${targetPath}.lock`, async () => {
			await expect(
				installAccountSubscriptionManual({
					inputPath,
					targetPath,
					stateDir,
					identityKeys,
					generatedAt,
					lockTimeoutMs: 5,
				}),
			).rejects.toThrow("timeout acquiring");
		});
		expect(readFileSync(targetPath)).toEqual(before);
	});
});

function readFrom(value: unknown) {
	const stateDir = mkdtempSync(join(tmpdir(), "fly2803-subscription-read-"));
	const directory = join(stateDir, "account-subscriptions");
	mkdirSync(directory, { mode: 0o700 });
	const path = join(directory, "manual.json");
	write(path, value);
	return readAccountSubscriptionManual({ path, stateDir, generatedAt });
}
