/**
 * FLY-1066 face ④: resolve runner-target detection escalations only when the
 * execution is absent from StateStore and every configured project CommDB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type OrphanEscalationReconcileDeps,
	resolveOrphanDetectionEscalations,
} from "../bridge/orphan-escalation-reconcile.js";
import { StateStore } from "../StateStore.js";

describe("orphan detection escalation reconcile (FLY-1066)", () => {
	let store: StateStore;
	const projects = ["geo", "flywheel"];

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});
	afterEach(() => store.close());

	function seed(
		targetKey: string,
		fingerprint: string,
		status: "NEW" | "ACKED" = "NEW",
	) {
		store.upsertDetectionEscalation({
			targetKey,
			kind: "detection_stuck_confirmed",
			episodeFingerprint: fingerprint,
			issueId: `issue-${targetKey}`,
			firstDetectedAtMs: 1_000,
		});
		if (status === "ACKED") {
			store.ackDetectionEscalation(
				targetKey,
				"detection_stuck_confirmed",
				fingerprint,
				{ atMs: 2_000, disposition: "ack" },
			);
		}
	}

	function baseDeps(
		overrides: Partial<OrphanEscalationReconcileDeps> = {},
	): OrphanEscalationReconcileDeps {
		return {
			store,
			projectNames: projects,
			listCommDbExecutionIds: vi.fn(() => []),
			hasCommDbSession: vi.fn(() => false),
			log: () => {},
			...overrides,
		};
	}

	it("resolves double-absent NEW and ACKED rows with residue_harvest", () => {
		seed("exec-new", "fp:new");
		seed("exec-acked", "fp:acked", "ACKED");
		const deps = baseDeps();

		const result = resolveOrphanDetectionEscalations(deps);

		expect(result).toMatchObject({
			aborted: false,
			scanned: 2,
			candidateTargets: 2,
			resolvedTargets: 2,
			resolvedRows: 2,
		});
		for (const [target, fingerprint] of [
			["exec-new", "fp:new"],
			["exec-acked", "fp:acked"],
		] as const) {
			expect(
				store.getDetectionEscalation(
					target,
					"detection_stuck_confirmed",
					fingerprint,
				),
			).toMatchObject({ status: "RESOLVED", resolved_via: "residue_harvest" });
		}
	});

	it("keeps a target present in StateStore, even when its row is terminal", () => {
		seed("exec-state", "fp:state");
		store.upsertSession({
			execution_id: "exec-state",
			issue_id: "issue-exec-state",
			project_name: "geo",
			status: "completed",
		});

		const result = resolveOrphanDetectionEscalations(baseDeps());

		expect(result.resolvedRows).toBe(0);
		expect(
			store.getDetectionEscalation(
				"exec-state",
				"detection_stuck_confirmed",
				"fp:state",
			)?.status,
		).toBe("NEW");
	});

	it("keeps a target present in any configured project CommDB", () => {
		seed("exec-comm", "fp:comm");
		const list = vi.fn((projectName: string) =>
			projectName === "flywheel" ? ["exec-comm"] : [],
		);
		const deps = baseDeps({ listCommDbExecutionIds: list });

		const result = resolveOrphanDetectionEscalations(deps);

		expect(result.resolvedRows).toBe(0);
		expect(list).toHaveBeenCalledWith("geo");
		expect(list).toHaveBeenCalledWith("flywheel");
	});

	it("never treats a project:lead target key as an execution id", () => {
		seed("geo:product-lead", "fp:lead");
		const deps = baseDeps();

		const result = resolveOrphanDetectionEscalations(deps);

		expect(result.skippedNonRunnerTarget).toBe(1);
		expect(deps.hasCommDbSession).not.toHaveBeenCalled();
		expect(
			store.getDetectionEscalation(
				"geo:product-lead",
				"detection_stuck_confirmed",
				"fp:lead",
			)?.status,
		).toBe("NEW");
	});

	it("aborts the whole face-④ pass when any configured CommDB index is unreadable", () => {
		seed("exec-a", "fp:a");
		seed("exec-b", "fp:b");
		const deps = baseDeps({
			listCommDbExecutionIds: vi.fn((projectName: string) => {
				if (projectName === "flywheel") throw new Error("database is locked");
				return [];
			}),
		});

		const result = resolveOrphanDetectionEscalations(deps);

		expect(result.aborted).toBe(true);
		expect(result.abortReason).toBe("commdb_index_unreadable");
		expect(result.resolvedRows).toBe(0);
		expect(store.getDetectionEscalationsForReconcile()).toHaveLength(2);
	});

	it("aborts fail-closed when no configured project set can define global absence", () => {
		seed("exec-no-projects", "fp:no-projects");

		const result = resolveOrphanDetectionEscalations(
			baseDeps({ projectNames: [] }),
		);

		expect(result.aborted).toBe(true);
		expect(result.abortReason).toBe("no_configured_projects");
		expect(result.resolvedRows).toBe(0);
	});

	it("rechecks every CommDB after initial indexing and keeps an execution that re-registers in the race", () => {
		seed("exec-race", "fp:race");
		const present = new Set<string>();
		const deps = baseDeps({
			listCommDbExecutionIds: vi.fn(() => []),
			hasCommDbSession: vi.fn((_project, executionId) =>
				present.has(executionId),
			),
			beforeCandidateRecheck: (executionId) => present.add(executionId),
		});

		const result = resolveOrphanDetectionEscalations(deps);

		expect(result.resolvedRows).toBe(0);
		expect(deps.hasCommDbSession).toHaveBeenCalled();
		expect(
			store.getDetectionEscalation(
				"exec-race",
				"detection_stuck_confirmed",
				"fp:race",
			)?.status,
		).toBe("NEW");
	});

	it("keeps only the indeterminate candidate when a per-target CommDB re-read fails", () => {
		seed("exec-error", "fp:error");
		seed("exec-clean", "fp:clean");
		const deps = baseDeps({
			hasCommDbSession: vi.fn((_project, executionId) => {
				if (executionId === "exec-error") throw new Error("read failed");
				return false;
			}),
		});

		const result = resolveOrphanDetectionEscalations(deps);

		expect(result.readErrors).toBe(1);
		expect(result.resolvedTargets).toBe(1);
		expect(
			store.getDetectionEscalation(
				"exec-error",
				"detection_stuck_confirmed",
				"fp:error",
			)?.status,
		).toBe("NEW");
		expect(
			store.getDetectionEscalation(
				"exec-clean",
				"detection_stuck_confirmed",
				"fp:clean",
			)?.status,
		).toBe("RESOLVED");
	});

	it("rechecks StateStore immediately before resolution and keeps a newly appeared row", () => {
		seed("exec-state-race", "fp:state-race");
		const deps = baseDeps({
			beforeCandidateRecheck: () => {
				store.upsertSession({
					execution_id: "exec-state-race",
					issue_id: "issue-exec-state-race",
					project_name: "geo",
					status: "pending",
				});
			},
		});

		const result = resolveOrphanDetectionEscalations(deps);

		expect(result.resolvedRows).toBe(0);
		expect(
			store.getDetectionEscalation(
				"exec-state-race",
				"detection_stuck_confirmed",
				"fp:state-race",
			)?.status,
		).toBe("NEW");
	});
});
