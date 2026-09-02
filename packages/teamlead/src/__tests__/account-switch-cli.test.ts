import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CandidateSelectionResult } from "../account-heal/account-candidate-selector.js";
import type { AccountStore } from "../account-heal/account-store.js";
import {
	type AccountSwitchCliDeps,
	loadAlertIdentityEnv,
	parseDotEnvAssignments,
	runAccountSwitchCli,
} from "../account-heal/account-switch-cli.js";

const NOW = Date.parse("2026-09-01T20:00:00.000Z");

function store(): AccountStore {
	return {
		generation: 4,
		activeAccount: "personal1",
		accounts: [{ name: "personal1" }, { name: "school" }, { name: "personal" }],
		pendingSwitchNotifications: [],
	};
}

function selection(
	ranked: string[] = ["personal", "school"],
): CandidateSelectionResult {
	return {
		ranked,
		verifiedAt: new Date(NOW).toISOString(),
		usageByName: new Map(),
		malformedModelBenches: [],
		headroomDegraded: false,
		panorama: ranked.map((name) => ({
			name,
			status: "qualified",
			excludedBy: null,
			resetClass: "dated" as const,
		})),
	};
}

function harness(overrides: Partial<AccountSwitchCliDeps> = {}) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const readSnapshot = vi.fn(async () => ({
		activeName: "personal1",
		store: store(),
		activeCredential: {
			accessToken: "active-secret",
			expiresAt: NOW + 60_000,
		},
		poolAccounts: ["personal1", "school", "personal"],
	}));
	const selectCandidates = vi.fn(async () => selection());
	const switchAccount = vi.fn(async (input) => ({
		outcome: "switched" as const,
		from: input.observedAccount,
		to: input.preferredOrder?.[0] ?? "school",
		generation: input.observedGeneration + 1,
		notification: "delivered" as const,
	}));
	const sendAlert = vi.fn(async () => ({ primary: "sent" as const }));
	const reconcile = vi.fn(async () => true);
	const deps: AccountSwitchCliDeps = {
		now: () => NOW,
		trigger5hPct: 90,
		readSnapshot,
		selectCandidates,
		switchAccount,
		readIdentity: async (name) => ({ email: `${name}@example.com` }),
		sendAlert,
		reconcile,
		stdout: (line) => stdout.push(line),
		stderr: (line) => stderr.push(line),
		...overrides,
	};
	return {
		deps,
		stdout,
		stderr,
		readSnapshot,
		selectCandidates,
		switchAccount,
		sendAlert,
		reconcile,
	};
}

describe("runAccountSwitchCli", () => {
	it("rejects malformed input before reading account state", async () => {
		const h = harness();

		await expect(
			runAccountSwitchCli(["use", "../school"], h.deps),
		).resolves.toBe(2);
		expect(h.readSnapshot).not.toHaveBeenCalled();
		expect(h.switchAccount).not.toHaveBeenCalled();
	});

	it("live-verifies only an explicit use target and sends it through the manual executor", async () => {
		const h = harness({
			selectCandidates: vi.fn(async () => ({
				...selection(["school"]),
				panorama: [
					{
						name: "school",
						status: "qualified",
						excludedBy: null,
						resetClass: "dated",
						bypassed: {
							cooldown: true,
						},
					},
				],
			})),
		});

		expect(await runAccountSwitchCli(["use", "school"], h.deps)).toBe(0);
		expect(h.deps.selectCandidates).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				onlyNames: ["school"],
				cooldownPolicy: "ignore_explicit_target",
				headroomPolicy: { kind: "explicit_target" },
			}),
		);
		expect(h.switchAccount).toHaveBeenCalledWith(
			expect.objectContaining({
				trigger: { kind: "manual", mode: "use" },
				preferredOrder: ["school"],
				manualOverrides: new Map([
					[
						"school",
						{
							ignoreCooldown: true,
						},
					],
				]),
			}),
		);
	});

	it("uses generic selector ranking for next and reports every-dead pools", async () => {
		const h = harness();
		expect(await runAccountSwitchCli(["next"], h.deps)).toBe(0);
		expect(h.selectCandidates).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				cooldownPolicy: "exclude",
				headroomPolicy: {
					kind: "prefer_below_trigger",
					trigger5hPct: 90,
				},
			}),
		);
		expect(h.switchAccount).toHaveBeenCalledWith(
			expect.objectContaining({
				trigger: { kind: "manual", mode: "next" },
				preferredOrder: ["personal", "school"],
			}),
		);

		const dead = harness({
			selectCandidates: vi.fn(async () => ({
				...selection([]),
				panorama: [
					{
						name: "school",
						status: "freshness_stale",
						excludedBy: "unverifiable",
					},
					{
						name: "personal",
						status: "quota_exhausted",
						excludedBy: "quota",
					},
				],
			})),
		});
		expect(await runAccountSwitchCli(["next"], dead.deps)).toBe(32);
		expect(dead.switchAccount).not.toHaveBeenCalled();
		expect(dead.sendAlert).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "quota_no_target",
				body: expect.stringMatching(
					/personal:quota_exhausted.*school:freshness_stale/s,
				),
			}),
		);
	});

	it("reconciles one active-marker drift then reruns a fresh selection exactly once", async () => {
		const h = harness();
		h.switchAccount
			.mockResolvedValueOnce({
				outcome: "failed",
				reason: "stale marker",
				reasonCode: "active_marker_drift",
			})
			.mockResolvedValueOnce({
				outcome: "switched",
				from: "personal1",
				to: "school",
				generation: 5,
				notification: "pending",
			});

		expect(await runAccountSwitchCli(["use", "school"], h.deps)).toBe(0);
		expect(h.reconcile).toHaveBeenCalledTimes(1);
		expect(h.readSnapshot).toHaveBeenCalledTimes(2);
		expect(h.selectCandidates).toHaveBeenCalledTimes(2);
		expect(h.stderr.join("\n")).toContain(
			"FLYWHEEL_SWITCH_NOTIFICATION_PENDING",
		);
	});

	it("never loops when marker drift repeats after reconcile", async () => {
		const h = harness({
			switchAccount: vi.fn(async () => ({
				outcome: "failed" as const,
				reason: "stale marker",
				reasonCode: "active_marker_drift" as const,
			})),
		});

		expect(await runAccountSwitchCli(["next"], h.deps)).toBe(1);
		expect(h.deps.reconcile).toHaveBeenCalledTimes(1);
		expect(h.deps.switchAccount).toHaveBeenCalledTimes(2);
		expect(h.stderr).toContain("FLYWHEEL_MANUAL_RECONCILE_RACE");
	});

	it("surfaces and audits apply failure details", async () => {
		const auditFailure = vi.fn();
		const h = harness({
			switchAccount: vi.fn(async () => ({
				outcome: "failed" as const,
				reasonCode: "apply_failed" as const,
				reason: "spawn flywheel-claude-profile ENOENT",
			})),
		});
		Object.assign(h.deps, { auditFailure });

		expect(await runAccountSwitchCli(["use", "school"], h.deps)).toBe(1);
		expect(h.stderr).toContain(
			"FLYWHEEL_MANUAL_SWITCH_FAILED reason=apply_failed details=spawn flywheel-claude-profile ENOENT",
		);
		expect(auditFailure).toHaveBeenCalledWith({
			command: "use",
			profile: "school",
			reasonCode: "apply_failed",
			reason: "spawn flywheel-claude-profile ENOENT",
		});
	});

	it("does not append a fallback audit after the apply child started", async () => {
		const auditFailure = vi.fn();
		const h = harness({
			switchAccount: vi.fn(async () => ({
				outcome: "failed" as const,
				reasonCode: "apply_failed" as const,
				reason: "synthetic keychain writer rejected apply",
				applyProfileChildStarted: true,
			})),
		});
		Object.assign(h.deps, { auditFailure });

		expect(await runAccountSwitchCli(["use", "school"], h.deps)).toBe(1);
		expect(auditFailure).not.toHaveBeenCalled();
		expect(h.stderr).toContain(
			"FLYWHEEL_MANUAL_SWITCH_FAILED reason=apply_failed details=synthetic keychain writer rejected apply",
		);
	});

	it("keeps apply failure details when the audit sink fails", async () => {
		const h = harness({
			switchAccount: vi.fn(async () => ({
				outcome: "failed" as const,
				reasonCode: "apply_failed" as const,
				reason: "synthetic keychain writer rejected apply",
			})),
		});
		Object.assign(h.deps, {
			auditFailure: vi.fn(async () => {
				throw new Error("audit unavailable");
			}),
		});

		expect(await runAccountSwitchCli(["next"], h.deps)).toBe(1);
		expect(h.stderr).toContain("FLYWHEEL_MANUAL_SWITCH_AUDIT_FAILED");
		expect(h.stderr).toContain(
			"FLYWHEEL_MANUAL_SWITCH_FAILED reason=apply_failed details=synthetic keychain writer rejected apply",
		);
	});

	it("returns an already-active no-op without selector or alert side effects", async () => {
		const h = harness();

		expect(await runAccountSwitchCli(["use", "personal1"], h.deps)).toBe(0);
		expect(h.selectCandidates).not.toHaveBeenCalled();
		expect(h.switchAccount).not.toHaveBeenCalled();
		expect(h.stderr).toEqual([]);
		expect(h.sendAlert).not.toHaveBeenCalled();
	});
});

describe("parseDotEnvAssignments", () => {
	it("parses plain and quoted assignments without executing shell syntax", () => {
		expect(
			parseDotEnvAssignments(
				"PLAIN=value\nSINGLE='space value'\nDOUBLE=\"line\\nvalue\"\n",
			),
		).toEqual({
			PLAIN: "value",
			SINGLE: "space value",
			DOUBLE: "line\nvalue",
		});
	});

	it.each([
		"A=one\nA=two\n",
		"A=$(touch nope)\n",
		"A=$HOME\n",
		"A=`touch nope`\n",
		"A='unterminated\n",
	])("rejects duplicate, expandable, or malformed input", (raw) => {
		expect(() => parseDotEnvAssignments(raw)).toThrow();
	});

	it("loads allowlisted alert identity despite duplicate unrelated dotenv keys", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2240-dotenv-"));
		const envPath = join(dir, ".env");
		try {
			writeFileSync(
				envPath,
				"UNRELATED=old\nUNRELATED=new\nFLYWHEEL_NOTIFY_CHANNEL=ops\n",
			);
			const loaded = loadAlertIdentityEnv({ baseEnv: {}, envPath });
			expect(loaded.FLYWHEEL_NOTIFY_CHANNEL).toBe("ops");
			expect(loaded.UNRELATED).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads allowlisted alert identity from the production shell dotenv shape", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2240-shell-dotenv-"));
		const envPath = join(dir, ".env");
		try {
			writeFileSync(
				envPath,
				[
					"set -a",
					"export OPENAI_API_KEY='unrelated-secret'",
					"export FLYWHEEL_NOTIFY_CHANNEL=ops",
					"set +a",
					"",
				].join("\n"),
			);

			const loaded = loadAlertIdentityEnv({ baseEnv: {}, envPath });

			expect(loaded.FLYWHEEL_NOTIFY_CHANNEL).toBe("ops");
			expect(loaded.OPENAI_API_KEY).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([
		["shell expansion", "FLYWHEEL_CLAIMS_DB=$HOME/.flywheel/claims.db"],
		["unterminated quote", "FLYWHEEL_CLAIMS_DB='unterminated"],
		[
			"duplicate assignment",
			"FLYWHEEL_CLAIMS_DB=/first\nFLYWHEEL_CLAIMS_DB=/second",
		],
	])(
		"skips a malformed allowlisted alert value (%s) without blocking valid routing",
		(_case, malformed) => {
			const dir = mkdtempSync(join(tmpdir(), "fly2240-malformed-dotenv-"));
			const envPath = join(dir, ".env");
			try {
				writeFileSync(
					envPath,
					[malformed, "FLYWHEEL_NOTIFY_CHANNEL=ops", ""].join("\n"),
				);

				const loaded = loadAlertIdentityEnv({ baseEnv: {}, envPath });

				expect(loaded.FLYWHEEL_CLAIMS_DB).toBeUndefined();
				expect(loaded.FLYWHEEL_NOTIFY_CHANNEL).toBe("ops");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
