/**
 * FLY-793 (Codex R1 BLOCKING): the three-stage re-dispatch guard.
 *
 * A fresh `/api/runs/start` on a three-stage issue reroutes to the Design phase.
 * The pre-reroute per-role dedup keys on `main`, so it cannot see an already-active
 * Design/Implement/QA phase — a second dispatch would start another phase AND (via
 * Blueprint.removeIfExists on the SHARED branch-B key) tear away the running phase's
 * worktree. `getActivePhaseSessionForIssue` is the durable check that closes this;
 * `design_done` counts (the handoff window still holds branch B), and the same
 * status must protect the worktree from the reconciler.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("FLY-793 three-stage re-dispatch guard (Codex R1)", () => {
	let dir: string;
	let store: StateStore;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fly793-dedup-"));
		store = await StateStore.create(join(dir, "teamlead.db"));
	});
	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function seed(over: {
		execution_id: string;
		issue_id?: string;
		session_role?: string;
		status?: string;
		worktree_path?: string;
	}) {
		store.upsertSession({
			execution_id: over.execution_id,
			issue_id: over.issue_id ?? "FLY-793",
			project_name: "flywheel",
			status: over.status ?? "running",
			session_role: over.session_role ?? "main",
			worktree_path: over.worktree_path,
		});
	}

	describe("getActivePhaseSessionForIssue", () => {
		it("finds a running Implement phase (the pre-reroute main dedup misses it)", () => {
			seed({
				execution_id: "impl-1",
				session_role: "implement",
				status: "running",
			});
			const found = store.getActivePhaseSessionForIssue("FLY-793");
			expect(found?.execution_id).toBe("impl-1");
		});

		it("finds a QA phase at awaiting_review", () => {
			seed({
				execution_id: "qa-1",
				session_role: "qa",
				status: "awaiting_review",
			});
			expect(store.getActivePhaseSessionForIssue("FLY-793")?.execution_id).toBe(
				"qa-1",
			);
		});

		it("finds a Design phase in the design_done handoff window", () => {
			seed({
				execution_id: "design-1",
				session_role: "design",
				status: "design_done",
			});
			expect(store.getActivePhaseSessionForIssue("FLY-793")?.execution_id).toBe(
				"design-1",
			);
		});

		it("ignores a `main` role session (not a phase)", () => {
			seed({ execution_id: "main-1", session_role: "main", status: "running" });
			expect(store.getActivePhaseSessionForIssue("FLY-793")).toBeUndefined();
		});

		it("ignores a terminal (completed) phase session", () => {
			seed({
				execution_id: "design-done",
				session_role: "design",
				status: "completed",
			});
			expect(store.getActivePhaseSessionForIssue("FLY-793")).toBeUndefined();
		});

		it("scopes to the issue — an active phase on another issue does not match", () => {
			seed({
				execution_id: "other",
				issue_id: "FLY-999",
				session_role: "implement",
				status: "running",
			});
			expect(store.getActivePhaseSessionForIssue("FLY-793")).toBeUndefined();
		});

		it("returns undefined when the issue has no active phase", () => {
			expect(store.getActivePhaseSessionForIssue("FLY-793")).toBeUndefined();
		});

		// Codex R2: the pending/restart window — `worktree_ready` (reliable) can
		// write a durable pending row with a worktree_path BEFORE the fire-and-forget
		// `session_started` persists the phase role. Match by the created worktree.
		it("finds a pending row that ALREADY holds a worktree (role not yet persisted)", () => {
			seed({
				execution_id: "pending-1",
				session_role: "main", // role not yet persisted at worktree_ready
				status: "pending",
				worktree_path: "/Users/x/Dev/flywheel-FLY-793",
			});
			expect(store.getActivePhaseSessionForIssue("FLY-793")?.execution_id).toBe(
				"pending-1",
			);
		});

		it("ignores a pending row with NO worktree yet (nothing to clobber)", () => {
			seed({
				execution_id: "pending-empty",
				session_role: "main",
				status: "pending",
				// no worktree_path
			});
			expect(store.getActivePhaseSessionForIssue("FLY-793")).toBeUndefined();
		});
	});

	describe("listWorktreeProtectionSessions includes design_done", () => {
		it("protects a design_done phase's shared branch-B worktree from the reconciler", () => {
			seed({
				execution_id: "design-1",
				session_role: "design",
				status: "design_done",
			});
			const protectedIds = store
				.listWorktreeProtectionSessions("flywheel")
				.map((s) => s.execution_id);
			expect(protectedIds).toContain("design-1");
		});
	});
});
