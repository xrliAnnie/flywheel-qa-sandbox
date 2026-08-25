import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commDbPathForProject } from "../bridge/commdb-path.js";
import {
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
} from "../bridge/tmux-lookup.js";
import {
	HeartbeatService,
	PARKED_SWEEP_CANDIDATE_CAP,
	type StaleParkedCloseConfig,
} from "../HeartbeatService.js";
import { StateStore } from "../StateStore.js";

/**
 * FLY-1204: the periodic parked-phase reclaim patrol. These are safety
 * counter-examples FIRST — the whole point is to reclaim leaked phase sessions
 * WITHOUT ever killing a healthy parked context-holder.
 *
 * `tmuxState` (keyed by execution_id) drives the mocked tmux liveness so a phase
 * can be alive / dead / read-error / indeterminate deterministically.
 */
const { tmuxState } = vi.hoisted(() => ({
	tmuxState: new Map<string, string>(),
}));
vi.mock("../bridge/tmux-lookup.js", () => ({
	getTmuxTargetFromCommDb: vi.fn(),
	isTmuxWindowAlive: vi.fn(),
	lookupTmuxTarget: vi.fn((execId: string) => {
		const st = tmuxState.get(execId) ?? "dead";
		if (st === "error") return { kind: "error", error: "boom" };
		if (st === "dead") return { kind: "gone" };
		return {
			kind: "found",
			target: { tmuxWindow: execId, sessionName: execId },
		};
	}),
	probeRunnerProcessLiveness: vi.fn(async (tmuxWindow: string) => {
		const st = tmuxState.get(tmuxWindow) ?? "dead";
		if (st === "indeterminate") return "indeterminate";
		if (st === "alive") return "alive";
		return "absent";
	}),
}));

const PROJECT = "flywheel";
const OLD_TS = "2026-01-01 00:00:00"; // well past the 24h grace vs the real clock
const FRESH_TS = "2999-01-01 00:00:00"; // never beyond grace

let commDir: string;

beforeEach(() => {
	commDir = mkdtempSync(join(tmpdir(), "fly1204-parked-"));
	process.env.FLYWHEEL_COMM_DIR = commDir;
	tmuxState.clear();
	vi.mocked(lookupTmuxTarget).mockClear();
	vi.mocked(probeRunnerProcessLiveness).mockClear();
});
afterEach(() => {
	process.env.FLYWHEEL_COMM_DIR = undefined;
	rmSync(commDir, { recursive: true, force: true });
});

async function makeStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

function seed(
	store: StateStore,
	o: {
		execution_id: string;
		issue_id: string;
		status: string;
		chat_thread_role: string;
		workflow_node_id?: string;
		last_activity_at?: string;
	},
): void {
	store.upsertSession({
		execution_id: o.execution_id,
		issue_id: o.issue_id,
		project_name: PROJECT,
		status: o.status,
		session_role: o.chat_thread_role,
		chat_thread_role: o.chat_thread_role,
		workflow_node_id: o.workflow_node_id,
		last_activity_at: o.last_activity_at ?? OLD_TS,
	});
}

function withCommDb(fn: (db: CommDB) => void): void {
	const db = new CommDB(commDbPathForProject(PROJECT));
	try {
		fn(db);
	} finally {
		db.close();
	}
}

function declareParked(execId: string): void {
	withCommDb((db) => db.upsertDeclaredState(execId, "parked", null, 1, null));
}

function makeService(
	store: StateStore,
	cfg: StaleParkedCloseConfig,
	// staleCheckIntervalMs — default 0 so the sweep runs on every call; a real
	// interval exercises the independent throttle (plan §C2 / test plan §259).
	intervalMs = 0,
): HeartbeatService {
	return new HeartbeatService(
		store as never,
		{} as never, // notifier — checkStaleParkedPhases never calls it
		15,
		60_000,
		60,
		undefined,
		24, // staleThresholdHours
		intervalMs, // staleCheckIntervalMs
		undefined,
		48,
		undefined,
		undefined,
		undefined, // staleTerminalClose (decoupled from the parked patrol)
		undefined, // serverLoss
		cfg,
	);
}

function makeConfig(over?: Partial<StaleParkedCloseConfig>): {
	cfg: StaleParkedCloseConfig;
	closeParked: ReturnType<typeof vi.fn>;
	alertOrphan: ReturnType<typeof vi.fn>;
} {
	const closeParked = vi.fn(async () => ({ closed: true }));
	const alertOrphan = vi.fn(async () => {});
	const cfg: StaleParkedCloseConfig = {
		parkedStaleHours: 24,
		commDbPathForProject,
		closeParked,
		alertOrphan,
		...over,
	};
	return { cfg, closeParked, alertOrphan };
}

/** Convenience: exec ids that were passed to closeParked. */
function closedIds(spy: ReturnType<typeof vi.fn>): string[] {
	return spy.mock.calls
		.map((c) => (c[0] as { execution_id: string }).execution_id)
		.sort();
}

describe("FLY-1204 parked-phase reclaim — safety boundaries", () => {
	it("ship-claim path auto-reclaims a workflow-bound generic main actor", async () => {
		const store = await makeStore();
		seed(store, {
			execution_id: "generic",
			issue_id: "FLY-G1",
			status: "ship_parked",
			chat_thread_role: "main",
			workflow_node_id: "execute",
		});
		declareParked("generic");
		store.insertEvent({
			event_id: "claim-FLY-G1",
			execution_id: "generic",
			issue_id: "FLY-G1",
			project_name: PROJECT,
			event_type: "post_ship_finalization_claim",
			source: "test",
		});
		tmuxState.set("generic", "alive");
		const { cfg, closeParked } = makeConfig();
		await makeService(store, cfg).checkStaleParkedPhases();
		expect(closedIds(closeParked)).toEqual(["generic"]);
	});

	it("alerts but does not close a no-claim workflow-bound generic main actor", async () => {
		const store = await makeStore();
		seed(store, {
			execution_id: "generic",
			issue_id: "FLY-G2",
			status: "ship_parked",
			chat_thread_role: "main",
			workflow_node_id: "execute",
		});
		declareParked("generic");
		const { cfg, closeParked, alertOrphan } = makeConfig();
		await makeService(store, cfg).checkStaleParkedPhases();
		expect(closeParked).not.toHaveBeenCalled();
		expect(alertOrphan).toHaveBeenCalledWith(
			"FLY-G2",
			expect.arrayContaining([
				expect.objectContaining({ execution_id: "generic" }),
			]),
		);
	});

	it("an active workflow-bound generic main actor blocks reclaim for its issue", async () => {
		const store = await makeStore();
		seed(store, {
			execution_id: "parked",
			issue_id: "FLY-G3",
			status: "ship_parked",
			chat_thread_role: "main",
			workflow_node_id: "execute",
		});
		seed(store, {
			execution_id: "working",
			issue_id: "FLY-G3",
			status: "running",
			chat_thread_role: "main",
			workflow_node_id: "review",
		});
		declareParked("parked");
		tmuxState.set("working", "alive");
		const { cfg, closeParked, alertOrphan } = makeConfig();
		await makeService(store, cfg).checkStaleParkedPhases();
		expect(closeParked).not.toHaveBeenCalled();
		expect(alertOrphan).not.toHaveBeenCalled();
	});

	it("never patrols an ordinary non-workflow main session", async () => {
		const store = await makeStore();
		seed(store, {
			execution_id: "ordinary",
			issue_id: "FLY-G4",
			status: "ship_parked",
			chat_thread_role: "main",
		});
		declareParked("ordinary");
		tmuxState.set("ordinary", "alive");
		const { cfg, closeParked, alertOrphan } = makeConfig();
		await makeService(store, cfg).checkStaleParkedPhases();
		expect(closeParked).not.toHaveBeenCalled();
		expect(alertOrphan).not.toHaveBeenCalled();
	});

	it("has_working guard: an alive non-parked phase keeps the WHOLE issue (parked design not killed)", async () => {
		const store = await makeStore();
		seed(store, {
			execution_id: "d",
			issue_id: "FLY-1",
			status: "design_done",
			chat_thread_role: "design",
		});
		seed(store, {
			execution_id: "i",
			issue_id: "FLY-1",
			status: "running",
			chat_thread_role: "implement",
		});
		declareParked("d");
		// implement is genuinely working: NOT parked + tmux alive.
		tmuxState.set("i", "alive");
		const { cfg, closeParked, alertOrphan } = makeConfig();
		await makeService(store, cfg).checkStaleParkedPhases();
		expect(closeParked).not.toHaveBeenCalled();
		expect(alertOrphan).not.toHaveBeenCalled();
	});

	it("ship-claim path: auto-reclaims all real-parked/terminal candidates even if a row is alive", async () => {
		const store = await makeStore();
		seed(store, {
			execution_id: "d",
			issue_id: "FLY-2",
			status: "design_done",
			chat_thread_role: "design",
		});
		seed(store, {
			execution_id: "q",
			issue_id: "FLY-2",
			status: "completed",
			chat_thread_role: "qa",
		});
		declareParked("d");
		store.insertEvent({
			event_id: "claim-FLY-2",
			execution_id: "q",
			issue_id: "FLY-2",
			project_name: PROJECT,
			event_type: "post_ship_finalization_claim",
			source: "test",
		});
		// both alive so the cleanup revalidate closes them.
		tmuxState.set("d", "alive");
		tmuxState.set("q", "alive");
		const { cfg, closeParked, alertOrphan } = makeConfig();
		await makeService(store, cfg).checkStaleParkedPhases();
		expect(closedIds(closeParked)).toEqual(["d", "q"]);
		// ship-claim path → noClaim:false
		for (const call of closeParked.mock.calls) {
			expect((call[1] as { noClaim: boolean }).noClaim).toBe(false);
		}
		expect(alertOrphan).not.toHaveBeenCalled();
	});

	it("no-claim narrowing: completed qa auto-reclaimed; design_done only ALERTED (not closed)", async () => {
		const store = await makeStore();
		seed(store, {
			execution_id: "d",
			issue_id: "FLY-3",
			status: "design_done",
			chat_thread_role: "design",
		});
		seed(store, {
			execution_id: "q",
			issue_id: "FLY-3",
			status: "completed",
			chat_thread_role: "qa",
		});
		declareParked("d");
		// no ship claim; pipeline is quiet (design parked, qa terminal) → clean.
		tmuxState.set("q", "alive"); // completed qa leaked alive → revalidate closes it
		const { cfg, closeParked, alertOrphan } = makeConfig();
		await makeService(store, cfg).checkStaleParkedPhases();
		expect(closedIds(closeParked)).toEqual(["q"]);
		expect(
			(closeParked.mock.calls[0]?.[1] as { noClaim: boolean }).noClaim,
		).toBe(true);
		// design_done is a non-terminal parked orphan → alert only, never closed.
		expect(alertOrphan).toHaveBeenCalledTimes(1);
		expect(alertOrphan.mock.calls[0]?.[0]).toBe("FLY-3");
		expect(
			(alertOrphan.mock.calls[0]?.[1] as { execution_id: string }[]).map(
				(s) => s.execution_id,
			),
		).toEqual(["d"]);
	});

	it("declared-state guard: an awaiting_review QA that is NOT declared parked is never closed", async () => {
		const store = await makeStore();
		seed(store, {
			execution_id: "q",
			issue_id: "FLY-4",
			status: "awaiting_review",
			chat_thread_role: "qa",
		});
		// no declared_state row → not parked; probe dead so classify=clean.
		tmuxState.set("q", "dead");
		const { cfg, closeParked, alertOrphan } = makeConfig();
		await makeService(store, cfg).checkStaleParkedPhases();
		expect(closeParked).not.toHaveBeenCalled();
		// not parked → not reclaimable → not even an alert.
		expect(alertOrphan).not.toHaveBeenCalled();
	});

	it("FAIL fix-loop: a running QA declared parked is a candidate; a running QA NOT parked but alive keeps the issue", async () => {
		// (a) running + declared parked → reclaimable orphan (alert path, no claim)
		const storeA = await makeStore();
		seed(storeA, {
			execution_id: "q",
			issue_id: "FLY-5",
			status: "running",
			chat_thread_role: "qa",
		});
		declareParked("q");
		tmuxState.set("q", "dead"); // parked → classify skips the probe anyway
		const a = makeConfig();
		await makeService(storeA, a.cfg).checkStaleParkedPhases();
		expect(a.closeParked).not.toHaveBeenCalled(); // running (non-terminal) → alert, not auto-kill
		expect(a.alertOrphan).toHaveBeenCalledTimes(1);

		// (b) running + NOT parked + probe alive → really working → keep, no alert
		const storeB = await makeStore();
		seed(storeB, {
			execution_id: "q2",
			issue_id: "FLY-6",
			status: "running",
			chat_thread_role: "qa",
		});
		tmuxState.set("q2", "alive");
		const b = makeConfig();
		await makeService(storeB, b.cfg).checkStaleParkedPhases();
		expect(b.closeParked).not.toHaveBeenCalled();
		expect(b.alertOrphan).not.toHaveBeenCalled();
	});

	it("in-flight TURN guard: a fresh TURN whose holder session row is missing defers the whole issue", async () => {
		const store = await makeStore();
		seed(store, {
			execution_id: "q",
			issue_id: "FLY-7",
			status: "completed",
			chat_thread_role: "qa",
		});
		tmuxState.set("q", "alive");
		// A fresh TURN pointing at an unregistered holder = a spawn in progress.
		withCommDb((db) =>
			db.grantTurn("FLY-7", "not-yet-registered", "implement", Date.now()),
		);
		const { cfg, closeParked, alertOrphan } = makeConfig();
		await makeService(store, cfg).checkStaleParkedPhases();
		expect(closeParked).not.toHaveBeenCalled();
		expect(alertOrphan).not.toHaveBeenCalled();
	});

	it("stale TURN does NOT permanently block: completed qa reclaimed despite a stale TURN", async () => {
		const store = await makeStore();
		seed(store, {
			execution_id: "q",
			issue_id: "FLY-8",
			status: "completed",
			chat_thread_role: "qa",
		});
		tmuxState.set("q", "alive");
		// TURN holder IS the (terminal) completed qa row → row exists → stale, not in-flight.
		withCommDb((db) => db.grantTurn("FLY-8", "q", "qa", 1_700_000_000_000));
		const { cfg, closeParked } = makeConfig();
		await makeService(store, cfg).checkStaleParkedPhases();
		expect(closedIds(closeParked)).toEqual(["q"]);
	});

	it("read-error / indeterminate defers: a tmux read error keeps the issue and closes nothing", async () => {
		const store = await makeStore();
		seed(store, {
			execution_id: "i",
			issue_id: "FLY-9",
			status: "running",
			chat_thread_role: "implement",
		});
		// non-parked + lookup error → classifyIssueWorking returns defer.
		tmuxState.set("i", "error");
		const { cfg, closeParked, alertOrphan } = makeConfig();
		await makeService(store, cfg).checkStaleParkedPhases();
		expect(closeParked).not.toHaveBeenCalled();
		expect(alertOrphan).not.toHaveBeenCalled();
	});

	it("cleanup revalidate: a completed candidate whose process already died is NOT closed", async () => {
		const store = await makeStore();
		seed(store, {
			execution_id: "q",
			issue_id: "FLY-10",
			status: "completed",
			chat_thread_role: "qa",
		});
		store.insertEvent({
			event_id: "claim-FLY-10",
			execution_id: "q",
			issue_id: "FLY-10",
			project_name: PROJECT,
			event_type: "post_ship_finalization_claim",
			source: "test",
		});
		tmuxState.set("q", "dead"); // already gone → revalidate skips the close
		const { cfg, closeParked } = makeConfig();
		await makeService(store, cfg).checkStaleParkedPhases();
		expect(closeParked).not.toHaveBeenCalled();
	});

	it("double-probe budget: newest row terminal + next-newest alive non-parked → has_working keeps the issue", async () => {
		const store = await makeStore();
		// two QA rows: newest is terminal (completed), an older one is alive+working.
		seed(store, {
			execution_id: "q-old",
			issue_id: "FLY-11",
			status: "running",
			chat_thread_role: "qa",
			last_activity_at: "2026-06-01 00:00:00",
		});
		seed(store, {
			execution_id: "q-new",
			issue_id: "FLY-11",
			status: "completed",
			chat_thread_role: "qa",
			last_activity_at: "2026-06-02 00:00:00",
		});
		tmuxState.set("q-old", "alive"); // the older, non-terminal, non-parked row is working
		const { cfg, closeParked, alertOrphan } = makeConfig();
		await makeService(store, cfg).checkStaleParkedPhases();
		// has_working (from q-old) → keep everything; the completed q-new is NOT reclaimed.
		expect(closeParked).not.toHaveBeenCalled();
		expect(alertOrphan).not.toHaveBeenCalled();
	});

	it("alert once + durable dedupe across sweeps", async () => {
		const store = await makeStore();
		seed(store, {
			execution_id: "d1",
			issue_id: "FLY-12",
			status: "design_done",
			chat_thread_role: "design",
		});
		seed(store, {
			execution_id: "d2",
			issue_id: "FLY-12",
			status: "awaiting_review",
			chat_thread_role: "implement",
		});
		declareParked("d1");
		declareParked("d2");
		const { cfg, alertOrphan } = makeConfig();
		const svc = makeService(store, cfg);
		await svc.checkStaleParkedPhases();
		await svc.checkStaleParkedPhases(); // same orphan set → dedupe suppresses
		expect(alertOrphan).toHaveBeenCalledTimes(1);
	});

	it("alert failure is NOT deduped: a throwing alertOrphan is retried on the next sweep (Codex R1 fix)", async () => {
		const store = await makeStore();
		seed(store, {
			execution_id: "d",
			issue_id: "FLY-16",
			status: "design_done",
			chat_thread_role: "design",
		});
		declareParked("d");
		const alertOrphan = vi
			.fn()
			.mockRejectedValueOnce(new Error("sink not yet bound"))
			.mockResolvedValueOnce(undefined);
		const { cfg } = makeConfig({ alertOrphan });
		const svc = makeService(store, cfg);
		await svc.checkStaleParkedPhases(); // 1st: alert throws → dedupe NOT recorded
		await svc.checkStaleParkedPhases(); // 2nd: retried (would have been suppressed if deduped)
		expect(alertOrphan).toHaveBeenCalledTimes(2);
	});

	it("time backstop: a fresh (within-grace) no-claim orphan is neither closed nor alerted", async () => {
		const store = await makeStore();
		seed(store, {
			execution_id: "q",
			issue_id: "FLY-13",
			status: "completed",
			chat_thread_role: "qa",
			last_activity_at: FRESH_TS,
		});
		tmuxState.set("q", "alive");
		const { cfg, closeParked, alertOrphan } = makeConfig();
		await makeService(store, cfg).checkStaleParkedPhases();
		expect(closeParked).not.toHaveBeenCalled();
		expect(alertOrphan).not.toHaveBeenCalled();
	});

	it("re-entrancy guard: a second sweep while one is in flight short-circuits (no double close)", async () => {
		// QA phase (FLY-1204): the plan (§C2 parkedSweepRunning / test plan §258)
		// requires a long sweep NOT to be re-entered by the next heartbeat tick.
		// Hold sweep 1 open inside closeParked, then fire sweep 2: it must return
		// immediately on the guard and do NO work (no duplicate close of the same
		// candidate).
		const store = await makeStore();
		seed(store, {
			execution_id: "q",
			issue_id: "FLY-18",
			status: "completed",
			chat_thread_role: "qa",
		});
		store.insertEvent({
			event_id: "claim-FLY-18",
			execution_id: "q",
			issue_id: "FLY-18",
			project_name: PROJECT,
			event_type: "post_ship_finalization_claim",
			source: "test",
		});
		tmuxState.set("q", "alive");

		let releaseClose!: () => void;
		const closeGate = new Promise<void>((r) => {
			releaseClose = r;
		});
		let signalEntered!: () => void;
		const enteredClose = new Promise<void>((r) => {
			signalEntered = r;
		});
		const closeParked = vi.fn(async () => {
			signalEntered(); // sweep 1 is now inside closeParked → parkedSweepRunning=true
			await closeGate; // hold the sweep open across the second call
			return { closed: true };
		});
		const { cfg } = makeConfig({ closeParked });
		const svc = makeService(store, cfg);

		const first = svc.checkStaleParkedPhases();
		await enteredClose; // deterministic: sweep 1 is suspended mid-close
		await svc.checkStaleParkedPhases(); // sweep 2 must short-circuit on the guard
		expect(closeParked).toHaveBeenCalledTimes(1); // sweep 2 did no work
		releaseClose();
		await first;
		expect(closeParked).toHaveBeenCalledTimes(1); // still exactly once total
	});

	it("independent throttle: a second sweep within staleCheckIntervalMs is skipped", async () => {
		// QA phase (FLY-1204): the parked patrol carries its OWN throttle
		// (lastParkedCheckAt) so it does not re-scan on every heartbeat tick
		// (plan §C2 / test plan §259). With a real interval the first sweep runs;
		// an immediate second call within the window is throttled to a no-op.
		const store = await makeStore();
		seed(store, {
			execution_id: "q",
			issue_id: "FLY-19",
			status: "completed",
			chat_thread_role: "qa",
		});
		store.insertEvent({
			event_id: "claim-FLY-19",
			execution_id: "q",
			issue_id: "FLY-19",
			project_name: PROJECT,
			event_type: "post_ship_finalization_claim",
			source: "test",
		});
		tmuxState.set("q", "alive");
		const { cfg, closeParked } = makeConfig();
		const svc = makeService(store, cfg, 3_600_000); // 1h throttle window

		await svc.checkStaleParkedPhases(); // lastParkedCheckAt was 0 → runs
		expect(closeParked).toHaveBeenCalledTimes(1);
		closeParked.mockClear();
		await svc.checkStaleParkedPhases(); // within the 1h window → throttled
		expect(closeParked).not.toHaveBeenCalled();
	});

	it("single issue over the per-sweep cap: bounded per sweep + stable-watermark rotation drains the tail", async () => {
		const store = await makeStore();
		const total = PARKED_SWEEP_CANDIDATE_CAP + 50; // one issue, > the per-sweep cap
		for (let i = 0; i < total; i++) {
			// zero-pad so the execution_id order is deterministic for the assertion.
			const id = `q${String(i).padStart(4, "0")}`;
			seed(store, {
				execution_id: id,
				issue_id: "FLY-17",
				status: "completed",
				chat_thread_role: "qa",
			});
			tmuxState.set(id, "alive");
		}
		// A ship claim → every completed candidate is auto-reclaimable.
		store.insertEvent({
			event_id: "claim-FLY-17",
			execution_id: "q0000",
			issue_id: "FLY-17",
			project_name: PROJECT,
			event_type: "post_ship_finalization_claim",
			source: "test",
		});
		const { cfg, closeParked } = makeConfig();
		const svc = makeService(store, cfg);

		await svc.checkStaleParkedPhases();
		// Sweep 1 is bounded to exactly the per-sweep cap.
		expect(closeParked.mock.calls.length).toBe(PARKED_SWEEP_CANDIDATE_CAP);

		await svc.checkStaleParkedPhases(); // watermark resumes → drains the tail
		// Across both sweeps EVERY candidate was reached (no starvation).
		const closedSet = new Set(closedIds(closeParked));
		expect(closedSet.size).toBe(total);
	});

	it("FLY-1210 root-fix: candidates spread across MANY issues (total > cap) are all reached — no cross-window starvation (Codex R4)", async () => {
		const store = await makeStore();
		// 60 issues × 5 candidates = 300 > cap 200. This is the realistic multi-issue
		// shape Codex R4 flagged (NOT a single mega-issue), each candidate genuinely
		// alive. The stable-watermark rotation must reach every one over two sweeps.
		const issues = 60;
		const perIssue = 5;
		for (let i = 0; i < issues; i++) {
			const issueId = `FLY-9${String(i).padStart(3, "0")}`;
			for (let j = 0; j < perIssue; j++) {
				const id = `x${String(i).padStart(3, "0")}-${j}`;
				seed(store, {
					execution_id: id,
					issue_id: issueId,
					status: "completed",
					chat_thread_role: "qa",
				});
				tmuxState.set(id, "alive");
				// a ship claim per issue → all its candidates are auto-reclaimable.
				store.insertEvent({
					event_id: `claim-${issueId}-${j}`,
					execution_id: id,
					issue_id: issueId,
					project_name: PROJECT,
					event_type: "post_ship_finalization_claim",
					source: "test",
				});
			}
		}
		const total = issues * perIssue;
		const { cfg, closeParked } = makeConfig();
		const svc = makeService(store, cfg);

		await svc.checkStaleParkedPhases(); // cap
		expect(closeParked.mock.calls.length).toBe(PARKED_SWEEP_CANDIDATE_CAP);
		await svc.checkStaleParkedPhases(); // remaining
		expect(new Set(closedIds(closeParked)).size).toBe(total);
	});

	it("unwired (no staleParkedClose) → inert, never throws", async () => {
		const store = await makeStore();
		seed(store, {
			execution_id: "q",
			issue_id: "FLY-15",
			status: "completed",
			chat_thread_role: "qa",
		});
		const svc = new HeartbeatService(
			store as never,
			{} as never,
			15,
			60_000,
			60,
		);
		await expect(svc.checkStaleParkedPhases()).resolves.toBeUndefined();
	});
});
