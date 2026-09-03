import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	computeModelReviveExpiresAt,
	emptyQuotaMonitorState,
	loadQuotaMonitorState,
	type QuotaMonitorState,
	updateUnknownPaneObservations,
	writeQuotaMonitorState,
} from "../account-heal/quota-monitor-state.js";

let dir: string;
let path: string;
const NOW = Date.parse("2026-07-14T20:00:00Z");

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly1256-state-"));
	path = join(dir, "quota-monitor-state.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function populatedState(): QuotaMonitorState {
	return {
		...emptyQuotaMonitorState(7),
		lastPollAt: NOW - 1_000,
		lastSuccessfulUsageAt: NOW - 2_000,
		errorStreak: 2,
		backoffUntilMs: NOW + 300_000,
		tier: "accelerated",
		lastCandidateSweepAt: NOW - 60_000,
		lastSwitchAt: NOW - 120_000,
		reviveEpoch: {
			open: true,
			sourceAccount: "shopping",
			generation: 7,
			openedAt: NOW - 120_000,
			expiresAt: NOW + 3_600_000,
			panes: {
				"fleet:%12:4321": { attempts: 2, lastAttemptAt: NOW - 30_000 },
			},
		},
		blockedEpisode: {
			scope: "5h",
			startedAt: "2026-07-14T19:00:00.000Z",
			lastConfirmedAlertAt: null,
			alertCount: 0,
			blockedRound: 1,
			recoveryRound: 0,
			activeDelivery: {
				kind: "blocked",
				round: 1,
				attempts: 2,
				lastAttemptAt: "2026-07-14T19:30:00.000Z",
			},
		},
		pendingSwitchFailure: {
			reasonCode: "lock_lease_lost",
			degraded: true,
			applyExitCode: 48,
			childStarted: true,
			detail: "FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH",
			startedAt: "2026-07-14T19:10:00.000Z",
			lastConfirmedAlertAt: null,
			alertCount: 0,
			activeDelivery: {
				round: 0,
				attempts: 1,
				lastAttemptAt: "2026-07-14T19:40:00.000Z",
			},
		},
		identityMismatchEpisodes: {
			school: {
				checkpoint: "active",
				expectedKey: "b".repeat(64),
				actualDigest: "a".repeat(64),
				startedAt: "2026-07-14T19:20:00.000Z",
				lastConfirmedAlertAt: null,
				alertCount: 0,
				round: 1,
				activeDelivery: {
					round: 1,
					attempts: 1,
					lastAttemptAt: "2026-07-14T19:50:00.000Z",
				},
			},
		},
		identityAlertCursor: "school",
	};
}

describe("quota monitor persistent state", () => {
	it("missing state starts clean when the account store is also new", () => {
		expect(
			loadQuotaMonitorState(path, { nowMs: NOW, storeGeneration: 0 }),
		).toEqual({
			state: emptyQuotaMonitorState(0),
			recovery: "missing",
		});
		expect(existsSync(path)).toBe(false);
	});

	it("atomically round-trips versioned state as 0600 with no token-shaped schema", () => {
		const state = populatedState();
		writeQuotaMonitorState(state, path);

		expect(
			loadQuotaMonitorState(path, { nowMs: NOW, storeGeneration: 7 }),
		).toEqual({
			state,
		});
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir)).toEqual(["quota-monitor-state.json"]);
		expect(readFileSync(path, "utf8").toLowerCase()).not.toContain("token");
	});

	it("accepts null or absent switch-child evidence without changing the state version", () => {
		const state = populatedState();
		if (state.pendingSwitchFailure === null) throw new Error("missing fixture");
		state.pendingSwitchFailure.applyExitCode = null;
		state.pendingSwitchFailure.childStarted = null;
		delete state.pendingSwitchFailure.detail;
		writeQuotaMonitorState(state, path);

		const loaded = loadQuotaMonitorState(path, {
			nowMs: NOW,
			storeGeneration: 7,
		}).state;
		expect(loaded.version).toBe(2);
		expect(loaded.pendingSwitchFailure).toMatchObject({
			applyExitCode: null,
			childStarted: null,
		});
		expect(loaded.pendingSwitchFailure?.detail).toBeUndefined();
	});

	it.each([
		["oversized detail", "x".repeat(601)],
		["control characters", "marker\nforged"],
		["invalid unicode", "\ud800"],
	] as const)("rejects switch evidence with %s", (_label, detail) => {
		const state = populatedState();
		if (state.pendingSwitchFailure === null) throw new Error("missing fixture");
		state.pendingSwitchFailure.detail = detail;
		writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });

		const loaded = loadQuotaMonitorState(path, {
			nowMs: NOW,
			storeGeneration: 7,
		});
		expect(loaded.recovery).toBe("corrupt");
		expect(loaded.state.pendingSwitchFailure).toBeNull();
	});

	it("round-trips the v2 detection, outbox, confirmation, and bounded unknown ledger", () => {
		const state = populatedState();
		state.pendingDetection = {
			eventId: "model-cap-g7-0123456789abcdef",
			observedGeneration: 7,
			observedAt: NOW,
			sourceAccount: "shopping",
			models: ["Fable 5"],
			affectedPanes: [
				{
					socket: "flywheel",
					paneId: "%12",
					panePid: 4_321,
					sessionName: "flywheel",
					windowName: "FLY-1182-claude-runner",
				},
			],
		};
		state.alertOutbox = [
			{
				eventId: "model-cap-g7-0123456789abcdef:switch",
				generation: 8,
				createdAt: NOW + 1,
				alert: {
					kind: "model_cap_switched",
					severity: "info",
					title: "Claude model-cap account switched",
					body: "shopping->school",
					signature: "model-cap-switch-8",
				},
			},
		];
		state.confirmation = {
			eventId: "model-cap-g7-0123456789abcdef:confirm",
			generation: 8,
			dueAt: NOW + 7 * 60_000,
			sourceAccount: "shopping",
			targetAccount: "school",
			models: ["Fable 5"],
			affectedPanes: state.pendingDetection.affectedPanes,
		};
		state.unknownPanes = {
			"flywheel:%12:4321": { count: 2, lastSeenAt: NOW },
		};
		state.modelPaneSuppressions = {
			"flywheel:%12:4321": { models: ["Fable 5"], lastSeenAt: NOW },
		};

		writeQuotaMonitorState(state, path);
		expect(
			loadQuotaMonitorState(path, { nowMs: NOW, storeGeneration: 7 }),
		).toEqual({ state });
	});

	it("explicitly migrates a legacy v1 file, defaults new ledgers, and then round-trips as v2", () => {
		const scheduled = {
			...populatedState(),
			nextUsageDueAt: NOW + 300_000,
			nextPaneScanDueAt: NOW + 60_000,
			confirmDueAt: NOW + 420_000,
		};
		writeQuotaMonitorState(scheduled, path);
		expect(
			loadQuotaMonitorState(path, { nowMs: NOW, storeGeneration: 7 }).state,
		).toMatchObject({
			nextUsageDueAt: NOW + 300_000,
			nextPaneScanDueAt: NOW + 60_000,
			confirmDueAt: NOW + 420_000,
		});

		const {
			pendingDetection: _pendingDetection,
			alertOutbox: _alertOutbox,
			confirmation: _confirmation,
			unknownPanes: _unknownPanes,
			modelPaneSuppressions: _modelPaneSuppressions,
			nextUsageDueAt: _nextUsageDueAt,
			nextPaneScanDueAt: _nextPaneScanDueAt,
			confirmDueAt: _confirmDueAt,
			version: _version,
			...legacy
		} = populatedState();
		writeFileSync(path, JSON.stringify({ ...legacy, version: 1 }), {
			mode: 0o600,
		});
		const migrated = loadQuotaMonitorState(path, {
			nowMs: NOW,
			storeGeneration: 7,
		});
		expect(migrated).toMatchObject({
			recovery: "migrated_v1",
			state: {
				version: 2,
				nextUsageDueAt: 0,
				nextPaneScanDueAt: 0,
				confirmDueAt: null,
				pendingDetection: null,
				alertOutbox: [],
				confirmation: null,
				unknownPanes: {},
				modelPaneSuppressions: {},
			},
		});
		writeQuotaMonitorState(migrated.state, path);
		expect(
			loadQuotaMonitorState(path, { nowMs: NOW, storeGeneration: 7 }),
		).toEqual({ state: migrated.state });
	});

	it("ignores an interrupted pre-rename temp file and preserves the last committed state", () => {
		const committed = populatedState();
		writeQuotaMonitorState(committed, path);
		writeFileSync(`${path}.tmp.crashed`, '{"version":2', { mode: 0o600 });

		expect(
			loadQuotaMonitorState(path, { nowMs: NOW, storeGeneration: 7 }),
		).toEqual({ state: committed });
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("bounds persistent unknown streaks by pane instance and clears discontinuous observations", () => {
		const previous = {
			"flywheel:%1:4001": { count: 2, lastSeenAt: NOW - 60_000 },
			"flywheel:%2:4002": { count: 2, lastSeenAt: NOW - 60_000 },
		};
		const observed = [
			"flywheel:%1:4001",
			...Array.from(
				{ length: 80 },
				(_, index) => `flywheel:%${index + 10}:${index + 5_000}`,
			),
		];

		const next = updateUnknownPaneObservations(previous, observed, NOW);
		expect(Object.keys(next)).toHaveLength(64);
		expect(next["flywheel:%1:4001"]).toEqual({ count: 3, lastSeenAt: NOW });
		expect(next["flywheel:%2:4002"]).toBeUndefined();
		expect(updateUnknownPaneObservations(next, [], NOW + 60_000)).toEqual({});
	});

	it("round-trips a model revive authorization with the exact max-bench plus grace expiry", () => {
		const benchUntilByModel = {
			"Fable 5": new Date(NOW + 30 * 60_000).toISOString(),
			"Sonnet 5": new Date(NOW + 60 * 60_000).toISOString(),
		};
		const expiresAt = computeModelReviveExpiresAt(benchUntilByModel, NOW);
		expect(expiresAt).toBe(NOW + 90 * 60_000);
		const state = populatedState();
		state.reviveEpoch = {
			open: true,
			sourceAccount: "shopping",
			generation: 7,
			openedAt: NOW,
			expiresAt: expiresAt as number,
			trigger: { kind: "model", models: ["Fable 5", "Sonnet 5"] },
			panes: {},
		};
		writeQuotaMonitorState(state, path);
		expect(
			loadQuotaMonitorState(path, { nowMs: NOW, storeGeneration: 7 }),
		).toEqual({ state });
	});

	it("refuses an empty, malformed, or unbounded model revive deadline", () => {
		expect(computeModelReviveExpiresAt({}, NOW)).toBeNull();
		expect(
			computeModelReviveExpiresAt({ "Fable 5": "not-a-date" }, NOW),
		).toBeNull();
		expect(
			computeModelReviveExpiresAt(
				{ "Fable 5": new Date(NOW - 60 * 60_000).toISOString() },
				NOW,
			),
		).toBeNull();
	});

	it("loads legacy state without episode fields as empty episodes", () => {
		const legacy = populatedState() as QuotaMonitorState &
			Record<string, unknown>;
		delete legacy.blockedEpisode;
		delete legacy.pendingSwitchFailure;
		delete legacy.identityMismatchEpisodes;
		delete legacy.identityAlertCursor;
		writeFileSync(path, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

		const loaded = loadQuotaMonitorState(path, {
			nowMs: NOW,
			storeGeneration: 7,
		});

		expect(loaded.recovery).toBeUndefined();
		expect(loaded.state.blockedEpisode).toBeNull();
		expect(loaded.state.pendingSwitchFailure).toBeNull();
		expect(loaded.state.identityMismatchEpisodes).toBeNull();
		expect(loaded.state.identityAlertCursor).toBeNull();
	});

	it.each([
		[
			"blocked delivery round",
			() => {
				const state = populatedState();
				if (state.blockedEpisode?.activeDelivery) {
					state.blockedEpisode.activeDelivery.round = 2;
				}
				return state;
			},
		],
		[
			"switch-failure delivery round",
			() => {
				const state = populatedState();
				if (state.pendingSwitchFailure?.activeDelivery) {
					state.pendingSwitchFailure.activeDelivery.round = 1;
				}
				return state;
			},
		],
	] as const)("rejects a mismatched %s conservatively", (_label, makeState) => {
		writeFileSync(path, `${JSON.stringify(makeState())}\n`, { mode: 0o600 });

		const loaded = loadQuotaMonitorState(path, {
			nowMs: NOW,
			storeGeneration: 7,
		});

		expect(loaded.recovery).toBe("corrupt");
		expect(loaded.state.blockedEpisode).toBeNull();
		expect(loaded.state.pendingSwitchFailure).toBeNull();
	});

	it.each([
		"not json",
		JSON.stringify({ version: 1 }),
		JSON.stringify({
			...populatedState(),
			accessToken: "must-never-be-accepted",
		}),
	])(
		"corrupt or non-contract state resets conservatively and closes revive authorization",
		(raw) => {
			writeFileSync(path, raw, { mode: 0o600 });
			const loaded = loadQuotaMonitorState(path, {
				nowMs: NOW,
				storeGeneration: 9,
			});
			expect(loaded).toEqual({
				state: {
					...emptyQuotaMonitorState(9),
					lastSwitchAt: NOW,
				},
				recovery: "corrupt",
			});
		},
	);

	it("a store generation advanced while the daemon was down starts a new cooldown and discards the old epoch", () => {
		writeQuotaMonitorState(populatedState(), path);
		const loaded = loadQuotaMonitorState(path, {
			nowMs: NOW,
			storeGeneration: 8,
		});
		expect(loaded.recovery).toBe("generation_advanced");
		expect(loaded.state).toMatchObject({
			observedGeneration: 8,
			lastSwitchAt: NOW,
			reviveEpoch: null,
			blockedEpisode: null,
			pendingSwitchFailure: null,
			identityMismatchEpisodes: null,
			identityAlertCursor: null,
		});
		expect(loaded.state.backoffUntilMs).toBe(NOW + 300_000);
	});

	it("a state generation ahead of the account store is treated as corruption", () => {
		writeQuotaMonitorState(populatedState(), path);
		const loaded = loadQuotaMonitorState(path, {
			nowMs: NOW,
			storeGeneration: 6,
		});
		expect(loaded.recovery).toBe("corrupt");
		expect(loaded.state.observedGeneration).toBe(6);
		expect(loaded.state.lastSwitchAt).toBe(NOW);
		expect(loaded.state.reviveEpoch).toBeNull();
	});
});
