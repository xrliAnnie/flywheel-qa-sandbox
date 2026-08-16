/**
 * FLY-1328 A2 — the patrol sweep that clears asks belonging to runners that
 * died WITHOUT a teardown (so the A1 cascade never ran for them). This is the
 * path that drains the 178-corpse backlog the issue was filed over.
 *
 * The predicate matrix is the whole safety argument: everything here is about
 * what the sweep must NOT touch. A retired ask is a question the founder or
 * Lead never gets to answer, so every "leave it" case gets a test.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type {
	ZombieCandidateQuestion,
	ZombieGateHygieneDeps,
} from "../zombie-gate-hygiene.js";
import { runZombieGateHygiene } from "../zombie-gate-hygiene.js";

const DEAD_RUNNER = "11111111-2222-3333-4444-555555555555";
const OTHER_RUNNER = "99999999-8888-7777-6666-555555555555";

function sqliteUtcAgo(ms: number): string {
	return new Date(Date.now() - ms).toISOString().replace("T", " ").slice(0, 19);
}

function ask(
	over: Partial<ZombieCandidateQuestion> = {},
): ZombieCandidateQuestion {
	return {
		id: "q-ask",
		from_agent: DEAD_RUNNER,
		checkpoint: null,
		created_at: sqliteUtcAgo(45 * 60_000),
		...over,
	};
}

interface Harness {
	deps: ZombieGateHygieneDeps;
	events: Array<{ event_type: string; payload: Record<string, unknown> }>;
	retire: ReturnType<typeof vi.fn>;
	noteUnreachable: ReturnType<typeof vi.fn>;
}

/** Store/CommDB doubles. Defaults describe the fully-sweepable shape; each test
 * flips exactly one fact so a failure names its own cause. */
function harness(opts: {
	candidates: ZombieCandidateQuestion[];
	/** StateStore row; undefined = no session at all (the common corpse). */
	session?: { status: string; issue_id?: string; terminal_at?: string | null };
	/** CommDB registration row; undefined = torn down. */
	commRow?: unknown;
	retireResult?: boolean;
	response?: unknown;
	messageRow?: unknown;
	stillPending?: boolean;
	env?: Record<string, string | undefined>;
}): Harness {
	const events: Harness["events"] = [];
	const retire = vi.fn().mockReturnValue(opts.retireResult ?? true);
	const noteUnreachable = vi.fn();
	const byType = (t: string) => events.filter((e) => e.event_type === t);
	const deps = {
		store: {
			getSession: vi.fn().mockReturnValue(opts.session),
			insertEvent: vi.fn((e) => {
				events.push({
					event_type: e.event_type,
					payload: (e.payload ?? {}) as Record<string, unknown>,
				});
				return true;
			}),
			getEventsByType: vi.fn((t: string) => byType(t) as never),
		},
		projectName: "flywheel",
		pendingGateQuestions: opts.candidates,
		db: {
			getSession: vi.fn().mockReturnValue(opts.commRow),
			retireQuestionGuarded: retire,
			retireShipGate: vi.fn().mockReturnValue(true),
			getResponse: vi.fn().mockReturnValue(opts.response),
			getMessageById: vi.fn().mockReturnValue(opts.messageRow ?? { id: "q" }),
			isQuestionPending: vi.fn().mockReturnValue(opts.stillPending ?? false),
		},
		noteUnreachableRunner: noteUnreachable,
		env: opts.env ?? {},
	} as unknown as ZombieGateHygieneDeps;
	return { deps, events, retire, noteUnreachable };
}

const typesOf = (h: Harness) => h.events.map((e) => e.event_type);

describe("FLY-1328 A2 ask sweep", () => {
	it("M1: retires an aged ask whose runner left no session and no CommDB row", async () => {
		const h = harness({ candidates: [ask()] });
		const result = await runZombieGateHygiene(h.deps);

		expect(result.retiredAsks).toEqual(["q-ask"]);
		expect(h.retire).toHaveBeenCalledWith("q-ask", {
			expectedFromAgent: DEAD_RUNNER,
			requireUnanswered: true,
			resolvedVia: "owner_closed_sweep",
			retention: "ask_forensic",
		});
		expect(typesOf(h)).toEqual([
			"ask_hygiene_retire_intent",
			"ask_hygiene_retired",
		]);
		expect(h.events[1].payload).toMatchObject({
			questionId: "q-ask",
			resolvedVia: "owner_closed_sweep",
			outcome: "resolved",
		});
	});

	it("M2: retires when the StateStore session exists but is irreversibly terminal", async () => {
		const h = harness({
			candidates: [ask()],
			session: {
				status: "completed",
				issue_id: "FLY-1328",
				// Terminal AFTER the ask → the ask predates teardown → sweepable.
				terminal_at: sqliteUtcAgo(40 * 60_000),
			},
		});
		const result = await runZombieGateHygiene(h.deps);
		expect(result.retiredAsks).toEqual(["q-ask"]);
	});

	it("M2b: spares an ask written AFTER a terminal session's terminal_at (FLY-1257 chronology)", async () => {
		// The reopened-runner shape FLY-1257 proved is real: the session went
		// terminal and its CommDB row was finalized, then the SAME execution
		// identity was reopened and asked again (`ask` needs no session row). A
		// post-terminal ask is evidence someone IS waiting — retiring it would
		// swallow exactly the kind of question this ticket exists to protect.
		const h = harness({
			candidates: [ask({ created_at: sqliteUtcAgo(40 * 60_000) })],
			session: {
				status: "blocked",
				issue_id: "FLY-1328",
				terminal_at: sqliteUtcAgo(90 * 60_000), // terminal BEFORE the ask
			},
		});
		const result = await runZombieGateHygiene(h.deps);

		expect(result.retiredAsks).toEqual([]);
		expect(h.retire).not.toHaveBeenCalled();
		expect(typesOf(h)).toEqual([]);
	});

	it("M2c: an unreadable terminal_at does NOT spare the ask — chronology only speaks when it can", async () => {
		// Deliberately narrower than the gate branch. A missing/malformed clock is
		// no evidence of reopening, and 83 of production's 184 candidates have no
		// terminal_at at all — failing open here would forfeit them to defend a
		// shape that measured zero. The other four predicates still gate this.
		for (const terminal_at of [
			undefined,
			null,
			"not a date",
			"2026-07-17T01:02:03Z", // ISO, not canonical SQLite UTC
		]) {
			const h = harness({
				candidates: [ask()],
				session: { status: "completed", issue_id: "FLY-1328", terminal_at },
			});
			const result = await runZombieGateHygiene(h.deps);
			expect(result.retiredAsks).toEqual(["q-ask"]);
		}
	});

	it("M3: spares an ask whose CommDB registration row still exists", async () => {
		// FLY-161: the row surviving means the runner may be completed-but-alive or
		// parked — it can still answer.
		const h = harness({ candidates: [ask()], commRow: { execution_id: "x" } });
		const result = await runZombieGateHygiene(h.deps);

		expect(result.retiredAsks).toEqual([]);
		expect(h.retire).not.toHaveBeenCalled();
		expect(typesOf(h)).toEqual([]);
	});

	it("M4: spares a LIVE session whose CommDB row vanished, and does not alert on it", async () => {
		// The Z2 shape (FLY-1049 broken wake routing) — a real question on a real
		// runner. Retiring it would delete live work; alerting is the gate's job.
		const h = harness({
			candidates: [ask()],
			session: { status: "awaiting_review", issue_id: "FLY-1328" },
		});
		const result = await runZombieGateHygiene(h.deps);

		expect(result.retiredAsks).toEqual([]);
		expect(h.retire).not.toHaveBeenCalled();
		expect(h.noteUnreachable).not.toHaveBeenCalled();
		expect(typesOf(h)).toEqual([]);
	});

	it("M5: spares non-UUID senders (fail-closed identity guard)", async () => {
		const h = harness({
			candidates: [
				ask({ id: "q-1", from_agent: "runner" }),
				ask({ id: "q-2", from_agent: "qa-fly1239-78754" }),
				ask({ id: "q-3", from_agent: "lead" }),
			],
		});
		const result = await runZombieGateHygiene(h.deps);
		expect(result.retiredAsks).toEqual([]);
		expect(h.retire).not.toHaveBeenCalled();
	});

	it("M6: spares asks under 30 minutes old, and any ask with an unreadable clock", async () => {
		const h = harness({
			candidates: [
				ask({ id: "q-young", created_at: sqliteUtcAgo(29 * 60_000) }),
				ask({ id: "q-iso", created_at: "2026-07-17T01:02:03.000Z" }),
				ask({ id: "q-null", created_at: null }),
				ask({ id: "q-junk", created_at: "not a date" }),
			],
		});
		const result = await runZombieGateHygiene(h.deps);
		expect(result.retiredAsks).toEqual([]);
		expect(h.retire).not.toHaveBeenCalled();
	});

	it("M7: a concurrent answer wins the race — history is kept, outcome is honest", async () => {
		const h = harness({
			candidates: [ask()],
			retireResult: false,
			response: { id: "r-1", content: "answered!" },
		});
		const result = await runZombieGateHygiene(h.deps);

		expect(result.retiredAsks).toEqual([]);
		expect(h.events[1].payload.outcome).toBe("skipped_answered");
	});

	it("M7b: a still-pending row after a false mutation records nothing (retry next pass)", async () => {
		const h = harness({
			candidates: [ask()],
			retireResult: false,
			stillPending: true,
		});
		const result = await runZombieGateHygiene(h.deps);

		expect(result.retiredAsks).toEqual([]);
		// The intent stays as the durable breadcrumb; no outcome is invented.
		expect(typesOf(h)).toEqual(["ask_hygiene_retire_intent"]);
	});

	it("M8: converges on a large backlog in a SINGLE pass (no batch cap)", async () => {
		// The deploy contract: the first patrol pass after restart clears the
		// standing corpse pile, not a slice of it.
		const candidates = Array.from({ length: 200 }, (_, i) =>
			ask({ id: `q-${i}` }),
		);
		const h = harness({ candidates });
		const result = await runZombieGateHygiene(h.deps);
		expect(result.retiredAsks).toHaveLength(200);
	});

	it("M11: a completed-but-alive runner keeps its ask (the FLY-161 guarantee)", async () => {
		// Positive evidence, not just absence: session completed AND the CommDB row
		// present = parked/awaiting founder. This runner can still be woken.
		const h = harness({
			candidates: [ask()],
			session: { status: "completed", issue_id: "FLY-1328" },
			commRow: { execution_id: DEAD_RUNNER },
		});
		const result = await runZombieGateHygiene(h.deps);
		expect(result.retiredAsks).toEqual([]);
		expect(h.retire).not.toHaveBeenCalled();
	});

	it("M12: an ask that has not been relayed yet is spared until it ages out", async () => {
		// The delivery contract, honestly: a circuit-open lead means a fresh ask may
		// still be unrelayed. Age is what protects it — not a delivery receipt.
		const fresh = ask({ id: "q-fresh", created_at: sqliteUtcAgo(60_000) });
		const h = harness({ candidates: [fresh] });
		expect((await runZombieGateHygiene(h.deps)).retiredAsks).toEqual([]);

		// Same ask, now past the age guard (circuit long recovered, relay done).
		const aged = harness({
			candidates: [
				ask({ id: "q-fresh", created_at: sqliteUtcAgo(31 * 60_000) }),
			],
		});
		expect((await runZombieGateHygiene(aged.deps)).retiredAsks).toEqual([
			"q-fresh",
		]);
	});

	it("only touches the candidate's own runner", async () => {
		const h = harness({
			candidates: [
				ask({ id: "mine" }),
				ask({ id: "theirs", from_agent: OTHER_RUNNER }),
			],
		});
		await runZombieGateHygiene(h.deps);
		expect(h.retire).toHaveBeenCalledWith(
			"mine",
			expect.objectContaining({ expectedFromAgent: DEAD_RUNNER }),
		);
		expect(h.retire).toHaveBeenCalledWith(
			"theirs",
			expect.objectContaining({ expectedFromAgent: OTHER_RUNNER }),
		);
	});

	it("reconciles an ask intent left dangling by a crash, without touching gate intents", async () => {
		const h = harness({ candidates: [], stillPending: false });
		h.events.push({
			event_type: "ask_hygiene_retire_intent",
			payload: { questionId: "q-crashed" },
		});
		h.events.push({
			event_type: "founder_gate_zombie_resolve_intent",
			payload: { questionId: "q-gate-crashed" },
		});
		// getEventsByType returns objects the reconcile reads project_name off.
		(
			h.deps.store.getEventsByType as ReturnType<typeof vi.fn>
		).mockImplementation((t: string) =>
			h.events
				.filter((e) => e.event_type === t)
				.map((e) => ({
					...e,
					event_id: `${t}-${String(e.payload.questionId)}`,
					execution_id: DEAD_RUNNER,
					issue_id: "FLY-1328",
					project_name: "flywheel",
				})),
		);

		await runZombieGateHygiene(h.deps);

		const askOutcomes = h.events.filter(
			(e) => e.event_type === "ask_hygiene_retired",
		);
		expect(askOutcomes).toHaveLength(1);
		expect(askOutcomes[0].payload).toMatchObject({
			questionId: "q-crashed",
			reconciled: true,
		});
		// The ask reconcile must not classify the GATE intent — separate families.
		expect(
			h.events.filter(
				(e) =>
					e.event_type === "ask_hygiene_retired" &&
					e.payload.questionId === "q-gate-crashed",
			),
		).toEqual([]);
	});
});

describe("FLY-1328 teardown-premise sentinel", () => {
	// The A2 sweep reads "CommDB session row gone" as "runner torn down". That is
	// a call-graph fact, not a DB invariant: any new caller of these raw deletes
	// on a live runner would make the sweep destroy real questions. Today NOTHING
	// outside this file and its tests calls them. If you are here because this
	// test failed, your new call site must be a proven-teardown path — confirm
	// that, then add it to the list.
	it("no production code calls the raw session deletes", () => {
		const repoRoot = `${import.meta.dirname}/../../../../..`;
		let raw: string;
		try {
			raw = execFileSync(
				"git",
				[
					"grep",
					"-n",
					"-E",
					"\\.(deleteSession|deleteSessionAndRunnerPhaseLifecycle)\\(",
					"--",
					// A bare directory pathspec, then filter in JS: a `packages/*/src`
					// glob silently matches NOTHING here (git pathspec wildmatch needs
					// the whole path), which would make this test pass forever.
					"packages",
				],
				{ cwd: repoRoot, encoding: "utf8" },
			);
		} catch (err) {
			// git grep exits 1 on zero matches — that is this test's happy path.
			// Any other status is a broken probe, and a broken probe must fail loud
			// rather than silently "find nothing" forever.
			const e = err as { status?: number; stdout?: string };
			if (e.status !== 1) throw err;
			raw = e.stdout ?? "";
		}
		const hits = raw
			.split("\n")
			.filter(Boolean)
			.filter((line) => line.includes("/src/"))
			// Tests exercising the primitives, and the unrelated in-memory
			// edge-worker registry, are not CommDB teardown.
			.filter((line) => !line.includes("__tests__"))
			.filter((line) => !line.includes("/test/"))
			.filter((line) => !line.includes("GlobalSessionRegistry"));

		expect(hits).toEqual([]);
	});

	it("the sentinel's own probe can actually see a call site", () => {
		// The positive control. Without it, a mistyped pathspec or a swallowed exit
		// code turns the test above into a green light that means nothing — it
		// found nothing because it looked nowhere. This asserts the same probe
		// finds a call site we KNOW exists (edge-worker's registry, which the
		// filter above deliberately excludes).
		const repoRoot = `${import.meta.dirname}/../../../../..`;
		const raw = execFileSync(
			"git",
			[
				"grep",
				"-n",
				"-E",
				"\\.(deleteSession|deleteSessionAndRunnerPhaseLifecycle)\\(",
				"--",
				"packages",
			],
			{ cwd: repoRoot, encoding: "utf8" },
		);
		expect(
			raw.split("\n").filter((l) => l.includes("GlobalSessionRegistry.ts")),
		).not.toEqual([]);
	});
});
