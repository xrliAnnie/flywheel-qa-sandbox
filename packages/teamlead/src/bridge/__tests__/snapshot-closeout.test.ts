import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
	cleanupExecutionSnapshots,
	resolveActiveSnapshotOwner,
	runSnapshotMaintenance,
} from "../snapshot-closeout.js";

const binding = {
	activation_id: "activation-2",
	execution_id: "exec-1",
	run_id: "run-1",
	node_id: "implement",
	attempt: 2,
};

describe("snapshot owner resolution", () => {
	it("binds an unfinished workflow to its exact current activation", () => {
		const store = {
			resolveCurrentWorkflowActivation: () => ({
				kind: "current",
				binding,
			}),
			getWorkflowNodeCompletion: () => undefined,
		};

		expect(resolveActiveSnapshotOwner(store as never, "exec-1")).toEqual({
			kind: "current",
			owner: {
				kind: "workflow",
				executionId: "exec-1",
				runId: "run-1",
				nodeId: "implement",
				attempt: 2,
				activationId: "activation-2",
			},
		});
	});

	it("fails closed on workflow ambiguity instead of falling back to session", () => {
		const store = {
			resolveCurrentWorkflowActivation: () => ({
				kind: "ambiguous",
				activationIds: [],
			}),
			getSession: vi.fn(),
		};

		expect(resolveActiveSnapshotOwner(store as never, "exec-1")).toEqual({
			kind: "ambiguous",
		});
		expect(store.getSession).not.toHaveBeenCalled();
	});

	it("uses a live session only when no workflow history exists", () => {
		const store = {
			resolveCurrentWorkflowActivation: () => ({ kind: "none" }),
			getSession: () => ({
				execution_id: "exec-1",
				status: "running",
				started_at: "2026-09-08T12:00:00.000Z",
			}),
		};

		expect(resolveActiveSnapshotOwner(store as never, "exec-1")).toEqual({
			kind: "current",
			owner: {
				kind: "session",
				executionId: "exec-1",
				sessionStartedAt: "2026-09-08T12:00:00.000Z",
			},
		});
	});
});

describe("snapshot closeout", () => {
	it("is wired after accepted event-route terminal records", async () => {
		const source = await readFile(
			new URL("../event-route.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("cleanupExecutionSnapshots");
	});

	it("is retried by the central close-runner success path", async () => {
		const source = await readFile(
			new URL("../close-runner.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("cleanupExecutionSnapshots");
	});

	it("runs retention and residue cleanup on the existing maintenance tick", async () => {
		const source = await readFile(
			new URL("../plugin.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("runSnapshotMaintenance(store)");
	});

	it("deletes only an exact workflow owner with a durable completion", async () => {
		const owner = {
			kind: "workflow" as const,
			executionId: "exec-1",
			runId: "run-1",
			nodeId: "implement",
			attempt: 2,
			activationId: "activation-2",
		};
		const cleanup = vi.fn(async (input) => ({
			status: (await input.authorize(owner)) ? "deleted" : "not_authorized",
			bytesReleased: 4_096,
		}));
		const store = {
			getWorkflowActivation: () => binding,
			getWorkflowNodeCompletion: () => ({
				activation_id: "activation-2",
				execution_id: "exec-1",
			}),
		};

		await expect(
			cleanupExecutionSnapshots(store as never, "exec-1", {
				readOwner: () => owner,
				cleanup: cleanup as never,
			}),
		).resolves.toMatchObject({ status: "deleted" });
	});

	it("does not let an old-attempt callback delete a new activation", async () => {
		const newOwner = {
			kind: "workflow" as const,
			executionId: "exec-1",
			runId: "run-1",
			nodeId: "implement",
			attempt: 3,
			activationId: "activation-3",
		};
		const cleanup = vi.fn(async (input) => ({
			status: (await input.authorize(newOwner)) ? "deleted" : "not_authorized",
			bytesReleased: 0,
		}));
		const store = {
			getWorkflowActivation: () => ({
				...binding,
				activation_id: "activation-3",
				attempt: 3,
			}),
			getWorkflowNodeCompletion: () => undefined,
		};

		await expect(
			cleanupExecutionSnapshots(store as never, "exec-1", {
				readOwner: () => newOwner,
				cleanup: cleanup as never,
			}),
		).resolves.toMatchObject({ status: "not_authorized" });
	});

	it("logs a dry run before applying repair retention and retries terminal residue", async () => {
		const calls: string[] = [];
		const owner = {
			kind: "session" as const,
			executionId: "exec-terminal",
			sessionStartedAt: "2026-09-08T12:00:00.000Z",
		};
		const prune = vi.fn(async ({ dryRun }) => {
			calls.push(dryRun ? "dry-run" : "apply");
			return { mode: dryRun ? "dry-run" : "apply", items: [] };
		});
		const cleanup = vi.fn(async (input) => {
			calls.push("cleanup");
			return {
				status: (await input.authorize(owner)) ? "deleted" : "not_authorized",
				bytesReleased: 4_096,
			};
		});
		const log = vi.fn();
		const store = {
			getSession: () => ({
				execution_id: "exec-terminal",
				status: "completed",
				started_at: owner.sessionStartedAt,
			}),
		};

		await runSnapshotMaintenance(store as never, {
			prune: prune as never,
			inspect: () => [{ owner, bytes: 4_096 }],
			readOwner: () => owner,
			cleanup: cleanup as never,
			log,
		});

		expect(calls).toEqual(["dry-run", "apply", "cleanup"]);
		expect(log).toHaveBeenCalledWith(
			"snapshot_retention_dry_run",
			expect.objectContaining({ mode: "dry-run" }),
		);
	});

	it("reports an orphan entry and continues cleanup for valid directories", async () => {
		const owner = {
			kind: "session" as const,
			executionId: "exec-terminal",
			sessionStartedAt: "2026-09-08T12:00:00.000Z",
		};
		const cleanup = vi.fn(async () => ({
			status: "deleted" as const,
			bytesReleased: 4_096,
		}));
		const log = vi.fn();
		const store = {
			getSession: () => ({
				execution_id: owner.executionId,
				status: "completed",
				started_at: owner.sessionStartedAt,
			}),
		};

		await runSnapshotMaintenance(store as never, {
			prune: (async ({ dryRun }) => ({
				mode: dryRun ? "dry-run" : "apply",
				items: [],
			})) as never,
			inspect: (() => [
				{
					path: "orphan-exec",
					error: "managed_snapshot_owner_missing",
				},
				{ owner, bytes: 4_096 },
			]) as never,
			readOwner: () => owner,
			cleanup: cleanup as never,
			log,
		});

		expect(log).toHaveBeenCalledWith("snapshot_directory_unmanaged", {
			path: "orphan-exec",
			error: "managed_snapshot_owner_missing",
		});
		expect(cleanup).toHaveBeenCalledTimes(1);
	});
});
