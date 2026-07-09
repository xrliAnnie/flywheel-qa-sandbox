import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type PhaseLiveness,
	PhaseOrchestrator,
	type PhaseOrchestratorDeps,
	type PhaseSession,
	type ThreeStageVerdictIntent,
} from "../phase-orchestrator.js";

/**
 * FLY-1050: a dead three-stage QA phase row (terminated/failed/completed with
 * no ship claim) must no longer block the implement→QA handoff re-drive. The
 * respawn criteria is "does the pipeline still own itself": alive QA / a
 * latest-FAIL fix-loop / a ship claim → yes (skip); otherwise a stranded
 * implement@awaiting_review gets its handoff re-driven (spawning a fresh QA,
 * epoch+1) — from boot reconcile AND from the scoped event sites
 * (`reconcileQaLoss`). Guards: FAIL-intent skip, respawn cap (3 dead rows),
 * per-issue in-flight, natural idempotency via the alive spawned row.
 *
 * Fixtures follow research.md §3 (F1 = FLY-967, F2 = FLY-1018).
 */

const ISSUE = "FLY-967";
const HEAD = "a1b2c3d4e5f6a7b8";
const ENV_KEY = "FLYWHEEL_THREE_STAGE_QA_RESPAWN";

function implRow(over: Partial<PhaseSession> = {}): PhaseSession {
	return {
		execution_id: "impl-1",
		issue_id: ISSUE,
		project_name: "flywheel",
		session_role: "implement",
		chat_thread_role: "implement",
		status: "awaiting_review",
		review_question_id: "q-1", // genuine runner-driven completion evidence
		...over,
	};
}

function deadQaRow(over: Partial<PhaseSession> = {}): PhaseSession {
	return {
		execution_id: "qa-dead-1",
		issue_id: ISSUE,
		project_name: "flywheel",
		session_role: "qa",
		chat_thread_role: "qa",
		status: "terminated",
		...over,
	};
}

interface HarnessOpts {
	/** All qa-phase rows, NEWEST FIRST (mirrors listPhaseSessionRows order). */
	qaRows?: PhaseSession[];
	implementRows?: PhaseSession[];
	intents?: Record<string, ThreeStageVerdictIntent>;
	shipClaim?: boolean;
	threeStageEnabled?: boolean;
	/** A pre-existing alive QA (wake target) — F5. */
	aliveQa?: PhaseSession;
	ghostLiveness?: PhaseLiveness;
	startDelayMs?: number;
	startFails?: boolean;
}

function makeHarness(opts: HarnessOpts = {}) {
	const qaRows = [...(opts.qaRows ?? [])];
	const implementRows = [...(opts.implementRows ?? [])];
	const sessions = new Map<string, PhaseSession>();
	for (const r of [...qaRows, ...implementRows]) {
		sessions.set(r.execution_id, r);
	}
	const intents = new Map<string, ThreeStageVerdictIntent>(
		Object.entries(opts.intents ?? {}),
	);
	// The freshly-spawned QA row: set once startDispatcher.start resolves, so
	// getAlivePhaseSession/listPhaseSessionRows behave like the real store
	// (the alive row lands and naturally blocks re-triggers).
	let spawnedQa: PhaseSession | undefined;
	const start = vi.fn(
		async (req: {
			issueId: string;
			projectName: string;
			sessionRole: string;
		}) => {
			if (opts.startDelayMs) {
				await new Promise((r) => setTimeout(r, opts.startDelayMs));
			}
			if (opts.startFails) throw new Error("dispatch exploded");
			spawnedQa = {
				execution_id: "qa-new",
				issue_id: req.issueId,
				project_name: req.projectName,
				session_role: req.sessionRole,
				chat_thread_role: req.sessionRole,
				status: "running",
			};
			sessions.set("qa-new", spawnedQa);
			return { executionId: "qa-new" };
		},
	);
	const alertLeadPipelineError = vi.fn(async () => {});
	const capturePhaseHeadSha = vi.fn(async () => HEAD);
	const parkPhaseRunner = vi.fn(async () => {});
	const wakePhaseRunner = vi.fn(async () => ({ ok: true }));
	const closePhaseRunner = vi.fn(async () => {});
	const postIssueThread = vi.fn(async () => {});
	const grantTurn = vi.fn(() => {});
	const getAlivePhaseSession = vi.fn(
		(_issueId: string, phase: string): PhaseSession | undefined => {
			if (phase !== "qa") return undefined;
			if (opts.aliveQa) return opts.aliveQa;
			return spawnedQa;
		},
	);
	const listPhaseSessionRows = vi.fn(
		(_issueId: string, phase: string): PhaseSession[] => {
			if (phase === "qa")
				return spawnedQa ? [spawnedQa, ...qaRows] : [...qaRows];
			if (phase === "implement") return [...implementRows];
			return [];
		},
	);
	const listStrandedImplementPhases = vi.fn(() =>
		implementRows.filter((s) => s.status === "awaiting_review"),
	);
	const deps: PhaseOrchestratorDeps = {
		startDispatcher: { start },
		effects: {
			capturePhaseHeadSha,
			closePhaseRunner,
			alertLeadPipelineError,
			probePhaseAlive: vi.fn(async (): Promise<PhaseLiveness> => "alive"),
			probeGhostTmux: vi.fn(
				async (): Promise<PhaseLiveness> => opts.ghostLiveness ?? "absent",
			),
			parkPhaseRunner,
			wakePhaseRunner,
			assertPhaseWorktreeReady: vi.fn(async () => ({ ok: true })),
		},
		resolveThreeStage: () => ({
			enabled: opts.threeStageEnabled ?? true,
			...(opts.threeStageEnabled === false
				? { reason: "per-project off (test)" }
				: {}),
		}),
		listStrandedDesignPhases: () => [],
		listStrandedImplementPhases,
		listPhaseSessionRows,
		resolveLeadId: () => "eng-lead",
		keepAliveEnabled: () => true,
		getAlivePhaseSession,
		hasShipFinalizationClaim: vi.fn(() => opts.shipClaim ?? false),
		refreshPhaseStatusLine: vi.fn(async () => {}),
		grantTurn,
		turnBelt: {
			listTurns: vi.fn(() => []),
			getTurn: vi.fn(() => null),
			deleteTurn: vi.fn(() => {}),
			getSessionForTurnHolder: vi.fn((): PhaseSession | undefined => undefined),
			getPhaseSessionsForIssue: vi.fn((): PhaseSession[] => []),
		},
		qaVerdicts: {
			getSession: vi.fn((id: string) => sessions.get(id)),
			readIntent: vi.fn((id: string) => intents.get(id)),
			patchIntent: vi.fn((id, patch) => {
				intents.set(id, {
					...(intents.get(id) ?? {}),
					...patch,
				} as ThreeStageVerdictIntent);
			}),
			countImplementPhases: vi.fn(() => 1),
			recordFixRound: vi.fn(() => 1),
			getActiveImplementSession: vi.fn(
				(): PhaseSession | undefined => undefined,
			),
			listVerdictEventCandidates: vi.fn((): PhaseSession[] => []),
			getLatestQaResultEvent: vi.fn(() => undefined),
			listStrandedPassCandidates: vi.fn((): PhaseSession[] => []),
			postIssueThread,
			hasGateResponse: vi.fn(() => false),
		},
	};
	return {
		deps,
		start,
		alertLeadPipelineError,
		capturePhaseHeadSha,
		parkPhaseRunner,
		wakePhaseRunner,
		closePhaseRunner,
		postIssueThread,
		grantTurn,
		getAlivePhaseSession,
		listStrandedImplementPhases,
		intents,
		sessions,
	};
}

let savedEnv: string | undefined;
beforeEach(() => {
	savedEnv = process.env[ENV_KEY];
	delete process.env[ENV_KEY];
});
afterEach(() => {
	if (savedEnv === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = savedEnv;
});

// ─────────────────────────────────────────────────────────────────────────────
// F1 — the FLY-967 shape (qa terminated + intent pass)
// ─────────────────────────────────────────────────────────────────────────────
describe("FLY-1050 F1: qa terminated (intent pass) → clean QA respawn", () => {
	it("scoped reconcileQaLoss spawns exactly one QA at the implement head, re-parks implement, posts the respawn note", async () => {
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [deadQaRow()],
			intents: {
				"qa-dead-1": { status: "pass", event_id: "e1", at: "t0" },
			},
		});
		await new PhaseOrchestrator(h.deps).reconcileQaLoss({
			issueId: ISSUE,
			terminalExecId: "qa-dead-1",
		});
		expect(h.start).toHaveBeenCalledOnce();
		expect(h.start.mock.calls[0]![0]).toMatchObject({
			sessionRole: "qa",
			startPoint: HEAD, // capturePhaseHeadSha(implement) — the latest valid head
			shareParentBranch: true,
			ignoreRunnerLabelSelection: true,
		});
		// implement is idempotently re-parked, never closed/woken by the redrive
		expect(h.parkPhaseRunner).toHaveBeenCalledOnce();
		expect(h.wakePhaseRunner).not.toHaveBeenCalled();
		expect(h.closePhaseRunner).not.toHaveBeenCalled();
		// respawn note posted; no fail-closed alert
		expect(h.postIssueThread).toHaveBeenCalledOnce();
		expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
	});

	it("F1-boot: the same fixture through reconcileOnStartup spawns the same QA (boot and scoped share the criteria)", async () => {
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [deadQaRow()],
			intents: {
				"qa-dead-1": { status: "pass", event_id: "e1", at: "t0" },
			},
		});
		await new PhaseOrchestrator(h.deps).reconcileOnStartup();
		expect(h.start).toHaveBeenCalledOnce();
		expect(h.start.mock.calls[0]![0]).toMatchObject({ sessionRole: "qa" });
		expect(h.postIssueThread).toHaveBeenCalledOnce();
	});

	it("spawn failure → fail-closed alert, NO respawn note", async () => {
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [deadQaRow()],
			startFails: true,
		});
		await new PhaseOrchestrator(h.deps).reconcileQaLoss({
			issueId: ISSUE,
			terminalExecId: "qa-dead-1",
		});
		expect(h.alertLeadPipelineError).toHaveBeenCalledOnce();
		expect(h.postIssueThread).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// F2/F3 — the FLY-1018 shape + the respawn cap
// ─────────────────────────────────────────────────────────────────────────────
describe("FLY-1050 F2/F3: dead-row count vs the respawn cap", () => {
	it("F2: two dead failed qa rows (no intent) → respawn (2 < cap)", async () => {
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [
				deadQaRow({ execution_id: "qa-dead-2", status: "failed" }),
				deadQaRow({ execution_id: "qa-dead-1", status: "failed" }),
			],
		});
		await new PhaseOrchestrator(h.deps).reconcileQaLoss({
			issueId: ISSUE,
			terminalExecId: "qa-dead-2",
		});
		expect(h.start).toHaveBeenCalledOnce();
	});

	it("F3: three dead qa rows → NO respawn + fail-closed cap alert (every trigger re-alerts)", async () => {
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [
				deadQaRow({ execution_id: "qa-dead-3" }),
				deadQaRow({ execution_id: "qa-dead-2", status: "failed" }),
				deadQaRow({ execution_id: "qa-dead-1", status: "failed" }),
			],
		});
		const orch = new PhaseOrchestrator(h.deps);
		await orch.reconcileQaLoss({ issueId: ISSUE, terminalExecId: "qa-dead-3" });
		expect(h.start).not.toHaveBeenCalled();
		expect(h.alertLeadPipelineError).toHaveBeenCalledOnce();
		expect(
			(h.alertLeadPipelineError.mock.calls[0]![0] as { reason: string }).reason,
		).toContain("respawn cap");
		// discrete events re-alert until someone acts
		await orch.reconcileQaLoss({ issueId: ISSUE, terminalExecId: "qa-dead-3" });
		expect(h.alertLeadPipelineError).toHaveBeenCalledTimes(2);
		expect(h.start).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// F4 — the FAIL-intent fix-loop domain is never touched
// ─────────────────────────────────────────────────────────────────────────────
describe("FLY-1050 F4: latest FAIL intent owns the pipeline — no respawn", () => {
	it("F4: latest qa row intent {fail, fixExecId} → no spawn, no alert (fix-loop domain)", async () => {
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [deadQaRow({ status: "failed" })],
			intents: {
				"qa-dead-1": {
					status: "fail",
					event_id: "e1",
					at: "t0",
					fixExecId: "fix-1",
				},
			},
		});
		await new PhaseOrchestrator(h.deps).reconcileQaLoss({
			issueId: ISSUE,
			terminalExecId: "qa-dead-1",
		});
		expect(h.start).not.toHaveBeenCalled();
		expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
	});

	it("F4b: latest qa row intent {fail} WITHOUT fixExecId → still no spawn (verdict-sweep domain)", async () => {
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [deadQaRow({ status: "failed" })],
			intents: {
				"qa-dead-1": { status: "fail", event_id: "e1", at: "t0" },
			},
		});
		await new PhaseOrchestrator(h.deps).reconcileQaLoss({
			issueId: ISSUE,
			terminalExecId: "qa-dead-1",
		});
		expect(h.start).not.toHaveBeenCalled();
	});

	it("F4c latest-only: an OLD row's legitimate FAIL never blocks a NEW dead QA's respawn", async () => {
		// newest first: the latest dead row has NO intent; an older round carries
		// a completed FAIL {fail, fixExecId}. Scanning all history would block
		// the respawn forever (Codex R1 #3) — only qaRows[0] may be consulted.
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [
				deadQaRow({ execution_id: "qa-dead-2" }),
				deadQaRow({ execution_id: "qa-old-fail", status: "failed" }),
			],
			intents: {
				"qa-old-fail": {
					status: "fail",
					event_id: "e0",
					at: "t0",
					fixExecId: "fix-0",
				},
			},
		});
		await new PhaseOrchestrator(h.deps).reconcileQaLoss({
			issueId: ISSUE,
			terminalExecId: "qa-dead-2",
		});
		expect(h.start).toHaveBeenCalledOnce();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// F5/F6 — the pipeline already owns itself
// ─────────────────────────────────────────────────────────────────────────────
describe("FLY-1050 F5/F6: alive QA / ship claim → skip", () => {
	it("F5: an alive QA is on duty → no spawn", async () => {
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [deadQaRow()],
			aliveQa: deadQaRow({
				execution_id: "qa-alive",
				status: "awaiting_review",
			}),
		});
		await new PhaseOrchestrator(h.deps).reconcileQaLoss({
			issueId: ISSUE,
			terminalExecId: "qa-dead-1",
		});
		expect(h.start).not.toHaveBeenCalled();
	});

	it("F6: a ship-finalization claim exists → no spawn", async () => {
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [deadQaRow()],
			shipClaim: true,
		});
		await new PhaseOrchestrator(h.deps).reconcileQaLoss({
			issueId: ISSUE,
			terminalExecId: "qa-dead-1",
		});
		expect(h.start).not.toHaveBeenCalled();
	});

	it("no stranded implement (nothing at awaiting_review) → no-op", async () => {
		const h = makeHarness({
			implementRows: [implRow({ status: "running" })],
			qaRows: [deadQaRow()],
		});
		await new PhaseOrchestrator(h.deps).reconcileQaLoss({
			issueId: ISSUE,
			terminalExecId: "qa-dead-1",
		});
		expect(h.start).not.toHaveBeenCalled();
		expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// F7 — byte-compat sentinels
// ─────────────────────────────────────────────────────────────────────────────
describe("FLY-1050 F7: byte-compat sentinels", () => {
	it("a dead chat_thread_role='main' row → reconcileQaLoss is a full no-op", async () => {
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [],
		});
		h.sessions.set(
			"main-dead",
			deadQaRow({ execution_id: "main-dead", chat_thread_role: "main" }),
		);
		await new PhaseOrchestrator(h.deps).reconcileQaLoss({
			issueId: ISSUE,
			terminalExecId: "main-dead",
		});
		expect(h.start).not.toHaveBeenCalled();
		expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
	});

	it("a NON-terminal qa row (FSM-rejected zombie) → reconcileQaLoss refuses to re-drive", async () => {
		const zombie = deadQaRow({
			execution_id: "qa-zombie",
			status: "awaiting_review",
		});
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [zombie],
		});
		await new PhaseOrchestrator(h.deps).reconcileQaLoss({
			issueId: ISSUE,
			terminalExecId: "qa-zombie",
		});
		expect(h.start).not.toHaveBeenCalled();
	});

	it("three-stage OFF project → the policy gate inside onPhaseComplete refuses (disabled-warn, no spawn)", async () => {
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [deadQaRow()],
			threeStageEnabled: false,
		});
		await new PhaseOrchestrator(h.deps).reconcileQaLoss({
			issueId: ISSUE,
			terminalExecId: "qa-dead-1",
		});
		expect(h.start).not.toHaveBeenCalled();
		expect(h.postIssueThread).not.toHaveBeenCalled();
	});

	it("escape hatch =0: scoped reconcileQaLoss is inert", async () => {
		process.env[ENV_KEY] = "0";
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [deadQaRow()],
		});
		await new PhaseOrchestrator(h.deps).reconcileQaLoss({
			issueId: ISSUE,
			terminalExecId: "qa-dead-1",
		});
		expect(h.start).not.toHaveBeenCalled();
	});

	it("escape hatch =0: boot criteria reverts to row-exists (F1 fixture → skip)", async () => {
		process.env[ENV_KEY] = "0";
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [deadQaRow()],
		});
		await new PhaseOrchestrator(h.deps).reconcileOnStartup();
		expect(h.start).not.toHaveBeenCalled();
	});

	it("escape hatch =0: the G-A2 zero-qa-row boot re-drive still works (pre-fix behavior preserved)", async () => {
		process.env[ENV_KEY] = "0";
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [],
		});
		await new PhaseOrchestrator(h.deps).reconcileOnStartup();
		expect(h.start).toHaveBeenCalledOnce();
		// a plain G-A2 re-drive is NOT a respawn — no respawn thread note
		expect(h.postIssueThread).not.toHaveBeenCalled();
	});

	it("G-A2 unchanged with respawn ON: zero qa rows → re-drive, no respawn note", async () => {
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [],
		});
		await new PhaseOrchestrator(h.deps).reconcileOnStartup();
		expect(h.start).toHaveBeenCalledOnce();
		expect(h.postIssueThread).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency + idempotency
// ─────────────────────────────────────────────────────────────────────────────
describe("FLY-1050: concurrency + idempotency", () => {
	it("two concurrent reconcileQaLoss on the same issue → exactly one spawn (in-flight guard)", async () => {
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [deadQaRow()],
			startDelayMs: 20,
		});
		const orch = new PhaseOrchestrator(h.deps);
		await Promise.all([
			orch.reconcileQaLoss({ issueId: ISSUE, terminalExecId: "qa-dead-1" }),
			orch.reconcileQaLoss({ issueId: ISSUE, terminalExecId: "qa-dead-1" }),
		]);
		expect(h.start).toHaveBeenCalledOnce();
	});

	it("after a successful respawn (alive qa row landed) a re-trigger is a no-op", async () => {
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [deadQaRow()],
		});
		const orch = new PhaseOrchestrator(h.deps);
		await orch.reconcileQaLoss({ issueId: ISSUE, terminalExecId: "qa-dead-1" });
		await orch.reconcileQaLoss({ issueId: ISSUE, terminalExecId: "qa-dead-1" });
		expect(h.start).toHaveBeenCalledOnce();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// F9 — merged-but-awaiting_review implement (FLY-1023 shape): delivered, never respawn
// ─────────────────────────────────────────────────────────────────────────────
describe("FLY-1050 F9: a merge-blocked implement (PR merged, stuck awaiting_review) never respawns QA", () => {
	const mergedImpl = () =>
		implRow({ merge_block_reason: "merge_without_approval:off/off" });

	it("scoped reconcileQaLoss on a dead qa row → NO spawn, NO alert (delivered; merge-block flow owns it)", async () => {
		const h = makeHarness({
			implementRows: [mergedImpl()],
			qaRows: [deadQaRow()],
		});
		await new PhaseOrchestrator(h.deps).reconcileQaLoss({
			issueId: ISSUE,
			terminalExecId: "qa-dead-1",
		});
		expect(h.start).not.toHaveBeenCalled();
		expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
		expect(h.postIssueThread).not.toHaveBeenCalled();
	});

	it("boot reconcile → NO spawn, NO alert (same guard, boot path)", async () => {
		const h = makeHarness({
			implementRows: [mergedImpl()],
			qaRows: [deadQaRow()],
		});
		await new PhaseOrchestrator(h.deps).reconcileOnStartup();
		expect(h.start).not.toHaveBeenCalled();
		expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
	});

	it("zero qa rows (G-A2 candidate) but merge-blocked → NO spawn (a merged branch never gets a QA)", async () => {
		const h = makeHarness({
			implementRows: [mergedImpl()],
			qaRows: [],
		});
		await new PhaseOrchestrator(h.deps).reconcileOnStartup();
		expect(h.start).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Existing gates keep guarding the redrive
// ─────────────────────────────────────────────────────────────────────────────
describe("FLY-1050: the redrive passes through the existing handoff gates", () => {
	it("evidence gate: implement without a review binding → failClosed, no spawn", async () => {
		const h = makeHarness({
			implementRows: [implRow({ review_question_id: undefined })],
			qaRows: [deadQaRow()],
		});
		await new PhaseOrchestrator(h.deps).reconcileQaLoss({
			issueId: ISSUE,
			terminalExecId: "qa-dead-1",
		});
		expect(h.start).not.toHaveBeenCalled();
		expect(h.alertLeadPipelineError).toHaveBeenCalledOnce();
		expect(
			(h.alertLeadPipelineError.mock.calls[0]![0] as { reason: string }).reason,
		).toContain("review evidence");
	});

	it("ghost gate: the dead qa row still has a LIVE tmux → failClosed, no spawn", async () => {
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [deadQaRow({ tmux_session: "cmux-qa-ghost" })],
			ghostLiveness: "alive",
		});
		await new PhaseOrchestrator(h.deps).reconcileQaLoss({
			issueId: ISSUE,
			terminalExecId: "qa-dead-1",
		});
		expect(h.start).not.toHaveBeenCalled();
		expect(h.alertLeadPipelineError).toHaveBeenCalledOnce();
		expect(h.postIssueThread).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Turn belt: terminated holders stay on the liveness-probe path (Codex R1 #1)
// ─────────────────────────────────────────────────────────────────────────────
describe("FLY-1050 belt: terminated holder is NEVER fast-tracked stale", () => {
	function beltHarness(holderLiveness: PhaseLiveness) {
		const holder = deadQaRow(); // status terminated
		const impl = implRow(); // parked awaiting_review — the recovery candidate
		const h = makeHarness({ implementRows: [impl], qaRows: [holder] });
		h.deps.turnBelt.getTurn = vi.fn(() => ({
			issue_id: ISSUE,
			holder_exec_id: holder.execution_id,
			phase: "qa",
			epoch: 3,
			granted_at: Date.now(),
		}));
		h.deps.turnBelt.getSessionForTurnHolder = vi.fn(() => holder);
		h.deps.turnBelt.getPhaseSessionsForIssue = vi.fn(() => [holder, impl]);
		h.deps.effects.probePhaseAlive = vi.fn(
			async (s: PhaseSession): Promise<PhaseLiveness> =>
				s.execution_id === impl.execution_id ? "alive" : holderLiveness,
		);
		return h;
	}

	it("terminated holder + probe alive (cleanupPending shape) → TURN untouched, no STALE-TURN alert", async () => {
		const h = beltHarness("alive");
		await new PhaseOrchestrator(h.deps).reconcileTurnBelt({
			issueId: ISSUE,
			projectName: "flywheel",
			terminalExecId: "qa-dead-1",
		});
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.deps.turnBelt.deleteTurn).not.toHaveBeenCalled();
		expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
	});

	it("terminated holder + probe indeterminate → TURN untouched, no alert (fail-closed)", async () => {
		const h = beltHarness("indeterminate");
		await new PhaseOrchestrator(h.deps).reconcileTurnBelt({
			issueId: ISSUE,
			projectName: "flywheel",
			terminalExecId: "qa-dead-1",
		});
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
	});

	it("terminated holder + probe absent → normal recovery to the parked implement", async () => {
		const h = beltHarness("absent");
		await new PhaseOrchestrator(h.deps).reconcileTurnBelt({
			issueId: ISSUE,
			projectName: "flywheel",
			terminalExecId: "qa-dead-1",
		});
		expect(h.grantTurn).toHaveBeenCalledOnce();
		expect(h.grantTurn.mock.calls[0]![0]).toMatchObject({
			execId: "impl-1",
			phase: "implement",
		});
	});

	it("redrive success first → scoped belt reconcile no-ops via guard 1 (holder already the fresh spawn)", async () => {
		const h = makeHarness({
			implementRows: [implRow()],
			qaRows: [deadQaRow()],
		});
		const orch = new PhaseOrchestrator(h.deps);
		await orch.reconcileQaLoss({ issueId: ISSUE, terminalExecId: "qa-dead-1" });
		expect(h.start).toHaveBeenCalledOnce();
		// The dispatcher pre-launch seam overwrote the holder to the fresh spawn.
		h.deps.turnBelt.getTurn = vi.fn(() => ({
			issue_id: ISSUE,
			holder_exec_id: "qa-new",
			phase: "qa",
			epoch: 4,
			granted_at: Date.now(),
		}));
		await orch.reconcileTurnBelt({
			issueId: ISSUE,
			projectName: "flywheel",
			terminalExecId: "qa-dead-1",
		});
		expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
		expect(h.deps.turnBelt.deleteTurn).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Stranded-pass hardening: terminated joins the alert domain (root cause ③)
// ─────────────────────────────────────────────────────────────────────────────
describe("FLY-1050: stranded-pass alert covers terminated + suppresses on a live successor", () => {
	it("qa terminated + intent pass + no binding + no live successor → alert fires (was silent pre-fix)", async () => {
		const row = deadQaRow(); // terminated
		const h = makeHarness({
			qaRows: [row],
			intents: {
				"qa-dead-1": { status: "pass", event_id: "e1", at: "t0" },
			},
		});
		await new PhaseOrchestrator(h.deps).onPhaseComplete(row);
		expect(h.alertLeadPipelineError).toHaveBeenCalledOnce();
		expect(
			(h.alertLeadPipelineError.mock.calls[0]![0] as { reason: string }).reason,
		).toContain("terminated");
		expect(h.intents.get("qa-dead-1")?.alertedAt).toBeTruthy();
	});

	it("a live successor QA exists → not stranded, no alert (it owns the re-verify)", async () => {
		const row = deadQaRow();
		const h = makeHarness({
			qaRows: [row],
			intents: {
				"qa-dead-1": { status: "pass", event_id: "e1", at: "t0" },
			},
			aliveQa: deadQaRow({
				execution_id: "qa-alive",
				status: "awaiting_review",
			}),
		});
		await new PhaseOrchestrator(h.deps).onPhaseComplete(row);
		expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
		expect(h.intents.get("qa-dead-1")?.alertedAt).toBeUndefined();
	});

	it("the terminated stranded-pass hardening is NOT gated by the respawn escape hatch (=0)", async () => {
		process.env[ENV_KEY] = "0";
		const row = deadQaRow();
		const h = makeHarness({
			qaRows: [row],
			intents: {
				"qa-dead-1": { status: "pass", event_id: "e1", at: "t0" },
			},
		});
		await new PhaseOrchestrator(h.deps).onPhaseComplete(row);
		expect(h.alertLeadPipelineError).toHaveBeenCalledOnce();
	});
});
