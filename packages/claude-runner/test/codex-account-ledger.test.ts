import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexAuthIdentity } from "../src/codex-account-identity.js";
import {
	fingerprintCodexHome,
	readCodexAccountSnapshot,
	recordCodexAccountObservation,
	resolveCodexAccountLedgerRoot,
} from "../src/codex-account-ledger.js";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "fly2003-ledger-"));
	roots.push(root);
	return root;
}

function identity(
	profile: CodexAuthIdentity["profile"] = "personal",
): CodexAuthIdentity {
	const identities = {
		school: {
			profile: "school",
			email: "xiaorongli2011@u.northwestern.edu",
			accountId: "acct-school",
			plan: "pro",
			mode: "manual_backup",
		},
		personal: {
			profile: "personal",
			email: "xrliannie@gmail.com",
			accountId: "acct-personal",
			plan: "pro",
			mode: "primary",
		},
		business: {
			profile: "business",
			email: "xrliannie.b@gmail.com",
			accountId: "acct-business",
			plan: "prolite",
			mode: "manual_backup",
		},
	} as const;
	return identities[profile];
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

describe("Codex account ledger", () => {
	it("uses FLYWHEEL_STATE_DIR when present and otherwise HOME/.flywheel", () => {
		expect(
			resolveCodexAccountLedgerRoot({
				FLYWHEEL_STATE_DIR: "/tmp/flywheel-qa-529",
				HOME: "/tmp/founder-home",
			}),
		).toBe("/tmp/flywheel-qa-529/codex-account-ledger");
		expect(resolveCodexAccountLedgerRoot({ HOME: "/tmp/founder-home" })).toBe(
			"/tmp/founder-home/.flywheel/codex-account-ledger",
		);
	});

	it("writes only the approved token-free fields with a home fingerprint", () => {
		const root = tempRoot();
		const ledgerRoot = join(root, "ledger");
		const home = join(root, "execution-secret-id", "..", "runner-home");
		mkdirSync(resolve(home), { recursive: true });
		const snapshot = recordCodexAccountObservation({
			identity: identity("personal"),
			home,
			source: "status",
			ledgerRoot,
			observedAt: new Date("2026-08-24T18:00:00.000Z"),
		});
		const path = join(ledgerRoot, "personal.json");
		const text = readFileSync(path, "utf8");

		expect(Object.keys(snapshot)).toEqual([
			"version",
			"profile",
			"email",
			"accountId",
			"plan",
			"lastObservedAt",
			"lastSource",
			"lastHomeFingerprint",
			"mode",
		]);
		expect(snapshot).toEqual({
			version: 1,
			profile: "personal",
			email: "xrliannie@gmail.com",
			accountId: "acct-personal",
			plan: "pro",
			lastObservedAt: "2026-08-24T18:00:00.000Z",
			lastSource: "status",
			lastHomeFingerprint: fingerprintCodexHome(home),
			mode: "primary",
		});
		expect(text).not.toContain(resolve(home));
		expect(text).not.toContain("execution-secret-id");
		expect(text).not.toContain("token");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readdirSync(ledgerRoot)).toEqual(["personal.json"]);
	});

	it("isolates state roots and profile snapshots", () => {
		const root = tempRoot();
		const productionRoot = join(root, "production", "ledger");
		const qaRoot = join(root, "qa-529", "ledger");
		const home = join(root, "home");
		mkdirSync(home);

		recordCodexAccountObservation({
			identity: identity("personal"),
			home,
			source: "use",
			ledgerRoot: productionRoot,
		});
		recordCodexAccountObservation({
			identity: identity("school"),
			home,
			source: "save",
			ledgerRoot: qaRoot,
		});

		expect(
			readCodexAccountSnapshot("personal", { ledgerRoot: productionRoot }),
		).toMatchObject({ profile: "personal", lastSource: "use" });
		expect(
			readCodexAccountSnapshot("school", { ledgerRoot: productionRoot }),
		).toBeNull();
		expect(
			readCodexAccountSnapshot("school", { ledgerRoot: qaRoot }),
		).toMatchObject({
			profile: "school",
			lastSource: "save",
		});
	});

	it("last-writer-wins with complete JSON and no leftover temp files", () => {
		const root = tempRoot();
		const ledgerRoot = join(root, "ledger");
		const home = join(root, "home");
		mkdirSync(home);
		for (const source of ["status", "use", "save", "provision"] as const) {
			recordCodexAccountObservation({
				identity: identity("business"),
				home,
				source,
				ledgerRoot,
			});
		}
		expect(
			JSON.parse(readFileSync(join(ledgerRoot, "business.json"), "utf8")),
		).toMatchObject({ profile: "business", lastSource: "provision" });
		expect(readdirSync(ledgerRoot)).toEqual(["business.json"]);
	});

	it("rejects mismatched or unsafe snapshots without overwriting truth", () => {
		const root = tempRoot();
		const ledgerRoot = join(root, "ledger");
		const home = join(root, "home");
		mkdirSync(home);
		recordCodexAccountObservation({
			identity: identity("personal"),
			home,
			source: "status",
			ledgerRoot,
		});
		const path = join(ledgerRoot, "personal.json");
		const before = readFileSync(path);

		expect(() =>
			recordCodexAccountObservation({
				identity: { ...identity("personal"), email: "xrliannie.1@gmail.com" },
				home,
				source: "use",
				ledgerRoot,
			}),
		).toThrow(/identity mismatch/i);
		expect(readFileSync(path)).toEqual(before);

		const unsafeRoot = join(root, "unsafe-ledger");
		mkdirSync(join(root, "real-ledger"));
		symlinkSync(join(root, "real-ledger"), unsafeRoot);
		expect(() =>
			recordCodexAccountObservation({
				identity: identity("business"),
				home,
				source: "use",
				ledgerRoot: unsafeRoot,
			}),
		).toThrow(/symlink/i);
		expect(readdirSync(join(root, "real-ledger"))).toEqual([]);
	});

	it("refuses malformed persisted snapshots instead of treating them as truth", () => {
		const root = tempRoot();
		const ledgerRoot = join(root, "ledger");
		mkdirSync(ledgerRoot);
		writeFileSync(join(ledgerRoot, "school.json"), '{"profile":"business"}');

		expect(() => readCodexAccountSnapshot("school", { ledgerRoot })).toThrow(
			/invalid/i,
		);
	});

	it("refuses to replace a dangling canonical snapshot symlink", () => {
		const root = tempRoot();
		const ledgerRoot = join(root, "ledger");
		const home = join(root, "home");
		mkdirSync(ledgerRoot);
		mkdirSync(home);
		const snapshotPath = join(ledgerRoot, "personal.json");
		symlinkSync(join(root, "missing-snapshot"), snapshotPath);

		expect(() =>
			recordCodexAccountObservation({
				identity: identity("personal"),
				home,
				source: "status",
				ledgerRoot,
			}),
		).toThrow(/symlink/i);
		expect(lstatSync(snapshotPath).isSymbolicLink()).toBe(true);
	});
});
