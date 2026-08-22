import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	listPoolAccounts,
	readActiveProfileName,
	readKeychainMonitorCredential,
	readPoolMonitorCredential,
	resolvePoolProfileIdentity,
} from "../account-heal/quota-monitor-credentials.js";

const SECRET = "sk-ant-oat01-do-not-log";
let dir: string;
let poolDir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly1256-creds-"));
	poolDir = join(dir, "pool");
	mkdirSync(poolDir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function credential(accessToken = SECRET): string {
	return JSON.stringify({
		claudeAiOauth: {
			accessToken,
			refreshToken: "never-return",
			expiresAt: 1234,
		},
	});
}

describe("quota monitor credential readers", () => {
	it("reads token metadata plus a non-secret witness digest and never puts the secret in argv", async () => {
		const execFile = vi.fn(async () => ({ stdout: credential(), stderr: "" }));
		const result = await readKeychainMonitorCredential({
			securityBin: "/usr/bin/security",
			account: "annie",
			service: "Claude Code-credentials",
			keychain: "/tmp/scratch.keychain-db",
			execFile,
		});
		expect(result).toEqual({
			accessToken: SECRET,
			expiresAt: 1234,
			rawDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(JSON.stringify(execFile.mock.calls)).not.toContain(SECRET);
		expect(execFile).toHaveBeenCalledWith("/usr/bin/security", [
			"find-generic-password",
			"-a",
			"annie",
			"-s",
			"Claude Code-credentials",
			"-w",
			"/tmp/scratch.keychain-db",
		]);
	});

	it("returns null for missing/malformed Keychain material without returning parser details", async () => {
		for (const stdout of ["not-json", "{}", credential("")]) {
			const result = await readKeychainMonitorCredential({
				execFile: async () => ({ stdout, stderr: SECRET }),
			});
			expect(result).toBeNull();
		}
		expect(
			await readKeychainMonitorCredential({
				execFile: async () => {
					throw new Error(SECRET);
				},
			}),
		).toBeNull();
	});

	it("reads a regular pooled credential but refuses symlinked credential files", () => {
		const school = join(poolDir, "school");
		mkdirSync(school);
		writeFileSync(
			join(school, ".credentials.json"),
			credential("school-token"),
			{
				mode: 0o600,
			},
		);
		expect(readPoolMonitorCredential(poolDir, "school")).toEqual({
			accessToken: "school-token",
			expiresAt: 1234,
		});

		const business = join(poolDir, "business");
		mkdirSync(business);
		symlinkSync(
			join(school, ".credentials.json"),
			join(business, ".credentials.json"),
		);
		expect(readPoolMonitorCredential(poolDir, "business")).toBeNull();
	});

	it("reads .active only as a regular valid profile-name file", () => {
		const active = join(poolDir, ".active");
		writeFileSync(active, "shopping\n", { mode: 0o600 });
		expect(readActiveProfileName(poolDir)).toBe("shopping");
		writeFileSync(active, "../escape\n", { mode: 0o600 });
		expect(readActiveProfileName(poolDir)).toBeNull();
		rmSync(active);
		const target = join(dir, "outside-active");
		writeFileSync(target, "school\n");
		symlinkSync(target, active);
		expect(readActiveProfileName(poolDir)).toBeNull();
	});

	it("lists only valid, real account directories", () => {
		mkdirSync(join(poolDir, "shopping"));
		mkdirSync(join(poolDir, "school"));
		mkdirSync(join(poolDir, ".hidden"));
		mkdirSync(join(poolDir, "bad..name"));
		const outside = join(dir, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(poolDir, "business"));
		expect(listPoolAccounts(poolDir)).toEqual(["school", "shopping"]);
	});

	it("resolves a probed oauth/profile identity through one strict pool anchor", () => {
		for (const [name, uuid, email] of [
			["shopping", "uuid-shopping", "shopping@example.com"],
			["school", "uuid-school", "school@example.com"],
		] as const) {
			mkdirSync(join(poolDir, name));
			writeFileSync(
				join(poolDir, name, "identity-anchor.json"),
				JSON.stringify({
					accountUuid: uuid,
					email,
					anchoredAt: "2026-08-21T00:00:00.000Z",
					anchoredBy: "test",
					confirmedBy: "test",
				}),
				{ mode: 0o600 },
			);
		}

		expect(
			resolvePoolProfileIdentity(poolDir, {
				email: "school@example.com",
				uuid: "uuid-school",
			}),
		).toBe("school");
	});

	it("returns null for duplicate, malformed, or symlinked identity anchors", () => {
		for (const name of ["school", "shopping"]) {
			mkdirSync(join(poolDir, name));
			writeFileSync(
				join(poolDir, name, "identity-anchor.json"),
				JSON.stringify({
					accountUuid: "uuid-shared",
					email: "shared@example.com",
					anchoredAt: "2026-08-21T00:00:00.000Z",
					anchoredBy: "test",
					confirmedBy: "test",
				}),
				{ mode: 0o600 },
			);
		}
		expect(
			resolvePoolProfileIdentity(poolDir, {
				email: "shared@example.com",
				uuid: "uuid-shared",
			}),
		).toBeNull();

		writeFileSync(join(poolDir, "shopping", "identity-anchor.json"), "{}", {
			mode: 0o600,
		});
		rmSync(join(poolDir, "school", "identity-anchor.json"));
		const outside = join(dir, "outside-anchor.json");
		writeFileSync(outside, "{}", { mode: 0o600 });
		symlinkSync(outside, join(poolDir, "school", "identity-anchor.json"));
		expect(
			resolvePoolProfileIdentity(poolDir, {
				email: "shared@example.com",
				uuid: "uuid-shared",
			}),
		).toBeNull();
	});

	it("rejects anchor fields containing control characters", () => {
		mkdirSync(join(poolDir, "school"));
		writeFileSync(
			join(poolDir, "school", "identity-anchor.json"),
			JSON.stringify({
				accountUuid: "uuid-school\n",
				email: "school@example.com",
				anchoredAt: "2026-08-21T00:00:00.000Z",
				anchoredBy: "test",
				confirmedBy: "test",
			}),
			{ mode: 0o600 },
		);

		expect(
			resolvePoolProfileIdentity(poolDir, {
				email: "school@example.com",
				uuid: "uuid-school",
			}),
		).toBeNull();
	});
});
