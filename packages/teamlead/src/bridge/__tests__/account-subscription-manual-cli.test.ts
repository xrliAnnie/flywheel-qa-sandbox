import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAccountSubscriptionManual } from "../account-subscription-manual.js";
import { runAccountSubscriptionManualCli } from "../account-subscription-manual-cli.js";

const identityKey = "a".repeat(64);
const now = new Date("2026-09-23T20:00:00.000Z");

function validInput() {
	return {
		version: 1,
		confirmations: [
			{
				provider: "Claude",
				profile: "business",
				identityKey,
				status: "canceled",
				expiresOn: "2026-10-14",
				confirmedBy: "founder",
				confirmedAt: "2026-09-23T18:00:00.000Z",
				sourceRef: "FLY-2792#founder-confirmation",
			},
		],
	};
}

function fixture() {
	const stateDir = mkdtempSync(join(tmpdir(), "fly2803-subscription-cli-"));
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		stateDir,
		stdout,
		stderr,
		deps: {
			env: { FLYWHEEL_STATE_DIR: stateDir },
			home: "/unused-home",
			now: () => now,
			readIdentities: () => [
				{
					provider: "Claude" as const,
					profile: "business",
					identityKey,
				},
				{
					provider: "Codex" as const,
					profile: "personal2",
					identityKey: "b".repeat(64),
				},
			],
			stdout: (line: string) => stdout.push(line),
			stderr: (line: string) => stderr.push(line),
		},
	};
}

describe("FLY-2803 subscription confirmation CLI", () => {
	it("prints only provider, profile, presence, and non-secret identity digests", async () => {
		const f = fixture();
		const code = await runAccountSubscriptionManualCli(["identities"], f.deps);

		expect(code).toBe(0);
		expect(f.stderr).toEqual([]);
		expect(f.stdout).toEqual([
			JSON.stringify({
				provider: "Claude",
				profile: "business",
				hasIdentity: true,
				identityKey,
			}),
			JSON.stringify({
				provider: "Codex",
				profile: "personal2",
				hasIdentity: true,
				identityKey: "b".repeat(64),
			}),
		]);
		expect(f.stdout.join("\n")).not.toContain("@");
	});

	it("validates applicable input without writing the installed file", async () => {
		const f = fixture();
		const input = join(f.stateDir, "input.json");
		writeFileSync(input, JSON.stringify(validInput()), { mode: 0o600 });

		const code = await runAccountSubscriptionManualCli(
			["validate", "--input", input],
			f.deps,
		);

		expect(code).toBe(0);
		expect(f.stdout).toEqual([JSON.stringify({ ok: true, confirmations: 1 })]);
		expect(
			readAccountSubscriptionManual({
				path: join(f.stateDir, "account-subscriptions", "manual.json"),
				stateDir: f.stateDir,
				generatedAt: now.toISOString(),
			}).error,
		).toBe("missing_file");
	});

	it("installs through the fixed state target and reads it back", async () => {
		const f = fixture();
		const input = join(f.stateDir, "input.json");
		writeFileSync(input, JSON.stringify(validInput()), { mode: 0o600 });

		const code = await runAccountSubscriptionManualCli(
			["install", "--input", input],
			f.deps,
		);

		expect(code).toBe(0);
		expect(f.stdout).toEqual([
			JSON.stringify({ ok: true, installed: 1, total: 1 }),
		]);
		const installed = readAccountSubscriptionManual({
			path: join(f.stateDir, "account-subscriptions", "manual.json"),
			stateDir: f.stateDir,
			generatedAt: now.toISOString(),
		});
		expect(installed.data?.confirmations[0]).toMatchObject({
			profile: "business",
			status: "canceled",
			expiresOn: "2026-10-14",
		});
	});

	it("returns nonzero with a safe code for malformed, mismatched, or unknown commands", async () => {
		const malformed = fixture();
		const malformedInput = join(malformed.stateDir, "bad.json");
		writeFileSync(malformedInput, "{}", { mode: 0o600 });
		expect(
			await runAccountSubscriptionManualCli(
				["validate", "--input", malformedInput],
				malformed.deps,
			),
		).toBe(2);
		expect(malformed.stderr).toEqual([
			JSON.stringify({ ok: false, error: "invalid_schema" }),
		]);

		const mismatch = fixture();
		const mismatchInput = join(mismatch.stateDir, "mismatch.json");
		writeFileSync(
			mismatchInput,
			JSON.stringify({
				...validInput(),
				confirmations: [
					{ ...validInput().confirmations[0], identityKey: "c".repeat(64) },
				],
			}),
			{ mode: 0o600 },
		);
		expect(
			await runAccountSubscriptionManualCli(
				["install", "--input", mismatchInput],
				mismatch.deps,
			),
		).toBe(2);
		expect(mismatch.stderr).toEqual([
			JSON.stringify({ ok: false, error: "identity_mismatch" }),
		]);

		const unknown = fixture();
		expect(
			await runAccountSubscriptionManualCli(["delete"], unknown.deps),
		).toBe(2);
		expect(unknown.stderr).toEqual([
			JSON.stringify({ ok: false, error: "invalid_arguments" }),
		]);
	});

	it("rejects an input path with unsafe permissions", async () => {
		const f = fixture();
		const input = join(f.stateDir, "input.json");
		mkdirSync(join(f.stateDir, "account-subscriptions"), { mode: 0o700 });
		writeFileSync(input, JSON.stringify(validInput()), { mode: 0o666 });
		chmodSync(input, 0o666);

		expect(
			await runAccountSubscriptionManualCli(
				["validate", "--input", input],
				f.deps,
			),
		).toBe(2);
		expect(f.stderr).toEqual([
			JSON.stringify({ ok: false, error: "unsafe_file" }),
		]);
	});
});
