/**
 * FLY-1185 §2.4 — Layer A attestation + ship-time remote branch CAS.
 * Pins: binding mismatch → NO removal (R7); no binding → legacy removal with
 * bindingVerified:false → remote delete skipped; verified attestation +
 * merge evidence → lease CAS delete; production-shape (session.branch empty
 * but binding complete → executes; binding.branch differs → skip).
 */

import { describe, expect, it, vi } from "vitest";
import {
	makeShipRemoteBranchCleanup,
	type ShipRemoteCleanupDeps,
} from "../branch-cleanup.js";
import {
	makeWorktreeCleanup,
	type WorktreeCleanupDeps,
} from "../worktree-cleanup.js";

const ROOT = "/Users/x/Dev/flywheel";
const WT = "/Users/x/Dev/flywheel-FLY-603";
const BR = "flywheel-FLY-603";

function layerADeps(opts: {
	binding?: { path: string; branch: string; generation: string };
	marker?: string;
}) {
	const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
	const remove = vi.fn(async () => ({ removed: true, branchDeleted: true }));
	const d: WorktreeCleanupDeps = {
		store: {
			getSession: () =>
				({ execution_id: "e1", worktree_path: WT, branch: BR }) as never,
			insertEvent: (e: { event_type: string; payload?: unknown }) => {
				events.push({
					type: e.event_type,
					payload: (e.payload ?? {}) as Record<string, unknown>,
				});
				return true;
			},
			getWorktreeBinding: () => opts.binding,
		} as never,
		worktreeManager: {
			expectedWorktree: (_r, _p, key) => ({
				path: `/Users/x/Dev/flywheel-${key}`,
				branch: `flywheel-${key}`,
			}),
			parseWorktreeKeyFromPath: (_r, _p, p) => {
				const base = p.split("/").pop() ?? "";
				return base.startsWith("flywheel-")
					? base.slice("flywheel-".length)
					: null;
			},
			getRegisteredWorktree: async (_r, p) => ({
				path: p,
				branch: BR,
				head: "headsha123",
				isDetached: false,
				isBare: false,
			}),
			removeCleanWorktreeByPath: remove,
			readWorktreeGeneration: async () => opts.marker,
		} as never,
		resolveProjectRoot: () => ROOT,
		isWorktreeClean: async () => true,
		autoclean: true,
	};
	return { d, events, remove };
}

const input = {
	executionId: "e1",
	issueId: "FLY-603",
	issueIdentifier: "FLY-603",
	projectName: "flywheel",
	tmuxClosed: true,
	tmuxErrors: [] as string[],
};

describe("Layer A pre-delete attestation (FLY-1185 §2.4 R6#2/R7)", () => {
	it("matching binding + marker → removal with bindingVerified:true + headSha captured", async () => {
		const { d, remove } = layerADeps({
			binding: { path: WT, branch: BR, generation: "gen-1" },
			marker: "gen-1",
		});
		const att = await makeWorktreeCleanup(d)(input);
		expect(remove).toHaveBeenCalled();
		expect(att.removed).toBe(true);
		expect(att.bindingVerified).toBe(true);
		expect(att.actualBranch).toBe(BR);
		expect(att.headSha).toBe("headsha123");
	});

	it("binding present but generation mismatch → NO removal at all (R7)", async () => {
		const { d, remove, events } = layerADeps({
			binding: { path: WT, branch: BR, generation: "gen-OLD" },
			marker: "gen-NEW", // same path+branch REBUILD — the ABA case
		});
		const att = await makeWorktreeCleanup(d)(input);
		expect(remove).not.toHaveBeenCalled();
		expect(att.removed).toBe(false);
		expect(att.skippedReason).toBe("binding_mismatch");
		expect(
			events.find((e) => e.type === "worktree_cleanup_skipped")?.payload.reason,
		).toBe("binding_mismatch");
	});

	it("NO binding → legacy session-scoped removal proceeds, bindingVerified:false", async () => {
		const { d, remove } = layerADeps({ binding: undefined });
		const att = await makeWorktreeCleanup(d)(input);
		expect(remove).toHaveBeenCalled();
		expect(att.removed).toBe(true);
		expect(att.bindingVerified).toBe(false);
	});
});

describe("makeShipRemoteBranchCleanup", () => {
	function shipDeps(opts: {
		binding?: { path: string; branch: string; generation: string };
		mergedHeads?: string[];
		execResults?: Record<
			string,
			{ code: number; stdout: string; stderr: string }
		>;
	}) {
		const events: Array<{ type: string; payload: Record<string, unknown> }> =
			[];
		const execCalls: string[][] = [];
		const deps: ShipRemoteCleanupDeps = {
			store: {
				insertEvent: (e) => {
					events.push({ type: e.event_type, payload: e.payload });
					return true;
				},
				getWorktreeBinding: () => opts.binding,
			},
			resolveProjectRoot: () => ROOT,
			getMergedPrHeads: async () => new Set(opts.mergedHeads ?? []),
			exec: async (args) => {
				execCalls.push(args);
				const key = args.join(" ");
				for (const [pat, res] of Object.entries(opts.execResults ?? {})) {
					if (key.includes(pat)) return res;
				}
				return { code: 1, stdout: "", stderr: "default-fail" };
			},
		};
		return { deps, events, execCalls };
	}

	const attOk = {
		removed: true,
		bindingVerified: true,
		actualBranch: BR,
		headSha: "headsha123",
		branchDeleted: true,
	};

	it("verified attestation + merged-PR head → lease CAS delete executes", async () => {
		const { deps, events, execCalls } = shipDeps({
			binding: { path: WT, branch: BR, generation: "g" },
			mergedHeads: ["headsha123"],
			execResults: {
				"ls-remote": {
					code: 0,
					stdout: `headsha123\trefs/heads/${BR}\n`,
					stderr: "",
				},
				push: { code: 0, stdout: "", stderr: "" },
			},
		});
		await makeShipRemoteBranchCleanup(deps)({
			executionId: "e1",
			issueId: "FLY-603",
			projectName: "flywheel",
			attestation: attOk,
		});
		expect(events.map((e) => e.type)).toContain("ship_remote_branch_deleted");
		expect(
			execCalls.some((a) =>
				a.join(" ").includes(`--force-with-lease=refs/heads/${BR}:headsha123`),
			),
		).toBe(true);
	});

	it("bindingVerified:false → remote_delete_skipped, zero git calls", async () => {
		const { deps, events, execCalls } = shipDeps({
			binding: { path: WT, branch: BR, generation: "g" },
		});
		await makeShipRemoteBranchCleanup(deps)({
			executionId: "e1",
			issueId: "FLY-603",
			projectName: "flywheel",
			attestation: { ...attOk, bindingVerified: false },
		});
		expect(
			events.find((e) => e.type === "remote_delete_skipped")?.payload.reason,
		).toBe("binding_not_verified");
		expect(execCalls).toEqual([]);
	});

	it("production shape: binding.branch differs from attested branch → skip", async () => {
		const { deps, events } = shipDeps({
			binding: { path: WT, branch: "flywheel-OTHER", generation: "g" },
			mergedHeads: ["headsha123"],
		});
		await makeShipRemoteBranchCleanup(deps)({
			executionId: "e1",
			issueId: "FLY-603",
			projectName: "flywheel",
			attestation: attOk,
		});
		expect(
			events.find((e) => e.type === "remote_delete_skipped")?.payload.reason,
		).toBe("binding_branch_mismatch");
	});

	it("no merge evidence (not merged head, not ancestor) → skip, remainder to sweep", async () => {
		const { deps, events } = shipDeps({
			binding: { path: WT, branch: BR, generation: "g" },
			mergedHeads: [],
			execResults: {
				"merge-base": { code: 1, stdout: "", stderr: "" },
			},
		});
		await makeShipRemoteBranchCleanup(deps)({
			executionId: "e1",
			issueId: "FLY-603",
			projectName: "flywheel",
			attestation: attOk,
		});
		expect(
			events.find((e) => e.type === "remote_delete_skipped")?.payload.reason,
		).toBe("no_merge_evidence");
	});

	it("protected branch config → skip", async () => {
		const { deps, events } = shipDeps({
			binding: { path: WT, branch: BR, generation: "g" },
			mergedHeads: ["headsha123"],
		});
		deps.policies = new Map([
			["flywheel", { enabled: true, protectedBranches: ["flywheel-FLY-*"] }],
		]);
		await makeShipRemoteBranchCleanup(deps)({
			executionId: "e1",
			issueId: "FLY-603",
			projectName: "flywheel",
			attestation: attOk,
		});
		expect(
			events.find((e) => e.type === "remote_delete_skipped")?.payload.reason,
		).toBe("protected_branch");
	});
});
