import {
	existsSync,
	lutimesSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	countReviewRoundSpool,
	writeReviewRoundSpoolRecord,
} from "flywheel-comm/review-round-spool";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createReviewRoundSpoolReconciler } from "../review-round-spool-reconciler.js";

const EXEC = "11111111-2222-4333-8444-555555555555";
const THREAD = "01a0daf6-1f50-7522-b7dc-f0b3812a5dab";
const TURN = "01a0daf6-2634-7a23-a8e9-c1669023f451";
const NOW = Date.parse("2026-09-25T12:00:00.000Z");

function body(overrides: Record<string, unknown> = {}) {
	return {
		executionId: EXEC,
		reviewType: "design",
		codexThreadId: THREAD,
		codexTurnId: TURN,
		round: 1,
		verdict: "CHANGES_REQUESTED",
		modelEvidence: "rollout_turn",
		observedModel: "gpt-6-astra",
		observedEffort: "xhigh",
		reviewedPlanBlobSha: "a".repeat(40),
		reviewedAt: "2026-09-25T11:00:00.000Z",
		...overrides,
	};
}

function records(dir: string): string[] {
	return existsSync(dir)
		? readdirSync(dir).filter((name) => name.endsWith(".json"))
		: [];
}

describe("FLY-2891 review round spool reconciler", () => {
	let root: string;
	let dir: string;
	let store: StateStore;
	let clock: number;
	let warn: ReturnType<typeof vi.fn>;
	const reconciler = (extra: Record<string, unknown> = {}) =>
		createReviewRoundSpoolReconciler(store, {
			dir,
			now: () => clock,
			logger: { warn },
			...extra,
		});

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "fly2891-reconcile-"));
		dir = join(root, "state", "review-round-spool");
		store = await StateStore.create(":memory:");
		clock = NOW;
		warn = vi.fn();
		store.upsertSession({
			execution_id: EXEC,
			issue_id: "FLY-2891",
			project_name: "flywheel",
			status: "running",
		});
	});
	afterEach(() => {
		store.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("ingests a spooled round after the runner and its worktree are gone", () => {
		const worktree = join(root, "worktree");
		mkdirSync(worktree);
		writeReviewRoundSpoolRecord(dir, body(), { lastError: "fetch failed" });
		rmSync(worktree, { recursive: true, force: true });
		expect(reconciler().tick()).toMatchObject({ ingested: 1, quarantined: 0 });
		expect(records(dir)).toEqual([]);
		expect(store.reviewRounds.listRoundsForExecutions([EXEC])).toEqual([
			expect.objectContaining({ delivery: "spool", round: 1 }),
		]);
	});

	it("collapses two identical deliveries of one turn into one row", () => {
		writeReviewRoundSpoolRecord(dir, body());
		writeReviewRoundSpoolRecord(dir, body());
		expect(reconciler().tick()).toMatchObject({ ingested: 2 });
		expect(records(dir)).toEqual([]);
		expect(store.reviewRounds.listRoundsForExecutions([EXEC])).toHaveLength(1);
		expect(countReviewRoundSpool(dir)).toEqual({ pending: 0, quarantined: 0 });
	});

	it("keeps the first delivery and quarantines a conflicting later one visibly", () => {
		const first = writeReviewRoundSpoolRecord(dir, body());
		const second = writeReviewRoundSpoolRecord(
			dir,
			body({ verdict: "APPROVED" }),
		);
		utimesSync(first, new Date(NOW - 2_000), new Date(NOW - 2_000));
		utimesSync(second, new Date(NOW - 1_000), new Date(NOW - 1_000));
		expect(reconciler().tick()).toMatchObject({ ingested: 1, quarantined: 1 });
		expect(store.reviewRounds.listRoundsForExecutions([EXEC])).toEqual([
			expect.objectContaining({ verdict: "CHANGES_REQUESTED" }),
		]);
		const quarantineDir = join(dir, "quarantine");
		const [kept] = records(quarantineDir);
		expect(readFileSync(join(quarantineDir, `${kept}.reason`), "utf8")).toMatch(
			/^conflict: /,
		);
		expect(countReviewRoundSpool(dir)).toEqual({ pending: 0, quarantined: 1 });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(EXEC));
		expect(warn.mock.calls.flat().join("\n")).not.toContain("gpt-6-astra");
	});

	it("quarantines invalid payloads and unparseable files", () => {
		writeReviewRoundSpoolRecord(dir, body({ round: 0 }));
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(
				dir,
				`${EXEC}.design.${TURN}.round.00000000-0000-4000-8000-000000000000.json`,
			),
			"{not json",
		);
		expect(reconciler().tick()).toMatchObject({ quarantined: 2 });
		expect(records(dir)).toEqual([]);
		expect(countReviewRoundSpool(dir).quarantined).toBe(2);
	});

	it("retains unknown executions and write failures, then expires after 7 days", () => {
		// spooledAt is stamped from Date; pin it to NOW so the expiry below
		// never depends on the host date.
		vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
		try {
			writeReviewRoundSpoolRecord(
				dir,
				body({ executionId: "99999999-2222-4333-8444-555555555555" }),
			);
		} finally {
			vi.useRealTimers();
		}
		const tick = reconciler().tick;
		expect(tick()).toMatchObject({ retained: 1, quarantined: 0 });
		expect(records(dir)).toHaveLength(1);
		clock = NOW + 8 * 24 * 60 * 60 * 1000;
		expect(tick()).toMatchObject({ quarantined: 1 });
		const [kept] = records(join(dir, "quarantine"));
		expect(
			readFileSync(join(dir, "quarantine", `${kept}.reason`), "utf8"),
		).toMatch(/retry window expired: unknown_execution/);

		writeReviewRoundSpoolRecord(dir, body());
		vi.spyOn(store, "reviewRounds", "get").mockReturnValue({
			recordRound: () => {
				throw new Error("database is locked");
			},
		} as never);
		clock = NOW;
		expect(reconciler().tick()).toMatchObject({ retained: 1 });
		expect(records(dir)).toHaveLength(1);
	});

	it("leaves symlinks untouched and quarantines own oversized files", () => {
		mkdirSync(dir, { recursive: true });
		const outside = join(root, "outside.json");
		writeFileSync(outside, JSON.stringify({ schemaVersion: 1, body: body() }));
		const link = join(
			dir,
			`${EXEC}.design.${TURN}.round.00000000-0000-4000-8000-000000000001.json`,
		);
		symlinkSync(outside, link);
		const bigName = `${EXEC}.design.${TURN}.round.00000000-0000-4000-8000-000000000002.json`;
		writeFileSync(join(dir, bigName), "x".repeat(17 * 1024));
		expect(reconciler().tick()).toMatchObject({
			skipped: 1,
			quarantined: 1,
			ingested: 0,
		});
		expect(existsSync(link)).toBe(true);
		expect(existsSync(join(dir, bigName))).toBe(false);
		expect(
			readFileSync(join(dir, "quarantine", `${bigName}.reason`), "utf8"),
		).toMatch(/^oversized/);
		expect(store.reviewRounds.listRoundsForExecutions([EXEC])).toEqual([]);
		// A symlink is neither pending nor quarantined work.
		expect(countReviewRoundSpool(dir)).toEqual({ pending: 0, quarantined: 1 });
	});

	it("never lets untouchable files starve the file budget", () => {
		mkdirSync(dir, { recursive: true });
		const outside = join(root, "outside.json");
		writeFileSync(outside, "{}");
		for (let i = 0; i < 120; i += 1) {
			const link = join(
				dir,
				`${EXEC}.design.${TURN}.round.00000000-0000-4000-8000-${String(i).padStart(12, "0")}.json`,
			);
			symlinkSync(outside, link);
			// Older than the legit record, so they sort first (oldest-first).
			lutimesSync(link, new Date(NOW - 10_000), new Date(NOW - 10_000));
		}
		const legit = writeReviewRoundSpoolRecord(dir, body());
		utimesSync(legit, new Date(NOW), new Date(NOW));
		expect(reconciler().tick()).toMatchObject({ ingested: 1, skipped: 120 });
		expect(store.reviewRounds.listRoundsForExecutions([EXEC])).toHaveLength(1);
	});

	it("bounds one tick to the file budget", () => {
		for (let round = 1; round <= 105; round += 1)
			writeReviewRoundSpoolRecord(
				dir,
				body({
					round,
					codexTurnId: `01a0daf6-2634-7a23-a8e9-${String(round).padStart(12, "0")}`,
				}),
			);
		const tick = reconciler().tick;
		expect(tick()).toMatchObject({ scanned: 100, budgetExhausted: true });
		expect(records(dir)).toHaveLength(5);
		expect(tick()).toMatchObject({ scanned: 5, budgetExhausted: false });
		expect(store.reviewRounds.listRoundsForExecutions([EXEC])).toHaveLength(
			105,
		);
	});

	it("stops at the time budget", () => {
		writeReviewRoundSpoolRecord(dir, body());
		writeReviewRoundSpoolRecord(
			dir,
			body({ codexTurnId: "01a0daf6-2634-7a23-a8e9-c1669023f452", round: 2 }),
		);
		let calls = 0;
		const result = createReviewRoundSpoolReconciler(store, {
			dir,
			now: () => NOW + (calls++ > 1 ? 10_000 : 0),
			logger: { warn },
		}).tick();
		expect(result.budgetExhausted).toBe(true);
		expect(records(dir).length).toBeGreaterThan(0);
	});

	it("warns about records pending over an hour at most hourly", () => {
		const path = writeReviewRoundSpoolRecord(
			dir,
			body({ executionId: "99999999-2222-4333-8444-555555555555" }),
		);
		utimesSync(
			path,
			new Date(NOW - 2 * 3_600_000),
			new Date(NOW - 2 * 3_600_000),
		);
		const spooled = JSON.parse(readFileSync(path, "utf8"));
		spooled.spooledAt = new Date(NOW - 2 * 3_600_000).toISOString();
		writeFileSync(path, JSON.stringify(spooled));
		utimesSync(
			path,
			new Date(NOW - 2 * 3_600_000),
			new Date(NOW - 2 * 3_600_000),
		);
		const tick = reconciler().tick;
		tick();
		tick();
		const stale = warn.mock.calls.filter(([line]) =>
			String(line).includes("pending for over"),
		);
		expect(stale).toHaveLength(1);
		clock = NOW + 3_600_001;
		tick();
		expect(
			warn.mock.calls.filter(([line]) =>
				String(line).includes("pending for over"),
			),
		).toHaveLength(2);
	});

	it("reaps stale temp files from crashed writers but not fresh ones", () => {
		mkdirSync(dir, { recursive: true });
		const stale = join(dir, `.x.json.1.${"a".repeat(8)}.tmp`);
		const fresh = join(dir, `.y.json.1.${"b".repeat(8)}.tmp`);
		writeFileSync(stale, "{}");
		writeFileSync(fresh, "{}");
		utimesSync(
			stale,
			new Date(NOW - 2 * 3_600_000),
			new Date(NOW - 2 * 3_600_000),
		);
		utimesSync(fresh, new Date(NOW), new Date(NOW));
		reconciler().tick();
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});

	it("is a no-op when the spool directory does not exist", () => {
		expect(reconciler().tick()).toMatchObject({ scanned: 0 });
		expect(warn).not.toHaveBeenCalled();
	});
});
