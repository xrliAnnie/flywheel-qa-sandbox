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
	emptyQuotaMonitorState,
	loadQuotaMonitorState,
	type QuotaMonitorState,
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
