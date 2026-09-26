/**
 * FLY-1234 (T3 #5 / T2 boot test, Codex code R1 #3): the PRODUCTION
 * composition, assembled from the same modules plugin.ts consumes —
 * createJudgeRoutingDepsFactory + createStuckConfirmRunner + a REAL
 * createWatchdogJudge instance (fake spawn) + REAL routeSuspiciousReport +
 * REAL buildJudgeInputFromStore + REAL HeartbeatService.
 *
 * Proves the contracts the pure-module tests cannot:
 *  - single emission right (INV-4): judge c_stuck → exactly ONE session_stuck
 *    notification + ONE confirmed-stuck audit row + ZERO unified-escalation
 *    callbacks (the confirm path constructs its routing WITHOUT
 *    onConfirmedStuck);
 *  - the judge is fed TRUTHFUL seeded context: the prompt handed to the
 *    (fake) codex child carries the session's stage, comm-event summaries and
 *    the real pane frames;
 *  - boot ordering (R2 #4): with the production bind-then-start order NO tick
 *    ever observes an unbound holder, while the inverse (start-then-bind)
 *    provably produces the confirm_unbound fail-open — the test detects the
 *    regression the start() move exists to prevent.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeartbeatService } from "../../HeartbeatService.js";
import type { Session } from "../../StateStore.js";
import {
	CONFIRM_NOTES,
	type StuckConfirmResult,
} from "../stuck-pane-confirm.js";
import { createWatchdogJudge } from "../watchdog-judge.js";
import {
	createJudgeRoutingDepsFactory,
	createStuckConfirmRunner,
	type JudgeRoutingFactoryOpts,
} from "../watchdog-judge-assembly.js";

const EXEC = "exec-assembly-1";

function session(over: Partial<Session> = {}): Session {
	return {
		execution_id: EXEC,
		issue_id: "FLY-1224",
		issue_identifier: "FLY-1224",
		project_name: "flywheel",
		status: "running",
		session_stage: "implement",
		last_activity_at: "2026-07-13 18:00:00",
		...over,
	} as Session;
}

/** Recording store implementing BOTH the heartbeat and assembly surfaces. */
function makeStore(stuck: Session[]) {
	const notified = new Set<string>();
	const key = (e: string, s: string, f: string) => `${e}|${s}|${f}`;
	const sessions = new Map(stuck.map((s) => [s.execution_id, s]));
	const auditRows: Array<{ event_type: string; execution_id: string }> = [];
	return {
		// heartbeat surface
		getStuckSessions: vi.fn(() => stuck),
		getOrphanSessions: vi.fn(() => []),
		getStaleCompletedSessions: vi.fn(() => []),
		getAwaitingReviewTimedOut: vi.fn(() => []),
		forceStatus: vi.fn(),
		hasQuietWakeNotified: vi.fn((e: string, s: string, f: string) =>
			notified.has(key(e, s, f)),
		),
		recordQuietWakeNotified: vi.fn((e: string, s: string, f: string) => {
			notified.add(key(e, s, f));
		}),
		clearQuietWakeNotified: vi.fn(),
		pruneQuietWakeNotifiedNotIn: vi.fn(),
		// assembly surface
		getSession: vi.fn((id: string) => sessions.get(id)),
		getEventsByExecution: vi.fn(() => [
			{
				event_type: "stage_changed",
				event_id: "stage-implement-marker",
				ts: "2026-07-13 17:55:00",
			},
		]),
		insertEvent: vi.fn((row: { event_type: string; execution_id: string }) => {
			auditRows.push(row);
			return true;
		}),
		_auditRows: auditRows,
		_notified: notified,
	};
}

function makeNotifier() {
	return {
		onSessionStuck: vi.fn(async () => true),
		onSessionOrphaned: vi.fn(async () => {}),
		onSessionStale: vi.fn(async () => {}),
		onSessionMonitoringLost: vi.fn(async () => {}),
		onSessionMonitoringReestablished: vi.fn(async () => {}),
	};
}

/**
 * The full production wiring, with a fake codex child answering in the REAL
 * `codex exec --json` JSONL wire shape (FLY-1234 QA HIGH: a fake child that
 * prints a bare verdict object is a formation real codex never produces —
 * exactly the fixture blind spot that let the parse bug ship).
 */
function assemble(opts: {
	store: ReturnType<typeof makeStore>;
	verdict: "a_working" | "b_parked" | "c_stuck";
	frames?: [string, string];
	/** Real CommDB path — park probe AND gap-reader corroboration both read it. */
	commDbPath?: string;
}) {
	const prompts: string[] = [];
	const judge = createWatchdogJudge({
		repoRoot: "/tmp",
		env: {},
		logger: () => {},
		spawnRunner: async (spawnOpts) => {
			prompts.push(spawnOpts.stdin);
			const answer = JSON.stringify({
				verdict: opts.verdict,
				attribution: "unknown",
				suggestedAction: "n",
				rationale: "assembly",
			});
			const stdout = [
				'{"type":"thread.started","thread_id":"t-assembly"}',
				'{"type":"turn.started"}',
				JSON.stringify({
					type: "item.completed",
					item: { id: "item_0", type: "agent_message", text: answer },
				}),
				'{"type":"turn.completed","usage":{"input_tokens":1}}',
				"",
			].join("\n");
			return { code: 0, stdout, timedOut: false };
		},
	});
	// The seam createStuckConfirmRunner hands to the factory — recorded so the
	// test can assert the confirm path NEVER injects onConfirmedStuck (INV-4).
	const factoryOptsSeen: JudgeRoutingFactoryOpts[] = [];
	const realFactory = createJudgeRoutingDepsFactory({
		store: opts.store,
		judge,
		judgeEnabled: () => true,
		resolveOwner: (r) => ({
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			executionId: r.targetKey,
			issueId: "FLY-1224",
		}),
		// Default: no CommDB → gap reader cannot corroborate, park probe reads
		// null. Tests that need park evidence hand in a REAL CommDB file and the
		// PRODUCTION default probe reads it (no fake probe seam in these tests).
		getCommDbPath: () => opts.commDbPath ?? "/nonexistent/comm.db",
	});
	const buildRoutingDeps = (o: JudgeRoutingFactoryOpts) => {
		factoryOptsSeen.push(o);
		return realFactory(o);
	};
	let frameIdx = 0;
	const frames = opts.frames ?? [
		"codex exec — design review R2 running\n❯ ",
		"codex exec — design review R2 running\n❯ ",
	];
	const runner = createStuckConfirmRunner({
		buildRoutingDeps,
		probeLiveness: async () => "alive",
		captureFrame: async () => ({
			text: frames[Math.min(frameIdx++, 1)]!,
			capturedAtMs: frameIdx,
		}),
		commCorroborationMs: () => 1_800_000,
		env: { FLYWHEEL_STUCK_FRAME_GAP_MS: "1" },
		logger: () => {},
	});
	return { runner, prompts, factoryOptsSeen };
}

function buildService(
	store: ReturnType<typeof makeStore>,
	notifier: ReturnType<typeof makeNotifier>,
	holder: {
		current: ((s: Session) => Promise<StuckConfirmResult>) | null;
	},
	intervalMs = 300_000,
) {
	return new HeartbeatService(
		store as unknown as ConstructorParameters<typeof HeartbeatService>[0],
		notifier as unknown as ConstructorParameters<typeof HeartbeatService>[1],
		15,
		intervalMs,
		60,
		undefined,
		24,
		6 * 3_600_000,
		undefined,
		48,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined, // onMaintenanceTick (FLY-1185)
		holder,
	);
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
	for (const k of ["FLYWHEEL_STUCK_PANE_CONFIRM"]) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});
afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	vi.restoreAllMocks();
});

describe("FLY-1234 production assembly — single emission right (INV-4)", () => {
	it("judge c_stuck → exactly 1 session_stuck + 1 confirmed-stuck audit + 0 escalation callbacks", async () => {
		const store = makeStore([session()]);
		const notifier = makeNotifier();
		const { runner, factoryOptsSeen } = assemble({ store, verdict: "c_stuck" });
		const service = buildService(store, notifier, { current: runner });
		await service.check();

		// Exactly ONE Lead notification — the heartbeat's own, annotated.
		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(1);
		expect(notifier.onSessionStuck).toHaveBeenCalledWith(
			expect.objectContaining({ execution_id: EXEC }),
			expect.any(Number),
			{ confirmNote: CONFIRM_NOTES.frames_static_judge_c_stuck },
		);
		// Exactly ONE durable confirmed-stuck audit row.
		const confirmed = store._auditRows.filter(
			(r) => r.event_type === "watchdog_judge_confirmed_stuck",
		);
		expect(confirmed).toHaveLength(1);
		expect(confirmed[0]!.execution_id).toBe(EXEC);
		// The confirm path NEVER wires the unified-escalation callback — the
		// factory received no onConfirmedStuck to call (INV-4).
		expect(factoryOptsSeen).toHaveLength(1);
		expect(factoryOptsSeen[0]!.onConfirmedStuck).toBeUndefined();
		// And the emit deduped exactly once.
		expect(store.recordQuietWakeNotified).toHaveBeenCalledTimes(1);
	});

	it("judge a_working → 0 notifications, 0 dedup, 1 suppression audit", async () => {
		const store = makeStore([session()]);
		const notifier = makeNotifier();
		const { runner } = assemble({ store, verdict: "a_working" });
		const service = buildService(store, notifier, { current: runner });
		await service.check();

		expect(notifier.onSessionStuck).not.toHaveBeenCalled();
		expect(store.recordQuietWakeNotified).not.toHaveBeenCalled();
		const suppressed = store._auditRows.filter(
			(r) => r.event_type === "watchdog_judge_suppressed",
		);
		expect(suppressed).toHaveLength(1);
	});

	it("the judge prompt carries the SEEDED stage, comm summary and real frames (truthful context)", async () => {
		const store = makeStore([session()]);
		const notifier = makeNotifier();
		const { runner, prompts } = assemble({
			store,
			verdict: "a_working",
			frames: [
				"vitest run — restart-guard suite\n❯ ",
				"vitest run — restart-guard suite\n❯ ",
			],
		});
		const service = buildService(store, notifier, { current: runner });
		await service.check();

		expect(prompts).toHaveLength(1);
		const prompt = prompts[0]!;
		expect(prompt).toContain("stage: implement"); // seeded session_stage
		expect(prompt).toContain("stage-implement-marker"); // seeded comm summary
		expect(prompt).toContain("vitest run — restart-guard suite"); // real frames
		expect(prompt).toContain("park: (none)"); // no declared park → truthful none
	});

	it("QA case-e fix: a REAL declared park reaches the judge prompt AND corroborates b_parked → suppressed with 1 audit", async () => {
		// Real CommDB file — the PRODUCTION park probe and the gap reader both
		// read this same DB (the MEDIUM finding: the old hardcoded park:null
		// meant the model never saw the park evidence the b_parked few-shot
		// demands; 2/2 real runs on a genuinely parked husk fell to suspicious).
		const dir = mkdtempSync(join(tmpdir(), "fly1234-park-"));
		const dbPath = join(dir, "comm.db");
		const db = new CommDB(dbPath);
		db.upsertDeclaredState(
			EXEC,
			"parked",
			"three-stage implement parked awaiting QA",
			Date.now(),
			null,
		);
		db.close();
		try {
			const store = makeStore([session()]);
			const notifier = makeNotifier();
			const { runner, prompts } = assemble({
				store,
				verdict: "b_parked",
				frames: [
					"Parked. Waiting for wake.\n❯ ",
					"Parked. Waiting for wake.\n❯ ",
				],
				commDbPath: dbPath,
			});
			const service = buildService(store, notifier, { current: runner });
			await service.check();

			expect(prompts).toHaveLength(1);
			expect(prompts[0]!).toContain(
				"park: parked (three-stage implement parked awaiting QA)",
			);
			// b_parked verdict + REAL mechanical corroboration → suppressed:
			// zero notification, zero dedup, exactly one suppression audit row.
			expect(notifier.onSessionStuck).not.toHaveBeenCalled();
			expect(store.recordQuietWakeNotified).not.toHaveBeenCalled();
			expect(
				store._auditRows.filter(
					(r) => r.event_type === "watchdog_judge_suppressed",
				),
			).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("bounded downgrade authority: b_parked WITHOUT mechanical corroboration is demoted → emit judge_suspicious", async () => {
		// No CommDB anywhere: the model may claim b_parked, but the downgrade
		// authority demands mechanical corroboration — fail-open emit.
		const store = makeStore([session()]);
		const notifier = makeNotifier();
		const { runner, prompts } = assemble({
			store,
			verdict: "b_parked",
			frames: [
				"Parked. Waiting for wake.\n❯ ",
				"Parked. Waiting for wake.\n❯ ",
			],
		});
		const service = buildService(store, notifier, { current: runner });
		await service.check();

		expect(prompts[0]!).toContain("park: (none)"); // truthful — nothing declared
		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(1);
		expect(notifier.onSessionStuck).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(Number),
			{ confirmNote: CONFIRM_NOTES.judge_suspicious },
		);
	});
});

describe("FLY-1234 boot ordering (R2 #4) — bind BEFORE start", () => {
	async function runTicks(
		holder: {
			current: ((s: Session) => Promise<StuckConfirmResult>) | null;
		},
		bindLate?: (h: typeof holder) => void,
	) {
		const store = makeStore([session()]);
		const notifier = makeNotifier();
		const service = buildService(store, notifier, holder, 5);
		service.start();
		if (bindLate) {
			await new Promise((r) => setTimeout(r, 18));
			bindLate(holder);
		}
		await new Promise((r) => setTimeout(r, 60));
		service.stop();
		await new Promise((r) => setTimeout(r, 10)); // drain in-flight tick
		return notifier.onSessionStuck.mock.calls.map(
			(c) => (c[2] as { confirmNote?: string } | undefined)?.confirmNote,
		);
	}

	it("production order (bound before start): NO tick ever fail-opens with confirm_unbound", async () => {
		const runner = async (): Promise<StuckConfirmResult> => ({
			action: "emit",
			reason: "judge_unavailable",
			confirmNote: CONFIRM_NOTES.judge_unavailable,
		});
		const notes = await runTicks({ current: runner });
		expect(notes.length).toBeGreaterThan(0); // ticks really ran
		expect(
			notes.filter((n) => n === CONFIRM_NOTES.confirm_unbound),
		).toHaveLength(0);
	});

	it("inverse control (start before bind): the unbound transient IS observable — the ordering matters", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const runner = async (): Promise<StuckConfirmResult> => ({
			action: "suppress",
			reason: "frames_changing",
		});
		const notes = await runTicks({ current: null }, (h) => {
			h.current = runner;
		});
		expect(
			notes.filter((n) => n === CONFIRM_NOTES.confirm_unbound).length,
		).toBeGreaterThan(0);
	});

	it("plugin.ts production ordering: heartbeatService.start() sits AFTER the stuckConfirmHolder binding (source sentinel, Codex R2 #1)", () => {
		// startBridge cannot be booted in a unit test (servers/transports/timers),
		// so the production ordering is pinned STRUCTURALLY: exactly one start()
		// call, and it must come after the holder binding — a revert of the
		// FLY-1234 start() move (back above the judge wiring) fails here. The
		// behavioral halves of this contract are the two tests above.
		const source = readFileSync(join(__dirname, "..", "plugin.ts"), "utf-8");
		// Actual statement only — the identifier also appears in prose comments.
		const startCalls = [
			...source.matchAll(/^\s*heartbeatService\.start\(\);/gm),
		];
		expect(startCalls).toHaveLength(1);
		const bindIdx = source.indexOf("stuckConfirmHolder.current =");
		expect(bindIdx).toBeGreaterThan(-1);
		expect(startCalls[0]!.index).toBeGreaterThan(bindIdx);
		// And the binding itself goes through the tested assembly module.
		expect(source).toContain(
			"stuckConfirmHolder.current = createStuckConfirmRunner({",
		);
	});
});
