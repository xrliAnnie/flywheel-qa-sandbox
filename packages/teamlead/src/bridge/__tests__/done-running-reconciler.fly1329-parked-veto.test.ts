import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../../applyTransition.js";
import { DirectiveExecutor } from "../../DirectiveExecutor.js";
import { StateStore } from "../../StateStore.js";
import { reconcileDoneButRunning } from "../done-running-reconciler.js";

/**
 * FLY-1329 (A5): the FLY-324 boot sweep must not force-complete a session whose
 * runner has DECLARED itself parked.
 *
 * The sweep's own comment states the gap it shipped with: "'Parked vs
 * truly-done' is human knowledge the Lead has, not a signal any DB column
 * carries reliably." So the only protection was a hand-maintained
 * `FLYWHEEL_FLY324_SWEEP_EXCLUDE` env list that a human had to remember to fill
 * in before every cutover restart — and a park-alive runner's survival across a
 * Bridge restart rode on that memory.
 *
 * That premise is no longer true. `runner_declared_states` carries exactly this
 * signal: `flywheel-comm park` writes an explicit, unexpired park declaration —
 * the runner stating "I am alive and waiting". The sweep now reads it and vetoes
 * itself. The env exclude list stays as a Lead override.
 *
 * Real StateStore + real WorkflowFSM (matching the existing FLY-324 suite): the
 * transition must be genuinely refused, not merely un-dispatched to a spy.
 */
describe("FLY-1329 A5: FLY-324 boot sweep respects a park declaration", () => {
	let store: StateStore;
	let transitionOpts: ApplyTransitionOpts;
	let markerDir: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
		transitionOpts = { store, fsm, executor: new DirectiveExecutor(store) };
		markerDir = mkdtempSync(join(tmpdir(), "fly1329-markers-"));
	});

	afterEach(() => {
		store.close();
		rmSync(markerDir, { recursive: true, force: true });
	});

	/** The done-but-running shape: running + stage=completed + no route + no PR. */
	function seedZombie(execId: string, issueIdentifier?: string): void {
		store.upsertSession({
			execution_id: execId,
			issue_id: `issue-${execId}`,
			project_name: "flywheel",
			status: "running",
			...(issueIdentifier && { issue_identifier: issueIdentifier }),
		});
		store.patchSessionMetadata(execId, { session_stage: "completed" });
	}

	it("VETOES the force-complete when the runner declares itself parked", () => {
		seedZombie("parked-alive");
		const isParked = vi.fn((execId: string) => execId === "parked-alive");

		const result = reconcileDoneButRunning(store, transitionOpts, {
			markerDir,
			isParked,
		});

		expect(result.scanned).toBe(1);
		expect(result.reconciled).toBe(0);
		expect(result.parkedVetoed).toBe(1);
		expect(isParked).toHaveBeenCalledWith("parked-alive", "flywheel");
		// The real proof: the row survived the sweep.
		expect(store.getSession("parked-alive")!.status).toBe("running");
	});

	it("still force-completes a genuine zombie with NO park declaration", () => {
		seedZombie("real-zombie");

		const result = reconcileDoneButRunning(store, transitionOpts, {
			markerDir,
			isParked: vi.fn(() => false),
		});

		expect(result.parkedVetoed).toBe(0);
		expect(result.reconciled).toBe(1);
		expect(store.getSession("real-zombie")!.status).toBe("completed");
	});

	/** No `isParked` dep wired → byte-identical legacy behavior. */
	it("without the isParked dep, behaves exactly as before (byte-compat)", () => {
		seedZombie("legacy");

		const result = reconcileDoneButRunning(store, transitionOpts, {
			markerDir,
		});

		expect(result.reconciled).toBe(1);
		expect(result.parkedVetoed).toBe(0);
		expect(store.getSession("legacy")!.status).toBe("completed");
	});

	/**
	 * A park lookup that throws must FAIL CLOSED. A CommDB lock/corruption window
	 * tells us nothing about whether the runner is parked — and destroying a live
	 * session on "we could not tell" is the FLY-1319 mistake in a new costume.
	 */
	it("fail-closed: an isParked lookup that throws vetoes rather than destroys", () => {
		seedZombie("unknowable");

		const result = reconcileDoneButRunning(store, transitionOpts, {
			markerDir,
			isParked: vi.fn(() => {
				throw new Error("CommDB locked");
			}),
		});

		expect(result.reconciled).toBe(0);
		expect(result.parkedVetoed).toBe(1);
		expect(store.getSession("unknowable")!.status).toBe("running");
	});

	it("the Lead env exclude list still wins before any park lookup", () => {
		seedZombie("excluded", "FLY-999");
		const isParked = vi.fn(() => false);

		const result = reconcileDoneButRunning(store, transitionOpts, {
			markerDir,
			exclude: new Set(["FLY-999"]),
			isParked,
		});

		expect(result.excluded).toBe(1);
		expect(result.reconciled).toBe(0);
		expect(isParked).not.toHaveBeenCalled();
	});
});
