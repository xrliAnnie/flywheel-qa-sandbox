import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import {
	hasPendingCompleteMarker,
	isDoneButRunning,
	parseSweepExcludeEnv,
	reconcileDoneButRunning,
} from "../bridge/done-running-reconciler.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import { StateStore } from "../StateStore.js";

describe("FLY-324 isDoneButRunning predicate", () => {
	it("true for running + stage=completed + no route + no PR (no-code/QA zombie)", () => {
		expect(
			isDoneButRunning({
				status: "running",
				session_stage: "completed",
			}),
		).toBe(true);
	});

	it("false when status is not running", () => {
		expect(
			isDoneButRunning({
				status: "awaiting_review",
				session_stage: "completed",
			}),
		).toBe(false);
		expect(
			isDoneButRunning({ status: "completed", session_stage: "completed" }),
		).toBe(false);
	});

	it("false when stage is not completed (e.g. still implementing)", () => {
		expect(
			isDoneButRunning({ status: "running", session_stage: "implement" }),
		).toBe(false);
	});

	it("false when a decision_route was recorded (complete --route ran)", () => {
		expect(
			isDoneButRunning({
				status: "running",
				session_stage: "completed",
				decision_route: "no_code",
			}),
		).toBe(false);
	});

	it("false when a PR exists (dev ship flow — W2's domain, not FLY-324)", () => {
		expect(
			isDoneButRunning({
				status: "running",
				session_stage: "completed",
				pr_number: 42,
			}),
		).toBe(false);
	});
});

describe("FLY-324 reconcileDoneButRunning boot sweep", () => {
	let store: StateStore;
	let transitionOpts: ApplyTransitionOpts;
	let markerDir: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
		const executor = new DirectiveExecutor(store);
		transitionOpts = { store, fsm, executor };
		// Hermetic, empty marker dir so the sweep never reads the real
		// ~/.flywheel/state/complete-failed during tests.
		markerDir = mkdtempSync(join(tmpdir(), "fly324-markers-"));
	});

	afterEach(() => {
		store.close();
		rmSync(markerDir, { recursive: true, force: true });
	});

	/** Seed a session at `running`, then stamp stage + optional fields. */
	function seedRunning(
		execId: string,
		fields: {
			session_stage?: string;
			decision_route?: string;
			pr_number?: number;
		} = {},
	): void {
		store.upsertSession({
			execution_id: execId,
			issue_id: `issue-${execId}`,
			project_name: "geoforge3d",
			status: "running",
			decision_route: fields.decision_route,
			pr_number: fields.pr_number,
		});
		if (fields.session_stage) {
			store.patchSessionMetadata(execId, {
				session_stage: fields.session_stage,
			});
		}
	}

	it("transitions a done-but-running zombie to completed", () => {
		seedRunning("z1", { session_stage: "completed" });

		const result = reconcileDoneButRunning(store, transitionOpts, {
			markerDir,
		});

		expect(result.scanned).toBe(1);
		expect(result.reconciled).toBe(1);
		expect(result.rejected).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.excluded).toBe(0);
		expect(store.getSession("z1")!.status).toBe("completed");
	});

	it("sweeps several zombies and leaves non-matching active sessions alone", () => {
		seedRunning("zombie-a", { session_stage: "completed" });
		seedRunning("zombie-b", { session_stage: "completed" });
		// Not a zombie: still implementing.
		seedRunning("working", { session_stage: "implement" });
		// Not a zombie: complete --route already ran (would already be completed
		// in production; route presence alone must exclude it from the sweep).
		seedRunning("routed", {
			session_stage: "completed",
			decision_route: "no_code",
		});
		// Not a zombie: has a PR (dev ship flow).
		seedRunning("withpr", { session_stage: "completed", pr_number: 7 });

		const result = reconcileDoneButRunning(store, transitionOpts, {
			markerDir,
		});

		expect(result.scanned).toBe(2);
		expect(result.reconciled).toBe(2);
		expect(store.getSession("zombie-a")!.status).toBe("completed");
		expect(store.getSession("zombie-b")!.status).toBe("completed");
		// Untouched
		expect(store.getSession("working")!.status).toBe("running");
		expect(store.getSession("routed")!.status).toBe("running");
		expect(store.getSession("withpr")!.status).toBe("running");
	});

	it("does not touch awaiting_review / approved_to_ship sessions", () => {
		store.upsertSession({
			execution_id: "ar",
			issue_id: "issue-ar",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		store.patchSessionMetadata("ar", { session_stage: "completed" });

		const result = reconcileDoneButRunning(store, transitionOpts, {
			markerDir,
		});

		expect(result.scanned).toBe(0);
		expect(store.getSession("ar")!.status).toBe("awaiting_review");
	});

	it("is a no-op when there are no zombies", () => {
		seedRunning("active", { session_stage: "implement" });

		const result = reconcileDoneButRunning(store, transitionOpts, {
			markerDir,
		});

		expect(result).toEqual({
			scanned: 0,
			reconciled: 0,
			rejected: 0,
			skipped: 0,
			excluded: 0,
		});
	});

	// Codex R1 LOW: a zombie that still has a pending complete marker is owned
	// by the FLY-172 drain / heartbeat reconcile (the marker carries the real
	// route). The sweep must skip it, not force-complete it.
	it("skips a done-but-running session with a pending complete marker", () => {
		seedRunning("has-marker", { session_stage: "completed" });
		writeFileSync(
			join(markerDir, "has-marker.json"),
			JSON.stringify({ payload: { decision: { route: "needs_review" } } }),
		);

		const result = reconcileDoneButRunning(store, transitionOpts, {
			markerDir,
		});

		expect(result.scanned).toBe(1);
		expect(result.reconciled).toBe(0);
		expect(result.skipped).toBe(1);
		// Left running for the marker drain to route correctly.
		expect(store.getSession("has-marker")!.status).toBe("running");
	});

	it("hasPendingCompleteMarker detects a marker file by execId", () => {
		expect(hasPendingCompleteMarker("nope", markerDir)).toBe(false);
		writeFileSync(join(markerDir, "yes.json"), "{}");
		expect(hasPendingCompleteMarker("yes", markerDir)).toBe(true);
	});

	// Cutover safety: a parked Runner (reported stage=completed but still needed)
	// must be excluded by the Lead so it is not force-completed → torn down.
	it("excludes a session whose execId is on the exclude list", () => {
		seedRunning("parked-exec", { session_stage: "completed" });
		seedRunning("real-zombie", { session_stage: "completed" });

		const result = reconcileDoneButRunning(store, transitionOpts, {
			markerDir,
			exclude: new Set(["parked-exec"]),
		});

		expect(result.scanned).toBe(2);
		expect(result.reconciled).toBe(1);
		expect(result.excluded).toBe(1);
		expect(store.getSession("parked-exec")!.status).toBe("running");
		expect(store.getSession("real-zombie")!.status).toBe("completed");
	});

	it("excludes a session matched by issue_identifier (Lead writes FLY-319)", () => {
		store.upsertSession({
			execution_id: "exec-fly319",
			issue_id: "issue-fly319",
			issue_identifier: "FLY-319",
			project_name: "tidal-echo",
			status: "running",
		});
		store.patchSessionMetadata("exec-fly319", { session_stage: "completed" });

		const result = reconcileDoneButRunning(store, transitionOpts, {
			markerDir,
			exclude: new Set(["FLY-319"]),
		});

		expect(result.scanned).toBe(1);
		expect(result.reconciled).toBe(0);
		expect(result.excluded).toBe(1);
		expect(store.getSession("exec-fly319")!.status).toBe("running");
	});
});

describe("FLY-324 parseSweepExcludeEnv", () => {
	it("returns an empty set for unset / empty input (default: sweep all)", () => {
		expect(parseSweepExcludeEnv(undefined).size).toBe(0);
		expect(parseSweepExcludeEnv("").size).toBe(0);
		expect(parseSweepExcludeEnv("   ").size).toBe(0);
	});

	it("parses comma / whitespace separated execIds + identifiers, trimming blanks", () => {
		const set = parseSweepExcludeEnv("FLY-319, FLY-323 ,, bedf9f73  ");
		expect(set.has("FLY-319")).toBe(true);
		expect(set.has("FLY-323")).toBe(true);
		expect(set.has("bedf9f73")).toBe(true);
		expect(set.size).toBe(3);
	});
});
