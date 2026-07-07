/**
 * FLY-921 adversarial / scenario suite — orchestrator-level replay of the
 * FLY-543 incident chain over a REAL CommDB turn table (the same
 * better-sqlite3 store production uses), so the recovered TURN is asserted on
 * the actual runner-facing contract (`getTurn` — what `flywheel-comm turn`
 * reads), not on a mock.
 *
 * Scenario 4 (nested-session callback does not settle) lives at its own
 * layer: packages/edge-worker HookCallbackServer.test.ts + claude-runner
 * TmuxAdapter.test.ts (Fix A).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PhaseOrchestrator,
	type PhaseOrchestratorDeps,
	type PhaseSession,
	type ThreeStageVerdictIntent,
} from "../bridge/phase-orchestrator.js";

const ISSUE = "FLY-543";
const PROJECT = "flywheel";
const OLD_GRANT = () => Date.now() - 10 * 60_000;

function makeQaVerdicts(): PhaseOrchestratorDeps["qaVerdicts"] {
	const intents = new Map<string, ThreeStageVerdictIntent>();
	return {
		getSession: vi.fn(() => undefined),
		readIntent: vi.fn((id: string) => intents.get(id)),
		patchIntent: vi.fn(
			(id: string, patch: Partial<ThreeStageVerdictIntent>) => {
				intents.set(id, {
					...(intents.get(id) ?? {}),
					...patch,
				} as ThreeStageVerdictIntent);
			},
		),
		countImplementPhases: vi.fn(() => 1),
		recordFixRound: vi.fn(() => 1),
		getActiveImplementSession: vi.fn(() => undefined),
		listVerdictEventCandidates: vi.fn(() => []),
		getLatestQaResultEvent: vi.fn(() => undefined),
		listStrandedPassCandidates: vi.fn(() => []),
		postIssueThread: vi.fn(async () => {}),
		hasGateResponse: vi.fn(() => false),
	};
}

describe("FLY-921 adversarial — FLY-543 incident replay (real CommDB turn table)", () => {
	let tmpDir: string;
	let db: CommDB;
	/** In-memory session table (execution_id → row). */
	let sessions: Map<string, PhaseSession>;
	/** Per-exec probed liveness (default absent). */
	let liveness: Map<string, "alive" | "dead_pin" | "absent" | "indeterminate">;
	let alerts: string[];
	let started: Array<Record<string, unknown>>;
	let woken: Array<Record<string, unknown>>;
	let granted: Array<Record<string, unknown>>;
	let orchestrator: PhaseOrchestrator;
	let keepAlive: boolean;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly921-adv-"));
		db = new CommDB(join(tmpDir, "comm.db"));
		sessions = new Map();
		liveness = new Map();
		alerts = [];
		started = [];
		woken = [];
		granted = [];
		keepAlive = true;

		orchestrator = new PhaseOrchestrator({
			startDispatcher: {
				start: async (req) => {
					started.push(req as unknown as Record<string, unknown>);
					return { executionId: "spawned-exec" };
				},
			},
			effects: {
				capturePhaseHeadSha: async () => "f".repeat(40),
				closePhaseRunner: async () => {},
				alertLeadPipelineError: async ({ reason }) => {
					alerts.push(reason);
				},
				probePhaseAlive: async (s) => liveness.get(s.execution_id) ?? "absent",
				probeGhostTmux: async (s) => liveness.get(s.execution_id) ?? "absent",
				parkPhaseRunner: async () => {},
				wakePhaseRunner: async (args) => {
					woken.push(args as unknown as Record<string, unknown>);
					return { ok: true };
				},
				assertPhaseWorktreeReady: async () => ({ ok: true }),
			},
			resolveThreeStage: () => ({ enabled: true }),
			listStrandedDesignPhases: () => [],
			// FLY-939: adversarial replay predates G-A2/G-C — empty lists keep the
			// ghost guard + stranded-implement reconcile no-ops (byte-compat).
			listStrandedImplementPhases: () => [],
			listPhaseSessionRows: () => [],
			resolveLeadId: () => "eng-lead",
			keepAliveEnabled: () => keepAlive,
			getAlivePhaseSession: (issueId, phase) => {
				const ALIVE = new Set([
					"running",
					"awaiting_review",
					"approved_to_ship",
					"design_done",
				]);
				return [...sessions.values()].find(
					(s) =>
						s.issue_id === issueId &&
						s.chat_thread_role === phase &&
						ALIVE.has(s.status),
				);
			},
			hasShipFinalizationClaim: () => false,
			refreshPhaseStatusLine: async () => {},
			grantTurn: ({ issueId, execId, phase, projectName }) => {
				granted.push({ issueId, execId, phase, projectName });
				db.grantTurn(issueId, execId, phase, Date.now());
			},
			turnBelt: {
				listTurns: () =>
					db.listTurns().map((turn) => ({ projectName: PROJECT, turn })),
				getTurn: (issueId) => db.getTurn(issueId),
				deleteTurn: (issueId) => db.deleteTurn(issueId),
				getSessionForTurnHolder: (execId) => sessions.get(execId),
				getPhaseSessionsForIssue: (issueId) =>
					[...sessions.values()].filter((s) => s.issue_id === issueId),
			},
			qaVerdicts: makeQaVerdicts(),
		});
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function seed(over: Partial<PhaseSession> & { execution_id: string }) {
		const row: PhaseSession = {
			issue_id: ISSUE,
			project_name: PROJECT,
			status: "running",
			...over,
		};
		sessions.set(row.execution_id, row);
		return row;
	}

	function seedParkedAliveDesign() {
		liveness.set("design-1", "alive");
		return seed({
			execution_id: "design-1",
			session_role: "design",
			chat_thread_role: "design",
			status: "design_done",
		});
	}

	it("scenario 1 — FLY-543 replay: synthesized needs_review starts NO QA + alerts; killed holder then frees the TURN to the parked design", async () => {
		const design = seedParkedAliveDesign();
		const impl = seed({
			execution_id: "impl-1",
			session_role: "implement",
			chat_thread_role: "implement",
			status: "awaiting_review", // synthesized — NO review_question_id
		});
		db.grantTurn(ISSUE, impl.execution_id, "implement", OLD_GRANT());
		const epochBefore = db.getTurn(ISSUE)!.epoch;

		// ① The synthesized completion reaches the handoff boundary: evidence
		// gate refuses — QA is never spawned/woken, the Lead is alerted.
		await orchestrator.onPhaseComplete(impl);
		expect(started).toHaveLength(0);
		expect(woken).toHaveLength(0);
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toContain("WITHOUT runner-driven review evidence");

		// ② The Lead kills the stuck implement (status → failed); the terminal
		// event position runs the scoped reconcile: the TURN moves to the
		// probed-alive parked design — the FLY-543 operator no longer hand-edits
		// SQL.
		impl.status = "failed";
		await orchestrator.reconcileTurnBelt({
			issueId: ISSUE,
			projectName: PROJECT,
			terminalExecId: impl.execution_id,
		});
		const turn = db.getTurn(ISSUE);
		expect(turn!.holder_exec_id).toBe(design.execution_id);
		expect(turn!.phase).toBe("design");
		expect(turn!.epoch).toBe(epochBefore + 1);
	});

	it("scenario 2 — kill-holder recovery: failed+absent QA holder → design re-granted, epoch+1, ONE alert; re-run is idempotent (no double alert)", async () => {
		const design = seedParkedAliveDesign();
		const qa = seed({
			execution_id: "qa-1",
			session_role: "qa",
			chat_thread_role: "qa",
			status: "failed",
		});
		liveness.set("qa-1", "absent");
		db.grantTurn(ISSUE, qa.execution_id, "qa", OLD_GRANT());
		db.grantTurn(ISSUE, qa.execution_id, "qa", OLD_GRANT()); // epoch 2
		db.grantTurn(ISSUE, qa.execution_id, "qa", OLD_GRANT()); // epoch 3 (FLY-543 shape)

		await orchestrator.reconcileTurnBelt();
		const turn = db.getTurn(ISSUE);
		expect(turn!.holder_exec_id).toBe(design.execution_id);
		expect(turn!.epoch).toBe(4);
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toContain("qa-1");
		expect(alerts[0]).toContain("design-1");

		// Second reconcile: the new holder is probed alive → no action, no alert.
		await orchestrator.reconcileTurnBelt();
		expect(db.getTurn(ISSUE)!.epoch).toBe(4);
		expect(alerts).toHaveLength(1);
	});

	it("scenario 3 — founder mid-scope change: parked design polling `turn` gets it back after reconcile (no manual DB edit)", async () => {
		const design = seedParkedAliveDesign();
		// The dead QA still holds the TURN (FLY-543: `turn` answered
		// `not-yours holder=b6888f1e epoch=3` forever).
		seed({
			execution_id: "qa-dead",
			session_role: "qa",
			chat_thread_role: "qa",
			status: "failed",
		});
		db.grantTurn(ISSUE, "qa-dead", "qa", OLD_GRANT());

		// Pre-fix contract: design polling the turn is NOT the holder.
		expect(db.getTurn(ISSUE)!.holder_exec_id).not.toBe(design.execution_id);

		await orchestrator.reconcileTurnBelt();

		// Post-fix: the holder IS the design exec — exactly what makes the
		// runner-side `flywheel-comm turn` self-check answer `yours`.
		expect(db.getTurn(ISSUE)!.holder_exec_id).toBe(design.execution_id);
	});

	it("scenario 5 — synthesized completion does not advance the phase with keep-alive OFF either", async () => {
		keepAlive = false;
		seedParkedAliveDesign();
		const impl = seed({
			execution_id: "impl-1",
			session_role: "implement",
			chat_thread_role: "implement",
			status: "awaiting_review", // synthesized — no binding
		});
		await orchestrator.onPhaseComplete(impl);
		expect(started).toHaveLength(0);
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toContain("WITHOUT runner-driven review evidence");
	});

	it("scenario 6 — indeterminate holder probe: TURN untouched, zero alerts", async () => {
		seedParkedAliveDesign();
		const qa = seed({
			execution_id: "qa-maybe",
			session_role: "qa",
			chat_thread_role: "qa",
			status: "running",
		});
		liveness.set("qa-maybe", "indeterminate");
		db.grantTurn(ISSUE, qa.execution_id, "qa", OLD_GRANT());

		await orchestrator.reconcileTurnBelt();

		const turn = db.getTurn(ISSUE);
		expect(turn!.holder_exec_id).toBe("qa-maybe");
		expect(turn!.epoch).toBe(1);
		expect(alerts).toHaveLength(0);
		expect(granted).toHaveLength(0);
	});
});
