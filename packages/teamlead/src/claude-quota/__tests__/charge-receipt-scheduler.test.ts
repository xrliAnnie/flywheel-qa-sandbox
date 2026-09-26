import { describe, expect, it } from "vitest";
import {
	CLAUDE_CHARGE_MIN_RETRY_MS,
	CLAUDE_CHARGE_REFRESH_INTERVAL_MS,
	createClaudeChargeScheduler,
	nextClaudeChargeDueAt,
} from "../charge-receipt-scheduler.js";
import type {
	ClaudeChargeFacts,
	ClaudeChargeReading,
	ClaudeChargeStore,
} from "../charge-receipt-store.js";

const HOUR = 3_600_000;
const GENERATED = "2026-09-25T23:40:00.000Z";

const FACTS: ClaudeChargeFacts = {
	periodStart: "2026-09-04",
	periodEnd: "2026-10-04",
	paidOn: "2026-09-04",
	amountCents: 20000,
	receiptCount: 1,
	receiptAt: "2026-09-05T00:06:00.000Z",
	canceledAt: null,
	resumedAt: null,
};

function reading(
	overrides: Partial<ClaudeChargeReading> = {},
): ClaudeChargeReading {
	return {
		name: "personal",
		mailboxKey: "a".repeat(64),
		readAt: GENERATED,
		status: "ok",
		reason: null,
		facts: FACTS,
		lastGood: null,
		...overrides,
	};
}

function store(
	accounts: ClaudeChargeReading[],
	generatedAt = GENERATED,
): ClaudeChargeStore {
	return { version: 1, generatedAt, accounts };
}

describe("FLY-2897 nextClaudeChargeDueAt", () => {
	const now = Date.parse(GENERATED) + HOUR;

	it("is due now without a readable store", () => {
		expect(nextClaudeChargeDueAt(null, now)).toBe(now);
	});

	it("is due a day after the last round", () => {
		expect(nextClaudeChargeDueAt(store([reading()]), now)).toBe(
			Date.parse(GENERATED) + CLAUDE_CHARGE_REFRESH_INTERVAL_MS,
		);
	});

	it("reads again early on the morning after a charge day it has not seen", () => {
		// Read 09-25 PDT, period ends 09-25: due 09-26 00:05 PDT = 07:05 UTC,
		// before the daily round at 09-26 23:40 UTC.
		const facts = {
			...FACTS,
			periodStart: "2026-08-25",
			periodEnd: "2026-09-25",
		};
		expect(nextClaudeChargeDueAt(store([reading({ facts })]), now)).toBe(
			Date.parse("2026-09-26T07:05:00.000Z"),
		);
		const canceled = reading({
			status: "canceled",
			facts: { ...facts, canceledAt: "2026-09-20T18:00:00.000Z" },
		});
		expect(nextClaudeChargeDueAt(store([canceled]), now)).toBe(
			Date.parse("2026-09-26T07:05:00.000Z"),
		);
	});

	it("uses standard time in winter", () => {
		const read = "2026-12-10T20:00:00.000Z"; // 12:00 PST
		const facts = {
			...FACTS,
			periodStart: "2026-11-10",
			periodEnd: "2026-12-10",
		};
		expect(
			nextClaudeChargeDueAt(
				store([reading({ facts, readAt: read })], read),
				Date.parse(read) + HOUR,
			),
		).toBe(Date.parse("2026-12-11T08:05:00.000Z"));
	});

	it("does not keep re-reading once it has read after the charge day", () => {
		const facts = {
			...FACTS,
			periodStart: "2026-08-24",
			periodEnd: "2026-09-24",
		};
		expect(nextClaudeChargeDueAt(store([reading({ facts })]), now)).toBe(
			Date.parse(GENERATED) + CLAUDE_CHARGE_REFRESH_INTERVAL_MS,
		);
	});

	it("ignores the carried last good reading of a failed round", () => {
		const facts = {
			...FACTS,
			periodStart: "2026-08-25",
			periodEnd: "2026-09-25",
		};
		const failed = reading({
			status: "auth_invalid",
			reason: "invalid_grant",
			facts: null,
			lastGood: { readAt: GENERATED, status: "ok", facts },
		});
		expect(nextClaudeChargeDueAt(store([failed]), now)).toBe(
			Date.parse(GENERATED) + CLAUDE_CHARGE_REFRESH_INTERVAL_MS,
		);
	});

	it("is due now when the file claims a time in the future", () => {
		const early = Date.parse(GENERATED) - 10 * 60_000;
		expect(nextClaudeChargeDueAt(store([reading()]), early)).toBe(early);
		const future = reading({ readAt: "2026-09-26T23:40:00.000Z" });
		expect(nextClaudeChargeDueAt(store([future]), now)).toBe(now);
		const futureGood = reading({
			status: "read_failed",
			reason: "timeout",
			facts: null,
			lastGood: {
				readAt: "2026-09-26T23:40:00.000Z",
				status: "ok",
				facts: FACTS,
			},
		});
		expect(nextClaudeChargeDueAt(store([futureGood]), now)).toBe(now);
	});
});

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(initial: ClaudeChargeStore | null) {
	const state = {
		now: Date.parse(GENERATED) + HOUR,
		store: initial,
		reads: 0,
		refreshes: [] as ReturnType<typeof deferred>[],
		warnings: [] as string[],
	};
	const scheduler = createClaudeChargeScheduler({
		now: () => state.now,
		readStore: () => {
			state.reads += 1;
			return state.store;
		},
		refresh: () => {
			const round = deferred();
			state.refreshes.push(round);
			return round.promise;
		},
		warn: (line) => state.warnings.push(line),
	});
	return { state, scheduler };
}

describe("FLY-2897 createClaudeChargeScheduler", () => {
	it("starts one round when nothing was read yet, and not a second while it runs", async () => {
		const { state, scheduler } = harness(null);
		scheduler.tick();
		scheduler.tick();
		expect(state.refreshes).toHaveLength(1);
		state.store = store([reading()], new Date(state.now).toISOString());
		state.refreshes[0]!.resolve();
		await flush();
		state.now += HOUR;
		scheduler.tick();
		expect(state.refreshes).toHaveLength(1);
	});

	it("reads the file once, not on every tick, until the round is due", () => {
		const { state, scheduler } = harness(store([reading()]));
		for (let i = 0; i < 50; i += 1) {
			scheduler.tick();
			state.now += 3_000;
		}
		expect(state.reads).toBe(1);
		expect(state.refreshes).toHaveLength(0);
		state.now = Date.parse(GENERATED) + CLAUDE_CHARGE_REFRESH_INTERVAL_MS;
		scheduler.tick();
		expect(state.reads).toBe(2);
		expect(state.refreshes).toHaveLength(1);
	});

	it("does not start when another trigger already refreshed the file", () => {
		const { state, scheduler } = harness(store([reading()]));
		scheduler.tick();
		state.now = Date.parse(GENERATED) + CLAUDE_CHARGE_REFRESH_INTERVAL_MS;
		state.store = store([reading()], new Date(state.now - HOUR).toISOString());
		scheduler.tick();
		expect(state.refreshes).toHaveLength(0);
	});

	it("notices within minutes an earlier due that another trigger's write created", () => {
		const { state, scheduler } = harness(store([reading()]));
		scheduler.tick(); // caches the daily due, 09-26 23:40 UTC
		// A switch refresh rewrites the file: the period now ends today (09-25),
		// so the morning-after read is due 09-26 07:05 UTC.
		const today = {
			...FACTS,
			periodStart: "2026-08-25",
			periodEnd: "2026-09-25",
		};
		state.store = store([reading({ facts: today })]);
		state.now += 4 * 60_000;
		scheduler.tick();
		expect(state.reads).toBe(1);
		state.now += 60_000;
		scheduler.tick();
		expect(state.reads).toBe(2);
		state.now = Date.parse("2026-09-26T07:05:00.000Z");
		scheduler.tick();
		expect(state.refreshes).toHaveLength(1);
	});

	it("waits before retrying a failed round", async () => {
		const { state, scheduler } = harness(null);
		scheduler.tick();
		state.refreshes[0]!.reject(new Error("accounts_unreadable"));
		await flush();
		expect(state.warnings).toEqual([
			"[claude-charge] scheduled refresh failed: accounts_unreadable",
		]);
		// Backing off: no store reads on the 3 s ticks either.
		const readsAfterRound = state.reads;
		for (let i = 0; i < 10; i += 1) {
			state.now += 3_000;
			scheduler.tick();
		}
		expect(state.reads).toBe(readsAfterRound);
		state.now += CLAUDE_CHARGE_MIN_RETRY_MS - 30_001;
		scheduler.tick();
		expect(state.refreshes).toHaveLength(1);
		state.now += 1;
		scheduler.tick();
		expect(state.refreshes).toHaveLength(2);
	});

	it("never lets an error text carry anything but a code", async () => {
		const { state, scheduler } = harness(null);
		scheduler.tick();
		state.refreshes[0]!.reject(new Error("gog said x@example.com is bad"));
		await flush();
		expect(state.warnings).toEqual([
			"[claude-charge] scheduled refresh failed: error",
		]);
	});

	it("never throws out of tick", () => {
		const scheduler = createClaudeChargeScheduler({
			now: () => Date.now(),
			readStore: () => {
				throw new Error("boom");
			},
			refresh: () => {
				throw new Error("sync boom");
			},
			warn: () => {},
		});
		expect(() => scheduler.tick()).not.toThrow();
	});
});
